/**
 * Date formatting without `Intl`.
 *
 * The Devvit server runtime is Node-like but is not a full Node environment,
 * and the docs make no promise about bundled ICU data. Doing the offset
 * arithmetic by hand keeps the output identical everywhere and makes the
 * function trivially unit-testable.
 */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Formats an epoch-ms instant in a fixed UTC offset, e.g. "28 Sep 2026, 14:05 IST".
 *
 * Fixed-offset only: India does not observe daylight saving, so this is exact
 * for IST. Do not reuse it for a zone with DST without revisiting.
 */
export function formatDisplayDate(epochMs: number, offsetMinutes: number, label: string): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const month = MONTHS[shifted.getUTCMonth()] ?? '???';
  return (
    `${shifted.getUTCDate()} ${month} ${shifted.getUTCFullYear()}, ` +
    `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())} ${label}`
  );
}

/** Whole days between two instants, rounded down. Never negative. */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

/** Compact date for dense moderator-facing lines, e.g. "4 Aug 2026". */
export function formatShortDate(epochMs: number, offsetMinutes = 330): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const month = MONTHS[shifted.getUTCMonth()] ?? '???';
  return `${shifted.getUTCDate()} ${month} ${shifted.getUTCFullYear()}`;
}
