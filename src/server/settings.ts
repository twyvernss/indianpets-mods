import { CONFIG } from './config.js';
import type { ConfigRepo } from './data/configRepo.js';
import { DEFAULT_CHECKLIST_LABELS, starterTemplates } from './text.js';
import type { ChecklistItem, MessageTemplate } from './types.js';

/**
 * Effective configuration, resolved from three layers:
 *
 *   1. the defaults below,
 *   2. the subreddit settings declared in devvit.json (edited on
 *      developers.reddit.com, memoised for a minute),
 *   3. the runtime overrides in Redis (edited from a menu action inside the
 *      subreddit, read fresh on every request).
 *
 * Later layers win. Every value is coerced and every number is clamped here, so
 * no caller ever has to defend against a missing, mistyped or absurd value.
 */
export type AppSettings = {
  /** Master switch. When false the app takes no action at all. */
  enabled: boolean;

  /* --- verification --- */
  addModNote: boolean;
  /**
   * Name the verifying moderator in the PUBLIC comment.
   * Defaults to false on purpose: naming mods publicly is what generates the
   * unsolicited DMs this app was built to avoid.
   */
  showVerifyingModInComment: boolean;
  /** Blank means "use the built-in wording from text.ts". */
  customNoticeText: string;
  /**
   * Pre-written notice wordings a moderator can pick from on the verify form.
   * Empty means the default notice is the only option.
   */
  messageTemplates: MessageTemplate[];
  /** Moderator-editable tick-boxes, already parsed and bounded. */
  checklistItems: ChecklistItem[];
  /**
   * Render the checklist as one multi-select tick-list rather than a row of
   * toggles. Keeps the verify form short, which matters most on mobile.
   */
  compactChecklist: boolean;

  /**
   * Reply to the OP when AutoModerator holds their fundraiser, telling them
   * what to send. Off by default: most subreddits already have AutoModerator
   * post something similar, and two bot comments on one post is worse than
   * none. Turn this on and remove the AutoModerator comment.
   */
  automodReplyEnabled: boolean;
  /** Blank means "use the built-in intake wording". */
  automodReplyText: string;
  /** Show the author's account age and karma on the verify form. */
  showAuthorSummary: boolean;

  /**
   * Post flair that marks a post as a fundraiser, e.g. "Fundraiser".
   *
   * Blank treats every post as a candidate. When set, the bot only replies to
   * and reports posts carrying this flair, which is the single biggest noise
   * reduction available on a busy subreddit. Matched case-insensitively, and a
   * flair containing the text counts (so "Fundraiser" matches "Fundraiser Rs").
   */
  fundraiserFlairText: string;

  /**
   * Keep a durable, human-readable verification log on a subreddit wiki page.
   *
   * On by default, because the app's Redis data is discarded if the app is
   * ever uninstalled and cannot be read by a human at all. The wiki page
   * survives that and keeps its own revision history.
   */
  wikiLogEnabled: boolean;
  /** Base page name. Monthly pages are created underneath it. */
  wikiLogPage: string;
  /** Also post each verification to Mod Discussions. Off by default: noisy. */
  modmailLogEnabled: boolean;

  /* --- duplicate link detection --- */
  duplicateDetectionEnabled: boolean;
  /** Off by default: scanning every comment is a lot of work for a rare signal. */
  scanCommentsForLinks: boolean;
  /** When false, someone reposting their own link is logged but not reported. */
  reportSameAuthorReposts: boolean;
  /**
   * How long someone must wait before reposting their own fundraiser link.
   *
   * Set it to whatever the subreddit rules allow: a repost that waits this long
   * is legitimate and is never reported. 0 means there is no waiting period, so
   * same-author reposts are never reported at all. If reposts are NOT allowed,
   * set it very high (8760 = a year) so every one of them is flagged.
   */
  sameAuthorRepostHours: number;

  /* --- stale fundraiser reminders --- */
  staleRemindersEnabled: boolean;
  reminderDays: number;
  graceDays: number;
  /** Off by default. Locking is destructive enough to be an opt-in. */
  lockStalePosts: boolean;
  /** Blank means "use the built-in reminder wording". */
  customReminderText: string;

  /* --- author thresholds, used to annotate modqueue reports --- */
  minAccountAgeDays: number;
  minKarma: number;
};

