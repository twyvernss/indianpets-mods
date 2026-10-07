import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config.js';
import {
  sanitizeMultiline,
  sanitizeText,
  toBoolean,
  toNonEmptyString,
} from '../lib/sanitize.js';
import { daysBetween, formatDisplayDate } from '../lib/time.js';
import { isTransientError, withRetry } from '../lib/retry.js';
import {
  ANY_FLAIR,
  createSettingsReader,
  DEFAULT_SETTINGS,
  matchesFundraiserFlair,
  messageTemplatesToText,
  parseChecklistItems,
  parseMessageTemplates,
  parseSettings,
  sanitiseWikiPageName,
  TEMPLATE_SEPARATOR,
} from '../settings.js';
import {
  buildModNote,
  buildReminderComment,
  buildVerificationComment,
  DEFAULT_INTAKE_TEMPLATE,
  DEFAULT_NOTICE_TEMPLATE,
  DEFAULT_REMINDER_TEMPLATE,
  renderIntakeComment,
  starterTemplates,
  alreadyEscalatedToast,
  alreadyRemindedToast,
  escalatedToast,
  followUpDescription,
  wikiCheckBlockedToast,
  wikiCheckReadyToast,
} from '../text.js';
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
    const wrongTypes = parseSettings({ addModNote: 'yes', customNoticeText: 7, reminderDays: {} });
    expect(wrongTypes.addModNote).toBe(DEFAULT_SETTINGS.addModNote);
    expect(wrongTypes.customNoticeText).toBe(DEFAULT_SETTINGS.customNoticeText);
    expect(wrongTypes.reminderDays).toBe(DEFAULT_SETTINGS.reminderDays);
    expect(parseSettings({ showVerifyingModInComment: true }).showVerifyingModInComment).toBe(true);
  });

  it('supplies the starter notices when the box has never been filled in', () => {
    // Otherwise the picker would stay hidden until somebody opened settings and
    // pressed Save, which is exactly the trap this avoids.
    const resolved = parseSettings({});
    expect(resolved.messageTemplates.map((template) => template.label)).toEqual([
      'Documents checked with the clinic',
      'Registered rescue organisation',
    ]);
  });

  it('lets written notices replace the starters entirely', () => {
    const resolved = parseSettings({ messageTemplates: 'Only one\nIts body.' });
    expect(resolved.messageTemplates).toEqual([
      { id: 'tpl0', label: 'Only one', body: 'Its body.' },
    ]);
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
    await expect(reader.get()).resolves.toEqual(parseSettings({}));
  });
});

describe('public comment wording', () => {
  const base = { subredditName: 'IndianPets', dateLabel: '28 Sep 2026, 14:05 IST', customText: '' };

  it('never claims a guarantee and always tells people to use discretion', () => {
    const comment = buildVerificationComment({ ...base, modName: null });
    expect(comment).toContain('not a guarantee');
    expect(comment).toContain('at your own discretion');
  });

  it('says Approved in the heading, in bold', () => {
    const comment = buildVerificationComment({ ...base, modName: null });
    expect(comment.split('\n')[0]).toContain('**Approved**');
  });

  it('carries no em dashes and no automated-message footer', () => {
    const comment = buildVerificationComment({ ...base, modName: null });
    expect(comment).not.toContain('—');
    expect(comment).not.toContain('Posted automatically');
    expect(comment).not.toContain('Replies to this comment');
  });

  it('does not name the moderator by default', () => {
    const comment = buildVerificationComment({ ...base, modName: null });
    expect(comment).not.toContain('u/mod_one');
    expect(comment).toContain('mod team');
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
    expect(resolved).toEqual(parseSettings({}));
  });
});

