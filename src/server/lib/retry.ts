import type { Logger } from './logger.js';
import { describeError } from './logger.js';

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Hard ceiling on total time spent, including waits. */
  budgetMs: number;
};

/** Injectable clock/sleep/jitter so tests are deterministic and instant. */
export type RetryEnvironment = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const defaultRetryEnvironment: RetryEnvironment = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * Heuristic classification of a transient Reddit/platform failure.
 *
 * NOTE: Devvit does not document a typed error shape for Reddit API failures,
 * so this matches on message text. It is deliberately conservative — an
 * unrecognised error is treated as PERMANENT and surfaced to the moderator
 * rather than retried. Blindly retrying a write we cannot classify risks
 * duplicate comments, which is worse than a clear failure message.
 */
export function isTransientError(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  const markers = [
    '429',
    'rate limit',
    'ratelimit',
    'too many requests',
    '500',
    '502',
    '503',
    '504',
    'timeout',
    'timed out',
    'deadline exceeded',
    'econnreset',
    'socket hang up',
    'unavailable',
  ];
  return markers.some((marker) => message.includes(marker));
}

/**
 * Runs `operation`, retrying only transient failures with exponential backoff
 * and full jitter. Gives up early if the next wait would cross the budget, so
 * the caller always has time left to answer inside Devvit's 30s request limit.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  log: Logger,
  label: string,
  env: RetryEnvironment = defaultRetryEnvironment,
): Promise<T> {
  const deadline = env.now() + options.budgetMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt === options.attempts) {
        throw error;
      }

      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(backoff * env.random());

      if (env.now() + delay >= deadline) {
        log.warn('retry budget exhausted', { label, attempt, reason: describeError(error) });
        throw error;
      }

      log.warn('retrying transient failure', {
        label,
        attempt,
        delayMs: delay,
        reason: describeError(error),
      });
      await env.sleep(delay);
    }
  }

  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastError;
}
