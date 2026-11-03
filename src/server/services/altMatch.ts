import type { T3 } from '@devvit/web/shared';
import { CONFIG, JOBS } from '../config.js';
import type { FingerprintRepo, StoredFingerprint } from '../data/fingerprintRepo.js';
import type { LinkRepo } from '../data/linkRepo.js';
import type { IdentifierKind } from '../lib/fingerprint.js';
import {
  fingerprintPost,
  IDENTIFIER_WEIGHT,
  identifierKind,
  signatureSimilarity,
} from '../lib/fingerprint.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import type { SettingsReader } from '../settings.js';
import { matchesFundraiserFlair } from '../settings.js';
import { buildAltReportReason } from '../text.js';
import type { PostContent, RedditPort, SchedulerPort } from './redditPort.js';

/** Another account whose posts resemble this person's. */
export type AccountMatch = {
  author: string;
  /** Higher is a stronger match. Only meaningful for ordering. */
  score: number;
  /** Distinct identifiers shared, by kind. Excludes the common ones below. */
  shared: Partial<Record<IdentifierKind, number>>;
  /**
   * Identifiers shared that several other accounts ALSO use - a clinic's phone
   * number, a shelter's UPI ID. Listed, but not evidence of one person.
   */
  commonShared: number;
  /** Highest wording overlap between any two of the posts, 0 to 1. */
  textSimilarity: number;
  /** True when that wording is shared with several accounts, like a post template. */
  wordingIsCommon: boolean;
  /** Their posts that matched, newest first. */
  postIds: T3[];
  /** Filled in for the top matches only; a ban lookup is a Reddit call. */
  banned: boolean;
};

/** True when the match rests on payment details rather than links or wording. */
export function sharesPaymentDetails(match: AccountMatch): boolean {
  return (match.shared.upi ?? 0) + (match.shared.phone ?? 0) + (match.shared.bank ?? 0) > 0;
}

/**
 * Whether a match is strong enough to put the post in the modqueue.
 *
 * A banned account is always worth a look: that is ban evasion, whatever is
 * shared. Otherwise only DISTINCTIVE evidence counts - payment details few
 * accounts use, or wording that is not a template. Shared links alone are
 * the duplicate detector's job.
 */
export function isReportWorthy(match: AccountMatch, minSimilarity: number): boolean {
  if (match.banned) return true;
  if (sharesPaymentDetails(match)) return true;
  return match.textSimilarity >= minSimilarity && !match.wordingIsCommon;
}

/**
 * How many OTHER accounts must share an identifier, or a wording, before it is
 * treated as common rather than as a sign of one person. Two honest posters at
 * the same vet clinic share its phone number; three or more accounts sharing
 * something is a clinic, a shelter or a post template far more often than one
 * person with three accounts - and a banned account is still reported anyway.
 */
export const COMMON_ACCOUNTS = 3;

/**
 * Ranks every other account against one person's posts.
 *
 * Pure, so the scoring can be tested without Redis. An account qualifies with
 * any shared identifier, or with wording at or above `minSimilarity`. Score is
 * the weighted count of distinct shared identifiers plus up to six points for
 * wording, so one shared UPI ID (3) outranks a single shared link (2), and
 * shared payment details plus a copied story outranks either alone. Common
 * identifiers count one point each and common wording barely at all.
 */