describe('parseMessageTemplates', () => {
  const block = (label: string, body: string): string => `${label}\n${body}`;

  it('returns nothing for blank input', () => {
    expect(parseMessageTemplates('')).toEqual([]);
    expect(parseMessageTemplates(undefined)).toEqual([]);
  });

  it('reads name-then-body blocks separated by the separator line', () => {
    const raw = [
      block('Full documents', 'We saw the bill.'),
      TEMPLATE_SEPARATOR,
      block('Rescue org', 'Registered rescue.'),
    ].join('\n');

    expect(parseMessageTemplates(raw)).toEqual([
      { id: 'tpl0', label: 'Full documents', body: 'We saw the bill.' },
      { id: 'tpl1', label: 'Rescue org', body: 'Registered rescue.' },
    ]);
  });

  it('drops a block with a name but no body, which would post an empty comment', () => {
    const raw = ['Just a name', TEMPLATE_SEPARATOR, block('Real one', 'Body here.')].join('\n');
    expect(parseMessageTemplates(raw).map((template) => template.label)).toEqual(['Real one']);
  });

  it('caps how many templates are accepted', () => {
    const many = Array.from({ length: 20 }, (_, index) => block(`T${index}`, 'body')).join(
      `\n${TEMPLATE_SEPARATOR}\n`,
    );
    expect(parseMessageTemplates(many)).toHaveLength(CONFIG.maxMessageTemplates);
  });

  it('round-trips through the editor text', () => {
    const templates = parseMessageTemplates(block('A', 'body a'));
    expect(parseMessageTemplates(messageTemplatesToText(templates))).toEqual(templates);
  });
});

describe('matchesFundraiserFlair', () => {
  it('lets everything through when no flair is configured', () => {
    expect(matchesFundraiserFlair(null, '')).toBe(true);
    expect(matchesFundraiserFlair('Discussion', '   ')).toBe(true);
  });

  it('matches case-insensitively and allows extra text around it', () => {
    expect(matchesFundraiserFlair('Fundraiser', 'fundraiser')).toBe(true);
    expect(matchesFundraiserFlair('Fundraiser 2026', 'Fundraiser')).toBe(true);
    expect(matchesFundraiserFlair('Urgent Fundraiser', 'fundraiser')).toBe(true);
  });

  it('rejects other flairs and unflaired posts', () => {
    expect(matchesFundraiserFlair('Discussion', 'Fundraiser')).toBe(false);
    expect(matchesFundraiserFlair(null, 'Fundraiser')).toBe(false);
  });
});

describe('flair setting from the dropdown', () => {
  it('maps the "any post" sentinel back to no filter', () => {
    expect(parseSettings({ fundraiserFlairText: [ANY_FLAIR] }).fundraiserFlairText).toBe('');
  });

  it('accepts a select value, which arrives as an array', () => {
    expect(parseSettings({ fundraiserFlairText: ['Fundraiser'] }).fundraiserFlairText).toBe(
      'Fundraiser',
    );
  });

  it('accepts a plain string, for subreddits with no flairs', () => {
    expect(parseSettings({ fundraiserFlairText: ' Fundraiser ' }).fundraiserFlairText).toBe(
      'Fundraiser',
    );
  });
});

describe('editable default notice', () => {
  const base = { subredditName: 'IndianPets', dateLabel: '28 Sep 2026, 14:05 IST' };

  it('renders the same text whether the box is blank or holds the default template', () => {
    const blank = buildVerificationComment({ ...base, modName: null, customText: '' });
    const prefilled = buildVerificationComment({
      ...base,
      modName: null,
      customText: DEFAULT_NOTICE_TEMPLATE,
    });
    expect(prefilled).toBe(blank);
  });

  it('substitutes placeholders in an edited notice', () => {
    const comment = buildVerificationComment({
      ...base,
      modName: null,
      customText: 'Checked for r/{subreddit} on {date}.',
    });
    expect(comment).toBe('Checked for r/IndianPets on 28 Sep 2026, 14:05 IST.');
  });

  it('still adds the moderator attribution to an edited notice', () => {
    const comment = buildVerificationComment({
      ...base,
      modName: 'mod_one',
      customText: 'Short custom notice.',
    });
    expect(comment).toContain('Short custom notice.');
    expect(comment).toContain('Verified by u/mod_one');
  });

  it('does not name the moderator twice when the notice already uses {mod}', () => {
    const comment = buildVerificationComment({
      ...base,
      modName: 'mod_one',
      customText: 'Checked by {mod}.',
    });
    expect(comment.match(/mod_one/gu)).toHaveLength(1);
  });

  it('offers starter notices that parse into two titled blocks', () => {
    const templates = parseMessageTemplates(starterTemplates());
    expect(templates.map((template) => template.label)).toEqual([
      'Documents checked with the clinic',
      'Registered rescue organisation',
    ]);
    expect(templates[0]?.body).toContain('not a guarantee');
  });
});

