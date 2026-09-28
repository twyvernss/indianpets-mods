/**
 * Every tunable number in the app. Nothing here is read from user input.
 *
 * The figures in the comments are the Devvit platform limits these values are
 * designed to stay inside (documented as of Devvit 0.14.5).
 */
export const CONFIG = {
  /**
   * Devvit gives a moderator 10 minutes to complete a form opened from a
   * `forUserType: moderator` menu action. The token outlives that slightly so
   * the mod sees "session expired" rather than a confusing permission error.
   */
  tokenTtlSeconds: 15 * 60,

  /**
   * Guards against a double-click or a duplicated request racing itself.
   * Comfortably longer than the worst-case Reddit round trip, far shorter than
   * the 30s server request limit.
   */
  lockTtlSeconds: 120,

  /**
   * A `pending` record older than this is treated as a crashed run and may be
   * retried. Must exceed the maximum server request time (30s).
   */
  pendingStaleMs: 5 * 60 * 1000,

  /** Positive moderator lookups are cached; keeps the hot path off the Reddit API. */
  modCacheTtlSeconds: 300,
  /** Negative lookups expire quickly so a newly added mod is not locked out. */
  modCacheNegativeTtlSeconds: 60,

  /** Automod hold timestamps are only useful while the post is current. */
  automodHoldTtlSeconds: 30 * 24 * 60 * 60,

  /** App settings are re-read at most this often; they change very rarely. */
  settingsCacheMs: 60 * 1000,

  /** Reddit's hard limit on a mod note is 250 characters. */
  modNoteMaxLength: 250,

  /** Reddit truncates custom report reasons; keep well inside it. */
  reportReasonMaxLength: 100,

  /** Upper bound on the stored internal note. Generous but bounded. */
  noteMaxLength: 500,

  /** Guard rails on the moderator-configurable checklist. */
  maxChecklistItems: 20,
  checklistLabelMaxLength: 120,

  retry: {
    attempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 2_000,
    /**
     * Total time the retry helper may consume. The whole handler must finish
     * within Devvit's 30s request limit, and we still need time to respond.
     */
    budgetMs: 12_000,
  },

  duplicates: {
    /**
     * Bounds the Redis work one post can cause. A post pasting fifty URLs must
     * not turn into fifty round trips on a hot trigger path.
     */
    maxLinksPerPost: 10,
    /** Link ownership is remembered for roughly a year, then expires. */
    linkTtlSeconds: 365 * 24 * 60 * 60,
    /** Stops the same post being reported twice if a trigger is redelivered. */
    reportedTtlSeconds: 30 * 24 * 60 * 60,
    /**
     * Delay before the modqueue report job runs. Non-zero so the trigger
     * returns immediately and so the post is fully settled on Reddit's side.
     */
    reportDelaySeconds: 10,
  },

  intake: {
    /**
     * Delay before the "what we need from you" reply is posted after
     * AutoModerator filters a post. Non-zero so the trigger returns at once,
     * and so AutoModerator's own comment lands first.
     */
    replyDelaySeconds: 15,
    /** Stops a redelivered trigger replying twice to the same post. */
    repliedTtlSeconds: 30 * 24 * 60 * 60,
  },

  reminders: {
    /**
     * Posts handled per scheduled run.
     *
     * Each one costs at least one Reddit write (~200-400ms). Ten keeps a run
     * near a couple of seconds, far inside the 30s request limit, with room for
     * retries. When more remain the job chains another run.
     */
    batchSize: 10,
    /**
     * Ceiling on chained runs from one nightly trigger: 20 x 10 = 200 posts a
     * day. Also keeps `runJob` far below its 60-calls-per-minute limit.
     */
    maxChainedBatches: 20,
    /** Gap between chained batches. */
    chainDelaySeconds: 60,
    /** Bounds on what a moderator may configure. */
    minReminderDays: 1,
    maxReminderDays: 365,
    minGraceDays: 1,
    maxGraceDays: 90,
  },

  /** IST. r/IndianPets is an India-focused community; dates are shown in local time. */
  displayTimeZoneOffsetMinutes: 330,
  displayTimeZoneLabel: 'IST',
} as const;

/**
 * Names of the scheduled tasks declared in devvit.json. These strings must
 * match the keys under `scheduler.tasks` exactly.
 */
export const JOBS = {
  /** Nightly sweep for fundraisers that have gone quiet. */
  staleSweep: 'stale-sweep',
  /** Continuation of a sweep that had more work than one run allows. */
  staleSweepBatch: 'stale-sweep-batch',
  /** Files a duplicate-link report, off the trigger's hot path. */
  duplicateReport: 'duplicate-report',
  /** Replies to an OP whose fundraiser AutoModerator has just held. */
  automodReply: 'automod-reply',
} as const;

/**
 * Redis key schema.
 *
 * Devvit's Redis cannot list or scan keys, so every key that needs to be
 * discovered later is reachable from a sorted-set index. Records are stored as
 * plain string keys (not hash fields) because Devvit offers `mGet` for batched
 * string reads but has no `hmGet` and no pipelining - plain keys are the only
 * way to read many records in one command.
 */
export const KEY_PREFIX = 'fv';
