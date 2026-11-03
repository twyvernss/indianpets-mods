import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { Hono } from 'hono';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import {
  followUpFormResponse,
  noticesFormResponse,
  settingsFormResponse,
  userLookupFormResponse,
  verifyFormResponse,
} from '../formDefinitions.js';
import { describeError } from '../lib/logger.js';
import { wikiPageUrl } from '../services/auditLog.js';
import { formatVerifiedDate } from '../services/verification.js';
import {
  alreadyVerifiedToast,
  FOLLOW_UP_TOASTS,
  followUpDescription,
  heldByAutomodToast,
  SWEEP_DISABLED,
  sweepToast,
  TOASTS,
  WIKI_CHECK_TEXT,
  wikiCheckBlockedToast,
  wikiCheckReadyToast,
} from '../text.js';
import { historyResponse, UNEXPECTED_ERROR } from './responses.js';

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
        return c.json<UiResponse>(
          verifyFormResponse({
            token: outcome.token,
            authorSummary: outcome.authorSummary,
            items: outcome.items,
            compactChecklist: outcome.compactChecklist,
            templates: outcome.templates,
          }),
        );

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
 * "Fundraiser tools settings" - the subreddit-level editor.
 *
 * Opens a form pre-filled with the EFFECTIVE configuration, so what a moderator
 * sees is what the app is actually doing. Everything is switchable from here
 * without leaving Reddit and without a redeploy.
 */
