import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { CONFIG, JOBS } from '../config.js';
import { keys } from '../data/keys.js';
import { createVerificationRepo } from '../data/verificationRepo.js';
import type { ReminderService } from '../services/reminders.js';
import { createReminderService } from '../services/reminders.js';
import type { AppSettings } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit, FakeScheduler } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

type Harness = {
  service: ReminderService;
  repo: ReturnType<typeof createVerificationRepo>;
  redis: FakeRedis;
  reddit: FakeReddit;
  scheduler: FakeScheduler;
  setNow(ms: number): void;
  seed(record: Partial<VerificationRecord> & { postId: string }): Promise<void>;
};

function harness(
  settingsOverrides: Partial<AppSettings> = {},
  redditOptions: FakeRedditOptions = {},
): Harness {
  const redis = new FakeRedis();
  const reddit = new FakeReddit(redditOptions);
  const scheduler = new FakeScheduler();
  let clock = NOW;
  redis.nowMs = clock;

  const repo = createVerificationRepo(redis);
  const service = createReminderService({
    repo,
    reddit,
    scheduler,
    settings: fakeSettings(settingsOverrides),
    log: fakeLogger(),
    now: () => clock,
  });

  return {
    service,
    repo,
    redis,
    reddit,
    scheduler,
    setNow(ms) {
      clock = ms;
      redis.nowMs = ms;
    },
    async seed(partial) {
      const record: VerificationRecord = {
        schemaVersion: 2,
        authorName: 'op_user',
        modName: 'mod_one',
        verifiedAtMs: NOW - 40 * DAY,
        status: 'complete',
        note: '',
        checklist: null,
        commentId: 't1_x',
      templateLabel: null,
        deletedAtMs: null,
        reminderSentAtMs: null,
        opRespondedAtMs: null,
        escalatedAtMs: null,
        ...partial,
        postId: partial.postId as T3,
      } satisfies VerificationRecord;
      await repo.putComplete(record);
    },
  };
}

describe('sweep - reminding', () => {
  it('comments once on a fundraiser that is past the reminder window', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.reminded).toBe(1);
    expect(h.reddit.comments).toHaveLength(1);
    expect(h.reddit.lastCommentText).toContain('u/op_user');
    expect(h.reddit.lastCommentText).toContain('complete');
    expect((await h.repo.get('t3_old' as T3))?.reminderSentAtMs).toBe(NOW);
  });

  it('leaves a fundraiser that is not old enough alone', async () => {
    const h = harness();
    await h.seed({ postId: 't3_recent', verifiedAtMs: NOW - 5 * DAY });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.examined).toBe(0);
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('does not remind twice', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(h.reddit.comments).toHaveLength(1);
  });

  it('rolls back the timestamp if the comment fails, so the next sweep retries', async () => {
    const h = harness({}, { failOn: { comment: new Error('503 unavailable') } });
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.reminded).toBe(0);
    expect((await h.repo.get('t3_old' as T3))?.reminderSentAtMs).toBeNull();
  });

  it('honours custom reminder wording', async () => {
    const h = harness({
      customReminderText: 'Hi {op}, {days} days in r/{subreddit}, {grace} to go.',
      graceDays: 7,
    });
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.reddit.lastCommentText).toBe('Hi u/op_user, 40 days in r/IndianPets, 7 to go.');
  });

  it('does nothing when reminders or the app are switched off', async () => {
    const off = harness({ staleRemindersEnabled: false });
    await off.seed({ postId: 't3_old' });
    expect((await off.service.sweep({ offset: 0, batchIndex: 0 })).examined).toBe(0);

    const disabled = harness({ enabled: false });
    await disabled.seed({ postId: 't3_old' });
    expect((await disabled.service.sweep({ offset: 0, batchIndex: 0 })).examined).toBe(0);
  });
});

describe('sweep - escalation', () => {
  it('reports to the modqueue after the grace period, without removing', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + 8 * DAY);
    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.escalated).toBe(1);
    expect(h.reddit.reports).toHaveLength(1);
    expect(h.reddit.reports[0]?.reason).toContain('no update from OP');
    expect(h.reddit.locked).toHaveLength(0);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);
  });

  it('waits out the grace period before escalating', async () => {
    const h = harness({ graceDays: 7 });
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + 3 * DAY);
    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.escalated).toBe(0);
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('locks the post only when the subreddit has opted in', async () => {
    const h = harness({ lockStalePosts: true });
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + 8 * DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(h.reddit.locked).toEqual(['t3_old']);
  });

  it('closes the chase when the post has gone from Reddit', async () => {
    const h = harness({}, { post: null });
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.closed).toBe(1);
    expect(h.reddit.comments).toHaveLength(0);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);
  });

  it('closes the chase for a post that was already deleted', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old', deletedAtMs: NOW - DAY });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.closed).toBe(1);
    expect(h.reddit.comments).toHaveLength(0);
  });
});

