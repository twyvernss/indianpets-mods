import { redis, settings as devvitSettings } from '@devvit/web/server';
import type { ConfigRepo } from './data/configRepo.js';
import { createConfigRepo } from './data/configRepo.js';
import { createLinkRepo } from './data/linkRepo.js';
import type { RedisPort } from './data/redisPort.js';
import { createTokenRepo } from './data/tokenRepo.js';
import type { VerificationRepo } from './data/verificationRepo.js';
import { createVerificationRepo } from './data/verificationRepo.js';
import type { Logger } from './lib/logger.js';
import { createLogger } from './lib/logger.js';
import type { DuplicateService } from './services/duplicates.js';
import { createDuplicateService } from './services/duplicates.js';
import type { IntakeService } from './services/intake.js';
import { createIntakeService } from './services/intake.js';
import type { ModeratorGate } from './services/moderator.js';
import { createModeratorGate } from './services/moderator.js';
import { createRedditAdapter, createSchedulerAdapter } from './services/redditAdapter.js';
import type { ReminderService } from './services/reminders.js';
import { createReminderService } from './services/reminders.js';
import type { VerificationService } from './services/verification.js';
import { createVerificationService } from './services/verification.js';
import type { SettingsReader } from './settings.js';
import { createSettingsReader } from './settings.js';

/**
 * Composition root.
 *
 * This is the only module that reaches for the concrete Devvit clients. Every
 * service and handler receives its dependencies as ports, which is what makes
 * the unit tests able to run outside the Devvit runtime.
 *
 * The container is built once per process. Devvit server instances are
 * short-lived, so "once per process" is closer to "once per few requests" than
 * to a long-running singleton - nothing here may hold request-scoped state.
 */
export type Container = {
  log: Logger;
  repo: VerificationRepo;
  config: ConfigRepo;
  settings: SettingsReader;
  gate: ModeratorGate;
  verification: VerificationService;
  duplicates: DuplicateService;
  reminders: ReminderService;
  intake: IntakeService;
};

let instance: Container | null = null;

export function getContainer(): Container {
  if (instance) return instance;

  const log = createLogger({ app: 'indianpets-mods' });

  // The Devvit redis client structurally satisfies RedisPort; this is a
  // narrowing to the subset the app is allowed to use, not a widening.
  const redisPort: RedisPort = redis;

  const reddit = createRedditAdapter(log);
  const scheduler = createSchedulerAdapter();

  const repo = createVerificationRepo(redisPort);
  const links = createLinkRepo(redisPort);
  const tokens = createTokenRepo(redisPort);
  const config = createConfigRepo(redisPort);

  const settings = createSettingsReader(
    { getAll: () => devvitSettings.getAll<Record<string, unknown>>() },
    config,
  );

  const gate = createModeratorGate(reddit, redisPort, log);
  const now = (): number => Date.now();

  const verification = createVerificationService({
    repo,
    tokens,
    reddit,
    gate,
    settings,
    log,
    now,
    newId: () => globalThis.crypto.randomUUID(),
  });

  const duplicates = createDuplicateService({
    links,
    records: repo,
    reddit,
    scheduler,
    settings,
    log,
    now,
  });
  const reminders = createReminderService({ repo, reddit, scheduler, settings, log, now });
  const intake = createIntakeService({
    redis: redisPort,
    reddit,
    scheduler,
    settings,
    log,
    now,
    newId: () => globalThis.crypto.randomUUID(),
  });

  instance = {
    log,
    repo,
    config,
    settings,
    gate,
    verification,
    duplicates,
    reminders,
    intake,
  };
  return instance;
}