describe('sanitiseWikiPageName', () => {
  it('keeps a simple page name', () => {
    expect(sanitiseWikiPageName('fundraiser-verifications')).toBe('fundraiser-verifications');
  });

  it('allows nesting under an existing wiki section', () => {
    expect(sanitiseWikiPageName('spotlight/fundraisers')).toBe('spotlight/fundraisers');
  });

  it('lowercases and replaces characters Reddit will not accept in a path', () => {
    expect(sanitiseWikiPageName('Fundraiser Log!')).toBe('fundraiser-log');
  });

  it('never produces a leading, trailing or doubled separator', () => {
    expect(sanitiseWikiPageName('/spotlight//logs/')).toBe('spotlight/logs');
    expect(sanitiseWikiPageName('---')).toBe('fundraiser-verifications');
  });

  it('falls back rather than writing to the wiki root', () => {
    expect(sanitiseWikiPageName('')).toBe('fundraiser-verifications');
    expect(sanitiseWikiPageName('   ')).toBe('fundraiser-verifications');
  });
});

describe('sanitizeMultiline', () => {
  it('keeps paragraph breaks, which Markdown depends on', () => {
    expect(sanitizeMultiline('line one\n\nline two', 200)).toBe('line one\n\nline two');
  });

  it('normalises Windows line endings', () => {
    expect(sanitizeMultiline('a\r\nb', 200)).toBe('a\nb');
  });

  it('collapses runs of blank lines and trailing spaces', () => {
    expect(sanitizeMultiline('a   \n\n\n\n\nb', 200)).toBe('a\n\nb');
  });

  it('strips invisible and BiDi characters', () => {
    const cleaned = sanitizeMultiline('safe\u200Btext\u202Ereversed', 200);
    expect(cleaned).not.toContain('\u200B');
    expect(cleaned).not.toContain('\u202E');
  });

  it('rejects non-strings and bounds the length', () => {
    expect(sanitizeMultiline(undefined, 50)).toBe('');
    expect(sanitizeMultiline('x'.repeat(500), 50).length).toBeLessThanOrEqual(50);
  });
});

describe('notice editor round trip', () => {
  it('folds numbered title/message pairs back into the stored block format', () => {
    // What the submit handler builds, and what the settings layer parses, must
    // agree - this is the whole contract between the new editor and storage.
    const templates = [
      { id: 'tpl0', label: 'Documents checked', body: 'Body one.\n\nSecond paragraph.' },
      { id: 'tpl1', label: 'Registered rescue', body: 'Body two.' },
    ];

    const stored = messageTemplatesToText(templates);
    expect(parseMessageTemplates(stored)).toEqual(templates);
  });

  it('an empty editor falls back to the starter notices, not to nothing', () => {
    expect(parseSettings({ messageTemplates: '' }).messageTemplates.length).toBeGreaterThan(0);
  });
});

describe('every bot message is an editable template', () => {
  it('the reminder renders the same blank or prefilled', () => {
    const args = {
      subredditName: 'IndianPets',
      authorName: 'op_user',
      daysSinceVerified: 40,
      graceDays: 7,
    };
    const blank = buildReminderComment({ ...args, custom: '' });
    const prefilled = buildReminderComment({ ...args, custom: DEFAULT_REMINDER_TEMPLATE });

    expect(prefilled).toBe(blank);
    expect(blank).toContain('u/op_user');
    expect(blank).toContain('40 days ago');
    expect(blank).toContain('next 7 days');
  });

  it('the intake message renders the same blank or prefilled', () => {
    const args = { subredditName: 'IndianPets', authorName: 'op_user' };
    const blank = renderIntakeComment({ ...args, custom: '' });
    const prefilled = renderIntakeComment({ ...args, custom: DEFAULT_INTAKE_TEMPLATE });

    expect(prefilled).toBe(blank);
    expect(blank).toContain('u/op_user');
    expect(blank).toContain('do not** post these documents publicly');
  });

  it('greets politely when the author account is gone', () => {
    const comment = renderIntakeComment({
      subredditName: 'IndianPets',
      authorName: null,
      custom: '',
    });
    expect(comment.startsWith('Hi there,')).toBe(true);
  });

  it('leaves an unknown placeholder visible instead of blanking it', () => {
    // A mistyped placeholder should be obvious in the posted comment, not a
    // silent hole in a sentence.
    const comment = renderIntakeComment({
      subredditName: 'IndianPets',
      authorName: 'op_user',
      custom: 'Hello {op}, see r/{subredit} rules.',
    });
    expect(comment).toBe('Hello u/op_user, see r/{subredit} rules.');
  });
});

