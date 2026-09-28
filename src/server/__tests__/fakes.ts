import type { JsonObject, T1, T3 } from '@devvit/web/shared';
import type { ConfigRepo } from '../data/configRepo.js';
import type { RedisPort, RedisSetOptions, ZMemberLike } from '../data/redisPort.js';
import type { Logger } from '../lib/logger.js';
import type {
  AuthorSnapshot,
  CommentHandle,
  ModNoteInput,
  PostSnapshot,
  RedditPort,
  SchedulerPort,
} from '../services/redditPort.js';
import type { AppSettings, SettingsReader } from '../settings.js';
import { DEFAULT_SETTINGS } from '../settings.js';

/**
 * Test doubles.
 *
 * These implement the app's ports rather than mocking Devvit itself, which is
 * what makes the service layer testable outside the Devvit runtime.
 */

/** An in-memory Redis that honours `nx` and `expiration`, driven by a fake clock. */
export class FakeRedis implements RedisPort {
  private readonly strings = new Map<string, { value: string; expiresAtMs: number | null }>();
  private readonly sortedSets = new Map<string, Map<string, number>>();

  /** Mutable so a test can advance time and observe expiry. */
  public nowMs = 1_700_000_000_000;

  /** Lets a test assert that a batched read really was one call. */
  public mGetCalls = 0;

  private live(key: string): { value: string; expiresAtMs: number | null } | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.nowMs) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string> {
    if (options?.nx && this.live(key) !== undefined) return value;
    this.strings.set(key, {
      value,
      expiresAtMs: options?.expiration ? options.expiration.getTime() : null,
    });
    return value;
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.strings.delete(key);
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    this.mGetCalls += 1;
    return keys.map((key) => this.live(key)?.value ?? null);
  }

  async zAdd(key: string, ...members: ZMemberLike[]): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    let added = 0;
    for (const entry of members) {
      if (!set.has(entry.member)) added += 1;
      set.set(entry.member, entry.score);
    }
    this.sortedSets.set(key, set);
    return added;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) if (set.delete(member)) removed += 1;
    return removed;
  }

  async zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: {
      by: 'score' | 'lex' | 'rank';
      reverse?: boolean;
      limit?: { offset: number; count: number };
    },
  ): Promise<{ member: string; score: number }[]> {
    const set = this.sortedSets.get(key);
    if (!set) return [];

    let entries = [...set.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));

    if (options?.by === 'score') {
      const low = Number(start);
      const high = Number(stop);
      entries = entries.filter((entry) => entry.score >= low && entry.score <= high);
    } else {
      entries = entries.slice(Number(start), Number(stop) + 1);
    }

    if (options?.reverse) entries.reverse();
    if (options?.limit) {
      entries = entries.slice(options.limit.offset, options.limit.offset + options.limit.count);
    }
    return entries;
  }

  /** Test helper: how many sorted-set members a key currently holds. */
  sizeOf(key: string): number {
    return this.sortedSets.get(key)?.size ?? 0;
  }
}

export type FakeRedditOptions = {
  post?: PostSnapshot | null;
  moderators?: readonly string[];
  currentUser?: string | null;
  author?: AuthorSnapshot | null;
  failOn?: Partial<
    Record<'approve' | 'comment' | 'distinguish' | 'modNote' | 'report' | 'lock', Error>
  >;
};

/** Records every call so tests can assert on ordering and on what was skipped. */
export class FakeReddit implements RedditPort {
  public readonly calls: string[] = [];
  public readonly comments: string[] = [];
  public readonly reports: { postId: T3; reason: string }[] = [];
  public readonly locked: T3[] = [];
  public lastModNote: ModNoteInput | null = null;

  constructor(private readonly options: FakeRedditOptions = {}) {}

  get lastCommentText(): string {
    return this.comments.at(-1) ?? '';
  }

  subredditName(): string {
    return 'IndianPets';
  }

  async currentUsername(): Promise<string | null> {
    return this.options.currentUser ?? 'mod_one';
  }

  async isModerator(username: string): Promise<boolean> {
    const moderators = this.options.moderators ?? ['mod_one', 'mod_two'];
    return moderators.some((name) => name.toLowerCase() === username.toLowerCase());
  }

  async getPost(postId: T3): Promise<PostSnapshot | null> {
    this.calls.push('getPost');
    if (this.options.post === null) return null;
    return (
      this.options.post ?? { id: postId, authorName: 'op_user', isApproved: false, isRemoved: true }
    );
  }

  async approvePost(): Promise<void> {
    this.calls.push('approve');
    const failure = this.options.failOn?.approve;
    if (failure) throw failure;
  }

  async submitAppComment(_postId: T3, text: string): Promise<CommentHandle> {
    this.calls.push('comment');
    const failure = this.options.failOn?.comment;
    if (failure) throw failure;
    this.comments.push(text);

    const record = (name: string): void => {
      this.calls.push(name);
    };
    const distinguishFailure = this.options.failOn?.distinguish;

    return {
      id: 't1_fake' as T1,
      async distinguishAndSticky(): Promise<void> {
        record('distinguish');
        if (distinguishFailure) throw distinguishFailure;
      },
    };
  }

  async addModNote(input: ModNoteInput): Promise<void> {
    this.calls.push('modNote');
    const failure = this.options.failOn?.modNote;
    if (failure) throw failure;
    this.lastModNote = input;
  }

  async reportPost(postId: T3, reason: string): Promise<void> {
    this.calls.push('report');
    const failure = this.options.failOn?.report;
    if (failure) throw failure;
    this.reports.push({ postId, reason });
  }

  async lockPost(postId: T3): Promise<void> {
    this.calls.push('lock');
    const failure = this.options.failOn?.lock;
    if (failure) throw failure;
    this.locked.push(postId);
  }

  async getAuthor(username: string): Promise<AuthorSnapshot | null> {
    this.calls.push('getAuthor');
    if (this.options.author === null) return null;
    return this.options.author ?? { username, accountAgeDays: 400, karma: 5000 };
  }
}

/** Captures queued jobs instead of scheduling them. */
export class FakeScheduler implements SchedulerPort {
  public readonly jobs: { name: string; data: JsonObject; runAt: Date }[] = [];
  public failure: Error | null = null;

  async runJob(job: { name: string; data: JsonObject; runAt: Date }): Promise<string> {
    if (this.failure) throw this.failure;
    this.jobs.push(job);
    return `job-${this.jobs.length}`;
  }

  jobsNamed(name: string): { name: string; data: JsonObject; runAt: Date }[] {
    return this.jobs.filter((job) => job.name === name);
  }
}

export function fakeSettings(overrides: Partial<AppSettings> = {}): SettingsReader {
  const value: AppSettings = { ...DEFAULT_SETTINGS, ...overrides };
  return { get: async () => value };
}

/** An in-memory ConfigRepo, for testing the settings override layer. */
export class FakeConfigRepo implements ConfigRepo {
  private document: Record<string, unknown> = {};

  async read(): Promise<Record<string, unknown>> {
    return { ...this.document };
  }

  async merge(patch: Record<string, unknown>): Promise<void> {
    this.document = { ...this.document, ...patch };
  }

  async clear(): Promise<void> {
    this.document = {};
  }
}

/** Collects log lines so a test can assert nothing sensitive was written. */
export function fakeLogger(sink: string[] = []): Logger & { lines: string[] } {
  const make = (): Logger & { lines: string[] } => ({
    lines: sink,
    info: (message) => void sink.push(`info ${message}`),
    warn: (message) => void sink.push(`warn ${message}`),
    error: (message) => void sink.push(`error ${message}`),
    child: () => make(),
  });
  return make();
}
