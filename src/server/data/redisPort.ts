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
