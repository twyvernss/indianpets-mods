import type { T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import type { ChecklistItem, VerificationToken } from '../types.js';
import { keys } from './keys.js';
import type { RedisPort } from './redisPort.js';
import { parseJson } from './redisPort.js';

/**
 * Server-minted, short-lived proof that a specific moderator opened the verify
 * form for a specific post.
 *
 * WHY THIS EXISTS: the form-submission endpoint receives whatever the client
 * sends. A postId carried in form data could be swapped for any other post. The
 * token is generated server-side when the menu action is clicked, stored in
 * Redis, and is the only thing the submit handler trusts for the target post and
 * the acting moderator. It also naturally enforces Devvit's 10-minute "complete
 * the form" window for moderator menu actions.
 *
 * It additionally carries the exact checklist shown to that moderator, so
 * editing the checklist setting while a form is open cannot pair the wrong
 * labels with the submitted answers.
 */
export type TokenRepo = {
  mint(payload: VerificationToken): Promise<string>;
  resolve(token: string): Promise<VerificationToken | null>;
  /** Records the checklist a moderator is being shown. No-op if expired. */
  attachChecklist(token: string, items: readonly ChecklistItem[]): Promise<void>;
  consume(token: string): Promise<void>;
};

function isChecklistItems(value: unknown): value is ChecklistItem[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const item = entry as Record<string, unknown>;
      return typeof item['id'] === 'string' && typeof item['label'] === 'string';
    })
  );
}

function isVerificationToken(value: unknown): value is VerificationToken {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate['postId'] !== 'string' || !candidate['postId'].startsWith('t3_')) return false;
  if (typeof candidate['modName'] !== 'string' || candidate['modName'].length === 0) return false;
  if (typeof candidate['createdAtMs'] !== 'number') return false;

  const checklist = candidate['checklist'];
  if (checklist !== undefined && checklist !== null && !isChecklistItems(checklist)) return false;

  // Tokens minted before the checklist field existed are still valid.
  if (checklist === undefined) candidate['checklist'] = null;

  return true;
}

export function createTokenRepo(
  redis: RedisPort,
  generateId: () => string = () => globalThis.crypto.randomUUID(),
): TokenRepo {
  async function read(token: string): Promise<VerificationToken | null> {
    return parseJson(await redis.get(keys.token(token)), isVerificationToken);
  }

  async function write(token: string, payload: VerificationToken): Promise<void> {
    await redis.set(keys.token(token), JSON.stringify(payload), {
      // Expiry is anchored to when the token was MINTED, so refreshing its
      // contents cannot extend a moderator's 15-minute window indefinitely.
      expiration: new Date(payload.createdAtMs + CONFIG.tokenTtlSeconds * 1000),
    });
  }

  return {
    async mint(payload) {
      const token = generateId();
      await write(token, payload);
      return token;
    },

    resolve: read,

    async attachChecklist(token, items) {
      const existing = await read(token);
      if (!existing) return;
      await write(token, { ...existing, checklist: [...items] });
    },

    async consume(token) {
      await redis.del(keys.token(token));
    },
  };
}

/** Narrowing helper so callers never have to hand-check the prefix. */
export function asPostId(value: string): T3 | null {
  return value.startsWith('t3_') ? (value as T3) : null;
}