export function rankMatches(
  own: readonly StoredFingerprint[],
  ownAuthor: string,
  candidates: readonly StoredFingerprint[],
  minSimilarity: number,
): AccountMatch[] {
  const self = ownAuthor.toLowerCase();
  const ownIds = new Set(own.flatMap((fingerprint) => fingerprint.ids));
  const ownSigs = own.flatMap((fingerprint) => (fingerprint.sig ? [fingerprint.sig] : []));

  type Tally = { author: string; ids: Set<string>; similarity: number; posts: StoredFingerprint[] };
  const byAuthor = new Map<string, Tally>();
  /** Which other accounts use each shared identifier. */
  const idAccounts = new Map<string, Set<string>>();
  /** Other accounts whose wording clears the threshold. */
  const wordingAccounts = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate.author || candidate.author.toLowerCase() === self) continue;
    const key = candidate.author.toLowerCase();

    const sharedIds = candidate.ids.filter((id) => ownIds.has(id));
    let similarity = 0;
    if (candidate.sig) {
      for (const sig of ownSigs) similarity = Math.max(similarity, signatureSimilarity(sig, candidate.sig));
    }
    if (sharedIds.length === 0 && similarity < minSimilarity) continue;

    for (const id of sharedIds) {
      const accounts = idAccounts.get(id) ?? new Set<string>();
      accounts.add(key);
      idAccounts.set(id, accounts);
    }
    if (similarity >= minSimilarity) wordingAccounts.add(key);

    const tally = byAuthor.get(key) ?? { author: candidate.author, ids: new Set(), similarity: 0, posts: [] };
    for (const id of sharedIds) tally.ids.add(id);
    tally.similarity = Math.max(tally.similarity, similarity);
    tally.posts.push(candidate);
    byAuthor.set(key, tally);
  }

  const wordingIsCommon = wordingAccounts.size >= COMMON_ACCOUNTS;

  const matches: AccountMatch[] = [];
  for (const tally of byAuthor.values()) {
    const shared: Partial<Record<IdentifierKind, number>> = {};
    let commonShared = 0;
    let score = 0;
    for (const id of tally.ids) {
      const kind = identifierKind(id);
      if (!kind) continue;
      if ((idAccounts.get(id)?.size ?? 0) >= COMMON_ACCOUNTS) {
        commonShared += 1;
        score += 1;
        continue;
      }
      shared[kind] = (shared[kind] ?? 0) + 1;
      score += IDENTIFIER_WEIGHT[kind];
    }
    // Wording below the threshold, or wording many accounts share, still
    // helps ORDER accounts, but never qualifies one on its own.
    if (tally.similarity >= minSimilarity && !wordingIsCommon) {
      score += Math.round(tally.similarity * 6);
    } else {
      score += tally.similarity;
    }

    matches.push({
      author: tally.author,
      score,
      shared,
      commonShared,
      textSimilarity: tally.similarity,
      wordingIsCommon: wordingIsCommon && tally.similarity >= minSimilarity,
      postIds: tally.posts
        .sort((a, b) => b.postedAtMs - a.postedAtMs)
        .slice(0, 5)
        .map((post) => post.postId),
      banned: false,
    });
  }

  return matches.sort((a, b) => b.score - a.score || b.textSimilarity - a.textSimilarity);
}

