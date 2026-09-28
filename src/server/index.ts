import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { Hono } from 'hono';
import { forms } from './handlers/forms.js';
import { menu } from './handlers/menu.js';
import { jobs } from './handlers/scheduler.js';
import { triggers } from './handlers/triggers.js';

/**
 * Server entry point. Route wiring only - no logic lives here.
 *
 * Devvit requires every platform-invoked endpoint to sit under `/internal/`.
 * The paths mounted below must match the endpoints declared in devvit.json:
 *
 *   /internal/menu/verify-fundraiser          menu.items[0]
 *   /internal/menu/verification-status        menu.items[1]
 *   /internal/menu/settings                   menu.items[2]
 *   /internal/form/verify-submit              forms.verifyForm
 *   /internal/form/checklist-submit           forms.checklistForm
 *   /internal/form/settings-submit            forms.settingsForm
 *   /internal/triggers/automod-filter-post    triggers.onAutomoderatorFilterPost
 *   /internal/triggers/post-submit            triggers.onPostSubmit
 *   /internal/triggers/comment-create         triggers.onCommentCreate
 *   /internal/triggers/post-delete            triggers.onPostDelete
 *   /internal/jobs/stale-sweep                scheduler.tasks.stale-sweep
 *   /internal/jobs/stale-sweep-batch          scheduler.tasks.stale-sweep-batch
 *   /internal/jobs/duplicate-report           scheduler.tasks.duplicate-report
 *
 * There is no `/api/` router: this app has no client, so it has no endpoints a
 * user could call directly.
 */
const app = new Hono();
const internal = new Hono();

internal.route('/menu', menu);
internal.route('/form', forms);
internal.route('/triggers', triggers);
internal.route('/jobs', jobs);

app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