describe('sweep - batching', () => {
  it('processes a bounded page and chains the next one', async () => {
    const h = harness();
    for (let index = 0; index < CONFIG.reminders.batchSize; index++) {
      await h.seed({ postId: `t3_p${index}`, verifiedAtMs: NOW - (50 + index) * DAY });
    }

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.examined).toBe(CONFIG.reminders.batchSize);
    expect(result.chained).toBe(true);

    const chained = h.scheduler.jobsNamed(JOBS.staleSweepBatch);
    expect(chained).toHaveLength(1);
    expect(chained[0]?.data['offset']).toBe(CONFIG.reminders.batchSize);
    expect(chained[0]?.data['batchIndex']).toBe(1);
  });

  it('does not chain when the page was not full', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.chained).toBe(false);
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('stops chaining at the configured ceiling', async () => {
    const h = harness();
    for (let index = 0; index < CONFIG.reminders.batchSize; index++) {
      await h.seed({ postId: `t3_p${index}`, verifiedAtMs: NOW - (50 + index) * DAY });
    }

    const result = await h.service.sweep({
      offset: 0,
      batchIndex: CONFIG.reminders.maxChainedBatches - 1,
    });

    expect(result.chained).toBe(false);
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('keeps going when one post in the page fails', async () => {
    // Every comment fails; the sweep must still examine the whole page rather
    // than abandoning it at the first error.
    const h = harness({}, { failOn: { comment: new Error('503 unavailable') } });
    await h.seed({ postId: 't3_a', verifiedAtMs: NOW - 50 * DAY });
    await h.seed({ postId: 't3_b', verifiedAtMs: NOW - 49 * DAY });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.examined).toBe(2);
    expect(result.reminded).toBe(0);
    // Both stay in the open index, so tomorrow's sweep retries them.
    expect(h.redis.sizeOf(keys.openIndex())).toBe(2);
  });

  it('reads the whole page with one batched call', async () => {
    const h = harness();
    await h.seed({ postId: 't3_a', verifiedAtMs: NOW - 50 * DAY });
    await h.seed({ postId: 't3_b', verifiedAtMs: NOW - 49 * DAY });

    h.redis.mGetCalls = 0;
    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.redis.mGetCalls).toBe(1);
  });
});

describe('noteOpActivity', () => {
  it('records the reply but still reports, which is the default', async () => {
    // The mod team wants eyes on every chased fundraiser, because a reply is
    // not the same as a real answer.
    const h = harness();
    await h.seed({ postId: 't3_old' });
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    h.setNow(NOW + DAY);
    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'OP_user' });

    expect((await h.repo.get('t3_old' as T3))?.opRespondedAtMs).toBe(NOW + DAY);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(1);

    h.setNow(NOW + 20 * DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.reddit.reports).toHaveLength(1);
  });

  it('stops the chase on a reply when the subreddit opts out of that', async () => {
    const h = harness({ alwaysReportStale: false });
    await h.seed({ postId: 't3_old' });
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    h.setNow(NOW + DAY);
    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'OP_user' });

    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);

    h.setNow(NOW + 20 * DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('ignores comments from anyone who is not the OP', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'someone_else' });
    expect((await h.repo.get('t3_old' as T3))?.opRespondedAtMs).toBeNull();
  });

  it('ignores a post that is not being chased yet', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'op_user' });
    expect((await h.repo.get('t3_old' as T3))?.opRespondedAtMs).toBeNull();
  });

  it('costs one Redis read for a comment on an unknown post', async () => {
    const h = harness();
    await expect(
      h.service.noteOpActivity({ postId: 't3_unknown' as T3, author: 'someone' }),
    ).resolves.toBeUndefined();
    expect(h.reddit.calls).toEqual([]);
  });
});

/**
 * The moderator-initiated follow-up.
 *
 * These tests exist because the nightly chase otherwise takes 30 days plus a
 * 7-day grace to observe even once. They pin down that the manual path does
 * exactly what the sweep does, and that it cannot be used to double-comment
 * or double-report.
 */
