import { fnv1a32 } from './hash.js';

/**
 * URL extraction and normalisation for duplicate fundraiser detection.
 *
 * Everything here is pure and synchronous. No network calls: expanding a short
 * link would need `fetch`, which on Devvit requires each hostname to be
 * allow-listed and reviewed by Reddit AND a published Terms & Conditions and
 * Privacy Policy for the app. Short links are therefore indexed as-is and
 * flagged, so a moderator can see that the destination was not checked.
 */

/** A link reduced to something two posts can be compared on. */
export type NormalisedLink = {
  /** Stable dedupe key. Bounded in length. */
  key: string;
  /** Recognised fundraiser platform, or null. */
  platform: string | null;
  /** True when the host is a URL shortener, so the real destination is unknown. */
  shortened: boolean;
  /** Human-readable form, for the modqueue report. */
  display: string;
};

/**
 * Hosts that are never worth deduplicating.
 *
 * Without this, every post linking the subreddit rules or an Imgur album would
 * look like a duplicate of every other. False positives cost moderator
 * attention, which is the exact thing this app is supposed to save.
 */
export const IGNORED_HOSTS: ReadonlySet<string> = new Set([
  'reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'redd.it',
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
  'imgur.com',
  'i.imgur.com',
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'google.com',
  'docs.google.com',
  'drive.google.com',
  'wikipedia.org',
  'en.wikipedia.org',
  'twitter.com',
  'x.com',
  'facebook.com',
  'm.facebook.com',
]);

/** Hosts whose URLs hide their real destination behind a redirect. */
export const SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'buff.ly',
  'is.gd',
  'cutt.ly',
  'rb.gy',
  'rebrand.ly',
  'shorturl.at',
  's.id',
  'bl.ink',
  'tiny.cc',
  'lnkd.in',
  'shorturl.com',
  'short.io',
]);

/**
 * Query parameters that identify who shared a link rather than what it points
 * at. Two people sharing the same campaign produce different URLs purely
 * because of these, so they are dropped before comparison.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'referrer',
  'source',
  'si',
  'spm',
  '_ga',
  '_gl',
  'share_id',
  'shareid',
  'utm',
]);

/**
 * Fundraiser platforms whose campaign identifier can be pulled out of the path.
 *
 * Reducing a campaign to `platform:slug` means the same campaign still matches
 * when it is posted with a different path shape, a different subdomain or a
 * regional prefix.
 */
type PlatformRule = {
  platform: string;
  /** Host suffixes this rule applies to, e.g. `ketto.org` matches `www.ketto.org`. */
  hosts: readonly string[];
  /** Path segments that introduce a campaign slug. */
  slugAfter: readonly string[];
};

const PLATFORM_RULES: readonly PlatformRule[] = [
  { platform: 'ketto', hosts: ['ketto.org'], slugAfter: ['fundraiser', 'fr', 'stories', 'crowdfunding'] },
  { platform: 'milaap', hosts: ['milaap.org'], slugAfter: ['fundraisers', 'fundraiser'] },
  { platform: 'gofundme', hosts: ['gofundme.com'], slugAfter: ['f', 'manage'] },
  { platform: 'impactguru', hosts: ['impactguru.com'], slugAfter: ['fundraiser', 'fundraisers'] },
  { platform: 'donatekart', hosts: ['donatekart.com'], slugAfter: ['fundraiser', 'campaign'] },
  { platform: 'give', hosts: ['give.do'], slugAfter: ['fundraisers', 'campaign', 'c'] },
  { platform: 'fueladream', hosts: ['fueladream.com'], slugAfter: ['campaign', 'campaigns'] },
];

/** Keys longer than this are replaced by a hash to keep Redis keys bounded. */
const MAX_KEY_LENGTH = 160;

/**
 * Trailing characters that are almost always sentence punctuation or Markdown
 * syntax rather than part of the URL.
 */
const TRAILING_JUNK = /[.,;:!?)\]}>'"*_`]+$/u;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`\\]+/giu;

