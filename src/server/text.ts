import { CONFIG } from './config.js';
import type { ChecklistItemResult, DuplicateFinding } from './types.js';

/**
 * Every string a human ever sees. Edit here, not in the handlers.
 *
 * The public comment deliberately does NOT name the verifying moderator by
 * default: naming them is what causes the unsolicited DMs this app exists to
 * avoid.
 */

/**
 * Starting checklist. Moderators can replace this entirely from the subreddit
 * settings (one item per line), so treat this as a sensible default rather
 * than the definitive list.
 */
export const DEFAULT_CHECKLIST_LABELS: readonly string[] = [
  "Vet bill is in the OP's name and the pet matches the photos",
  'Clinic contact was checked',
  "Photo of pet with OP's username and date",
  'Amount on bill roughly matches the fundraiser goal',
  'Fundraiser link works and beneficiary matches',
  'Account age / karma meets our minimum',
];

export const FORM_TEXT = {
  verifyTitle: 'Verify fundraiser',
  verifyDescription:
    'This approves the post and adds a stickied verification notice from the mod team. Your username is recorded internally but is not shown publicly.',
  verifyAccept: 'Verify',
  verifyCancel: 'Cancel',

  noteLabel: 'Internal note (optional)',
  noteHelp: 'Visible only to moderators, in the app record and the mod note. Never posted publicly.',
  notePlaceholder: 'e.g. Called the clinic on 28 Sep, bill reference #4471 confirmed.',

  showChecklistLabel: 'Fill in the verification checklist',
  showChecklistHelp: 'Leave this off for the quick path. Turning it on opens a second form.',

  checklistTitle: 'Verification checklist',
  checklistDescription:
    'All items are optional and none of them block submission. Tick whatever you actually checked.',
  checklistAccept: 'Verify',
  checklistCancel: 'Cancel',
} as const;

export const TOASTS = {
  notModerator: 'Only moderators of this community can verify fundraisers.',
  notAPost: 'This action can only be run on a post.',
  postMissing: 'That post no longer exists, or it could not be loaded.',
  inProgress: 'Another verification for this post is already running. Give it a few seconds.',
  expired: 'This verification session expired. Close the form and choose "Verify fundraiser" again.',
  noRecord: 'This post has not been verified by the app.',
} as const;

export function alreadyVerifiedToast(modName: string, dateLabel: string): string {
  return `Already verified by u/${modName} on ${dateLabel}. No changes were made.`;
}

export function verifiedToast(dateLabel: string): string {
  return `Verified. The post is approved and the notice is stickied (${dateLabel}).`;
}

/**
 * The status toast.
 *
 * Carries the follow-up state as well as the verification, because otherwise
 * there is no way to see at a glance whether the OP was ever asked for an
 * update and whether they answered. The app learns about a reply from the
 * comment trigger; this is where a moderator finds out.
 */
export function statusToast(input: {
  modName: string;
  dateLabel: string;
  hasChecklist: boolean;
  hasNote: boolean;
  reminderSentAtMs: number | null;
  opRespondedAtMs: number | null;
  escalatedAtMs: number | null;
}): string {
  const extras: string[] = [];
  if (input.hasChecklist) extras.push('checklist filled');
  if (input.hasNote) extras.push('note attached');
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';

  // Most recent fact first: a reply supersedes the chase, and a report
  // supersedes the wait.
  let follow = '';
  if (input.opRespondedAtMs !== null) {
    follow = ' The OP replied after being asked for an update.';
  } else if (input.escalatedAtMs !== null) {
    follow = ' Reported to the modqueue: the OP never replied.';
  } else if (input.reminderSentAtMs !== null) {
    follow = ' The OP has been asked for an update and has not replied yet.';
  }

  return `Verified by u/${input.modName} on ${input.dateLabel}${suffix}.${follow}`;
}

export function heldByAutomodToast(dateLabel: string): string {
  return `Not verified yet. AutoModerator filtered this post on ${dateLabel}.`;
}

