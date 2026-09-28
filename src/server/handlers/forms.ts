import { context } from '@devvit/web/server';
import type { T3, UiResponse } from '@devvit/web/shared';
import { Hono } from 'hono';
import { CONFIG } from '../config.js';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import { CHECKLIST_FIELD } from '../formDefinitions.js';
import { describeError } from '../lib/logger.js';
import { sanitizeText, toBoolean, toNonEmptyString } from '../lib/sanitize.js';
import { pickOverrides } from '../settings.js';
import { TOASTS } from '../text.js';
import type { VerifyFormValues } from '../types.js';
import { toastFor, UNEXPECTED_ERROR } from './responses.js';

export const forms = new Hono();

/** The post the platform says this request is about, if it says anything. */
function contextPostId(): T3 | null {
  return typeof context.postId === 'string' ? asPostId(context.postId) : null;
}

/**
 * Reads the checklist answers out of the submitted form.
 *
 * The verify form renders the checklist one of two ways, so both shapes are
 * accepted:
 *  - compact: a single multi-select, whose value is an array of item ids;
 *  - toggles: one boolean field per item, named `item0`, `item1`, ...
 *
 * Returns null when nothing was ticked, which the service treats as "the
 * moderator used the quick path" rather than "every item was answered no".
 */
function readChecklistAnswers(body: Record<string, unknown>): Record<string, boolean> | null {
  const answers: Record<string, boolean> = {};

  const selected = body[CHECKLIST_FIELD];
  if (Array.isArray(selected)) {
    for (const value of selected) {
      if (typeof value === 'string' && /^item\d+$/u.test(value)) answers[value] = true;
    }
  }

  for (const [key, value] of Object.entries(body)) {
    // Only positional checklist ids; never `token`, `note` or anything else.
    if (/^item\d+$/u.test(key) && toBoolean(value)) answers[key] = true;
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

/**
 * The one and only verify form submission.
 *
 * Note and checklist arrive together, so a moderator presses Verify once.
 */
forms.post('/verify-submit', async (c) => {
  const { log, verification } = getContainer();

  try {
    const body = await c.req.json<VerifyFormValues & Record<string, unknown>>();

    const outcome = await verification.complete({
      token: toNonEmptyString(body.token),
      contextPostId: contextPostId(),
      note: sanitizeText(body.note, CONFIG.noteMaxLength),
      checklistAnswers: readChecklistAnswers(body),
    });
    return c.json<UiResponse>(toastFor(outcome));
  } catch (error) {
    log.error('verify-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * The in-subreddit settings editor.
 *
 * Writes a runtime override that wins over the devvit.json settings and takes
 * effect on the very next action. Moderator status is re-checked here: this
 * endpoint changes how the app behaves for the whole subreddit.
 */
forms.post('/settings-submit', async (c) => {
  const { log, config, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const body = await c.req.json<Record<string, unknown>>();

    if (toBoolean(body['resetAll'])) {
      await config.clear();
      log.info('settings reset to defaults', { mod: username });
      return c.json<UiResponse>({
        showToast: { text: 'Settings reset to the app defaults.', appearance: 'success' },
      });
    }

    // `pickOverrides` drops anything that is not a known, overridable key, so a
    // crafted request cannot write arbitrary data into the config document.
    await config.merge(pickOverrides(body));
    log.info('settings updated', { mod: username });

    return c.json<UiResponse>({
      showToast: { text: 'Settings saved. They apply from now on.', appearance: 'success' },
    });
  } catch (error) {
    log.error('settings-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});
