import { fnv1a32 } from './hash.js';
import { collectLinks, extractUrls } from './urls.js';

/**
 * Post fingerprints for spotting alt accounts and ban evasion.
 *
 * Someone evading a ban rarely reuses their username, but they almost always
 * reuse the things that get them paid: the same UPI ID, the same phone number,
 * the same bank account, the same fundraiser link - and very often the same
 * story, pasted with small edits. A fingerprint captures those so a new post
 * can be compared with every other account's posts.
 *
 * Everything here is pure and synchronous. Identifiers are HASHED before they
 * leave this module, so Redis never holds a readable phone number or UPI ID -
 * only enough to say "these two posts share one".
 */

/** What kind of thing two posts were found to share. */
export type IdentifierKind = 'upi' | 'phone' | 'bank' | 'link';

/**
 * How strongly each kind points at the same person.
 *
 * A payment identifier is about as close to a fingerprint as a post gets. A
 * link is weaker: two honest people can share the same campaign.
 */
export const IDENTIFIER_WEIGHT: Readonly<Record<IdentifierKind, number>> = {
  upi: 3,
  phone: 3,
  bank: 3,
  link: 2,
};

export type PostFingerprint = {
  /** Hashed identifiers, each `kind:hash`. Deduplicated, bounded. */
  ids: string[];
  /** MinHash signature of the wording, or null when there is too little text. */
  sig: number[] | null;
};

/** Signature length. 32 gives roughly +/-9% on a similarity estimate. */
export const SIGNATURE_SIZE = 32;
/** Locality-sensitive hashing: 8 bands of 4. Finds pairs above ~50% reliably. */
export const BAND_COUNT = 8;
const ROWS_PER_BAND = SIGNATURE_SIZE / BAND_COUNT;
/** Words per shingle. Three keeps "please help my dog" from matching everything. */
const SHINGLE_WORDS = 3;
/** Below this many shingles the wording says nothing reliable about the author. */
const MIN_SHINGLES = 8;
/** Bounds the hashing work for a very long post. */
const MAX_WORDS = 1500;
/** Bounds the Redis work one post can cause. */
export const MAX_IDENTIFIERS = 20;

/** `name@bank`. Excludes e-mail addresses, whose domain contains a dot. */
const UPI_PATTERN = /(?<![\w.@-])([a-z0-9][a-z0-9._-]{1,63})@([a-z][a-z0-9]{1,31})(?![\w.@-]|\.[a-z])/giu;

/** Indian mobile numbers, with or without +91 / 0 and the usual separators. */
const PHONE_PATTERN = /(?<![\d])(?:\+?91[\s-]*|0)?([6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}|[6-9]\d{4}[\s-]?\d{5})(?![\d])/gu;

/** A long run of digits. Only counted as a bank account when labelled as one. */
const DIGIT_RUN_PATTERN = /(?<![\d])\d{9,18}(?![\d])/gu;
const ACCOUNT_LABEL = /(?:a\/c|acc(?:oun)?t|acct|account\s*(?:no|number)|a\/c\s*no)/iu;
/** How far before a digit run its "account" label may sit. */
const ACCOUNT_LABEL_WINDOW = 40;

function hashed(kind: IdentifierKind, value: string): string {
  return `${kind}:${fnv1a32(`${kind}|${value}`)}`;
}

/** The kind encoded at the front of a hashed identifier. */
export function identifierKind(id: string): IdentifierKind | null {
  const kind = id.slice(0, id.indexOf(':'));
  return kind === 'upi' || kind === 'phone' || kind === 'bank' || kind === 'link' ? kind : null;
}

/** Text with URLs removed, so a link's digits are never read as a phone number. */
function withoutUrls(text: string): string {
  let result = text;
  for (const url of extractUrls(text)) result = result.split(url).join(' ');
  return result;
}

/**
 * Payment identifiers in a block of text, hashed.
 *
 * Exported for tests; production code uses {@link fingerprintPost}.
 */
export function extractPaymentIdentifiers(rawText: string): string[] {
  const text = withoutUrls(rawText);
  const found = new Set<string>();

  for (const match of text.matchAll(UPI_PATTERN)) {
    found.add(hashed('upi', `${match[1]}@${match[2]}`.toLowerCase()));
  }

  const phoneSpans: [number, number][] = [];
  for (const match of text.matchAll(PHONE_PATTERN)) {
    const digits = (match[1] ?? '').replace(/\D/gu, '');
    if (digits.length !== 10) continue;
    found.add(hashed('phone', digits));
    const start = match.index ?? 0;
    phoneSpans.push([start, start + match[0].length]);
  }

  for (const match of text.matchAll(DIGIT_RUN_PATTERN)) {
    const start = match.index ?? 0;
    // A phone number is a ten-digit run too; it has already been counted.
    if (phoneSpans.some(([from, to]) => start >= from && start < to)) continue;
    const before = text.slice(Math.max(0, start - ACCOUNT_LABEL_WINDOW), start);
    if (ACCOUNT_LABEL.test(before)) found.add(hashed('bank', match[0]));
  }

  return [...found];
}

/** Lower-case words, URLs and digits removed. Works for Hindi as well as English. */
export function wordsOf(text: string): string[] {
  return withoutUrls(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]+/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length >= 2)
    .slice(0, MAX_WORDS);
}

function fnvInt(seed: number, value: string): number {
  return Number.parseInt(fnv1a32(`${seed}|${value}`), 16);
}

/**
 * MinHash signature of the wording.
 *
 * Two signatures agree in a slot with probability equal to the Jaccard
 * similarity of the two posts' shingle sets, so the fraction of agreeing
 * slots estimates how much of the text is shared.
 */
export function textSignature(text: string): number[] | null {
  const words = wordsOf(text);
  const shingles = new Set<string>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index++) {
    shingles.add(words.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  if (shingles.size < MIN_SHINGLES) return null;

  const signature: number[] = new Array<number>(SIGNATURE_SIZE).fill(Number.MAX_SAFE_INTEGER);
  for (const shingle of shingles) {
    for (let seed = 0; seed < SIGNATURE_SIZE; seed++) {
      const value = fnvInt(seed, shingle);
      if (value < (signature[seed] ?? Number.MAX_SAFE_INTEGER)) signature[seed] = value;
    }
  }
  return signature;
}

/** Estimated share of wording two posts have in common, 0 to 1. */
export function signatureSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let same = 0;
  for (let index = 0; index < a.length; index++) if (a[index] === b[index]) same += 1;
  return same / a.length;
}

/**
 * Bucket keys for finding similar wording without comparing against every post.
 *
 * Two posts that agree on all four slots of any band land in the same bucket.
 * At 50% similarity that happens in at least one of eight bands about 40% of
 * the time; at 70% about 87%; at 80%, 98%.
 */
export function signatureBands(signature: readonly number[]): string[] {
  const bands: string[] = [];
  for (let band = 0; band < BAND_COUNT; band++) {
    const rows = signature.slice(band * ROWS_PER_BAND, (band + 1) * ROWS_PER_BAND);
    bands.push(`${band}:${fnv1a32(rows.join(','))}`);
  }
  return bands;
}

/** Everything comparable about one post. */
export function fingerprintPost(input: { title: string; body: string; url: string }): PostFingerprint {
  const text = `${input.title}\n${input.body}`;
  const links = collectLinks(input, MAX_IDENTIFIERS).map((link) => `link:${link.key}`);
  const ids = [...new Set([...extractPaymentIdentifiers(text), ...links])].slice(0, MAX_IDENTIFIERS);
  return { ids, sig: textSignature(text) };
}