/**
 * The public verification comment.
 *
 * Wording constraints that must survive any future edit:
 *  - it states what was checked (documents) and nothing more;
 *  - it explicitly disclaims any guarantee;
 *  - it tells readers to donate at their own discretion.
 */
/**
 * The built-in verification notice, as an editable template.
 *
 * Defined once, with placeholders rather than interpolated values, so the
 * settings form can show a moderator EXACTLY what the bot posts and let them
 * edit it. Saving it unchanged behaves identically to leaving the box blank.
 *
 * Wording constraints that must survive any edit:
 *  - it states what was checked (documents) and nothing more;
 *  - it explicitly disclaims any guarantee;
 *  - it tells readers to donate at their own discretion.
 */
export const DEFAULT_NOTICE_TEMPLATE = [
  '## Fundraiser **Approved** by the r/{subreddit} mod team',
  '',
  'The moderators of r/{subreddit} have reviewed documents submitted privately by the original poster for this fundraiser, and they were consistent with the fundraiser described here.',
  '',
  '**This is not a guarantee.** We cannot audit how donated money is actually spent, we are not involved in this fundraiser, and documents can be forged or circumstances can change after a check is done. Please donate at your own discretion, and only what you can comfortably afford.',
  '',
  'If something about this fundraiser looks wrong, report this post or [message the moderators](https://www.reddit.com/message/compose?to=/r/{subreddit}). Please do not accuse people in the comments.',
].join('\n');

/**
 * Renders the public verification comment.
 *
 * Precedence: the notice the moderator picked at verify time, then the single
 * custom notice, then the built-in template. All three go through the same
 * placeholder substitution, so they behave identically.
 */
export function buildVerificationComment(input: {
  subredditName: string;
  dateLabel: string;
  /** Null when the setting to name the moderator is off (the default). */
  modName: string | null;
  /** Subreddit-configured override; blank means use the built-in wording. */
  customText: string;
}): string {
  const attribution = input.modName ? `u/${input.modName}` : 'the moderator team';

  // One rendering path for all three sources - picked template, custom notice,
  // built-in template - so they behave identically and a moderator who saves
  // the prefilled default changes nothing.
  const rendered = applyPlaceholders(input.customText.trim() || DEFAULT_NOTICE_TEMPLATE, {
    subreddit: input.subredditName,
    date: input.dateLabel,
    mod: attribution,
  });

  // The attribution line is appended to ANY wording, so the setting keeps
  // working after a moderator edits the notice. Skipped when the text already
  // names them, which happens if they used the {mod} placeholder themselves.
  if (input.modName && !rendered.includes(`u/${input.modName}`)) {
    return `${rendered}\n\n*Verified by u/${input.modName}.*`;
  }
  return rendered;
}

/**
 * A starting point for the saved-notices box.
 *
 * Shown when a subreddit has no templates yet, so the block format is obvious
 * and the first notice is the wording already in use rather than a blank page.
 */
export function starterTemplates(): string {
  return [
    'Documents checked with the clinic',
    '## Fundraiser **Approved** by the r/{subreddit} mod team',
    '',
    'The moderators of r/{subreddit} have seen the treatment documents for this fundraiser and confirmed them directly with the clinic.',
    '',
    '**This is not a guarantee.** We cannot audit how donated money is actually spent, we are not involved in this fundraiser, and circumstances can change after a check is done. Please donate at your own discretion, and only what you can comfortably afford.',
    '',
    'If something about this fundraiser looks wrong, report this post or [message the moderators](https://www.reddit.com/message/compose?to=/r/{subreddit}). Please do not accuse people in the comments.',
    '---',
    'Registered rescue organisation',
    '## Fundraiser **Approved** by the r/{subreddit} mod team',
    '',
    'This fundraiser is run by a rescue organisation known to the r/{subreddit} mod team, and we have seen documentation for the animals involved.',
    '',
    '**This is not a guarantee.** We cannot audit how donated money is actually spent. Please donate at your own discretion, and only what you can comfortably afford.',
    '',
    'If something about this fundraiser looks wrong, report this post or [message the moderators](https://www.reddit.com/message/compose?to=/r/{subreddit}). Please do not accuse people in the comments.',
  ].join('\n');
}

