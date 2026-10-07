import type { UiResponse } from '@devvit/web/shared';
import type { FollowUpResult } from '../services/reminders.js';
import { formatVerifiedDate } from '../services/verification.js';
import {
  alreadyEscalatedToast,
  alreadyRemindedToast,
  alreadyVerifiedToast,
  escalatedToast,
  FOLLOW_UP_TOASTS,
  TOASTS,
  verifiedToast,
} from '../text.js';
import type { VerifyOutcome } from '../types.js';

/**
 * Maps a verification outcome onto the toast the moderator sees.
 *
 * Every branch says what actually happened. There is deliberately no generic
 * "success" for the partial cases: if the post was approved but the notice
 * could not be pinned, the moderator is told so and what to do about it.
 */
export function toastFor(outcome: VerifyOutcome): UiResponse {
  switch (outcome.kind) {
    case 'ok':
      return { showToast: { text: verifiedToast(formatVerifiedDate(Date.now())), appearance: 'success' } };

    case 'already-verified':
      return {
        showToast: {
          text: alreadyVerifiedToast(
            outcome.record.modName,
            formatVerifiedDate(outcome.record.verifiedAtMs),
          ),
          appearance: 'neutral',
        },
      };

    case 'in-progress':
      return { showToast: { text: TOASTS.inProgress, appearance: 'neutral' } };

    case 'post-missing':
      return { showToast: { text: TOASTS.postMissing, appearance: 'neutral' } };

    case 'expired':
      return { showToast: { text: TOASTS.expired, appearance: 'neutral' } };

    case 'not-moderator':
      return { showToast: { text: TOASTS.notModerator, appearance: 'neutral' } };

    case 'partial':
      return { showToast: { text: outcome.detail, appearance: 'neutral' } };

    case 'failed':
      return { showToast: { text: outcome.detail, appearance: 'neutral' } };
  }
}

/**
 * Maps a follow-up outcome onto its toast.
 *
 * Same principle as above: every branch names what actually happened, and the
 * two "already" branches say explicitly that nothing was repeated - a
 * moderator needs to know a second comment was NOT posted on someone's post.
 */
export function followUpResponse(result: FollowUpResult): UiResponse {
  switch (result.kind) {
    case 'reminded':
      return { showToast: { text: FOLLOW_UP_TOASTS.reminded, appearance: 'success' } };

    case 'escalated':
      return { showToast: { text: escalatedToast(result.locked), appearance: 'success' } };

    case 'already-reminded':
      return {
        showToast: {
          text: alreadyRemindedToast(formatVerifiedDate(result.atMs)),
          appearance: 'neutral',
        },
      };

    case 'already-escalated':
      return {
        showToast: {
          text: alreadyEscalatedToast(formatVerifiedDate(result.atMs)),
          appearance: 'neutral',
        },
      };

    case 'no-record':
      return { showToast: { text: FOLLOW_UP_TOASTS.noRecord, appearance: 'neutral' } };

    case 'not-verified':
      return { showToast: { text: FOLLOW_UP_TOASTS.notVerified, appearance: 'neutral' } };

    case 'deleted':
      return { showToast: { text: FOLLOW_UP_TOASTS.deleted, appearance: 'neutral' } };

    case 'post-missing':
      return { showToast: { text: FOLLOW_UP_TOASTS.postMissing, appearance: 'neutral' } };

    case 'busy':
      return { showToast: { text: FOLLOW_UP_TOASTS.busy, appearance: 'neutral' } };

    case 'disabled':
      return { showToast: { text: FOLLOW_UP_TOASTS.disabled, appearance: 'neutral' } };

    case 'failed':
      return { showToast: { text: result.detail, appearance: 'neutral' } };
  }
}

/**
 * The toast shown when a handler throws unexpectedly.
 *
 * Internal error text never reaches the moderator: it goes to the logs, and
 * the UI gets a message that tells them the action did not complete.
 *
 * It deliberately does NOT claim that nothing changed. An unexpected throw can
 * happen after the post was approved, and telling a moderator "nothing was
 * changed" when something was is worse than telling them to look.
 */
export const UNEXPECTED_ERROR: UiResponse = {
  showToast: {
    text: 'Something went wrong and the action did not complete. Check the post before retrying.',
    appearance: 'neutral',
  },
};