/** Keys a moderator may override at runtime. Anything else is ignored. */
export const OVERRIDABLE_KEYS = [
  'enabled',
  'addModNote',
  'showVerifyingModInComment',
  'customNoticeText',
  'messageTemplates',
  'checklistItems',
  'fundraiserFlairText',
  'wikiLogEnabled',
  'wikiLogPage',
  'modmailLogEnabled',
  'compactChecklist',
  'automodReplyEnabled',
  'automodReplyText',
  'showAuthorSummary',
  'duplicateDetectionEnabled',
  'scanCommentsForLinks',
  'reportSameAuthorReposts',
  'sameAuthorRepostHours',
  'staleRemindersEnabled',
  'reminderDays',
  'graceDays',
  'lockStalePosts',
  'customReminderText',
  'minAccountAgeDays',
  'minKarma',
] as const;

export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];

export const DEFAULT_SETTINGS: AppSettings = {
  enabled: true,

  addModNote: true,
  showVerifyingModInComment: false,
  customNoticeText: '',
  // Left empty here on purpose: DEFAULT_SETTINGS is evaluated at module load,
  // before TEMPLATE_SEPARATOR exists, so calling the parser here would be a
  // temporal dead zone error. The starter notices are applied in parseSettings
  // instead, which only ever runs at request time.
  messageTemplates: [],
  checklistItems: toChecklistItems(DEFAULT_CHECKLIST_LABELS),
  compactChecklist: true,
  fundraiserFlairText: '',
  wikiLogEnabled: true,
  wikiLogPage: 'fundraiser-verifications',
  modmailLogEnabled: false,
  automodReplyEnabled: false,
  automodReplyText: '',
  showAuthorSummary: true,

  duplicateDetectionEnabled: true,
  scanCommentsForLinks: false,
  reportSameAuthorReposts: true,
  sameAuthorRepostHours: 24,

  staleRemindersEnabled: true,
  reminderDays: 30,
  graceDays: 7,
  lockStalePosts: false,
  customReminderText: '',

  minAccountAgeDays: 0,
  minKarma: 0,
};

/** The slice of Devvit's settings client this app uses. */
export type SettingsPort = {
  getAll(): Promise<Record<string, unknown>>;
};

export type SettingsReader = {
  get(): Promise<AppSettings>;
};

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a value that may come from a `select` field.
 *
 * Devvit submits a select as an array of strings even when only one option can
 * be chosen, so both shapes have to be accepted. The sentinel {@link ANY_FLAIR}
 * maps back to an empty string, which every caller reads as "no filter".
 */
function coerceSelectString(value: unknown, fallback: string): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return fallback;
  return raw === ANY_FLAIR ? '' : raw;
}

/**
 * Numbers from a Devvit `number` setting can arrive as strings depending on the
 * client, and a moderator can type anything into the box.
 */
function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function toChecklistItems(labels: readonly string[]): ChecklistItem[] {
  return labels.map((label, index) => ({ id: `item${index}`, label }));
}

/**
 * Parses the moderator-editable checklist: one label per line, blank lines
 * ignored, Markdown bullets tolerated. Falls back to the built-in list when the
 * setting is empty.
 *
 * Ids are positional and only ever used within a single open form - the LABEL is
 * what gets stored on the record, so reordering or rewording the list later
 * cannot corrupt existing verification history.
 */
export function parseChecklistItems(raw: unknown): ChecklistItem[] {
  if (typeof raw !== 'string') return toChecklistItems(DEFAULT_CHECKLIST_LABELS);

  const labels = raw
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*•]\s*/u, '').trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, CONFIG.checklistLabelMaxLength))
    .slice(0, CONFIG.maxChecklistItems);

  return labels.length > 0 ? toChecklistItems(labels) : toChecklistItems(DEFAULT_CHECKLIST_LABELS);
}

/**
 * Dropdown value meaning "do not filter by flair at all".
 *
 * Defined here rather than in the form so the parser and the form cannot drift
 * apart: a select field submits its value as an array of strings, and this is
 * the one value that must map back to an empty setting.
 */
export const ANY_FLAIR = '__any__';

/** The line that separates one notice template from the next. */
export const TEMPLATE_SEPARATOR = "---";

