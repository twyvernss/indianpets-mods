import type { T1, T3 } from '@devvit/web/shared';

/**
 * One tick-box on the verification checklist.
 *
 * Items are configurable per subreddit (a paragraph setting, one label per
 * line), so `id` is positional and only meaningful while a form is open.
 */
export type ChecklistItem = { id: string; label: string };

/**
 * A completed tick-box.
 *
 * The LABEL is stored, not just the id. If a moderator later reword or reorders
 * the checklist, old records still say exactly what was checked at the time -
 * which is the whole point of keeping a verification record.
 */
export type ChecklistItemResult = { label: string; checked: boolean };

/**
 * A pre-written verification notice a moderator can pick at verify time.
 *
 * Defined in the subreddit settings, one block per template, so the mod team
 * can keep two or three wordings (full documents, rescue organisation, partial
 * paperwork) without editing code.
 */
export type MessageTemplate = { id: string; label: string; body: string };

/**
 * `pending` is written BEFORE any Reddit side effect so a crash midway cannot
 * leave the post looking unverified (which would let a second run post a
 * duplicate comment). It is promoted to `complete` once the comment exists, and
 * deleted if the Reddit calls fail outright.
 */
export type VerificationStatus = 'pending' | 'complete';

/** Current record schema. See `upgradeRecord` for how v1 rows are read. */
export const RECORD_SCHEMA_VERSION = 2;

export type VerificationRecord = {
  schemaVersion: 2;
  postId: T3;
  /** Null once the author deletes their account or the post is deleted. */
  authorName: string | null;
  /** Moderator who ran the action. Internal only - never published. */
  modName: string;
  verifiedAtMs: number;
  status: VerificationStatus;
  /** Internal note. Never posted publicly; may be copied into a mod note. */
  note: string;
  /** Null when the moderator used the quick path. */
  checklist: ChecklistItemResult[] | null;
  /** The app's stickied verification comment, once it exists. */
  commentId: T1 | null;
  /** Label of the notice template used, or null for the default wording. */
  templateLabel: string | null;
  /** Set when the post is later deleted or removed. */
  deletedAtMs: number | null;

  /* --- staleness tracking (v2) --- */

  /** When the bot asked the OP for an update. Null until the first reminder. */
  reminderSentAtMs: number | null;
  /** When the OP commented after the reminder. Null if they never did. */
  opRespondedAtMs: number | null;
  /** When the post was reported to the modqueue for going unanswered. */
  escalatedAtMs: number | null;
};

/** Short-lived proof that a specific moderator opened the form for a specific post. */
export type VerificationToken = {
  postId: T3;
  modName: string;
  createdAtMs: number;
  /**
   * The exact checklist shown to this moderator.
   *
   * Captured server-side when the checklist form is built, so that editing the
   * checklist setting mid-session cannot cause the wrong labels to be stored
   * against the wrong answers.
   */
  checklist: ChecklistItem[] | null;
  /** The notice templates offered on that form, for the same reason. */
  templates: MessageTemplate[] | null;
};

/** Discriminated result so handlers can build a precise, honest toast. */
export type VerifyOutcome =
  | { kind: 'ok'; commentId: T1 }
  | { kind: 'already-verified'; record: VerificationRecord }
  | { kind: 'in-progress' }
  | { kind: 'post-missing' }
  | { kind: 'expired' }
  | { kind: 'not-moderator' }
  /** Materially succeeded but one step failed; the mod is told exactly what. */
  | { kind: 'partial'; detail: string }
  | { kind: 'failed'; detail: string };

/** Values posted back by the first form. */
export type VerifyFormValues = {
  token?: unknown;
  note?: unknown;
  showChecklist?: unknown;
};

/** Values posted back by the checklist form. Tick-box names are dynamic. */
export type ChecklistFormValues = VerifyFormValues & Record<string, unknown>;

/* ------------------------------------------------------------------------ */
/* Duplicate link detection (v2)                                             */
/* ------------------------------------------------------------------------ */

/** The first post seen carrying a given normalised link. */
export type LinkRecord = {
  postId: T3;
  author: string | null;
  firstSeenMs: number;
  /** Display form of the link, for the modqueue report. */
  display: string;
  /** True when the link is a shortener whose destination was never resolved. */
  shortened: boolean;
};

/** What the duplicate detector concluded about one post. */
export type DuplicateFinding = {
  postId: T3;
  author: string | null;
  /** The earlier post carrying the same link. */
  originalPostId: T3;
  originalAuthor: string | null;
  display: string;
  shortened: boolean;
  /** True when the same person posted both. Reported more quietly. */
  sameAuthor: boolean;
  /** Whole hours between the earlier post and this one. */
  hoursSincePrevious: number;
  /**
   * True when a same-author repost arrived sooner than the community allows.
   * A same-author repost that respects the window is not a finding at all.
   */
  tooSoon: boolean;
};
