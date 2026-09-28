import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { Hono } from 'hono';
import { getContainer } from '../container.js';
import { settingsFormResponse, verifyFormResponse } from '../formDefinitions.js';
import { describeError } from '../lib/logger.js';
import { formatVerifiedDate } from '../services/verification.js';
import { alreadyVerifiedToast, heldByAutomodToast, statusToast, TOASTS } from '../text.js';
import { UNEXPECTED_ERROR } from './responses.js';

export const menu = new Hono();

/**
 * "Verify fundraiser".
 *
 * Does no Reddit writes: it authorises the moderator, rejects a post that is
 * already verified, mints a token and opens the form. Keeping the writes in the
 * form submit means a moderator who opens the form and cancels has changed
 * nothing.
 */
menu.post('/verify-fundraiser', async (c) => {
  const { log, verification } = getContainer();

  try {
    const { targetId } = await c.req.json<MenuItemRequest>();
    const outcome = await verification.begin(targetId);

    switch (outcome.kind) {
      case 'ready':
        return c.json<UiResponse>(verifyFormResponse(outcome.token, outcome.authorSummary));

      case 'already-verified':
        return c.json<UiResponse>({
          showToast: {
            text: alreadyVerifiedToast(
              outcome.record.modName,
              formatVerifiedDate(outcome.record.verifiedAtMs),
            ),
            appearance: 'neutral',
          },
        });

      case 'disabled':
        return c.json<UiResponse>({
          showToast: {
            text: 'The app is switched off. Turn it back on from "Fundraiser tools settings".',
            appearance: 'neutral',
          },
        });

      case 'not-moderator':
        return c.json<UiResponse>({
          showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
        });

      case 'not-a-post':
        return c.json<UiResponse>({ showToast: { text: TOASTS.notAPost, appearance: 'neutral' } });
    }
  } catch (error) {
    log.error('verify-fundraiser menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Fundraiser verification status" - read-only.
 *
 * Useful on its own, and it is also how a moderator confirms what the app
 * recorded without digging through the modlog.
 */
menu.post('/verification-status', async (c) => {
  const { log, verification } = getContainer();

  try {
    const { targetId } = await c.req.json<MenuItemRequest>();
    const outcome = await verification.status(targetId);

    switch (outcome.kind) {
      case 'verified':
        return c.json<UiResponse>({
          showToast: {
            text: statusToast(
              outcome.record.modName,
              formatVerifiedDate(outcome.record.verifiedAtMs),
              outcome.record.checklist !== null,
              outcome.record.note.length > 0,
            ),
            appearance: 'success',
          },
        });

      case 'held-by-automod':
        return c.json<UiResponse>({
          showToast: {
            text: heldByAutomodToast(formatVerifiedDate(outcome.heldAtMs)),
            appearance: 'neutral',
          },
        });

      case 'none':
        return c.json<UiResponse>({ showToast: { text: TOASTS.noRecord, appearance: 'neutral' } });

      case 'not-moderator':
        return c.json<UiResponse>({
          showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
        });

      case 'not-a-post':
        return c.json<UiResponse>({ showToast: { text: TOASTS.notAPost, appearance: 'neutral' } });
    }
  } catch (error) {
    log.error('verification-status menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Fundraiser tools settings" - the subreddit-level editor.
 *
 * Opens a form pre-filled with the EFFECTIVE configuration, so what a moderator
 * sees is what the app is actually doing. Everything is switchable from here
 * without leaving Reddit and without a redeploy.
 */
menu.post('/settings', async (c) => {
  const { log, settings, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    return c.json<UiResponse>(settingsFormResponse(await settings.get()));
  } catch (error) {
    log.error('settings menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});
