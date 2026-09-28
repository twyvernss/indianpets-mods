import type { T1, T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import { RECORD_SCHEMA_VERSION } from '../types.js';
import { DEFAULT_CHECKLIST_LABELS } from '../text.js';
import type { ChecklistItemResult, VerificationRecord } from '../types.js';
import { keys } from './keys.js';
import type { RedisPort } from './redisPort.js';
import { parseJson } from './redisPort.js';

export type VerificationRepo = {
  get(postId: T3): Promise<VerificationRecord | null>;
  /** Batched read. One `mGet`, never one call per id. */
  getMany(postIds: readonly T3[]): Promise<VerificationRecord[]>;
  /** Writes the record without touching the indexes. Used for `pending`. */
  putProvisional(record: VerificationRecord): Promise<void>;
  /** Writes the record AND registers it in both indexes. Used for `complete`. */
  putComplete(record: VerificationRecord): Promise<void>;
  /** Overwrites an existing complete record in place, leaving indexes alone. */
  update(record: VerificationRecord): Promise<void>;
  /** Removes the record and both index entries. */
  remove(postId: T3): Promise<void>;
  /** Scrubs user-identifying content but keeps the row for idempotency. */
  markDeleted(postId: T3, deletedAtMs: number): Promise<void>;
  /** Stops staleness reminders without losing the verification history. */
  closeOpen(postId: T3): Promise<void>;

  /**
   * Oldest open verifications with `verifiedAtMs <= cutoffMs`, oldest first.
   * Bounded by `limit` so a sweep can never exceed its time budget.
   */
  openBefore(cutoffMs: number, limit: number, offset: number): Promise<T3[]>;
  /** How many verifications are still awaiting a reminder or escalation. */
  openCount(cutoffMs: number): Promise<number>;

  /** Returns an owner token on success, or false if someone else holds the lock. */
  acquireLock(postId: T3, ownerToken: string, nowMs: number): Promise<boolean>;
  releaseLock(postId: T3, ownerToken: string): Promise<void>;

  /**
   * Every fundraiser this app has verified for a given person, newest first.
   *
   * Kept deliberately content-free (a post id and a timestamp) and NOT erased
   * when a post is deleted: it records what the moderator team did, in the same
   * spirit as a mod note, and is the only way to see that someone has raised
   * here before and then removed the evidence.
   */
  getAuthorHistory(username: string, limit: number): Promise<{ postId: T3; verifiedAtMs: number }[]>;

  recordAutomodHold(postId: T3, heldAtMs: number, nowMs: number): Promise<void>;
  getAutomodHold(postId: T3): Promise<number | null>;
};

function isChecklistResults(value: unknown): value is ChecklistItemResult[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const item = entry as Record<string, unknown>;
      return typeof item['label'] === 'string' && typeof item['checked'] === 'boolean';
    })
  );
}

function optionalNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Reads a stored row, upgrading the v1 shape if it is encountered.
 *
 * v1 stored the checklist as a fixed-key object (`{ billInOpName: true, ... }`)
 * because the items were hard-coded. v2 stores `{ label, checked }[]` so the
 * list can be edited per subreddit. v1 was never published, but it WAS possible
 * to playtest, so a test subreddit can legitimately hold v1 rows - dropping
 * them would let the app comment on a post it had already verified.
 */
function upgradeRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  const version = value['schemaVersion'];
  if (version === RECORD_SCHEMA_VERSION) return value;
  if (version !== 1) return null;

  const legacy = value['checklist'];
  let checklist: ChecklistItemResult[] | null = null;

  if (legacy !== null && typeof legacy === 'object') {
    const entries = legacy as Record<string, unknown>;
    // v1's keys were positional against this exact list, in this order.
    checklist = DEFAULT_CHECKLIST_LABELS.map((label, index) => ({
      label,
      checked: entries[LEGACY_CHECKLIST_KEYS[index] ?? ''] === true,
    }));
  }

  return {
    ...value,
    schemaVersion: RECORD_SCHEMA_VERSION,
    checklist,
    reminderSentAtMs: null,
    opRespondedAtMs: null,
    escalatedAtMs: null,
  };
}