export type AltDeps = {
  fingerprints: FingerprintRepo;
  /** Read-only here: whether the duplicate detector already reported the post. */
  links: LinkRepo;
  reddit: RedditPort;
  scheduler: SchedulerPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

export type AltCheckOutcome =
  | { kind: 'off' }
  | { kind: 'no-match' }
  | { kind: 'matched'; top: AccountMatch; reported: boolean };

export type AltService = {
  /** Fingerprints one post. Safe to repeat. */
  index(post: PostContent): Promise<StoredFingerprint | null>;
  /**
   * Accounts this person's posts resemble, strongest first, with ban status
   * for the top few. Indexes `ensureIndexed` first if the app has never seen it.
   */
  matchesForAuthor(username: string, ensureIndexed?: T3): Promise<AccountMatch[]>;
  /** The scheduled check for a new post: index, match, and report if warranted. */
  check(post: PostContent): Promise<AltCheckOutcome>;
  /** Fingerprints one page of recent posts. Returns the last id, or null when done. */
  backfill(after: T3 | null): Promise<{ indexed: number; last: T3 | null; posts: PostContent[] }>;
  /** Called when the author deletes a post. */
  forgetPost(postId: T3): Promise<void>;
};

export function createAltService(deps: AltDeps): AltService {
  const { fingerprints, links, reddit, scheduler, settings, log, now } = deps;

  async function index(post: PostContent): Promise<StoredFingerprint | null> {
    if (!post.authorName) return null;
    const { ids, sig } = fingerprintPost(post);
    const stored: StoredFingerprint = {
      postId: post.id,
      author: post.authorName,
      postedAtMs: post.createdAtMs,
      ids,
      sig,
    };
    await fingerprints.save(stored, now());
    return stored;
  }

  /** Matches for a set of the person's own fingerprints. */
  async function match(own: StoredFingerprint[], author: string): Promise<AccountMatch[]> {
    const config = await settings.get();
    const candidateIds = new Set<T3>();
    for (const fingerprint of own) {
      for (const postId of await fingerprints.candidates(fingerprint)) candidateIds.add(postId);
    }
    const ownIds = new Set(own.map((fingerprint) => fingerprint.postId));
    const candidates = await fingerprints.getMany([...candidateIds].filter((id) => !ownIds.has(id)));

    const ranked = rankMatches(own, author, candidates, config.altSimilarityPercent / 100).slice(
      0,
      CONFIG.alt.topMatches,
    );
    const bans = await Promise.all(ranked.map((entry) => reddit.isBanned(entry.author)));
    return ranked.map((entry, position) => ({ ...entry, banned: bans[position] ?? false }));
  }

  return {
    index,

    async matchesForAuthor(username, ensureIndexed): Promise<AccountMatch[]> {
      if (ensureIndexed && !(await fingerprints.get(ensureIndexed))) {
        const content = await reddit.getPostContent(ensureIndexed);
        if (content) await index(content);
      }

      const postIds = await fingerprints.byAuthor(username, CONFIG.history.postsToMatch);
      const own = await fingerprints.getMany(postIds);
      // Logged because an empty answer here is otherwise indistinguishable
      // from "this person matches nobody" - which is how a broken newest-first
      // read once went unnoticed.
      log.info('matching a poster', { ownPosts: own.length });
      if (own.length === 0) return [];
      return match(own, username);
    },

    async check(post): Promise<AltCheckOutcome> {
      const config = await settings.get();
      if (!config.enabled || !config.altDetectionEnabled || !post.authorName) return { kind: 'off' };

      const scoped = log.child({ postId: post.id });
      const own = await index(post);
      if (!own) return { kind: 'off' };

      const matches = await match([own], post.authorName);
      const top = matches[0];
      if (!top) return { kind: 'no-match' };

      // The strongest match is not always the one worth reporting: a banned
      // account ranked second matters more than a shared link ranked first.
      // Shared links alone are left to the duplicate detector, so the same
      // post is not queued twice; a banned match is reported regardless.
      const worth = matches.find((entry) => isReportWorthy(entry, config.altSimilarityPercent / 100));
      let reported = false;

      if (worth && !(await fingerprints.wasReported(post.id))) {
        const duplicateAlready = await links.wasReported(post.id);
        // Every report the app files is for the chosen fundraiser flair only -
        // the mod team's rule, with no exceptions. A post under another flair
        // that looks like a fundraiser is reported separately, as mis-flaired.
        let flairOk = true;
        if (config.fundraiserFlairText.length > 0) {
          const snapshot = await reddit.getPost(post.id);
          flairOk = snapshot !== null && matchesFundraiserFlair(snapshot.flairText, config.fundraiserFlairText);
        }

        if (flairOk && (!duplicateAlready || worth.banned)) {
          await fingerprints.markReported(post.id, now());
          await reddit.reportPost(post.id, buildAltReportReason(worth));
          reported = true;
        }
      }

      scoped.info('alt check done', {
        matched: (worth ?? top).author,
        score: (worth ?? top).score,
        banned: (worth ?? top).banned,
        textSimilarity: Math.round((worth ?? top).textSimilarity * 100),
        commonShared: top.commonShared,
        wordingIsCommon: top.wordingIsCommon,
        reported,
      });

      if (config.userHistoryEnabled) {
        try {
          await scheduler.runJob({
            name: JOBS.userHistory,
            data: { username: post.authorName },
            runAt: new Date(now() + CONFIG.history.delaySeconds * 1000),
          });
        } catch (error) {
          scoped.warn('could not queue the history rebuild', { reason: describeError(error) });
        }
      }

      return { kind: 'matched', top: worth ?? top, reported };
    },

    async backfill(after): Promise<{ indexed: number; last: T3 | null; posts: PostContent[] }> {
      const posts = await reddit.listNewPosts(after, CONFIG.alt.backfillBatchSize);
      let indexed = 0;
      for (const post of posts) {
        if (await index(post)) indexed += 1;
      }
      const last = posts.at(-1)?.id ?? null;
      return { indexed, last: posts.length < CONFIG.alt.backfillBatchSize ? null : last, posts };
    },

    async forgetPost(postId): Promise<void> {
      await fingerprints.forget(postId);
    },
  };
}

/** Narrows a scheduled job's payload back to post content. */
export function isPostContent(value: unknown): value is PostContent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'].startsWith('t3_') &&
    (candidate['authorName'] === null || typeof candidate['authorName'] === 'string') &&
    typeof candidate['title'] === 'string' &&
    typeof candidate['body'] === 'string' &&
    typeof candidate['url'] === 'string' &&
    typeof candidate['createdAtMs'] === 'number' &&
    (candidate['flairText'] === undefined ||
      candidate['flairText'] === null ||
      typeof candidate['flairText'] === 'string')
  );
}