describe('followUpDescription', () => {
  const base = {
    daysSinceVerified: 40,
    daysSinceReminder: null as number | null,
    escalated: false,
    opResponded: false,
    reminderDays: 30,
    graceDays: 7,
    remindersEnabled: true,
    lockStalePosts: false,
  };

  it('is explicit that reporting does not lock when the setting is off', () => {
    const text = followUpDescription(base);
    expect(text).toContain('does not lock or remove');
    expect(text).not.toContain('LOCK the post');
  });

  it('warns in capitals when reporting will also lock the post', () => {
    // A moderator is one tap from locking someone's fundraiser; this must not
    // be buried in a sentence they can skim past.
    expect(followUpDescription({ ...base, lockStalePosts: true })).toContain('LOCK the post');
  });

  it('says whether an update has already been asked for', () => {
    expect(followUpDescription(base)).toContain('No update has been requested yet');
    expect(followUpDescription({ ...base, daysSinceReminder: 3 })).toContain(
      'asked for an update 3 days ago',
    );
  });

  it('mentions an existing report so a moderator does not expect a second one', () => {
    expect(followUpDescription({ ...base, escalated: true })).toContain('already been reported');
  });

  it('mentions that the OP has replied', () => {
    expect(followUpDescription({ ...base, opResponded: true })).toContain('OP has replied');
  });

  it('says plainly that nothing happens on its own when the check is off', () => {
    const text = followUpDescription({ ...base, remindersEnabled: false });
    expect(text).toContain('switched off');
    expect(text).not.toContain('Normally the OP is asked');
  });

  it('never writes "1 days"', () => {
    const text = followUpDescription({
      ...base,
      daysSinceVerified: 1,
      daysSinceReminder: 1,
      reminderDays: 1,
      graceDays: 1,
    });
    expect(text).not.toContain('1 days');
    expect(text).toContain('1 day');
  });
});

describe('follow-up toasts', () => {
  it('says whether the post was locked, never just "done"', () => {
    expect(escalatedToast(true)).toContain('locked');
    expect(escalatedToast(false)).toContain('not locked');
  });

  it('makes clear that no second comment or report was made', () => {
    expect(alreadyRemindedToast('4 Aug 2026')).toContain('No second comment');
    expect(alreadyEscalatedToast('4 Aug 2026')).toContain('Nothing was done again');
  });
});

describe('wiki check toasts', () => {
  it('names the page and the row count', () => {
    const text = wikiCheckReadyToast({
      page: 'fundraiser-verifications/2026-10',
      rows: 3,
      createdNow: false,
    });
    expect(text).toContain('fundraiser-verifications/2026-10');
    expect(text).toContain('3 verifications logged');
    expect(text).toContain('moderator-only');
  });

  it('says when it had to create the page, and uses the singular for one row', () => {
    expect(wikiCheckReadyToast({ page: 'p', rows: 1, createdNow: true })).toContain(
      'Created the page',
    );
    expect(wikiCheckReadyToast({ page: 'p', rows: 1, createdNow: true })).toContain(
      '1 verification logged',
    );
  });

  it('says nothing is logged yet rather than "0 verifications"', () => {
    expect(wikiCheckReadyToast({ page: 'p', rows: 0, createdNow: true })).toContain(
      'no verifications logged yet',
    );
  });

  it('leads with the consequence, not the cause', () => {
    const text = wikiCheckBlockedToast('Reddit said no.');
    expect(text.startsWith('Nothing will be written')).toBe(true);
    expect(text).toContain('Reddit said no.');
    expect(text).toContain('wiki being disabled');
  });
});
