/**
 * The exact slice of the Devvit Redis client this app uses.
 *
 * Declaring it structurally (rather than importing the concrete client
 * everywhere) does three things:
 *  - it documents the app's entire storage surface in one place;
 *  - it keeps `@devvit/web/server` out of the unit tests, which would
 *    otherwise fail on import outside the Devvit runtime;
 *  - it makes every repository trivially mockable with a plain object.
 *
 * The real `redis` export from `@devvit/web/server` satisfies this type.
 */
export type ZMemberLike = { readonly member: string; readonly score: number };

export type RedisSetOptions = {
  /** Only set when the key does not already exist. */
  nx?: boolean;
  /** Absolute expiry instant. */
  expiration?: Date;
};

export type RedisPort = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string>;
  del(...keys: string[]): Promise<void>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  zAdd(key: string, ...members: ZMemberLike[]): Promise<number>;
  zRem(key: string, members: string[]): Promise<number>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: { by: 'score' | 'lex' | 'rank'; reverse?: boolean; limit?: { offset: number; count: number } },
  ): Promise<{ member: string; score: number }[]>;
};

/**
 * Parses a JSON value read from Redis without ever throwing.
 *
 * A malformed row is treated as absent rather than crashing a handler: bad
 * data from an old schema version must never be able to take the app down.
 */
export function parseJson<T>(raw: string | null | undefined, validate: (value: unknown) => value is T): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validate(parsed) ? parsed : null;
}

/**
 * The `limit` newest members of a sorted set scored by time.
 *
 * Devvit takes the score range as (lowest, highest) EVEN WHEN reversed, and
 * swaps it into Redis's (highest, lowest) order itself - see `ZRange` in
 * `@devvit/redis/test/mocks/RedisMock.js`. Raw Redis wants the opposite, and
 * passing it that way through Devvit returns nothing at all, which once emptied
 * alt matching on the dev subreddit. Every newest-first read goes through here
 * so that is decided in exactly one place.
 */
export async function newestByScore(
  redis: RedisPort,
  key: string,
  limit: number,
): Promise<{ member: string; score: number }[]> {
  return redis.zRange(key, 0, Number.MAX_SAFE_INTEGER, {
    by: 'score',
    reverse: true,
    limit: { offset: 0, count: limit },
  });
}

/**
 * Every member of a sorted set, lowest score first, read in pages.
 *
 * Devvit returns at most 1,000 members from a score range when no `limit` is
 * given, so anything that can grow past that is read page by page.
 */
export async function allByScore(redis: RedisPort, key: string, pageSize = 1000): Promise<string[]> {
  const members: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await redis.zRange(key, 0, Number.MAX_SAFE_INTEGER, {
      by: 'score',
      limit: { offset, count: pageSize },
    });
    members.push(...page.map((entry) => entry.member));
    if (page.length < pageSize) return members;
  }
}
