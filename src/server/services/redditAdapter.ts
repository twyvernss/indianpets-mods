import { context, reddit, scheduler } from '@devvit/web/server';
import type { WikiPagePermissionLevel } from '@devvit/web/server';
import type { T1, T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';
import type {
  AuthorSnapshot,
  CommentHandle,
  ModNoteInput,
  PostSnapshot,
  RedditPort,
  SchedulerPort,
} from './redditPort.js';

/**
 * The real implementations of {@link RedditPort} and {@link SchedulerPort},
 * backed by `@devvit/web/server`.
 *
 * This is the only module in the app that imports the Devvit Reddit client.
 * Every call is wrapped in the shared retry helper, which retries transient
 * failures (429/5xx/timeouts) and re-throws everything else immediately.
 */
/**
 * `WikiPagePermissionLevel.MODS_ONLY`.
 *
 * Devvit re-exports that enum from `@devvit/web/server` with `export type`, so
 * the runtime value cannot be imported - only the type. The numeric value is
 * part of Reddit's wiki API (0 = subreddit permissions, 1 = approved
 * contributors, 2 = mods only) and is stable.
 */
const WIKI_MODS_ONLY = 2 as WikiPagePermissionLevel;

export function createRedditAdapter(log: Logger): RedditPort {
  const run = <T>(label: string, operation: () => Promise<T>): Promise<T> =>
    withRetry(operation, CONFIG.retry, log, label);

  return {
    subredditName(): string {
      return context.subredditName;
    },

    async currentUsername(): Promise<string | null> {
      // `context.username` is populated for user-initiated requests and costs
      // nothing; fall back to an API call only when it is absent.
      if (typeof context.username === 'string' && context.username.length > 0) {
        return context.username;
      }
      const username = await run('getCurrentUsername', () => reddit.getCurrentUsername());
      return username ?? null;
    },

    async isModerator(username: string): Promise<boolean> {
      // Passing `username` filters server-side, so this returns 0 or 1 entries
      // rather than the whole mod list.
      const moderators = await run('getModerators', () =>
        reddit.getModerators({ subredditName: context.subredditName, username }).all(),
      );
      return moderators.length > 0;
    },

    async getPost(postId: T3): Promise<PostSnapshot | null> {
      try {
        const post = await run('getPostById', () => reddit.getPostById(postId));
        return {
          id: postId,
          // A deleted account surfaces as the literal string "[deleted]".
          authorName: post.authorName && post.authorName !== '[deleted]' ? post.authorName : null,
          isApproved: post.isApproved(),
          isRemoved: post.isRemoved(),
          flairText: post.flair?.text ?? null,
        };
      } catch (error) {
        log.warn('post could not be loaded', { postId, reason: describeError(error) });
        return null;
      }
    },

    async approvePost(postId: T3): Promise<void> {
      await run('approve', () => reddit.approve(postId));
    },

    async submitAppComment(postId: T3, text: string): Promise<CommentHandle> {
      // `runAs: 'APP'` posts as the app account (u/indianpets-mods), which is
      // the entire point: no moderator's personal account is attached to this.
      const comment = await run('submitComment', () =>
        reddit.submitComment({ id: postId, text, runAs: 'APP' }),
      );

      return {
        id: comment.id as T1,
        async distinguishAndSticky(): Promise<void> {
          // `true` = also sticky. One call does both, so there is no window in
          // which the comment is pinned but not badged (or vice versa).
          await run('distinguish', () => comment.distinguish(true));
        },
      };
    },

    async addModNote(input: ModNoteInput): Promise<void> {
      await run('addModNote', () =>
        reddit.addModNote({
          subreddit: context.subredditName,
          user: input.username,
          note: input.note,
          redditId: input.postId,
          // No `label`: Devvit's UserNoteLabel enum only offers ban/warning
          // style labels plus SOLID_CONTRIBUTOR/HELPFUL_USER. None of them mean
          // "fundraiser verified", so an unlabelled note is honest.
        }),
      );
    },

    async reportPost(postId: T3, reason: string): Promise<void> {
      // `report` needs the Post model itself, not just an id, so this costs two
      // round trips. It only ever runs on the rare duplicate/stale paths, never
      // on a hot trigger path.
      const post = await run('getPostById(report)', () => reddit.getPostById(postId));
      await run('report', () => reddit.report(post, { reason }));
    },

    async lockPost(postId: T3): Promise<void> {
      const post = await run('getPostById(lock)', () => reddit.getPostById(postId));
      if (!post.isLocked()) await run('lock', () => post.lock());
    },

    async getAuthor(username: string): Promise<AuthorSnapshot | null> {
      try {
        const user = await run('getUserByUsername', () => reddit.getUserByUsername(username));
        if (!user) return null;
        return {
          username: user.username,
          accountAgeDays: Math.max(
            0,
            Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000),
          ),
          karma: user.linkKarma + user.commentKarma,
        };
      } catch (error) {
        log.warn('author could not be loaded', { username, reason: describeError(error) });
        return null;
      }
    },

    async readWikiPage(page: string): Promise<string | null> {
      try {
        const wiki = await run('getWikiPage', () =>
          reddit.getWikiPage(context.subredditName, page),
        );
        return wiki.content;
      } catch {
        // Devvit throws rather than returning null for a page that does not
        // exist yet, which is the normal first-run case.
        return null;
      }
    },

    async ensureWikiPagePrivate(page: string, seedContent: string): Promise<boolean> {
      try {
        const existing = await this.readWikiPage(page);

        if (existing === null) {
          // Seeded with content that names nobody, so the page is never
          // world-readable WITH identifying rows in it, even for an instant.
          await run('createWikiPage', () =>
            reddit.createWikiPage({
              subredditName: context.subredditName,
              page,
              content: seedContent,
              reason: 'Create fundraiser verification log',
            }),
          );
        }

        await run('updateWikiPageSettings', () =>
          reddit.updateWikiPageSettings({
            subredditName: context.subredditName,
            page,
            listed: false,
            permLevel: WIKI_MODS_ONLY,
          }),
        );

        // Read it back. Applying a setting is not the same as it having taken,
        // and this decides whether moderator names get written down.
        const settings = await run('getWikiPageSettings', () =>
          reddit.getWikiPageSettings(context.subredditName, page),
        );

        const isPrivate = Number(settings.permLevel) === Number(WIKI_MODS_ONLY);
        if (!isPrivate) {
          log.error('wiki log page is NOT restricted to moderators; refusing to write to it', {
            page,
            permLevel: String(settings.permLevel),
          });
        }
        return isPrivate;
      } catch (error) {
        log.error('could not confirm the wiki log page is private', {
          page,
          reason: describeError(error),
        });
        return false;
      }
    },

    async writeWikiPage(page: string, content: string, reason: string): Promise<void> {
      await run('updateWikiPage', () =>
        reddit.updateWikiPage({ subredditName: context.subredditName, page, content, reason }),
      );
    },

    async sendModDiscussion(subject: string, bodyMarkdown: string): Promise<void> {
      await run('modDiscussion', () =>
        reddit.modMail.createModDiscussionConversation({
          subject,
          bodyMarkdown,
          subredditId: context.subredditId,
        }),
      );
    },

    async getPostFlairs(): Promise<{ id: string; text: string }[]> {
      try {
        const templates = await run('getPostFlairTemplates', () =>
          reddit.getPostFlairTemplates(context.subredditName),
        );
        return templates
          .map((template) => ({ id: template.id, text: template.text }))
          .filter((flair) => flair.text.trim().length > 0);
      } catch (error) {
        // A subreddit with no flairs, or a permissions hiccup, must not stop the
        // settings form from opening.
        log.warn('post flairs could not be listed', { reason: describeError(error) });
        return [];
      }
    },
  };
}

export function createSchedulerAdapter(): SchedulerPort {
  return {
    async runJob(job): Promise<string> {
      return scheduler.runJob({ name: job.name, data: job.data, runAt: job.runAt });
    },
  };
}
