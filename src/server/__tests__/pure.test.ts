import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config.js';
import { sanitizeText, toBoolean, toNonEmptyString } from '../lib/sanitize.js';
import { daysBetween, formatDisplayDate } from '../lib/time.js';
import { isTransientError, withRetry } from '../lib/retry.js';
import { createSettingsReader, DEFAULT_SETTINGS, parseChecklistItems, parseSettings } from '../settings.js';
import { buildModNote, buildVerificationComment } from '../text.js';
import { fakeLogger, FakeConfigRepo } from './fakes.js';

describe('sanitizeText', () => {
  it('rejects non-strings', () => {
    expect(sanitizeText(undefined, 50)).toBe('');
    expect(sanitizeText(42, 50)).toBe('');
    expect(sanitizeText({ note: 'x' }, 50)).toBe('');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeText('  called   the\n\nclinic  ', 50)).toBe('called the clinic');
  });

  it('strips zero-width and BiDi override characters', () => {
    const hostile = `bill​ok‮reversed`;
    const cleaned = sanitizeText(hostile, 100);
    expect(cleaned).not.toContain('​');
    expect(cleaned).not.toContain('‮');
  });

  it('never exceeds the cap, including the ellipsis', () => {
    const cleaned = sanitizeText('a'.repeat(400), 20);
    expect(cleaned.length).toBeLessThanOrEqual(20);
    expect(cleaned.endsWith('…')).toBe(true);
  });

  it('leaves a value at exactly the cap untouched', () => {
    const exact = 'b'.repeat(20);
    expect(sanitizeText(exact, 20)).toBe(exact);
  });
});

describe('toBoolean / toNonEmptyString', () => {
  it('only treats real booleans and the string "true" as true', () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean('true')).toBe(true);
    expect(toBoolean('yes')).toBe(false);
    expect(toBoolean(1)).toBe(false);
    expect(toBoolean(undefined)).toBe(false);
  });

  it('rejects blank and oversized strings', () => {
    expect(toNonEmptyString('  ')).toBeNull();
    expect(toNonEmptyString('x'.repeat(500))).toBeNull();
    expect(toNonEmptyString(' abc ')).toBe('abc');
  });
});

describe('formatDisplayDate', () => {
  it('renders IST correctly, including the half-hour offset', () => {
    // 2026-09-28T08:35:00Z is 14:05 IST on the same day.
    const utc = Date.UTC(2026, 8, 28, 8, 35, 0);
    expect(formatDisplayDate(utc, 330, 'IST')).toBe('28 Sep 2026, 14:05 IST');
  });

  it('rolls over the date when the offset crosses midnight', () => {
    const utc = Date.UTC(2026, 8, 28, 20, 0, 0); // 01:30 IST on the 29th
    expect(formatDisplayDate(utc, 330, 'IST')).toBe('29 Sep 2026, 01:30 IST');
  });
});

describe('daysBetween', () => {
  it('floors and never goes negative', () => {
    const day = 86_400_000;
    expect(daysBetween(0, day * 3 + 1000)).toBe(3);
    expect(daysBetween(day * 5, day)).toBe(0);
  });
});

describe('isTransientError', () => {
  it('recognises rate limits and gateway failures', () => {
    expect(isTransientError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isTransientError(new Error('upstream 503 unavailable'))).toBe(true);
    expect(isTransientError(new Error('context deadline exceeded'))).toBe(true);
  });

  it('treats unrecognised failures as permanent so writes are not repeated', () => {
    expect(isTransientError(new Error('SUBREDDIT_NOEXIST'))).toBe(false);
    expect(isTransientError(new Error('post already approved'))).toBe(false);
  });
});

