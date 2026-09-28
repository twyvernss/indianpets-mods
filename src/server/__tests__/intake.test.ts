import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { JOBS } from '../config.js';
import { keys } from '../data/keys.js';
import type { IntakeService } from '../services/intake.js';
import { createIntakeService } from '../services/intake.js';
import type { AppSettings } from '../settings.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit, FakeScheduler } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const POST_ID = 't3_held' as T3;
const NOW = 1_700_000_000_000;

type Harness = {
  service: IntakeService;
  redis: FakeRedis;
  reddit: FakeReddit;
  scheduler: FakeScheduler;
};

function harness(
  settingsOverrides: Partial<AppSettings> = {},
  redditOptions: FakeRedditOptions = {},
): Harness {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit(redditOptions);
  const scheduler = new FakeScheduler();

  let claimCounter = 0;
  const service = createIntakeService({
    redis,
    reddit,
    scheduler,
    newId: () => `claim-${++claimCounter}`,
    // The reply is off by default, so most tests opt in explicitly.
    settings: fakeSettings({ automodReplyEnabled: true, ...settingsOverrides }),
    log: fakeLogger(),
    now: () => NOW,
  });

  return { service, redis, reddit, scheduler };
}

describe('onAutomodHold', () => {
  it('records when the post was held', async () => {
    const h = harness();
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW - 5000 });

    expect(await h.redis.get(keys.automodHold(POST_ID))).toBe(String(NOW - 5000));
  });

  it('records the hold even when replies are switched off', async () => {
    const h = harness({ automodReplyEnabled: false });
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });

    expect(await h.redis.get(keys.automodHold(POST_ID))).toBe(String(NOW));
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('queues the reply instead of posting it on the trigger', async () => {
    const h = harness();
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });

    expect(h.scheduler.jobsNamed(JOBS.automodReply)).toHaveLength(1);
    // No Reddit calls at all on the trigger path.
    expect(h.reddit.calls).toEqual([]);
  });

  it('queues only once when the trigger is redelivered', async () => {
    const h = harness();
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });

    expect(h.scheduler.jobsNamed(JOBS.automodReply)).toHaveLength(1);
  });

  it('releases the claim when queueing fails, so a redelivery can retry', async () => {
    const h = harness();
    h.scheduler.failure = new Error('scheduler unavailable');

    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });
    expect(await h.redis.get(keys.automodReplied(POST_ID))).toBeUndefined();

    h.scheduler.failure = null;
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });
    expect(h.scheduler.jobsNamed(JOBS.automodReply)).toHaveLength(1);
  });

  it('does nothing extra when the app is switched off', async () => {
    const h = harness({ enabled: false });
    await h.service.onAutomodHold({ postId: POST_ID, author: null, heldAtMs: NOW });
    expect(h.scheduler.jobs).toHaveLength(0);
  });
});

describe('postReply', () => {
  it('posts the intake comment and distinguishes it', async () => {
    const h = harness();
    await h.service.postReply({ postId: POST_ID, author: 'op_user' });

    expect(h.reddit.comments).toHaveLength(1);
    expect(h.reddit.lastCommentText).toContain('u/op_user');
    expect(h.reddit.lastCommentText).toContain('modmail');
    expect(h.reddit.calls).toContain('distinguish');
  });

  it('tells the OP not to post documents publicly', async () => {
    const h = harness();
    await h.service.postReply({ postId: POST_ID, author: 'op_user' });
    expect(h.reddit.lastCommentText).toContain('do not** post these documents publicly');
  });

  it('falls back to the post author when the trigger had no username', async () => {
    const h = harness();
    await h.service.postReply({ postId: POST_ID, author: null });
    // FakeReddit's default post is authored by op_user.
    expect(h.reddit.lastCommentText).toContain('u/op_user');
  });

  it('stays silent on a post a moderator has already approved', async () => {
    const h = harness({}, {
      post: { id: POST_ID, authorName: 'op_user', isApproved: true, isRemoved: false },
    });
    await h.service.postReply({ postId: POST_ID, author: 'op_user' });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('stays silent when the post has gone', async () => {
    const h = harness({}, { post: null });
    await h.service.postReply({ postId: POST_ID, author: 'op_user' });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('re-checks the setting, in case it was switched off after queueing', async () => {
    const h = harness({ automodReplyEnabled: false });
    await h.service.postReply({ postId: POST_ID, author: 'op_user' });
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('honours custom intake wording', async () => {
    const h = harness({ automodReplyText: '{op}, send docs to r/{subreddit} modmail.' });
    await h.service.postReply({ postId: POST_ID, author: 'op_user' });
    expect(h.reddit.lastCommentText).toBe('u/op_user, send docs to r/IndianPets modmail.');
  });

  it('still counts as posted when distinguishing fails', async () => {
    const h = harness({}, { failOn: { distinguish: new Error('FORBIDDEN') } });
    await expect(h.service.postReply({ postId: POST_ID, author: 'op_user' })).resolves.toBeUndefined();
    expect(h.reddit.comments).toHaveLength(1);
  });
});