/** The v1 checklist field names, in the order their labels appeared. */
const LEGACY_CHECKLIST_KEYS: readonly string[] = [
  'billInOpName',
  'clinicContacted',
  'petPhotoWithUsername',
  'amountMatchesGoal',
  'linkWorksBeneficiaryMatches',
  'accountAgeKarmaOk',
];

/**
 * Validates a row read back from Redis.
 *
 * Deliberately strict on the fields the app branches on (`status`, `postId`,
 * `verifiedAtMs`) and forgiving elsewhere, so a row written by an older version
 * is either usable or cleanly ignored - never half-trusted.
 */
export function isVerificationRecord(value: unknown): value is VerificationRecord {
  if (typeof value !== 'object' || value === null) return false;

  const upgraded = upgradeRecord(value as Record<string, unknown>);
  if (!upgraded) return false;

  if (typeof upgraded['postId'] !== 'string' || !upgraded['postId'].startsWith('t3_')) return false;
  if (typeof upgraded['modName'] !== 'string') return false;
  if (typeof upgraded['verifiedAtMs'] !== 'number' || !Number.isFinite(upgraded['verifiedAtMs'])) return false;
  if (upgraded['status'] !== 'pending' && upgraded['status'] !== 'complete') return false;
  if (typeof upgraded['note'] !== 'string') return false;

  const author = upgraded['authorName'];
  if (author !== null && typeof author !== 'string') return false;

  const commentId = upgraded['commentId'];
  if (commentId !== null && (typeof commentId !== 'string' || !commentId.startsWith('t1_'))) return false;

  if (!optionalNumber(upgraded['deletedAtMs'])) return false;
  if (!optionalNumber(upgraded['reminderSentAtMs'])) return false;
  if (!optionalNumber(upgraded['opRespondedAtMs'])) return false;
  if (!optionalNumber(upgraded['escalatedAtMs'])) return false;

  const checklist = upgraded['checklist'];
  if (checklist !== null && !isChecklistResults(checklist)) return false;

  // Copy the upgraded fields back so the caller receives the v2 shape even when
  // the stored row was v1. Safe because `upgraded` is either `value` itself or
  // a superset of it.
  Object.assign(value, upgraded);
  return true;
}

