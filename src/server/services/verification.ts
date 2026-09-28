import type { T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import type { TokenRepo } from '../data/tokenRepo.js';
import { asPostId } from '../data/tokenRepo.js';
import type { VerificationRepo } from '../data/verificationRepo.js';
import { completeRecord, newPendingRecord } from '../data/verificationRepo.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { formatDisplayDate } from '../lib/time.js';
import type { SettingsReader } from '../settings.js';
import { buildModNote, buildVerificationComment } from '../text.js';
import type {
  ChecklistItem,
  ChecklistItemResult,
  VerificationRecord,
  VerifyOutcome,
} from '../types.js';
import type { ModeratorGate } from './moderator.js';
import type { RedditPort } from './redditPort.js';

export type BeginOutcome =
  | { kind: 'ready'; token: string }
  | { kind: 'already-verified'; record: VerificationRecord }
  | { kind: 'not-moderator' }
  | { kind: 'not-a-post' }
  | { kind: 'disabled' };

export type ChecklistOutcome =
  | { kind: 'ready'; token: string; items: ChecklistItem[] }
  | { kind: 'expired' }
  | { kind: 'not-moderator' };

export type StatusOutcome =
  | { kind: 'verified'; record: VerificationRecord }
  | { kind: 'held-by-automod'; heldAtMs: number }
  | { kind: 'none' }
  | { kind: 'not-moderator' }
  | { kind: 'not-a-post' };

export type VerificationDeps = {
  repo: VerificationRepo;
  tokens: TokenRepo;
  reddit: RedditPort;
  gate: ModeratorGate;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
  /** Unique id source for lock ownership. Injected so tests are deterministic. */
  newId: () => string;
};

export type VerificationService = {
  /** Called by the menu action, before the form is shown. */
  begin(targetId: string): Promise<BeginOutcome>;

  /**
   * Called when a moderator asks for the checklist on the first form.
   * Resolves the configured items and records them against the token, so the
   * labels stored later are exactly the ones that were displayed.
   */
  openChecklist(input: { token: string | null; contextPostId: T3 | null }): Promise<ChecklistOutcome>;

  /**
   * Called by the form submit handlers.
   *
   * `token` is the primary path: it is server-minted and proves which post the
   * moderator actually opened the form on.
   *
   * `contextPostId` is a fallback for one documented uncertainty. The token is
   * carried to the submit endpoint through the form's `data` bag, which the
   * Devvit docs show being echoed back for values that have no matching field -
   * but that behaviour is demonstrated by example rather than specified. If the
   * token does not come back, `context.postId` is used instead. That is equally
   * safe: it is supplied by the platform, not the client. Whichever path is
   * taken, moderator status is re-checked server-side.
   */
  complete(input: {
    token: string | null;
    contextPostId: T3 | null;
    note: string;
    /** Raw tick-box answers keyed by field id, or null for the quick path. */
    checklistAnswers: Record<string, boolean> | null;
  }): Promise<VerifyOutcome>;

  /** Read-only status lookup for the second menu action. */
  status(targetId: string): Promise<StatusOutcome>;
};

export function formatVerifiedDate(epochMs: number): string {
  return formatDisplayDate(epochMs, CONFIG.displayTimeZoneOffsetMinutes, CONFIG.displayTimeZoneLabel);
}

export function createVerificationService(deps: VerificationDeps): VerificationService {
  const { repo, tokens, reddit, gate, settings, log, now, newId } = deps;

  /**
   * A stored record blocks a re-run only when it represents finished work.
   * A `pending` row left behind by a crashed request goes stale after
   * `pendingStaleMs` and stops blocking, so a transient failure can never
   * permanently wedge a post.
   */
  function blockingState(
    record: VerificationRecord | null,
    timestamp: number,
  ): 'none' | 'complete' | 'in-progress' {
    if (!record) return 'none';
    if (record.status === 'complete') return 'complete';
    return timestamp - record.verifiedAtMs < CONFIG.pendingStaleMs ? 'in-progress' : 'none';
  }

  async function requireModerator(): Promise<string | null> {
    const username = await gate.actingUsername();
    if (!username) return null;
    return (await gate.isModerator(username)) ? username : null;
  }

  /** Resolves the target post from the token, or the platform-supplied id. */
  async function resolveTarget(
    token: string | null,
    contextPostId: T3 | null,
  ): Promise<{ postId: T3; modName: string | null } | null> {
    if (token) {
      const payload = await tokens.resolve(token);
      // A token that was supplied but did not resolve means the window lapsed.
      // Falling back would silently defeat it, so this fails closed.
      if (!payload) return null;
      return { postId: payload.postId, modName: payload.modName };
    }
    return contextPostId ? { postId: contextPostId, modName: null } : null;
  }

  async function authorise(expectedMod: string | null): Promise<string | null> {
    const username = await requireModerator();
    if (!username) return null;
    if (expectedMod && username.toLowerCase() !== expectedMod.toLowerCase()) return null;
    return username;
  }

  return {
    async begin(targetId: string): Promise<BeginOutcome> {
      const postId = asPostId(targetId);
      if (!postId) return { kind: 'not-a-post' };

      const username = await requireModerator();
      if (!username) {
        log.warn('non-moderator attempted to begin verification', { postId });
        return { kind: 'not-moderator' };
      }

      const config = await settings.get();
      if (!config.enabled) return { kind: 'disabled' };

      // Cheap Redis read. Catching this here saves the moderator from filling in
      // a form for a post that is already done.
      const existing = await repo.get(postId);
      if (blockingState(existing, now()) === 'complete' && existing) {
        return { kind: 'already-verified', record: existing };
      }

      const token = await tokens.mint({
        postId,
        modName: username,
        createdAtMs: now(),
        checklist: null,
      });
      log.info('verification started', { postId, mod: username });
      return { kind: 'ready', token };
    },

    async openChecklist({ token, contextPostId }): Promise<ChecklistOutcome> {
      let activeToken = token;
      const target = await resolveTarget(activeToken, contextPostId);
      if (!target) return { kind: 'expired' };

      const username = await authorise(target.modName);
      if (!username) return { kind: 'not-moderator' };

      // No token came back from the form: mint a fresh one for the platform's
      // post id so the second form still has a trustworthy anchor.
      if (!activeToken) {
        activeToken = await tokens.mint({
          postId: target.postId,
          modName: username,
          createdAtMs: now(),
          checklist: null,
        });
      }

      const { checklistItems } = await settings.get();
      await tokens.attachChecklist(activeToken, checklistItems);

      return { kind: 'ready', token: activeToken, items: checklistItems };
    },

    async complete(input): Promise<VerifyOutcome> {
      const target = await resolveTarget(input.token, input.contextPostId);
      if (!target) return { kind: 'expired' };

      const { postId } = target;
      const scoped = log.child({ postId, tokenUsed: input.token !== null });

      // Re-authorise on submit. The token proves which post was targeted; it
      // does not prove the submitter is still a moderator, or is even the same
      // person. Both are checked again here.
      const username = await authorise(target.modName);
      if (!username) {
        scoped.warn('verification submit rejected');
        return { kind: 'not-moderator' };
      }

      const config = await settings.get();
      if (!config.enabled) return { kind: 'failed', detail: 'The app is currently disabled.' };

      // Pair the submitted answers with the labels that were actually shown.
      const checklist = input.checklistAnswers
        ? await resolveChecklist(input.token, input.checklistAnswers)
        : null;

      if (input.token) await tokens.consume(input.token);

      const startedAt = now();
      const existing = await repo.get(postId);
      const blocked = blockingState(existing, startedAt);
      if (blocked === 'complete' && existing) return { kind: 'already-verified', record: existing };
      if (blocked === 'in-progress') return { kind: 'in-progress' };

      const lockOwner = newId();
      if (!(await repo.acquireLock(postId, lockOwner, startedAt))) {
        return { kind: 'in-progress' };
      }

      try {
        return await runVerification({
          postId,
          username,
          note: input.note,
          checklist,
          startedAt,
          scoped: scoped.child({ mod: username }),
        });
      } finally {
        await repo.releaseLock(postId, lockOwner);
      }
    },

    async status(targetId: string): Promise<StatusOutcome> {
      const postId = asPostId(targetId);
      if (!postId) return { kind: 'not-a-post' };

      const username = await requireModerator();
      if (!username) return { kind: 'not-moderator' };

      const record = await repo.get(postId);
      if (record && record.status === 'complete') return { kind: 'verified', record };

      const heldAtMs = await repo.getAutomodHold(postId);
      if (heldAtMs !== null) return { kind: 'held-by-automod', heldAtMs };

      return { kind: 'none' };
    },
  };

  /**
   * Turns `{ item0: true, item2: true }` into labelled results.
   *
   * Labels come from the token (the exact list the moderator saw). If the token
   * is gone, the current settings are used - slightly worse, never wrong enough
   * to matter, and far better than discarding the moderator's work.
   */
  async function resolveChecklist(
    token: string | null,
    answers: Record<string, boolean>,
  ): Promise<ChecklistItemResult[]> {
    const payload = token ? await tokens.resolve(token) : null;
    const items = payload?.checklist ?? (await settings.get()).checklistItems;
    return items.map((item) => ({ label: item.label, checked: answers[item.id] === true }));
  }

  /**
   * The actual side effects, run under the post lock.
   *
   * Ordering is deliberate:
   *  1. read the post (needed for author + current approval state);
   *  2. write a `pending` record BEFORE touching Reddit, so a crash after the
   *     comment is posted still leaves evidence and a retry cannot double-post;
   *  3. approve and comment CONCURRENTLY - they are independent;
   *  4. distinguish+sticky only once the comment exists;
   *  5. promote the record to `complete`;
   *  6. mod note last, as the only genuinely optional step.
   */
  async function runVerification(args: {
    postId: T3;
    username: string;
    note: string;
    checklist: ChecklistItemResult[] | null;
    startedAt: number;
    scoped: Logger;
  }): Promise<VerifyOutcome> {
    const { postId, username, note, checklist, startedAt, scoped } = args;

    const [post, appSettings] = await Promise.all([reddit.getPost(postId), settings.get()]);
    if (!post) return { kind: 'post-missing' };

    const record = newPendingRecord({
      postId,
      authorName: post.authorName,
      modName: username,
      nowMs: startedAt,
      note,
      checklist,
    });
    await repo.putProvisional(record);

    const dateLabel = formatVerifiedDate(startedAt);
    const commentText = buildVerificationComment({
      subredditName: reddit.subredditName(),
      dateLabel,
      modName: appSettings.showVerifyingModInComment ? username : null,
      customText: appSettings.customNoticeText,
    });

    // Approving an already-approved post is a wasted round trip and an extra
    // modlog entry, so it is skipped when the post is already visible.
    const needsApproval = !post.isApproved || post.isRemoved;
    const [approval, commentResult] = await Promise.allSettled([
      needsApproval ? reddit.approvePost(postId) : Promise.resolve(),
      reddit.submitAppComment(postId, commentText),
    ]);

    if (commentResult.status === 'rejected') {
      // No comment means nothing was actually published. Drop the provisional
      // record so the moderator can simply run the action again.
      await repo.remove(postId);
      scoped.error('verification failed: comment not posted', {
        reason: describeError(commentResult.reason),
      });

      return {
        kind: 'failed',
        detail:
          approval.status === 'fulfilled' && needsApproval
            ? 'The post was approved but the verification comment failed to post. Run "Verify fundraiser" again.'
            : 'Nothing was changed: the verification comment could not be posted. Try again in a moment.',
      };
    }

    const comment = commentResult.value;
    const warnings: string[] = [];

    if (approval.status === 'rejected') {
      warnings.push('the post could not be approved (approve it manually)');
      scoped.error('approve failed', { reason: describeError(approval.reason) });
    }

    try {
      await comment.distinguishAndSticky();
    } catch (error) {
      // The notice is public but not pinned or badged. Worth flagging loudly;
      // not worth undoing a correct comment.
      warnings.push('the notice could not be pinned or distinguished (do it manually)');
      scoped.error('distinguish failed', { commentId: comment.id, reason: describeError(error) });
    }

    await repo.putComplete(completeRecord(record, comment.id));

    if (appSettings.addModNote && post.authorName) {
      try {
        await reddit.addModNote({
          username: post.authorName,
          postId,
          note: buildModNote({ modName: username, dateLabel, checklist, note }).slice(
            0,
            CONFIG.modNoteMaxLength,
          ),
        });
      } catch (error) {
        warnings.push('the mod note could not be added');
        scoped.warn('mod note failed', { reason: describeError(error) });
      }
    }

    scoped.info('verification complete', {
      commentId: comment.id,
      durationMs: now() - startedAt,
      checklistUsed: checklist !== null,
      noteLength: note.length,
      warnings: warnings.length,
    });

    if (warnings.length > 0) {
      return { kind: 'partial', detail: `Verified, but ${warnings.join('; ')}.` };
    }
    return { kind: 'ok', commentId: comment.id };
  }
}
