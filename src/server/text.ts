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

export function statusToast(
  modName: string,
  dateLabel: string,
  hasChecklist: boolean,
  hasNote: boolean,
): string {
  const extras: string[] = [];
  if (hasChecklist) extras.push('checklist filled');
  if (hasNote) extras.push('note attached');
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return `Verified by u/${modName} on ${dateLabel}${suffix}.`;
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
export function buildVerificationComment(input: {
  subredditName: string;
  dateLabel: string;
  /** Null when the setting to name the moderator is off (the default). */
  modName: string | null;
  /** Subreddit-configured override; blank means use the built-in wording. */
  customText: string;
}): string {
  const attribution = input.modName ? `u/${input.modName}` : 'the moderator team';

  if (input.customText.trim().length > 0) {
    return applyPlaceholders(input.customText, {
      subreddit: input.subredditName,
      date: input.dateLabel,
      mod: attribution,
    });
  }

  return [
    `## Fundraiser verification — r/${input.subredditName} mod team`,
    '',
    `The moderators of r/${input.subredditName} have reviewed documents submitted privately by the original poster for this fundraiser, and they were consistent with the fundraiser described here.`,
    '',
    '**This is not a guarantee.** We cannot audit how donated money is actually spent, we are not involved in this fundraiser, and documents can be forged or circumstances can change after a check is done. Please donate at your own discretion, and only what you can comfortably afford.',
    '',
    `If something about this fundraiser looks wrong, report this post or [message the moderators](https://www.reddit.com/message/compose?to=/r/${input.subredditName}) — do not accuse people in the comments.`,
    '',
    '---',
    '',
    `^(Posted automatically by the r/${input.subredditName} moderator team's bot on ${input.dateLabel}.` +
      // Only rendered when the subreddit has explicitly opted in to naming the
      // moderator. The default keeps the check anonymous.
      `${input.modName ? ` Verified by u/${input.modName}.` : ''}` +
      ` Replies to this comment are not read — please use modmail.)`,
  ].join('\n');
}

/**
 * The staleness reminder posted on a fundraiser that has gone quiet.
 *
 * It is addressed to the OP, asks for one specific thing, and says what happens
 * next. It must never imply the fundraiser is suspect - most are simply still
 * running.
 */
export function buildReminderComment(input: {
  subredditName: string;
  authorName: string | null;
  daysSinceVerified: number;
  graceDays: number;
}): string {
  const greeting = input.authorName ? `u/${input.authorName}` : 'Hi there';

  return [
    `${greeting} — this fundraiser was verified by the r/${input.subredditName} mod team ${input.daysSinceVerified} days ago.`,
    '',
    'Could you post a short update as a reply here? Either:',
    '',
    '- how the treatment or rescue is going, and whether you still need help, or',
    '- that the fundraiser is **complete** and no longer taking donations.',
    '',
    `Keeping this current helps people decide whether to donate. If we do not hear anything in the next ${input.graceDays} days, a moderator will take a look at the post.`,
    '',
    '---',
    '',
    `^(Automated reminder from the r/${input.subredditName} moderator team's bot. Reply here — this comment is monitored for your reply only; for anything else please use modmail.)`,
  ].join('\n');
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
 * A same-author repost is reported with different wording so moderators can
 * tell at a glance whether they are looking at someone re-sharing their own
 * campaign (common and usually fine) or two different accounts pushing the same
 * link (the case worth investigating).
 */
export function buildDuplicateReportReason(finding: DuplicateFinding): string {
  const original = finding.originalAuthor ? `u/${finding.originalAuthor}` : 'a deleted account';
  const shortNote = finding.shortened ? ' [short link, destination unchecked]' : '';

  const reason = finding.sameAuthor
    ? `Repost: same link as this author's earlier post ${finding.originalPostId}${shortNote}`
    : `Same fundraiser link as post ${finding.originalPostId} by ${original}${shortNote}`;

  return truncate(reason, CONFIG.reportReasonMaxLength);
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

function applyPlaceholders(
  template: string,
  values: Readonly<Record<'subreddit' | 'date' | 'mod', string>>,
): string {
  return template
    .replaceAll('{subreddit}', values.subreddit)
    .replaceAll('{date}', values.date)
    .replaceAll('{mod}', values.mod);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
