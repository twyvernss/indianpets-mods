import type { T3 } from '@devvit/web/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../config.js';
import { keys } from '../data/keys.js';
import { createTokenRepo } from '../data/tokenRepo.js';
import { createVerificationRepo } from '../data/verificationRepo.js';
import { createModeratorGate } from '../services/moderator.js';
import type { VerificationService } from '../services/verification.js';
import { createVerificationService } from '../services/verification.js';
import type { AppSettings } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const POST_ID = 't3_abc123' as T3;
const NOW = 1_700_000_000_000;

type Harness = {
  service: VerificationService;
  redis: FakeRedis;
  reddit: FakeReddit;
  repo: ReturnType<typeof createVerificationRepo>;
  tokens: ReturnType<typeof createTokenRepo>;
  setNow(ms: number): void;
};

function harness(
  redditOptions: FakeRedditOptions = {},
  settingsOverrides: Partial<AppSettings> = {},
): Harness {
  const redis = new FakeRedis();
  const reddit = new FakeReddit(redditOptions);
  const log = fakeLogger();

  let clock = NOW;
  redis.nowMs = clock;

  const repo = createVerificationRepo(redis);
  let tokenCounter = 0;
  const tokens = createTokenRepo(redis, () => `token-${++tokenCounter}`);
  const gate = createModeratorGate(reddit, redis, log, () => clock);

  const service = createVerificationService({
    repo,
    tokens,
    reddit,
    gate,
    settings: fakeSettings(settingsOverrides),
    log,
    now: () => clock,
    newId: () => `lock-${clock}`,
  });

  return {
    service,
    redis,
    reddit,
    repo,
    tokens,
    setNow(ms: number) {
      clock = ms;
      redis.nowMs = ms;
    },
  };
}