describe('withRetry', () => {
  const env = { now: () => 0, sleep: async () => {}, random: () => 1 };
  const options = { attempts: 3, baseDelayMs: 10, maxDelayMs: 50, budgetMs: 10_000 };

  it('retries a transient failure and then succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('503 unavailable'))
      .mockResolvedValue('done');

    await expect(withRetry(operation, options, fakeLogger(), 'test', env)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('THREAD_LOCKED'));

    await expect(withRetry(operation, options, fakeLogger(), 'test', env)).rejects.toThrow('THREAD_LOCKED');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops once the time budget would be crossed', async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('timeout'));
    const tight = { ...options, budgetMs: 1 };

    await expect(withRetry(operation, tight, fakeLogger(), 'test', env)).rejects.toThrow('timeout');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('settings', () => {
  it('falls back to defaults for missing or wrongly typed values', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ addModNote: 'yes', customNoticeText: 7 })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ showVerifyingModInComment: true }).showVerifyingModInComment).toBe(true);
  });

  it('caches reads for the configured window and refreshes after it', async () => {
    let clock = 0;
    const getAll = vi.fn(async () => ({ addModNote: false }));
    const reader = createSettingsReader({ getAll }, new FakeConfigRepo(), () => clock, 1000);

    await reader.get();
    await reader.get();
    expect(getAll).toHaveBeenCalledTimes(1);

    clock += 1001;
    await reader.get();
    expect(getAll).toHaveBeenCalledTimes(2);
  });

  it('returns defaults rather than throwing when settings cannot be read', async () => {
    const reader = createSettingsReader(
      {
        getAll: async () => {
          throw new Error('settings unavailable');
        },
      },
      new FakeConfigRepo(),
    );
    await expect(reader.get()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('public comment wording', () => {
  const base = { subredditName: 'IndianPets', dateLabel: '28 Sep 2026, 14:05 IST', customText: '' };

  it('never claims a guarantee and always tells people to use discretion', () => {
    const comment = buildVerificationComment({ ...base, modName: null });
    expect(comment).toContain('not a guarantee');
    expect(comment).toContain('at your own discretion');
  });

  it('does not name the moderator by default', () => {
    const comment = buildVerificationComment({ ...base, modName: null });
    expect(comment).not.toContain('u/mod_one');
    expect(comment).toContain('moderator team');
  });

  it('names the moderator only when explicitly asked to', () => {
    const comment = buildVerificationComment({ ...base, modName: 'mod_one' });
    expect(comment).toContain('u/mod_one');
  });

  it('substitutes placeholders in custom wording', () => {
    const comment = buildVerificationComment({
      ...base,
      modName: null,
      customText: 'Checked by {mod} in r/{subreddit} on {date}.',
    });
    expect(comment).toBe('Checked by the moderator team in r/IndianPets on 28 Sep 2026, 14:05 IST.');
  });
});

describe('buildModNote', () => {
  it('leads with who and when so truncation never loses the essentials', () => {
    const note = buildModNote({
      modName: 'mod_one',
      dateLabel: '28 Sep 2026, 14:05 IST',
      checklist: null,
      note: 'x'.repeat(400),
    });
    expect(note.startsWith('Fundraiser verified by u/mod_one on 28 Sep 2026, 14:05 IST.')).toBe(true);
    expect(note.slice(0, CONFIG.modNoteMaxLength)).toContain('mod_one');
  });

  it('summarises the checklist as a ratio', () => {
    const note = buildModNote({
      modName: 'mod_one',
      dateLabel: 'today',
      checklist: [
        { label: 'a', checked: true },
        { label: 'b', checked: true },
        { label: 'c', checked: false },
        { label: 'd', checked: true },
        { label: 'e', checked: false },
        { label: 'f', checked: false },
      ],
      note: '',
    });
    expect(note).toContain('Checklist 3/6.');
  });
});

describe('parseChecklistItems', () => {
  it('falls back to the built-in list when blank or missing', () => {
    expect(parseChecklistItems('').length).toBeGreaterThan(0);
    expect(parseChecklistItems(undefined)).toEqual(parseChecklistItems(''));
    expect(parseChecklistItems('   \n  \n ')).toEqual(parseChecklistItems(''));
  });

  it('reads one item per line and assigns positional ids', () => {
    const items = parseChecklistItems('Bill matches\nClinic called\n');
    expect(items).toEqual([
      { id: 'item0', label: 'Bill matches' },
      { id: 'item1', label: 'Clinic called' },
    ]);
  });

  it('tolerates a Markdown bullet list, because moderators will write one', () => {
    const items = parseChecklistItems('- Bill matches\n* Clinic called\n\u2022 Photo checked');
    expect(items.map((item) => item.label)).toEqual([
      'Bill matches',
      'Clinic called',
      'Photo checked',
    ]);
  });

  it('caps the number of items and the length of each label', () => {
    const many = Array.from({ length: 50 }, (_, index) => `item ${index}`).join('\n');
    expect(parseChecklistItems(many)).toHaveLength(CONFIG.maxChecklistItems);

    const long = parseChecklistItems('x'.repeat(500));
    expect(long[0]?.label.length).toBe(CONFIG.checklistLabelMaxLength);
  });
});

describe('settings override layer', () => {
  it('lets a runtime override win over the devvit.json value', async () => {
    const overrides = new FakeConfigRepo();
    const reader = createSettingsReader(
      { getAll: async () => ({ staleRemindersEnabled: true, reminderDays: 30 }) },
      overrides,
    );

    expect((await reader.get()).staleRemindersEnabled).toBe(true);

    await overrides.merge({ staleRemindersEnabled: false });
    // Overrides are read fresh every time, so this takes effect immediately
    // even though the underlying settings are memoised.
    expect((await reader.get()).staleRemindersEnabled).toBe(false);
    expect((await reader.get()).reminderDays).toBe(30);
  });

  it('ignores keys that are not overridable', async () => {
    const overrides = new FakeConfigRepo();
    await overrides.merge({ somethingElse: 'nope', enabled: false });

    const reader = createSettingsReader({ getAll: async () => ({}) }, overrides);
    const resolved = await reader.get();

    expect(resolved.enabled).toBe(false);
    expect(resolved).not.toHaveProperty('somethingElse');
  });

  it('clamps out-of-range numbers instead of trusting them', async () => {
    const overrides = new FakeConfigRepo();
    await overrides.merge({ reminderDays: 99999, graceDays: -5 });

    const resolved = await createSettingsReader({ getAll: async () => ({}) }, overrides).get();
    expect(resolved.reminderDays).toBe(CONFIG.reminders.maxReminderDays);
    expect(resolved.graceDays).toBe(CONFIG.reminders.minGraceDays);
  });

  it('survives a corrupt override document', async () => {
    const broken = {
      read: async (): Promise<Record<string, unknown>> => {
        throw new Error('redis down');
      },
      merge: async (): Promise<void> => {},
      clear: async (): Promise<void> => {},
    };

    const resolved = await createSettingsReader({ getAll: async () => ({}) }, broken).get();
    expect(resolved).toEqual(DEFAULT_SETTINGS);
  });
});
