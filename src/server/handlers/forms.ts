import { context } from '@devvit/web/server';
import type { T3, UiResponse } from '@devvit/web/shared';
import { Hono } from 'hono';
import { CONFIG } from '../config.js';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import { checklistFormResponse } from '../formDefinitions.js';
import { describeError } from '../lib/logger.js';
import { sanitizeText, toBoolean, toNonEmptyString } from '../lib/sanitize.js';
import { pickOverrides } from '../settings.js';
import { TOASTS } from '../text.js';
import type { ChecklistFormValues, VerifyFormValues } from '../types.js';
import { toastFor, UNEXPECTED_ERROR } from './responses.js';

export const forms = new Hono();

/** The post the platform says this request is about, if it says anything. */
function contextPostId(): T3 | null {
  return typeof context.postId === 'string' ? asPostId(context.postId) : null;
}

/**
 * Step one: note + "fill in the checklist?".
 *
 * Either opens the checklist form or performs the verification immediately.
 * The quick path ends here, which is the whole point of the design.
 */
forms.post('/verify-submit', async (c) => {
  const { log, verification } = getContainer();

  try {
    const body = await c.req.json<VerifyFormValues>();
    const note = sanitizeText(body.note, CONFIG.noteMaxLength);
    const token = toNonEmptyString(body.token);

    if (toBoolean(body.showChecklist)) {
      const opened = await verification.openChecklist({ token, contextPostId: contextPostId() });

      if (opened.kind === 'ready') {
        return c.json<UiResponse>(checklistFormResponse(opened.token, note, opened.items));
      }
      return c.json<UiResponse>({
        showToast: {
          text: opened.kind === 'expired' ? TOASTS.expired : TOASTS.notModerator,
          appearance: 'neutral',
        },
      });
    }

    const outcome = await verification.complete({
      token,
      contextPostId: contextPostId(),
      note,
      checklistAnswers: null,
    });
    return c.json<UiResponse>(toastFor(outcome));
  } catch (error) {
    log.error('verify-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * Step two: the optional checklist.
 *
 * Tick-box names are dynamic (the list is subreddit-configurable), so the raw
 * answers are collected here and paired with their labels inside the service,
 * using the list recorded against the token.
 */
forms.post('/checklist-submit', async (c) => {
  const { log, verification } = getContainer();

  try {
    const body = await c.req.json<ChecklistFormValues>();

    const answers: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(body)) {
      // Only positional checklist ids; never `token`, `note` or anything else.
      if (/^item\d+$/u.test(key)) answers[key] = toBoolean(value);
    }

    const outcome = await verification.complete({
      token: toNonEmptyString(body.token),
      contextPostId: contextPostId(),
      note: sanitizeText(body.note, CONFIG.noteMaxLength),
      checklistAnswers: answers,
    });
    return c.json<UiResponse>(toastFor(outcome));
  } catch (error) {
    log.error('checklist-submit failed', { reason: describeError(error) });
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
