import type { UiResponse } from '@devvit/web/shared';
import { formatVerifiedDate } from '../services/verification.js';
import { alreadyVerifiedToast, TOASTS, verifiedToast } from '../text.js';
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
