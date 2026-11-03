import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { fundraiserSignals } from '../lib/fundraiserSignals.js';
import { createFlairCheckService } from '../services/flairCheck.js';
import type { PostContent } from '../services/redditPort.js';
import type { AppSettings } from '../settings.js';
import { buildMisflairReason } from '../text.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit } from './fakes.js';

const NOW = 1_700_000_000_000;

function text(title: string, body = '', url = ''): { title: string; body: string; url: string } {
  return { title, body, url };
}

describe('fundraiser signals', () => {
  it('treats a fundraising platform link as enough on its own', () => {
    const signals = fundraiserSignals(text('Update on Bruno', 'https://www.ketto.org/fundraiser/help-bruno'));
    expect(signals).toEqual({ likely: true, reasons: ['Ketto link'] });
  });

  it('treats a UPI ID or a labelled bank account as enough on its own', () => {
    expect(fundraiserSignals(text('Bruno', 'send to bruno.help@okaxis')).reasons).toContain('UPI ID');
    expect(fundraiserSignals(text('Bruno', 'A/c no 123456789012')).reasons).toContain('bank account');
  });

  it('needs two different money words when there is no link or payment detail', () => {
    expect(fundraiserSignals(text('Please donate', 'the vet bill is huge')).likely).toBe(true);
    expect(fundraiserSignals(text('Kindly help', 'GPay me any amount')).likely).toBe(true);
    // One word alone is ordinary conversation.
    expect(fundraiserSignals(text('Where can I donate old food bowls?')).likely).toBe(false);
  });

  it('counts one word family once, so "donate, donation, donors" is still one signal', () => {
    expect(fundraiserSignals(text('Donate', 'donation from donors')).likely).toBe(false);
  });

  it('leaves ordinary posts alone, including ones with a clinic phone number', () => {
    expect(fundraiserSignals(text('My cat sleeping', 'Look at her!')).likely).toBe(false);
    expect(fundraiserSignals(text('Good vet in Pune?', 'Dr Rao, call 9876543210')).likely).toBe(false);
    expect(fundraiserSignals(text('Adopt Kalu', 'https://imgur.com/abc')).likely).toBe(false);
  });

  it('does not count a word that only appears inside a link', () => {
    expect(fundraiserSignals(text('Look', 'https://example.org/donate-fundraiser-page')).likely).toBe(false);
  });
});

describe('misflair report reason', () => {
  it('names the flair and the reasons, within the report length limit', () => {
    const reason = buildMisflairReason('Discussion', ['Ketto link', '"donate"']);
    expect(reason).toBe('Looks like a fundraiser but has "Discussion": Ketto link, "donate"');
    expect(buildMisflairReason(null, ['UPI ID'])).toContain('no flair');
    expect(buildMisflairReason('x', Array(40).fill('"donate"')).length).toBeLessThanOrEqual(100);
  });
});

function post(body: string): PostContent {
  return { id: 't3_new' as T3, authorName: 'someone', title: 'Please help', body, url: '', createdAtMs: NOW };
}

function harness(flair: string | null, overrides: Partial<AppSettings> = { fundraiserFlairText: 'Fundraiser' }) {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit({
    post: { id: 't3_new' as T3, authorName: 'someone', isApproved: true, isRemoved: false, flairText: flair },
  });
  const service = createFlairCheckService({
    reddit,
    redis,
    settings: fakeSettings(overrides),
    log: fakeLogger(),
    now: () => NOW,
  });
  return { reddit, service };
}

describe('flair check', () => {
  it('reports a fundraiser posted under another flair, and never removes it', async () => {
    const h = harness('Discussion');
    await expect(h.service.check(post('UPI bruno.help@okaxis'))).resolves.toBe('reported');
    expect(h.reddit.reports[0]?.reason).toContain('"Discussion"');
    expect(h.reddit.calls).not.toContain('remove');
  });

  it('leaves a properly flaired fundraiser to the other checks', async () => {
    const h = harness('Fundraiser');
    await expect(h.service.check(post('UPI bruno.help@okaxis'))).resolves.toBe('flaired');
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('costs no Reddit call for an ordinary post', async () => {
    const h = harness('Discussion');
    await expect(h.service.check(post('my cat is asleep'))).resolves.toBe('not-a-fundraiser');
    expect(h.reddit.calls).toHaveLength(0);
  });

  it('reports a post only once', async () => {
    const h = harness('Discussion');
    await h.service.check(post('UPI bruno.help@okaxis'));
    await expect(h.service.check(post('UPI bruno.help@okaxis'))).resolves.toBe('already-reported');
    expect(h.reddit.reports).toHaveLength(1);
  });

  it('does nothing until a fundraiser flair is chosen, or when switched off', async () => {
    await expect(harness('Discussion', { fundraiserFlairText: '' }).service.check(post('UPI a.b@okaxis'))).resolves.toBe(
      'off',
    );
    await expect(
      harness('Discussion', { fundraiserFlairText: 'Fundraiser', reportMisflairedFundraisers: false }).service.check(
        post('UPI a.b@okaxis'),
      ),
    ).resolves.toBe('off');
  });
});
