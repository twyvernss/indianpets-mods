/**
 * Structured logging.
 *
 * Devvit surfaces `console` output in `devvit logs`. Emitting a single JSON
 * object per line keeps those logs greppable.
 *
 * Deliberately omitted from every log line: the moderator's free-text note and
 * any checklist content. Those can contain third-party details (clinic names,
 * phone numbers) that have no business in application logs. Note LENGTH is
 * logged instead, which is enough to debug truncation bugs.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps `fields` onto every subsequent line. */
  child(fields: LogFields): Logger;
};

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, base: LogFields, message: string, fields?: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...base,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    info: (message, fields) => emit('info', base, message, fields),
    warn: (message, fields) => emit('warn', base, message, fields),
    error: (message, fields) => emit('error', base, message, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/**
 * Turns an unknown thrown value into a message safe to log.
 * Never returns the raw object, which could carry request bodies.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