/**
 * Parses the moderator-written notice templates.
 *
 * Format: blocks separated by a line containing only `---`. The first non-empty
 * line of a block is its name (what the moderator picks from the dropdown);
 * everything after it is the comment body.
 *
 * A block with a name but no body is dropped: picking it would post an empty
 * comment, which is worse than not offering it.
 */
export function parseMessageTemplates(raw: unknown): MessageTemplate[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  const blocks: string[][] = [[]];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim() === TEMPLATE_SEPARATOR) blocks.push([]);
    else blocks[blocks.length - 1]?.push(line);
  }

  const templates: MessageTemplate[] = [];
  for (const block of blocks) {
    const firstIndex = block.findIndex((line) => line.trim().length > 0);
    if (firstIndex === -1) continue;

    const label = (block[firstIndex] ?? '').trim().slice(0, CONFIG.templateLabelMaxLength);
    const body = block.slice(firstIndex + 1).join('\n').trim().slice(0, CONFIG.templateBodyMaxLength);
    if (label.length === 0 || body.length === 0) continue;

    templates.push({ id: `tpl${templates.length}`, label, body });
    if (templates.length >= CONFIG.maxMessageTemplates) break;
  }

  return templates;
}

/**
 * Reduces a moderator-typed page name to something safe in a wiki path.
 *
 * Reddit wiki paths accept lowercase letters, digits, underscores, hyphens and
 * slashes. Anything else becomes a hyphen, and an empty result falls back to
 * the default rather than writing to the subreddit wiki root.
 */
export function sanitiseWikiPageName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'fundraiser-verifications';
}

/** Renders the templates back to the block form a moderator edits. */
export function messageTemplatesToText(templates: readonly MessageTemplate[]): string {
  return templates
    .map((template) => `${template.label}\n${template.body}`)
    .join(`\n${TEMPLATE_SEPARATOR}\n`);
}

/**
 * Does this post's flair mark it as a fundraiser?
 *
 * A blank setting means "every post counts", so the feature is opt-in and the
 * app never silently ignores posts because of a flair rename.
 */
export function matchesFundraiserFlair(
  flairText: string | null,
  configured: string,
): boolean {
  const wanted = configured.trim().toLowerCase();
  if (wanted.length === 0) return true;
  return (flairText ?? '').toLowerCase().includes(wanted);
}

/** Renders the checklist back to the one-per-line form a moderator edits. */
export function checklistItemsToText(items: readonly ChecklistItem[]): string {
  return items.map((item) => item.label).join('\n');
}

