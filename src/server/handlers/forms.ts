import { context } from '@devvit/web/server';
import type { T3, UiResponse } from '@devvit/web/shared';
import { Hono } from 'hono';
import { CONFIG } from '../config.js';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import { CHECKLIST_FIELD, NOTICE_SLOTS, noticeFieldNames } from '../formDefinitions.js';
import { describeError } from '../lib/logger.js';
import {
  sanitizeMultiline,
  sanitizeText,
  toBoolean,
  toNonEmptyString,
} from '../lib/sanitize.js';
import { messageTemplatesToText, pickOverrides } from '../settings.js';
import { TOASTS } from '../text.js';
import type { MessageTemplate, VerifyFormValues } from '../types.js';
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

/** Reads a single-choice `select` value, which Devvit submits as an array. */
function readSelected(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
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
      // A select submits an array even when only one option is selectable.
      templateId: readSelected(body['template']),
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

/**
 * The verification-notice editor.
 *
 * Numbered title/message pairs are folded back into the same block format the
 * setting has always stored, so nothing downstream changes and a moderator who
 * prefers to edit the raw setting still can. A slot needs BOTH a title and a
 * message to count: a title with no body would post an empty comment, and a
 * body with no title could not be picked from the dropdown.
 */
forms.post('/notices-submit', async (c) => {
  const { log, config, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const body = await c.req.json<Record<string, unknown>>();

    const templates: MessageTemplate[] = [];
    for (let index = 0; index < NOTICE_SLOTS; index++) {
      const names = noticeFieldNames(index);
      const label = sanitizeText(body[names.title], CONFIG.templateLabelMaxLength);
      const text = sanitizeMultiline(body[names.body], CONFIG.templateBodyMaxLength);
      if (label.length === 0 || text.length === 0) continue;
      templates.push({ id: `tpl${templates.length}`, label, body: text });
    }

    await config.merge({
      customNoticeText: sanitizeMultiline(
        body['customNoticeText'],
        CONFIG.templateBodyMaxLength,
      ),
      automodReplyText: sanitizeMultiline(body['automodReplyText'], CONFIG.templateBodyMaxLength),
      customReminderText: sanitizeMultiline(
        body['customReminderText'],
        CONFIG.templateBodyMaxLength,
      ),
      // Stored blank when every slot is empty, which the settings layer reads
      // as "fall back to the starter notices".
      messageTemplates: templates.length > 0 ? messageTemplatesToText(templates) : '',
    });

    log.info('verification notices updated', { mod: username, count: templates.length });

    return c.json<UiResponse>({
      showToast: {
        text:
          templates.length > 0
            ? `Saved. ${templates.length} notice${templates.length === 1 ? '' : 's'} to pick from.`
            : 'Saved. No custom notices, so the starter list is used.',
        appearance: 'success',
      },
    });
  } catch (error) {
    log.error('notices-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});
