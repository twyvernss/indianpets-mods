import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { Hono } from 'hono';
import { getContainer } from './container.js';
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

// A request for an address this version does not have - typically a menu item
// from an older version still cached on a phone. Logged, and answered with a
// toast a moderator can act on instead of silence.
app.notFound((c) => {
  getContainer().log.warn('unknown endpoint', { path: c.req.path });
  return c.json({
    showToast: {
      text: 'This menu item is out of date. Close and reopen the app, then try again.',
      appearance: 'neutral',
    },
  });
});

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