describe('runFollowUp', () => {
  it('asks the OP for an update however recently the post was verified', async () => {
    const h = harness();
    // One minute old: the nightly sweep would not look at this post at all.
    await h.seed({ postId: 't3_fresh', verifiedAtMs: NOW - 60_000 });

    const result = await h.service.runFollowUp({ postId: 't3_fresh' as T3, step: 'next' });

    expect(result.kind).toBe('reminded');
    expect(h.reddit.comments).toHaveLength(1);
    expect((await h.repo.get('t3_fresh' as T3))?.reminderSentAtMs).toBe(NOW);
  });

  it('posts the same reminder wording the nightly sweep posts', async () => {
    const manual = harness();
    await manual.seed({ postId: 't3_a', verifiedAtMs: NOW - 40 * DAY });
    await manual.service.runFollowUp({ postId: 't3_a' as T3, step: 'remind' });

    const swept = harness();
    await swept.seed({ postId: 't3_a', verifiedAtMs: NOW - 40 * DAY });
    await swept.service.sweep({ offset: 0, batchIndex: 0 });

    expect(manual.reddit.comments[0]).toBe(swept.reddit.comments[0]);
  });

  it('never posts a second reminder on the same post', async () => {
    const h = harness();
    await h.seed({ postId: 't3_twice', reminderSentAtMs: NOW - 2 * DAY });

    const result = await h.service.runFollowUp({ postId: 't3_twice' as T3, step: 'remind' });

    expect(result).toEqual({ kind: 'already-reminded', atMs: NOW - 2 * DAY });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('reports to the modqueue without waiting out the grace period', async () => {
    const h = harness({ lockStalePosts: false });
    // Reminded one minute ago, so the sweep would still be in its grace window.
    await h.seed({ postId: 't3_soon', reminderSentAtMs: NOW - 60_000 });

    const result = await h.service.runFollowUp({ postId: 't3_soon' as T3, step: 'escalate' });

    expect(result).toEqual({ kind: 'escalated', locked: false });
    expect(h.reddit.reports).toHaveLength(1);
    expect(h.reddit.locked).toHaveLength(0);
  });

  it('locks the post as well when the subreddit opted in', async () => {
    const h = harness({ lockStalePosts: true });
    await h.seed({ postId: 't3_lock', reminderSentAtMs: NOW - 60_000 });

    const result = await h.service.runFollowUp({ postId: 't3_lock' as T3, step: 'escalate' });

    expect(result).toEqual({ kind: 'escalated', locked: true });
    expect(h.reddit.locked).toEqual(['t3_lock']);
  });

  it('still reports when the lock fails, and says the post is not locked', async () => {
    // A failed lock must not abort the escalation: the report is already filed,
    // and throwing would leave the post in the open index to be reported a
    // second time by the next sweep.
    const h = harness({ lockStalePosts: true }, { failOn: { lock: new Error('locked down') } });
    await h.seed({ postId: 't3_nolock', reminderSentAtMs: NOW - 60_000 });

    const result = await h.service.runFollowUp({ postId: 't3_nolock' as T3, step: 'escalate' });

    expect(result).toEqual({ kind: 'escalated', locked: false });
    expect(h.reddit.reports).toHaveLength(1);
  });

  it('never reports the same post twice', async () => {
    const h = harness();
    await h.seed({
      postId: 't3_done',
      reminderSentAtMs: NOW - 10 * DAY,
      escalatedAtMs: NOW - 3 * DAY,
    });

    const result = await h.service.runFollowUp({ postId: 't3_done' as T3, step: 'escalate' });

    expect(result).toEqual({ kind: 'already-escalated', atMs: NOW - 3 * DAY });
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('rolls the report back when Reddit rejects it, so a retry is possible', async () => {
    const h = harness({}, { failOn: { report: new Error('reddit down') } });
    await h.seed({ postId: 't3_fail', reminderSentAtMs: NOW - 10 * DAY });

    const result = await h.service.runFollowUp({ postId: 't3_fail' as T3, step: 'escalate' });

    expect(result.kind).toBe('failed');
    expect((await h.repo.get('t3_fail' as T3))?.escalatedAtMs).toBeNull();
  });

  it('rolls the reminder back when the comment is rejected', async () => {
    const h = harness({}, { failOn: { comment: new Error('rate limited') } });
    await h.seed({ postId: 't3_cfail' });

    const result = await h.service.runFollowUp({ postId: 't3_cfail' as T3, step: 'remind' });

    expect(result.kind).toBe('failed');
    expect((await h.repo.get('t3_cfail' as T3))?.reminderSentAtMs).toBeNull();
  });

  it('picks the reminder first and the report second when told to decide', async () => {
    const h = harness();
    await h.seed({ postId: 't3_seq' });

    expect((await h.service.runFollowUp({ postId: 't3_seq' as T3, step: 'next' })).kind).toBe(
      'reminded',
    );
    expect((await h.service.runFollowUp({ postId: 't3_seq' as T3, step: 'next' })).kind).toBe(
      'escalated',
    );
    expect(h.reddit.comments).toHaveLength(1);
    expect(h.reddit.reports).toHaveLength(1);
  });

  it('works even when the nightly check is switched off', async () => {
    // This is how a moderator tries the feature out before enabling it.
    const h = harness({ staleRemindersEnabled: false });
    await h.seed({ postId: 't3_off' });

    expect((await h.service.runFollowUp({ postId: 't3_off' as T3, step: 'remind' })).kind).toBe(
      'reminded',
    );
  });

  it('refuses when the app itself is switched off', async () => {
    const h = harness({ enabled: false });
    await h.seed({ postId: 't3_master' });

    expect(await h.service.runFollowUp({ postId: 't3_master' as T3, step: 'remind' })).toEqual({
      kind: 'disabled',
    });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('declines a post the app has never verified', async () => {
    const h = harness();

    expect(await h.service.runFollowUp({ postId: 't3_unknown' as T3, step: 'next' })).toEqual({
      kind: 'no-record',
    });
  });

  it('declines a post that has been deleted', async () => {
    const h = harness();
    await h.seed({ postId: 't3_gone', deletedAtMs: NOW - DAY });

    expect(await h.service.runFollowUp({ postId: 't3_gone' as T3, step: 'next' })).toEqual({
      kind: 'deleted',
    });
  });

  it('reports the post as missing when it is gone from Reddit', async () => {
    const h = harness({}, { post: null });
    await h.seed({ postId: 't3_404' });

    expect(await h.service.runFollowUp({ postId: 't3_404' as T3, step: 'remind' })).toEqual({
      kind: 'post-missing',
    });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('refuses a second concurrent run on the same post', async () => {
    // The lock is what stops two taps on a phone posting two reminders.
    const h = harness();
    await h.seed({ postId: 't3_busy' });
    await h.repo.acquireLock('t3_busy' as T3, 'someone-else', NOW);

    expect(await h.service.runFollowUp({ postId: 't3_busy' as T3, step: 'remind' })).toEqual({
      kind: 'busy',
    });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('releases the lock afterwards so a later run is not blocked', async () => {
    const h = harness();
    await h.seed({ postId: 't3_rel' });

    await h.service.runFollowUp({ postId: 't3_rel' as T3, step: 'remind' });

    expect(await h.repo.acquireLock('t3_rel' as T3, 'next-run', NOW)).toBe(true);
  });
});

describe('inspectFollowUp', () => {
  it('reports the reminder as the next step before one has been sent', async () => {
    const h = harness();
    await h.seed({ postId: 't3_i1', verifiedAtMs: NOW - 12 * DAY });

    const state = await h.service.inspectFollowUp('t3_i1' as T3);

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.nextStep).toBe('remind');
    expect(state.daysSinceVerified).toBe(12);
    expect(state.daysSinceReminder).toBeNull();
  });

  it('reports the report as the next step once the OP has been asked', async () => {
    const h = harness();
    await h.seed({
      postId: 't3_i2',
      verifiedAtMs: NOW - 40 * DAY,
      reminderSentAtMs: NOW - 5 * DAY,
    });

    const state = await h.service.inspectFollowUp('t3_i2' as T3);

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.nextStep).toBe('escalate');
    expect(state.daysSinceReminder).toBe(5);
  });

  it('writes nothing and calls Reddit not at all', async () => {
    const h = harness();
    await h.seed({ postId: 't3_i3' });

    await h.service.inspectFollowUp('t3_i3' as T3);

    expect(h.reddit.comments).toHaveLength(0);
    expect(h.reddit.reports).toHaveLength(0);
  });
});

describe('pinning the reminder', () => {
  it('pins and distinguishes the reminder, like the verification notice', async () => {
    const h = harness();
    await h.seed({ postId: 't3_pin' });

    await h.service.runFollowUp({ postId: 't3_pin' as T3, step: 'remind' });

    expect(h.reddit.calls).toContain('distinguish');
  });

  it('keeps the reminder when it cannot be pinned, and does not roll it back', async () => {
    // Reddit allows only two stickied comments per post, so a failed pin is a
    // normal outcome. Rolling back would make the next sweep comment again.
    const h = harness({}, { failOn: { distinguish: new Error('too many stickies') } });
    await h.seed({ postId: 't3_nopin' });

    const result = await h.service.runFollowUp({ postId: 't3_nopin' as T3, step: 'remind' });

    expect(result.kind).toBe('reminded');
    expect(h.reddit.comments).toHaveLength(1);
    expect((await h.repo.get('t3_nopin' as T3))?.reminderSentAtMs).toBe(NOW);
  });

  it('pins reminders sent by the nightly sweep too', async () => {
    const h = harness();
    await h.seed({ postId: 't3_swept', verifiedAtMs: NOW - 40 * DAY });

    await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(h.reddit.calls).toContain('distinguish');
  });
});
