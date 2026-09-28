import type { JsonObject, T1, T3 } from '@devvit/web/shared';

/**
 * The app's entire Reddit and scheduler surface, expressed as ports.
 *
 * Handlers and services depend on these types, never on `@devvit/web/server`
 * directly. That keeps the Devvit runtime out of the unit tests and makes the
 * real cost of each operation visible in one place: every method here is at
 * least one network round trip, and the flows are budgeted around that.
 */

/** Just the post fields this app needs. Avoids passing Devvit models around. */
export type PostSnapshot = {
  id: T3;
  /** Null when the account is deleted or the author is unavailable. */
  authorName: string | null;
  isApproved: boolean;
  isRemoved: boolean;
  /** Plain-text post flair, or null. Used to tell fundraisers from other posts. */
  flairText: string | null;
};

/** Author facts used only to annotate a modqueue report. */
export type AuthorSnapshot = {
  username: string;
  accountAgeDays: number;
  karma: number;
};

/**
 * A comment the app just created.
 *
 * `distinguishAndSticky` lives on the handle rather than as a free function
 * taking an id, because Devvit's `submitComment` already returns a live Comment
 * model - calling it here costs nothing, whereas a separate `getCommentById`
 * would add a needless round trip.
 */
export type CommentHandle = {
  readonly id: T1;
  /** `distinguish(true)` applies the green MOD tag AND pins the comment. */
  distinguishAndSticky(): Promise<void>;
};

export type ModNoteInput = {
  username: string;
  postId: T3;
  note: string;
};

export type RedditPort = {
  /** Name of the subreddit this installation is running in. */
  subredditName(): string;
  /** The user who triggered the current request, if any. */
  currentUsername(): Promise<string | null>;
  isModerator(username: string): Promise<boolean>;
  /** Returns null when the post does not exist or cannot be read. */
  getPost(postId: T3): Promise<PostSnapshot | null>;
  approvePost(postId: T3): Promise<void>;
  submitAppComment(postId: T3, text: string): Promise<CommentHandle>;
  addModNote(input: ModNoteInput): Promise<void>;

  /* --- v2 --- */

  /**
   * Sends a post to the modqueue for human review.
   * Never removes anything: reporting is the strongest automated action this
   * app is allowed to take.
   */
  reportPost(postId: T3, reason: string): Promise<void>;
  /** Locks a post. Only ever called when the subreddit has opted in. */
  lockPost(postId: T3): Promise<void>;
  /** Returns null when the account is deleted, suspended or unreadable. */
  getAuthor(username: string): Promise<AuthorSnapshot | null>;
  /**
   * The subreddit's post flair templates, for the settings dropdown.
   * Returns an empty list if the subreddit has none or they cannot be read.
   */
  getPostFlairs(): Promise<{ id: string; text: string }[]>;

  /* --- durable audit log --- */

  /** Current contents of a wiki page, or null if it does not exist yet. */
  readWikiPage(page: string): Promise<string | null>;
  /**
   * Creates or replaces a wiki page. New pages are locked to MODS_ONLY and
   * unlisted, because the log names the people who asked for money here.
   */
  writeWikiPage(page: string, content: string, reason: string): Promise<void>;
  /** Posts to Mod Discussions. Does not involve or notify any user. */
  sendModDiscussion(subject: string, bodyMarkdown: string): Promise<void>;
};

/** The slice of Devvit's scheduler this app uses. */
export type SchedulerPort = {
  /** Queues a one-off job. `name` must match a task declared in devvit.json. */
  runJob(job: { name: string; data: JsonObject; runAt: Date }): Promise<string>;
};