/** Pulls candidate URLs out of free text, including Markdown link targets. */
export function extractUrls(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimUrl(match[0]);
    if (candidate.length > 0) found.push(candidate);
  }
  return found;
}

function trimUrl(raw: string): string {
  let candidate = raw.replace(TRAILING_JUNK, '');

  // A closing bracket is only junk if it is unbalanced - some real URLs
  // contain matched parentheses (Wikipedia-style paths).
  const opens = (candidate.match(/\(/gu) ?? []).length;
  const closes = (candidate.match(/\)/gu) ?? []).length;
  if (closes > opens) candidate = candidate.replace(/\)+$/u, '');

  return candidate;
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function matchPlatform(host: string): PlatformRule | null {
  for (const rule of PLATFORM_RULES) {
    if (rule.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return rule;
  }
  return null;
}

function boundKey(key: string): string {
  return key.length <= MAX_KEY_LENGTH ? key : `h:${fnv1a32(key)}:${key.slice(0, 32)}`;
}

/**
 * Reduces one URL to a comparable key, or returns null when the link should be
 * ignored (unparseable, non-http, or an ignored host).
 */
export function normaliseUrl(raw: string): NormalisedLink | null {
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = stripWww(parsed.hostname.toLowerCase());
  if (host.length === 0 || IGNORED_HOSTS.has(host)) return null;

  const shortened = SHORTENER_HOSTS.has(host);
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);

  const rule = matchPlatform(host);
  if (rule) {
    const slug = campaignSlug(segments, rule.slugAfter);
    if (slug) {
      return {
        key: boundKey(`${rule.platform}:${slug}`),
        platform: rule.platform,
        shortened: false,
        display: `${host}/${segments.join('/')}`,
      };
    }
  }

  // Generic fallback: host + path + the query parameters that actually
  // identify the resource, sorted so parameter order cannot split a match.
  const keptParams = [...parsed.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAMS.has(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const path = segments.join('/');
  const query = keptParams.map(([name, value]) => `${name}=${value}`).join('&');
  const bare = query.length > 0 ? `${host}/${path}?${query}` : `${host}/${path}`;

  return {
    key: boundKey(`url:${bare}`),
    platform: rule?.platform ?? null,
    shortened,
    display: bare,
  };
}

/**
 * The slug is the segment following a known campaign segment, e.g. the `x` in
 * `/fundraiser/x`. Falls back to the last path segment for hosts whose rule
 * matched but whose path shape is unfamiliar, so a new URL layout degrades to
 * "still comparable" rather than "silently ignored".
 */
function campaignSlug(segments: readonly string[], slugAfter: readonly string[]): string | null {
  for (let index = 0; index < segments.length - 1; index++) {
    const current = segments[index];
    const next = segments[index + 1];
    if (current && next && slugAfter.includes(current.toLowerCase())) {
      return next.toLowerCase();
    }
  }

  const last = segments.at(-1);
  return last && segments.length > 0 ? last.toLowerCase() : null;
}

/**
 * Collects every distinct comparable link in a post.
 *
 * `capacity` bounds the work a single post can cause: a post pasting hundreds
 * of URLs must not turn into hundreds of Redis round trips.
 */
export function collectLinks(
  input: { title?: string | undefined; body?: string | undefined; url?: string | undefined },
  capacity = 10,
): NormalisedLink[] {
  const raw = [
    ...extractUrls(input.title ?? ''),
    ...extractUrls(input.body ?? ''),
    // A link post's `url` is the target itself and has no surrounding text.
    ...(input.url ? [input.url] : []),
  ];

  const seen = new Set<string>();
  const links: NormalisedLink[] = [];

  for (const candidate of raw) {
    if (links.length >= capacity) break;
    const normalised = normaliseUrl(candidate);
    if (!normalised || seen.has(normalised.key)) continue;
    seen.add(normalised.key);
    links.push(normalised);
  }

  return links;
}
