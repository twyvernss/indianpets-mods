/**
 * Input hardening.
 *
 * Everything arriving from a form is `unknown`: the values come from the
 * client, and a moderator's client is still a client. Nothing in this module
 * trusts the type of its input.
 */

/**
 * Characters that must never reach Redis, the wiki log, or a log line:
 * C0/C1 control codes, zero-width joiners/spaces, and the BiDi override
 * characters that can be used to make stored text render deceptively.
 *
 * Built with `String.raw` so the source stays readable and contains no literal
 * control characters itself.
 */
/**
 * Characters that must never reach Redis, a public comment, the wiki log or a
 * log line: C0/C1 control codes, zero-width and directional marks, and the
 * BiDi overrides that can make stored text render deceptively.
 *
 * TAB (0009) and LINE FEED (000A) are deliberately NOT in this class.
 * `sanitizeText` collapses them anyway, and `sanitizeMultiline` depends on
 * newlines surviving - Markdown paragraphs are made of them.
 */
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu;


const WHITESPACE_RUN = /\s+/gu;
const ELLIPSIS = '…';

/**
 * Normalises a free-text field to a single-line, bounded, control-character-free
 * string. Returns `''` for anything that is not a usable string.
 *
 * The result is only ever stored in Redis or written to the moderator-only wiki log; it is
 * never interpolated into the public comment, so Markdown is left intact
 * rather than escaped. If that ever changes, escape at the point of rendering.
 */
export function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';

  const cleaned = input
    .normalize('NFC')
    .replace(INVISIBLE, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();

  if (cleaned.length <= maxLength) return cleaned;

  // Reserve one character for the ellipsis so the cap is never exceeded.
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`;
}

/** Form booleans arrive as real booleans, but never assume it. */
export function toBoolean(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return input === 'true';
  return false;
}

/** A non-empty, length-bounded string, or null. Used for opaque values such as tokens. */
export function toNonEmptyString(input: unknown, maxLength = 200): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Like {@link sanitizeText} but PRESERVES line breaks.
 *
 * Used for text that is posted as Markdown, where paragraph breaks are the
 * whole point. Control characters and invisible/BiDi characters are still
 * stripped, and runs of blank lines are collapsed so a stray scroll of
 * newlines cannot pad a comment out.
 */
export function sanitizeMultiline(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';

  const cleaned = input
    .normalize('NFC')
    .replace(INVISIBLE, ' ')
    // Normalise Windows line endings, drop trailing spaces, and collapse runs
    // of blank lines so a scroll of newlines cannot pad out a public comment.
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength).trimEnd();
}