/** Resolves one merged bag of raw values into typed, clamped settings. */
export function parseSettings(raw: Record<string, unknown>): AppSettings {
  const { reminders } = CONFIG;

  return {
    enabled: coerceBoolean(raw['enabled'], DEFAULT_SETTINGS.enabled),

    addModNote: coerceBoolean(raw['addModNote'], DEFAULT_SETTINGS.addModNote),
    showVerifyingModInComment: coerceBoolean(
      raw['showVerifyingModInComment'],
      DEFAULT_SETTINGS.showVerifyingModInComment,
    ),
    customNoticeText: coerceString(raw['customNoticeText'], DEFAULT_SETTINGS.customNoticeText),
    // An unset box means "use the starter notices", so the picker works on a
    // fresh install without anybody having to open settings and press Save.
    // Writing something in the box replaces them entirely.
    messageTemplates: (() => {
      const parsed = parseMessageTemplates(raw['messageTemplates']);
      return parsed.length > 0 ? parsed : parseMessageTemplates(starterTemplates());
    })(),
    checklistItems: parseChecklistItems(raw['checklistItems']),
    fundraiserFlairText: coerceSelectString(
      raw['fundraiserFlairText'],
      DEFAULT_SETTINGS.fundraiserFlairText,
    ).trim(),
    compactChecklist: coerceBoolean(raw['compactChecklist'], DEFAULT_SETTINGS.compactChecklist),

    wikiLogEnabled: coerceBoolean(raw['wikiLogEnabled'], DEFAULT_SETTINGS.wikiLogEnabled),
    // The page name goes straight into a wiki path, so it is reduced to the
    // characters Reddit allows there rather than trusted as typed.
    wikiLogPage: sanitiseWikiPageName(
      coerceString(raw['wikiLogPage'], DEFAULT_SETTINGS.wikiLogPage),
    ),
    modmailLogEnabled: coerceBoolean(raw['modmailLogEnabled'], DEFAULT_SETTINGS.modmailLogEnabled),
    automodReplyEnabled: coerceBoolean(
      raw['automodReplyEnabled'],
      DEFAULT_SETTINGS.automodReplyEnabled,
    ),
    automodReplyText: coerceString(raw['automodReplyText'], DEFAULT_SETTINGS.automodReplyText),
    showAuthorSummary: coerceBoolean(raw['showAuthorSummary'], DEFAULT_SETTINGS.showAuthorSummary),

    duplicateDetectionEnabled: coerceBoolean(
      raw['duplicateDetectionEnabled'],
      DEFAULT_SETTINGS.duplicateDetectionEnabled,
    ),
    scanCommentsForLinks: coerceBoolean(
      raw['scanCommentsForLinks'],
      DEFAULT_SETTINGS.scanCommentsForLinks,
    ),
    reportSameAuthorReposts: coerceBoolean(
      raw['reportSameAuthorReposts'],
      DEFAULT_SETTINGS.reportSameAuthorReposts,
    ),
    sameAuthorRepostHours: coerceNumber(
      raw['sameAuthorRepostHours'],
      DEFAULT_SETTINGS.sameAuthorRepostHours,
      CONFIG.duplicates.minRepostWindowHours,
      CONFIG.duplicates.maxRepostWindowHours,
    ),

    staleRemindersEnabled: coerceBoolean(
      raw['staleRemindersEnabled'],
      DEFAULT_SETTINGS.staleRemindersEnabled,
    ),
    reminderDays: coerceNumber(
      raw['reminderDays'],
      DEFAULT_SETTINGS.reminderDays,
      reminders.minReminderDays,
      reminders.maxReminderDays,
    ),
    graceDays: coerceNumber(
      raw['graceDays'],
      DEFAULT_SETTINGS.graceDays,
      reminders.minGraceDays,
      reminders.maxGraceDays,
    ),
    lockStalePosts: coerceBoolean(raw['lockStalePosts'], DEFAULT_SETTINGS.lockStalePosts),
    customReminderText: coerceString(raw['customReminderText'], DEFAULT_SETTINGS.customReminderText),

    minAccountAgeDays: coerceNumber(
      raw['minAccountAgeDays'],
      DEFAULT_SETTINGS.minAccountAgeDays,
      0,
      3650,
    ),
    minKarma: coerceNumber(raw['minKarma'], DEFAULT_SETTINGS.minKarma, 0, 1_000_000),
  };
}

/**
 * Keeps only the keys a moderator is allowed to override, dropping `undefined`
 * so that "left blank" never means "force this to empty".
 */
export function pickOverrides(patch: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of OVERRIDABLE_KEYS) {
    const value = patch[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/**
 * Builds the effective-settings reader.
 *
 * The devvit.json settings are memoised for {@link CONFIG.settingsCacheMs}
 * because they change rarely and each read is a platform call. The Redis
 * overrides are read fresh every time: a moderator who flips a switch expects
 * the very next action to respect it, and one extra Redis GET is a fair price.
 *
 * If either source fails, the app falls back to what it has rather than
 * throwing. A settings outage must never block a moderator from verifying a
 * fundraiser.
 */
export function createSettingsReader(
  port: SettingsPort,
  overrides: ConfigRepo,
  now: () => number = () => Date.now(),
  ttlMs: number = CONFIG.settingsCacheMs,
): SettingsReader {
  let cachedBase: Record<string, unknown> | null = null;
  let cachedAtMs = 0;

  return {
    async get(): Promise<AppSettings> {
      const timestamp = now();

      if (cachedBase === null || timestamp - cachedAtMs >= ttlMs) {
        try {
          cachedBase = await port.getAll();
        } catch {
          cachedBase = cachedBase ?? {};
        }
        cachedAtMs = timestamp;
      }

      let patch: Record<string, unknown> = {};
      try {
        patch = await overrides.read();
      } catch {
        patch = {};
      }

      return parseSettings({ ...cachedBase, ...pickOverrides(patch) });
    },
  };
}
