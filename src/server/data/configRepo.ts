import { KEY_PREFIX } from '../config.js';
import type { RedisPort } from './redisPort.js';

/**
 * Runtime configuration overrides, editable from inside Reddit.
 *
 * WHY THIS EXISTS: Devvit's own app settings can only be READ at runtime
 * (`SettingsClient` exposes `get`/`getAll` and nothing else), and editing them
 * means leaving the subreddit for the app's settings page on
 * developers.reddit.com. That is fine for set-and-forget values and far too
 * slow for "turn the reminder bot off, right now, from my phone".
 *
 * So this layer stores a JSON patch in Redis that wins over the devvit.json
 * settings. A moderator edits it through a normal menu action and form, and it
 * takes effect on the very next request - overrides are deliberately NOT memoised
 * in process, unlike the underlying settings.
 *
 *   fv:cfg   STRING   JSON object of overridden setting keys. No TTL.
 *
 * One Redis GET per handler invocation (~1-3ms) buys instant, in-Reddit control
 * of every feature. That trade is worth it.
 */
export type ConfigRepo = {
  /** Raw override patch. Unknown keys are ignored downstream, never trusted. */
  read(): Promise<Record<string, unknown>>;
  /** Merges `patch` over the existing overrides. */
  merge(patch: Record<string, unknown>): Promise<void>;
  /** Drops all overrides, returning the app to its devvit.json settings. */
  clear(): Promise<void>;
};

const CONFIG_KEY = `${KEY_PREFIX}:cfg`;

export function createConfigRepo(redis: RedisPort): ConfigRepo {
  async function read(): Promise<Record<string, unknown>> {
    const raw = await redis.get(CONFIG_KEY);
    if (typeof raw !== 'string' || raw.length === 0) return {};

    try {
      const parsed: unknown = JSON.parse(raw);
      // An array is also `typeof 'object'`; only a plain object is usable here.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      // A corrupt override document must never take the app down; falling back
      // to `{}` means the devvit.json settings apply, which is a safe state.
      return {};
    }
  }

  return {
    read,

    async merge(patch) {
      const current = await read();
      await redis.set(CONFIG_KEY, JSON.stringify({ ...current, ...patch }));
    },

    async clear() {
      await redis.del(CONFIG_KEY);
    },
  };
}