/**
 * The staleness reminder posted on a fundraiser that has gone quiet.
 *
 * It is addressed to the OP, asks for one specific thing, and says what happens
 * next. It must never imply the fundraiser is suspect - most are simply still
 * running.
 */
export const DEFAULT_REMINDER_TEMPLATE = [
  '{op}, this fundraiser was verified by the r/{subreddit} mod team {days} days ago.',
  '',
  'Could you post a short update as a reply here? Either:',
  '',
  '- how the treatment or rescue is going, and whether you still need help, or',
  '- that the fundraiser is **complete** and no longer taking donations.',
  '',
  'Keeping this current helps people decide whether to donate. If we do not hear anything in the next {grace} days, a moderator will take a look at the post.',
].join('\n');

/**
 * The staleness reminder posted on a fundraiser that has gone quiet.
 *
 * It is addressed to the OP, asks for one specific thing, and says what
 * happens next. It must never imply the fundraiser is suspect - most are
 * simply still running.
 */
export function buildReminderComment(input: {
  /** Subreddit override; blank means the built-in wording. */
  custom: string;
  subredditName: string;
  authorName: string | null;
  daysSinceVerified: number;
  graceDays: number;
}): string {
  return applyPlaceholders(input.custom.trim() || DEFAULT_REMINDER_TEMPLATE, {
    subreddit: input.subredditName,
    op: input.authorName ? `u/${input.authorName}` : 'Hi there',
    days: String(input.daysSinceVerified),
    grace: String(input.graceDays),
  });
}

/** Modqueue report reason for a fundraiser that never answered its reminder. */
export function buildStaleReportReason(daysSinceVerified: number): string {
  return truncate(
    `Verified fundraiser, no update from OP after ${daysSinceVerified} days`,
    CONFIG.reportReasonMaxLength,
  );
}

/**
 * Modqueue report reason for a repeated fundraiser link.
 *
 * The two cases read very differently on purpose. A same-author repost inside
 * the waiting period is a rules matter and says so with the numbers. The same
 * link from a DIFFERENT account is the one worth investigating, and never
 * mentions timing, because it is a problem however long ago it happened.
 */
export function buildDuplicateReportReason(
  finding: DuplicateFinding,
  context: { previouslyVerified: boolean; minimumHours: number },
): string {
  const shortNote = finding.shortened ? ' [short link unchecked]' : '';
  const verified = context.previouslyVerified ? ' - earlier post was verified' : '';

  // A same-author repost only reaches here when it broke the community's
  // waiting period, so the reason says exactly that rather than implying the
  // person did something suspicious by reposting at all.
  if (finding.sameAuthor) {
    return truncate(
      `Reposted after ${finding.hoursSincePrevious}h, minimum is ${context.minimumHours}h: same link as ${finding.originalPostId}${verified}${shortNote}`,
      CONFIG.reportReasonMaxLength,
    );
  }

  const original = finding.originalAuthor ? `u/${finding.originalAuthor}` : 'a deleted account';
  return truncate(
    `Same fundraiser link as post ${finding.originalPostId} by ${original}${verified}${shortNote}`,
    CONFIG.reportReasonMaxLength,
  );
}

/** Appended to a report when the author is below the configured thresholds. */
export function buildAuthorRiskNote(input: {
  accountAgeDays: number;
  karma: number;
  belowAge: boolean;
  belowKarma: boolean;
}): string {
  if (!input.belowAge && !input.belowKarma) return '';
  return ` (new account: ${input.accountAgeDays}d, ${input.karma} karma)`;
}

/**
 * Builds the mod note body.
 *
 * Reddit caps mod notes at 250 characters, so this is assembled
 * highest-value-first and the caller truncates: who verified, when, how many
 * checklist items were ticked, then as much of the note as still fits.
 */
export function buildModNote(input: {
  modName: string;
  dateLabel: string;
  checklist: ChecklistItemResult[] | null;
  note: string;
}): string {
  const parts = [`Fundraiser verified by u/${input.modName} on ${input.dateLabel}.`];

  if (input.checklist && input.checklist.length > 0) {
    const ticked = input.checklist.filter((item) => item.checked).length;
    parts.push(`Checklist ${ticked}/${input.checklist.length}.`);
  }

  if (input.note.length > 0) parts.push(input.note);

  return parts.join(' ');
}