export function createVerificationRepo(redis: RedisPort): VerificationRepo {
  async function read(postId: T3): Promise<VerificationRecord | null> {
    return parseJson(await redis.get(keys.record(postId)), isVerificationRecord);
  }

  async function write(record: VerificationRecord): Promise<void> {
    await redis.set(keys.record(record.postId), JSON.stringify(record));
  }

  return {
    get: read,

    async getMany(postIds) {
      if (postIds.length === 0) return [];
      const raws = await redis.mGet(postIds.map((id) => keys.record(id)));
      const records: VerificationRecord[] = [];
      for (const raw of raws) {
        const record = parseJson(raw, isVerificationRecord);
        if (record) records.push(record);
      }
      return records;
    },

    putProvisional: write,
    update: write,

    async putComplete(record) {
      // The record must land before the indexes: an index entry pointing at a
      // missing record is a harder state to reason about than the reverse.
      await write(record);

      const writes = [
        redis.zAdd(keys.verifiedIndex(), { member: record.postId, score: record.verifiedAtMs }),
        redis.zAdd(keys.openIndex(), { member: record.postId, score: record.verifiedAtMs }),
      ];
      if (record.authorName) {
        writes.push(
          redis.zAdd(keys.authorHistory(record.authorName), {
            member: record.postId,
            score: record.verifiedAtMs,
          }),
        );
      }
      await Promise.all(writes);
    },



    async remove(postId) {
      // A rolled-back verification never happened, so it must not leave a trace
      // in the author's history either.
      const existing = await read(postId);
      const removals = [
        redis.del(keys.record(postId)),
        redis.zRem(keys.verifiedIndex(), [postId]),
        redis.zRem(keys.openIndex(), [postId]),
      ];
      if (existing?.authorName) {
        removals.push(redis.zRem(keys.authorHistory(existing.authorName), [postId]));
      }
      await Promise.all(removals);
    },

    async markDeleted(postId, deletedAtMs) {
      const existing = await read(postId);
      if (!existing) {
        await redis.zRem(keys.openIndex(), [postId]);
        return;
      }

      // Devvit Rules require stored user content to be dropped when the content
      // is deleted on Reddit. The row itself is kept (without any user content)
      // so a later re-verify still sees "already verified" and cannot post a
      // second comment.
      await write({
        ...existing,
        authorName: null,
        note: '',
        checklist: null,
        deletedAtMs,
      });
      await redis.zRem(keys.openIndex(), [postId]);
    },

    async closeOpen(postId) {
      await redis.zRem(keys.openIndex(), [postId]);
    },

    async openBefore(cutoffMs, limit, offset) {
      const entries = await redis.zRange(keys.openIndex(), 0, cutoffMs, {
        by: 'score',
        limit: { offset, count: limit },
      });
      return entries.map((entry) => entry.member as T3);
    },

    async openCount(cutoffMs) {
      const entries = await redis.zRange(keys.openIndex(), 0, cutoffMs, { by: 'score' });
      return entries.length;
    },

    /**
     * Lock acquisition.
     *
     * Devvit types `set()` as returning `string`, and the docs do not state what
     * it returns when `nx` prevents the write. Rather than depend on that
     * unspecified behaviour, this writes a unique owner token and reads it back:
     * we hold the lock only if what is stored is what we wrote.
     */
    async acquireLock(postId, ownerToken, nowMs) {
      const key = keys.lock(postId);
      await redis.set(key, ownerToken, {
        nx: true,
        expiration: new Date(nowMs + CONFIG.lockTtlSeconds * 1000),
      });
      return (await redis.get(key)) === ownerToken;
    },

    async releaseLock(postId, ownerToken) {
      const key = keys.lock(postId);
      // Only release a lock we still own; otherwise the TTL handles it.
      if ((await redis.get(key)) === ownerToken) await redis.del(key);
    },

    async getAuthorHistory(username, limit) {
      const entries = await redis.zRange(keys.authorHistory(username), 0, Number.MAX_SAFE_INTEGER, {
        by: 'score',
        reverse: true,
        limit: { offset: 0, count: limit },
      });
      return entries.map((entry) => ({
        postId: entry.member as T3,
        verifiedAtMs: entry.score,
      }));
    },

    async recordAutomodHold(postId, heldAtMs, nowMs) {
      await redis.set(keys.automodHold(postId), String(heldAtMs), {
        expiration: new Date(nowMs + CONFIG.automodHoldTtlSeconds * 1000),
      });
    },

    async getAutomodHold(postId) {
      const raw = await redis.get(keys.automodHold(postId));
      if (typeof raw !== 'string') return null;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : null;
    },
  };
}

/** Convenience factory used when building a fresh record. */
export function newPendingRecord(input: {
  postId: T3;
  authorName: string | null;
  modName: string;
  nowMs: number;
  note: string;
  checklist: ChecklistItemResult[] | null;
}): VerificationRecord {
  return {
    schemaVersion: 2,
    postId: input.postId,
    authorName: input.authorName,
    modName: input.modName,
    verifiedAtMs: input.nowMs,
    status: 'pending',
    note: input.note,
    checklist: input.checklist,
    commentId: null,
    deletedAtMs: null,
    reminderSentAtMs: null,
    opRespondedAtMs: null,
    escalatedAtMs: null,
  };
}

export function completeRecord(record: VerificationRecord, commentId: T1): VerificationRecord {
  return { ...record, status: 'complete', commentId };
}
