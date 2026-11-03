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
 *   /internal/menu/*       menu.items[].endpoint      handlers/menu.ts
 *   /internal/form/*       forms.*                    handlers/forms.ts
 *   /internal/triggers/*   triggers.*                 handlers/triggers.ts
 *   /internal/jobs/*       scheduler.tasks.*.endpoint handlers/scheduler.ts
 *
 * The full list lives in devvit.json; repeating it here only let it go stale.
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
