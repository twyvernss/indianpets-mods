import { context } from '@devvit/web/server';
import type { T3, UiResponse } from '@devvit/web/shared';
import { Hono } from 'hono';
import { CONFIG } from '../config.js';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import {
  CHECKLIST_FIELD,
  FOLLOW_UP_FIELD,
  isMessageChoice,
  isSettingsSection,
  LOOKUP_FIELD,
  noticeEditorResponse,
  PICK_FIELD,
  pickedValue,
  settingsFormResponse,
} from '../formDefinitions.js';
import { describeError } from '../lib/logger.js';
import {
  sanitizeMultiline,
  sanitizeText,
  toBoolean,
  toNonEmptyString,
} from '../lib/sanitize.js';
import type { FollowUpStep } from '../services/reminders.js';
import { messageTemplatesToText, pickOverrides } from '../settings.js';
import { TOASTS } from '../text.js';
import type { MessageTemplate, VerifyFormValues } from '../types.js';
import { followUpResponse, historyResponse, toastFor, UNEXPECTED_ERROR } from './responses.js';

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
    if (body['section'] === 'reset') {
      return c.json<UiResponse>({
        showToast: { text: 'Nothing was reset.', appearance: 'neutral' },
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

/** Step 2 of the settings editor: open the section that was picked. */
forms.post('/settings-pick', async (c) => {
  const { log, settings, gate, reddit } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({ showToast: { text: TOASTS.notModerator, appearance: 'neutral' } });
    }

    const body = await c.req.json<Record<string, unknown>>();
    const section = pickedValue(body[PICK_FIELD]);
    if (!isSettingsSection(section)) {
      return c.json<UiResponse>({ showToast: { text: 'Pick a section first.', appearance: 'neutral' } });
    }

    // Flairs are only needed for the section that shows the flair menu.
    const [current, flairs] = await Promise.all([
      settings.get(),
      section === 'fundraisers' ? reddit.getPostFlairs() : Promise.resolve([]),
    ]);
    return c.json<UiResponse>(settingsFormResponse(current, flairs, section));
  } catch (error) {
    log.error('settings-pick failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/** Step 2 of the bot-messages editor: open the message that was picked. */
forms.post('/notices-pick', async (c) => {
  const { log, settings, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({ showToast: { text: TOASTS.notModerator, appearance: 'neutral' } });
    }

    const body = await c.req.json<Record<string, unknown>>();
    const choice = pickedValue(body[PICK_FIELD]);
    if (!isMessageChoice(choice)) {
      return c.json<UiResponse>({ showToast: { text: 'Pick a message first.', appearance: 'neutral' } });
    }
    return c.json<UiResponse>(noticeEditorResponse(await settings.get(), choice));
  } catch (error) {
    log.error('notices-pick failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * Saves the one message that was edited.
 *
 * A saved notice needs both a title and a message to appear when verifying;
 * clearing the title deletes it. The other notices are written back as they
 * are, so editing one never disturbs the rest.
 */
forms.post('/notices-submit', async (c) => {
  const { log, config, gate, settings } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const body = await c.req.json<Record<string, unknown>>();
    const choice = typeof body['choice'] === 'string' ? body['choice'] : '';
    if (!isMessageChoice(choice)) {
      return c.json<UiResponse>({ showToast: { text: 'That message could not be saved.', appearance: 'neutral' } });
    }

    const text = sanitizeMultiline(body['body'], CONFIG.templateBodyMaxLength);

    if (choice === 'default' || choice === 'automod' || choice === 'reminder') {
      const key =
        choice === 'default' ? 'customNoticeText' : choice === 'automod' ? 'automodReplyText' : 'customReminderText';
      await config.merge({ [key]: text });
      log.info('bot message updated', { mod: username, choice });
      return c.json<UiResponse>({
        showToast: {
          text: text.length > 0 ? 'Saved.' : 'Saved. The built-in wording is used.',
          appearance: 'success',
        },
      });
    }

    const index = Number(choice.slice(5));
    const label = sanitizeText(body['title'], CONFIG.templateLabelMaxLength);
    const current = await settings.get();
    const notices: (MessageTemplate | null)[] = Array.from(
      { length: Math.max(current.messageTemplates.length, index + 1) },
      (_, slot) => current.messageTemplates[slot] ?? null,
    );
    notices[index] = label.length > 0 && text.length > 0 ? { id: '', label, body: text } : null;

    const kept = notices
      .filter((notice): notice is MessageTemplate => notice !== null)
      .map((notice, slot) => ({ ...notice, id: `tpl${slot}` }));
    // Stored blank when every notice is gone, which the settings layer reads
    // as "fall back to the starter notices".
    await config.merge({ messageTemplates: kept.length > 0 ? messageTemplatesToText(kept) : '' });
    log.info('saved notice updated', { mod: username, slot: index, count: kept.length });

    return c.json<UiResponse>({
      showToast: {
        text: notices[index] ? `Saved. ${kept.length} notice${kept.length === 1 ? '' : 's'} to pick from.` : 'Notice removed.',
        appearance: 'success',
      },
    });
  } catch (error) {
    log.error('notices-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/** Narrows the submitted step to the three values the service accepts. */
function readStep(value: unknown): FollowUpStep | 'next' {
  const raw = readSelected(value);
  return raw === 'remind' || raw === 'escalate' ? raw : 'next';
}

/**
 * The follow-up form submission.
 *
 * The target post comes from the server-minted token, never from the request
 * body, and the acting moderator is re-checked here: this endpoint can report
 * and lock a post.
 */
forms.post('/follow-up-submit', async (c) => {
  const { log, reminders, gate, tokens } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const body = await c.req.json<Record<string, unknown>>();
    const token = toNonEmptyString(body['token']);

    // Token first, for the reason given in the verify flow; `context.postId` is
    // the documented fallback and is equally platform-supplied. A post id from
    // the form body is never trusted.
    let postId: T3 | null = null;
    if (token) {
      const payload = await tokens.resolve(token);
      // A token that was supplied but did not resolve means the window lapsed.
      // Falling back would silently defeat it, so this fails closed.
      if (!payload) {
        return c.json<UiResponse>({
          showToast: { text: TOASTS.expired, appearance: 'neutral' },
        });
      }
      if (payload.modName.toLowerCase() !== username.toLowerCase()) {
        return c.json<UiResponse>({
          showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
        });
      }
      postId = payload.postId;
      await tokens.consume(token);
    } else {
      postId = contextPostId();
    }

    if (!postId) {
      return c.json<UiResponse>({ showToast: { text: TOASTS.notAPost, appearance: 'neutral' } });
    }

    const step = readStep(body[FOLLOW_UP_FIELD]);
    const result = await reminders.runFollowUp({ postId, step });

    log.info('follow-up run', { postId, step, outcome: result.kind, mod: username });
    return c.json<UiResponse>(followUpResponse(result));
  } catch (error) {
    log.error('follow-up-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/** "Look up a poster's history" submitted: rebuild their page and open it. */
forms.post('/user-lookup-submit', async (c) => {
  const { log, gate, reddit, history } = getContainer();

  try {
    const moderator = await gate.actingUsername();
    if (!moderator || !(await gate.isModerator(moderator))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const body = await c.req.json<Record<string, unknown>>();
    const typed = sanitizeText(body[LOOKUP_FIELD], 40).replace(/^\/?u\//iu, '').trim();
    if (!/^[\w-]{3,20}$/u.test(typed)) {
      return c.json<UiResponse>({
        showToast: { text: `"${typed}" is not a valid Reddit username.`, appearance: 'neutral' },
      });
    }

    const result = await history.open(typed);
    log.info('poster history looked up', { mod: moderator, kind: result.kind });
    return c.json<UiResponse>(historyResponse(result, typed, reddit.subredditName()));
  } catch (error) {
    log.error('user-lookup-submit failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});