async function tokenFor(h: Harness): Promise<string> {
  const outcome = await h.service.begin(POST_ID);
  if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.kind}`);
  // `begin` may read the post and author to build the moderator context line.
  // Clear the log so call-ordering assertions describe the verify action alone.
  h.reddit.calls.length = 0;
  return outcome.token;
}

/** A complete record, for seeding the fake store directly. */
function recordFixture(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    schemaVersion: 2,
    postId: POST_ID,
    authorName: 'op_user',
    modName: 'mod_one',
    verifiedAtMs: NOW,
    status: 'complete',
    note: '',
    checklist: null,
    commentId: 't1_x',
    deletedAtMs: null,
    reminderSentAtMs: null,
    opRespondedAtMs: null,
    escalatedAtMs: null,
    ...overrides,
  };
}

describe('begin', () => {
  it('rejects a target that is not a post', async () => {
    const h = harness();
    await expect(h.service.begin('t1_comment')).resolves.toEqual({ kind: 'not-a-post' });
  });

  it('rejects a non-moderator', async () => {
    const h = harness({ currentUser: 'random_user', moderators: ['mod_one'] });
    await expect(h.service.begin(POST_ID)).resolves.toEqual({ kind: 'not-moderator' });
  });

  it('refuses to start when the master switch is off', async () => {
    const h = harness({}, { enabled: false });
    await expect(h.service.begin(POST_ID)).resolves.toEqual({ kind: 'disabled' });
  });

  it('makes no Reddit write calls', async () => {
    const h = harness();
    const outcome = await h.service.begin(POST_ID);
    expect(outcome.kind).toBe('ready');
    expect(h.reddit.calls).not.toContain('approve');
    expect(h.reddit.calls).not.toContain('comment');
    expect(h.reddit.calls).not.toContain('modNote');
  });

  it('builds the moderator context line from the author and the automod hold', async () => {
    const h = harness({ author: { username: 'op_user', accountAgeDays: 400, karma: 5200 } });
    await h.repo.recordAutomodHold(POST_ID, NOW - 3_600_000, NOW);

    const outcome = await h.service.begin(POST_ID);
    if (outcome.kind !== 'ready') throw new Error('expected ready');

    expect(outcome.authorSummary).toContain('u/op_user');
    expect(outcome.authorSummary).toContain('1y');
    expect(outcome.authorSummary).toContain('5.2k karma');
    expect(outcome.authorSummary).toContain('held');
  });

  it('omits the context line when the setting is off, and skips the lookups', async () => {
    const h = harness({}, { showAuthorSummary: false });

    const outcome = await h.service.begin(POST_ID);
    if (outcome.kind !== 'ready') throw new Error('expected ready');

    expect(outcome.authorSummary).toBeNull();
    expect(h.reddit.calls).not.toContain('getAuthor');
  });

  it('still opens the form when the author lookup fails', async () => {
    const h = harness({ author: null });

    const outcome = await h.service.begin(POST_ID);
    expect(outcome.kind).toBe('ready');
    if (outcome.kind === 'ready') expect(outcome.authorSummary).toBeNull();
  });

  it('refuses a post that is already verified', async () => {
    const h = harness();
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect((await h.service.begin(POST_ID)).kind).toBe('already-verified');
  });
});

describe('complete - happy path', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('approves, comments, then distinguishes - in that order', async () => {
    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: 'called the clinic',
      checklistAnswers: null,
    });

    expect(outcome.kind).toBe('ok');
    // approve and comment are issued together; distinguish must come after the
    // comment exists, so it is always last.
    expect(h.reddit.calls).toEqual(['getPost', 'approve', 'comment', 'distinguish', 'modNote']);
  });

  it('stores a complete record and indexes it in both sorted sets', async () => {
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: 'called the clinic',
      checklistAnswers: null,
    });

    expect(await h.repo.get(POST_ID)).toMatchObject({
      schemaVersion: 2,
      status: 'complete',
      modName: 'mod_one',
      authorName: 'op_user',
      note: 'called the clinic',
      checklist: null,
      commentId: 't1_fake',
      reminderSentAtMs: null,
    });
    expect(h.redis.sizeOf(keys.verifiedIndex())).toBe(1);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(1);
  });

  it('keeps the moderator out of the public comment by default', async () => {
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    expect(h.reddit.lastCommentText).not.toContain('mod_one');
    expect(h.reddit.lastCommentText).toContain('not a guarantee');
  });

  it('never exceeds the 250 character mod note limit', async () => {
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: 'x'.repeat(CONFIG.noteMaxLength),
      checklistAnswers: null,
    });
    expect(h.reddit.lastModNote?.note.length ?? 0).toBeLessThanOrEqual(CONFIG.modNoteMaxLength);
  });
});

describe('checklist', () => {
  it('stores the labels that were shown, not just the answers', async () => {
    const h = harness();
    const token = await tokenFor(h);

    const opened = await h.service.openChecklist({ token, contextPostId: null });
    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;

    await h.service.complete({
      token: opened.token,
      contextPostId: null,
      note: '',
      checklistAnswers: { [opened.items[0]?.id ?? 'item0']: true, item2: true },
    });

    const record = await h.repo.get(POST_ID);
    expect(record?.checklist).toHaveLength(opened.items.length);
    expect(record?.checklist?.[0]).toEqual({ label: opened.items[0]?.label, checked: true });
    expect(record?.checklist?.[1]?.checked).toBe(false);
    expect(record?.checklist?.[2]?.checked).toBe(true);
  });

  it('uses the subreddit-configured items rather than a hard-coded list', async () => {
    const h = harness({}, {
      checklistItems: [
        { id: 'item0', label: 'Bill matches' },
        { id: 'item1', label: 'Clinic called' },
      ],
    });

    const opened = await h.service.openChecklist({
      token: await tokenFor(h),
      contextPostId: null,
    });
    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;
    expect(opened.items.map((item) => item.label)).toEqual(['Bill matches', 'Clinic called']);

    await h.service.complete({
      token: opened.token,
      contextPostId: null,
      note: '',
      checklistAnswers: { item1: true },
    });

    expect(await h.repo.get(POST_ID).then((r) => r?.checklist)).toEqual([
      { label: 'Bill matches', checked: false },
      { label: 'Clinic called', checked: true },
    ]);
    expect(h.reddit.lastModNote?.note).toContain('Checklist 1/2.');
  });

  it('refuses to open the checklist for a non-moderator', async () => {
    const h = harness({ currentUser: 'random_user', moderators: ['mod_one'] });
    await expect(
      h.service.openChecklist({ token: null, contextPostId: POST_ID }),
    ).resolves.toEqual({ kind: 'not-moderator' });
  });
});

describe('complete - idempotency', () => {
  it('does not comment twice when the action is run again', async () => {
    const h = harness();

    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    const firstCount = h.reddit.calls.filter((call) => call === 'comment').length;

    const second = await h.service.complete({
      token: null,
      contextPostId: POST_ID,
      note: '',
      checklistAnswers: null,
    });

    expect(second.kind).toBe('already-verified');
    expect(h.reddit.calls.filter((call) => call === 'comment')).toHaveLength(firstCount);
  });

  it('reports in-progress while another run holds the lock', async () => {
    const h = harness();
    await h.repo.acquireLock(POST_ID, 'someone-else', NOW);

    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome).toEqual({ kind: 'in-progress' });
    expect(h.reddit.calls).not.toContain('comment');
  });

  it('lets a crashed pending record be retried once it goes stale', async () => {
    const h = harness();
    await h.repo.putProvisional(recordFixture({ status: 'pending', commentId: null }));

    const blocked = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    expect(blocked).toEqual({ kind: 'in-progress' });

    h.setNow(NOW + CONFIG.pendingStaleMs + 1);
    const retried = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    expect(retried.kind).toBe('ok');
  });
});

describe('complete - authorisation', () => {
  it('rejects an expired or unknown token without falling back', async () => {
    const h = harness();
    const outcome = await h.service.complete({
      token: 'token-does-not-exist',
      contextPostId: POST_ID,
      note: '',
      checklistAnswers: null,
    });
    expect(outcome).toEqual({ kind: 'expired' });
    expect(h.reddit.calls).not.toContain('comment');
  });

  it('rejects a token minted for a different moderator', async () => {
    const h = harness({ currentUser: 'mod_two' });
    await h.tokens.mint({ postId: POST_ID, modName: 'mod_one', createdAtMs: NOW, checklist: null });

    await expect(
      h.service.complete({ token: 'token-1', contextPostId: null, note: '', checklistAnswers: null }),
    ).resolves.toEqual({ kind: 'not-moderator' });
  });

  it('rejects a user who lost moderator status between the form and the submit', async () => {
    const h = harness({ currentUser: 'mod_one', moderators: [] });
    await h.tokens.mint({ postId: POST_ID, modName: 'mod_one', createdAtMs: NOW, checklist: null });

    const outcome = await h.service.complete({
      token: 'token-1',
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    expect(outcome).toEqual({ kind: 'not-moderator' });
    expect(h.reddit.calls).not.toContain('comment');
  });

  it('expires when neither a token nor a platform post id is available', async () => {
    const h = harness();
    await expect(
      h.service.complete({ token: null, contextPostId: null, note: '', checklistAnswers: null }),
    ).resolves.toEqual({ kind: 'expired' });
  });

  it('refuses to act while the master switch is off', async () => {
    const h = harness({}, { enabled: false });
    await h.tokens.mint({ postId: POST_ID, modName: 'mod_one', createdAtMs: NOW, checklist: null });

    const outcome = await h.service.complete({
      token: 'token-1',
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    expect(outcome.kind).toBe('failed');
    expect(h.reddit.calls).not.toContain('comment');
  });
});

describe('complete - failure handling', () => {
  it('skips the approve call when the post is already approved', async () => {
    const h = harness({
      post: { id: POST_ID, authorName: 'op_user', isApproved: true, isRemoved: false },
    });

    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(h.reddit.calls).not.toContain('approve');
    expect(h.reddit.calls).toContain('comment');
  });

  it('reports a missing post without writing anything', async () => {
    const h = harness({ post: null });
    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome).toEqual({ kind: 'post-missing' });
    expect(await h.repo.get(POST_ID)).toBeNull();
  });

  it('rolls back the record and names the approved-but-not-commented state', async () => {
    const h = harness({ failOn: { comment: new Error('THREAD_LOCKED') } });

    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.detail).toContain('approved');
      expect(outcome.detail).toContain('again');
    }
    expect(await h.repo.get(POST_ID)).toBeNull();
  });

  it('keeps a successful comment when distinguishing fails, and says so', async () => {
    const h = harness({ failOn: { distinguish: new Error('FORBIDDEN') } });

    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind === 'partial') expect(outcome.detail).toContain('pinned');
    expect((await h.repo.get(POST_ID))?.status).toBe('complete');
  });

  it('reports a failed approve but still records the verification', async () => {
    const h = harness({ failOn: { approve: new Error('FORBIDDEN') } });

    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind === 'partial') expect(outcome.detail).toContain('approve');
    expect((await h.repo.get(POST_ID))?.status).toBe('complete');
  });

  it('surfaces a failed mod note instead of swallowing it', async () => {
    const h = harness({ failOn: { modNote: new Error('USER_DOESNT_EXIST') } });

    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind === 'partial') expect(outcome.detail).toContain('mod note');
  });

  it('skips the mod note entirely when the author account is deleted', async () => {
    const h = harness({
      post: { id: POST_ID, authorName: null, isApproved: false, isRemoved: true },
    });

    const outcome = await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });

    expect(outcome.kind).toBe('ok');
    expect(h.reddit.calls).not.toContain('modNote');
    expect((await h.repo.get(POST_ID))?.authorName).toBeNull();
  });

  it('honours the setting that disables mod notes', async () => {
    const h = harness({}, { addModNote: false });
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: '',
      checklistAnswers: null,
    });
    expect(h.reddit.calls).not.toContain('modNote');
  });
});

describe('status', () => {
  it('reports a verified post', async () => {
    const h = harness();
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: 'note',
      checklistAnswers: null,
    });
    expect((await h.service.status(POST_ID)).kind).toBe('verified');
  });

  it('reports an automod hold when the post is not verified yet', async () => {
    const h = harness();
    await h.repo.recordAutomodHold(POST_ID, NOW - 3_600_000, NOW);

    await expect(h.service.status(POST_ID)).resolves.toEqual({
      kind: 'held-by-automod',
      heldAtMs: NOW - 3_600_000,
    });
  });

  it('reports nothing for an untouched post', async () => {
    const h = harness();
    await expect(h.service.status(POST_ID)).resolves.toEqual({ kind: 'none' });
  });
});

describe('deletion handling', () => {
  it('scrubs user content but keeps the row so re-verification is still blocked', async () => {
    const h = harness();
    await h.service.complete({
      token: await tokenFor(h),
      contextPostId: null,
      note: 'clinic phone number redacted',
      checklistAnswers: null,
    });

    await h.repo.markDeleted(POST_ID, NOW + 1000);

    const record = await h.repo.get(POST_ID);
    expect(record?.authorName).toBeNull();
    expect(record?.note).toBe('');
    expect(record?.checklist).toBeNull();
    expect(record?.status).toBe('complete');
    expect(record?.deletedAtMs).toBe(NOW + 1000);

    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);
    expect(h.redis.sizeOf(keys.verifiedIndex())).toBe(1);

    const retry = await h.service.complete({
      token: null,
      contextPostId: POST_ID,
      note: '',
      checklistAnswers: null,
    });
    expect(retry.kind).toBe('already-verified');
  });

  it('tolerates a delete event for a post it never verified', async () => {
    const h = harness();
    await expect(h.repo.markDeleted(POST_ID, NOW)).resolves.toBeUndefined();
  });
});

describe('storage', () => {
  it('reads many records with a single mGet rather than one call per id', async () => {
    const h = harness();
    const ids = ['t3_a', 't3_b', 't3_c'] as T3[];

    for (const postId of ids) {
      await h.repo.putProvisional(recordFixture({ postId }));
    }

    h.redis.mGetCalls = 0;
    const records = await h.repo.getMany(ids);

    expect(records).toHaveLength(3);
    expect(h.redis.mGetCalls).toBe(1);
  });

  it('ignores malformed rows instead of throwing', async () => {
    const h = harness();
    await h.redis.set(keys.record(POST_ID), '{not json');
    await expect(h.repo.get(POST_ID)).resolves.toBeNull();
  });

  it('upgrades a v1 row so an already-verified post is still recognised', async () => {
    const h = harness();
    // Exactly what v1 wrote, including its fixed-key checklist object.
    await h.redis.set(
      keys.record(POST_ID),
      JSON.stringify({
        schemaVersion: 1,
        postId: POST_ID,
        authorName: 'op_user',
        modName: 'mod_one',
        verifiedAtMs: NOW,
        status: 'complete',
        note: 'legacy note',
        checklist: { billInOpName: true, clinicContacted: false },
        commentId: 't1_old',
        deletedAtMs: null,
      }),
    );

    const record = await h.repo.get(POST_ID);
    expect(record?.schemaVersion).toBe(2);
    expect(record?.checklist?.[0]).toEqual({
      label: "Vet bill is in the OP's name and the pet matches the photos",
      checked: true,
    });
    expect(record?.checklist?.[1]?.checked).toBe(false);
    expect(record?.reminderSentAtMs).toBeNull();

    // And the whole point: it still blocks a second verification comment.
    const retry = await h.service.complete({
      token: null,
      contextPostId: POST_ID,
      note: '',
      checklistAnswers: null,
    });
    expect(retry.kind).toBe('already-verified');
  });
});