menu.post('/settings', async (c) => {
  const { log, settings, gate, reddit } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const [current, flairs] = await Promise.all([settings.get(), reddit.getPostFlairs()]);
    return c.json<UiResponse>(settingsFormResponse(current, flairs));
  } catch (error) {
    log.error('settings menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Edit verification notices".
 *
 * Separate from the settings action on purpose: these are the only genuinely
 * long fields, and keeping them out of the settings form is what lets that form
 * open promptly on mobile.
 */
menu.post('/notices', async (c) => {
  const { log, settings, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    return c.json<UiResponse>(noticesFormResponse(await settings.get()));
  } catch (error) {
    log.error('notices menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Fundraiser status & follow-up" - one place to see a post's state and act.
 *
 * This used to be two items, a read-only status toast and the follow-up form,
 * which showed the same facts twice. Now: an unverified post gets the status
 * toast (including whether AutoModerator is holding it), and a verified post
 * opens the follow-up form, whose description says who verified it and when.
 * Nothing is written here: the action happens on submit, so a moderator who
 * opens this and cancels has changed nothing.
 */
menu.post('/follow-up', async (c) => {
  const { log, reminders, gate, tokens, verification } = getContainer();

  try {
    const { targetId } = await c.req.json<MenuItemRequest>();
    const postId = asPostId(targetId);
    if (!postId) {
      return c.json<UiResponse>({ showToast: { text: TOASTS.notAPost, appearance: 'neutral' } });
    }

    // Authorised here as well as on submit. `forUserType` only controls who
    // sees the item; this is still a plain HTTP endpoint.
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const state = await reminders.inspectFollowUp(postId);

    switch (state.kind) {
      case 'no-record': {
        const status = await verification.status(postId);
        return c.json<UiResponse>({
          showToast: {
            text:
              status.kind === 'held-by-automod'
                ? heldByAutomodToast(formatVerifiedDate(status.heldAtMs))
                : TOASTS.noRecord,
            appearance: 'neutral',
          },
        });
      }
      case 'not-verified':
        return c.json<UiResponse>({
          showToast: { text: FOLLOW_UP_TOASTS.notVerified, appearance: 'neutral' },
        });
      case 'deleted':
        return c.json<UiResponse>({
          showToast: { text: FOLLOW_UP_TOASTS.deleted, appearance: 'neutral' },
        });
      case 'ready': {
        // Server-minted, so the submit endpoint never has to trust a post id
        // from the client. Same mechanism the verify form uses.
        const token = await tokens.mint({
          postId,
          modName: username,
          createdAtMs: Date.now(),
          checklist: null,
          templates: null,
        });

        return c.json<UiResponse>(
          followUpFormResponse({
            token,
            nextStep: state.nextStep,
            description: followUpDescription({
              verifiedBy: state.record.modName,
              verifiedOn: formatVerifiedDate(state.record.verifiedAtMs),
              daysSinceVerified: state.daysSinceVerified,
              daysSinceReminder: state.daysSinceReminder,
              escalated: state.record.escalatedAtMs !== null,
              opResponded: state.record.opRespondedAtMs !== null,
              reminderDays: state.settings.reminderDays,
              graceDays: state.settings.graceDays,
              remindersEnabled: state.settings.staleRemindersEnabled,
              lockStalePosts: state.settings.lockStalePosts,
            }),
          }),
        );
      }
    }
  } catch (error) {
    log.error('follow-up menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Check the wiki log" - proves the durable log actually works.
 *
 * Runs the real privacy check against the real page for this month, reports
 * what it found, and drops the moderator on the page so they can see it.
 */
menu.post('/wiki-check', async (c) => {
  const { log, audit, gate, reddit } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const result = await audit.check();

    switch (result.kind) {
      case 'off':
        return c.json<UiResponse>({
          showToast: { text: WIKI_CHECK_TEXT.off, appearance: 'neutral' },
        });

      case 'blocked':
        return c.json<UiResponse>({
          showToast: { text: wikiCheckBlockedToast(result.reason), appearance: 'neutral' },
        });

      case 'ready':
        // Toast and navigation together: the toast is the verdict, the page is
        // the evidence. Both fields of UiResponse are independent.
        return c.json<UiResponse>({
          showToast: { text: wikiCheckReadyToast(result), appearance: 'success' },
          navigateTo: wikiPageUrl(reddit.subredditName(), result.openPage),
        });
    }
  } catch (error) {
    log.error('wiki-check menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Run the nightly check now".
 *
 * The same sweep the 03:00 cron runs, on demand. It does NOT bypass the
 * configured waiting periods - that is the point. It answers "is the schedule
 * working?", whereas the per-post follow-up answers "does the action work?".
 */
menu.post('/run-sweep', async (c) => {
  const { log, reminders, settings, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const config = await settings.get();
    if (!config.enabled || !config.staleRemindersEnabled) {
      return c.json<UiResponse>({ showToast: { text: SWEEP_DISABLED, appearance: 'neutral' } });
    }

    const result = await reminders.sweep({ offset: 0, batchIndex: 0 });
    log.info('sweep run by hand', { mod: username, ...result });

    return c.json<UiResponse>({
      showToast: {
        text: sweepToast(result),
        appearance: result.examined > 0 ? 'success' : 'neutral',
      },
    });
  } catch (error) {
    log.error('run-sweep menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/**
 * "Poster history & matches" - on a post.
 *
 * Rebuilds the poster's moderator-only wiki page and opens it. The toast names
 * the account their posts match most closely, and whether it is banned here,
 * which answers the ban-evasion question without opening the page at all.
 */
menu.post('/poster-history', async (c) => {
  const { log, gate, reddit, history } = getContainer();

  try {
    const { targetId } = await c.req.json<MenuItemRequest>();
    const postId = asPostId(targetId);
    if (!postId) {
      return c.json<UiResponse>({ showToast: { text: TOASTS.notAPost, appearance: 'neutral' } });
    }

    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }

    const post = await reddit.getPost(postId);
    if (!post?.authorName) {
      return c.json<UiResponse>({
        showToast: { text: "This post's author account is deleted, so it has no history.", appearance: 'neutral' },
      });
    }

    // A post made before matching existed has no fingerprint yet; this one is
    // taken on the spot so its matches show immediately.
    const result = await history.rebuild(post.authorName, { ensureIndexed: postId });
    log.info('poster history opened', { mod: username, kind: result.kind });
    return c.json<UiResponse>(historyResponse(result, post.authorName, reddit.subredditName()));
  } catch (error) {
    log.error('poster-history menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});

/** "Look up a poster's history" - subreddit menu. Opens the username form. */
menu.post('/user-lookup', async (c) => {
  const { log, gate } = getContainer();

  try {
    const username = await gate.actingUsername();
    if (!username || !(await gate.isModerator(username))) {
      return c.json<UiResponse>({
        showToast: { text: TOASTS.notModerator, appearance: 'neutral' },
      });
    }
    return c.json<UiResponse>(userLookupFormResponse());
  } catch (error) {
    log.error('user-lookup menu action failed', { reason: describeError(error) });
    return c.json<UiResponse>(UNEXPECTED_ERROR);
  }
});