/** Substitutes `{name}` tokens. Unknown tokens are left alone, not blanked.
 *
 * Leaving them alone matters: a moderator who mistypes a placeholder sees the
 * literal text in the posted comment and can spot their error, rather than
 * silently posting a sentence with a hole in it.
 */
function applyPlaceholders(template: string, values: Readonly<Record<string, string>>): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${name}}`, value);
  }
  return rendered;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/**
 * The reply posted to an OP when AutoModerator holds their fundraiser.
 *
 * It must read as helpful, not accusatory - the overwhelming majority of these
 * posts are genuine people with a sick animal. It says what is needed, where to
 * send it, and what happens next. It never promises a timeframe.
 */
export const DEFAULT_INTAKE_TEMPLATE = [
  '{op}, your post is held for review while the r/{subreddit} mod team checks the details. This is routine for every fundraiser here and is not an accusation.',
  '',
  '**To get it approved, please [send us a modmail](https://www.reddit.com/message/compose?to=/r/{subreddit}) with:**',
  '',
  '1. The vet bill or treatment estimate, showing the clinic name and your name.',
  '2. A photo of the animal together with a handwritten note showing your Reddit username and the date.',
  '3. The clinic phone number, so we can confirm the treatment.',
  '4. The fundraiser link, and who receives the money.',
  '',
  'Please **do not** post these documents publicly, they usually contain your address and phone number. Send them by modmail only.',
  '',
  'Once we have checked them, your post is approved automatically and a verification notice is added to it.',
].join('\n');

/**
 * The reply posted to an OP when AutoModerator holds their fundraiser.
 *
 * It must read as helpful, not accusatory - the overwhelming majority of
 * these posts are genuine people with a sick animal. It says what is needed,
 * where to send it, and what happens next. It never promises a timeframe.
 */
export function renderIntakeComment(input: {
  /** Subreddit override; blank means the built-in wording. */
  custom: string;
  subredditName: string;
  authorName: string | null;
}): string {
  return applyPlaceholders(input.custom.trim() || DEFAULT_INTAKE_TEMPLATE, {
    subreddit: input.subredditName,
    op: input.authorName ? `u/${input.authorName}` : 'Hi there',
  });
}

/**
 * One-line author summary shown to the moderator on the verify form.
 *
 * Shown to MODERATORS only, never published. It is context for a human
 * decision, deliberately not a score and not a recommendation.
 */
export function formatAuthorSummary(input: {
  username: string;
  accountAgeDays: number;
  karma: number;
  heldAtLabel: string | null;
  /** Dates of fundraisers this app verified for them before, newest first. */
  previousVerifiedDates: readonly string[];
}): string {
  const age =
    input.accountAgeDays >= 365
      ? `${Math.floor(input.accountAgeDays / 365)}y`
      : `${input.accountAgeDays}d`;
  const karma =
    input.karma >= 1000 ? `${(input.karma / 1000).toFixed(1)}k` : String(input.karma);

  const parts = [`u/${input.username}`, `account ${age}`, `${karma} karma`];
  if (input.heldAtLabel) parts.push(`held ${input.heldAtLabel}`);

  const previous = input.previousVerifiedDates;
  if (previous.length === 0) {
    parts.push('no previous fundraiser verified here');
  } else {
    // The count is the signal; the dates are the detail. Shown even when the
    // posts themselves were later deleted, which is the point of keeping it.
    const shown = previous.slice(0, 3).join(', ');
    const more = previous.length > 3 ? `, +${previous.length - 3} more` : '';
    parts.push(
      `${previous.length} previous verified (${shown}${more})`,
    );
  }

  return parts.join(' \u00b7 ');
}

/* ------------------------------------------------------------------------ */
/* Follow-up on a fundraiser that has gone quiet                             */
/* ------------------------------------------------------------------------ */

export const FOLLOW_UP_TEXT = {
  title: 'Fundraiser follow-up',
  accept: 'Run it',
  cancel: 'Cancel',
  stepLabel: 'What should happen now',
  stepHelp:
    'This runs the same steps the nightly check runs, immediately, without waiting out the configured days.',
  nextOption: 'Whatever the nightly check would do next',
  remindOption: 'Ask the OP for an update now',
  escalateOption: 'Report to the modqueue now',
} as const;

/**
 * The follow-up form's description: everything the app knows about this post,
 * in plain sentences.
 *
 * A moderator is about to report or lock someone's fundraiser, so the form has
 * to say what state the post is actually in and what the button will do. It
 * must never be vague about the lock, which is the one visible consequence.
 */
export function followUpDescription(input: {
  daysSinceVerified: number;
  daysSinceReminder: number | null;
  escalated: boolean;
  opResponded: boolean;
  reminderDays: number;
  graceDays: number;
  remindersEnabled: boolean;
  lockStalePosts: boolean;
}): string {
  const parts: string[] = [`Verified ${dayCount(input.daysSinceVerified)} ago.`];

  if (input.daysSinceReminder === null) {
    parts.push('No update has been requested yet.');
  } else {
    parts.push(`The OP was asked for an update ${dayCount(input.daysSinceReminder)} ago.`);
  }

  if (input.opResponded) parts.push('The OP has replied since.');
  if (input.escalated) parts.push('This post has already been reported to the modqueue.');

  parts.push(
    input.remindersEnabled
      ? `Normally the OP is asked after ${dayCount(input.reminderDays)} and the post is reported ${dayCount(input.graceDays)} later.`
      : 'The nightly check is switched off, so nothing happens on its own.',
  );

  parts.push(
    input.lockStalePosts
      ? 'Reporting will also LOCK the post, because that setting is on.'
      : 'Reporting does not lock or remove the post.',
  );

  return parts.join(' ');
}

/** "1 day" / "30 days", so sentences never read "1 days". */
function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

export const FOLLOW_UP_TOASTS = {
  reminded: 'Asked the OP for an update. The comment is on the post now.',
  noRecord: 'This post has not been verified by the app, so there is nothing to follow up.',
  notVerified: 'A verification for this post is still in progress. Try again in a few seconds.',
  deleted: 'That post has been deleted, so the app has stopped chasing it.',
  postMissing: 'That post no longer exists on Reddit. The app has stopped chasing it.',
  busy: 'Another follow-up for this post is already running. Give it a few seconds.',
  disabled: 'The app is switched off. Turn it back on from "Fundraiser tools settings".',
} as const;

export function escalatedToast(locked: boolean): string {
  return locked
    ? 'Reported to the modqueue and locked the post.'
    : 'Reported to the modqueue. The post is not locked.';
}

export function alreadyRemindedToast(dateLabel: string): string {
  return `The OP was already asked on ${dateLabel}. No second comment was posted.`;
}

export function alreadyEscalatedToast(dateLabel: string): string {
  return `Already reported to the modqueue on ${dateLabel}. Nothing was done again.`;
}

/* ------------------------------------------------------------------------ */
/* Wiki log diagnostic                                                       */
/* ------------------------------------------------------------------------ */

export const WIKI_CHECK_TEXT = {
  off: 'The wiki log is switched off. Turn on "Keep a durable verification log" in the settings menu.',
} as const;

export function wikiCheckReadyToast(input: {
  page: string;
  rows: number;
  createdNow: boolean;
}): string {
  const state = input.createdNow
    ? 'Created the page and confirmed it is moderator-only'
    : 'Confirmed the page is moderator-only';
  const rows =
    input.rows === 0
      ? 'no verifications logged yet'
      : `${input.rows} verification${input.rows === 1 ? '' : 's'} logged`;
  return `${state}: ${input.page} (${rows}).`;
}

export function wikiCheckBlockedToast(reason: string): string {
  return truncate(
    `Nothing will be written to the wiki log: ${reason} The usual cause is the wiki being disabled for this community.`,
    300,
  );
}
