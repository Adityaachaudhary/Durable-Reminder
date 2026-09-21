import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ManualClock, type Clock } from './clock';
import { ReminderService, ServiceError } from './service';
import type { Worker } from './worker';

export interface ApiOptions {
  service: ReminderService;
  clock: Clock;
  /** Needed for the /admin endpoints (only mounted when the clock is a ManualClock). */
  worker?: Worker;
}

type Body = Record<string, unknown>;

async function readBody(request: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ServiceError('invalid_request', 'Request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ServiceError('invalid_request', 'Request body must be a JSON object');
  }
  return parsed as Body;
}

/**
 * REST API over the service.
 *
 *   POST   /reminders               create (201; 200 if the same id + same request is replayed; 409 if the id is taken by different content)
 *   GET    /reminders[?state=]      list
 *   GET    /reminders/:id           inspect: item + attempt history + version history
 *   PATCH  /reminders/:id           edit; body needs expectedVersion (409 if stale)
 *   POST   /reminders/:id/cancel    cancel (idempotent)
 *   GET    /health
 *
 * With a ManualClock (demos, tests) there are also:
 *   GET    /admin/clock             current time
 *   POST   /admin/clock             {"advanceMs": 60000} or {"now": "2026-03-08T07:30:00Z"}
 *   POST   /admin/tick              run the worker until nothing more is due at the current time
 */
export function createApp(options: ApiOptions): Hono {
  const { service, clock, worker } = options;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      return c.json({ error: { code: error.code, message: error.message, ...error.details } }, error.status as ContentfulStatusCode);
    }
    console.error('[api] unexpected error', error);
    return c.json({ error: { code: 'internal_error', message: 'Unexpected error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

  app.get('/health', (c) => c.json({ ok: true, now: new Date(clock.now()).toISOString() }));

  app.post('/reminders', async (c) => {
    const body = await readBody(c.req.raw);
    const { item, created } = service.create({
      id: body.id as string | undefined,
      kind: body.kind as 'reminder' | 'follow_up' | undefined,
      content: body.content as string,
      timeZone: body.timeZone as string,
      at: body.at as string,
      conversationId: body.conversationId as string | undefined,
    });
    return c.json(item, created ? 201 : 200);
  });

  app.get('/reminders', (c) => c.json({ items: service.list({ state: c.req.query('state') }) }));

  app.get('/reminders/:id', (c) => c.json(service.get(c.req.param('id'))));

  app.patch('/reminders/:id', async (c) => {
    const body = await readBody(c.req.raw);
    const { item, changed } = service.edit(c.req.param('id'), {
      expectedVersion: body.expectedVersion as number,
      content: body.content as string | undefined,
      at: body.at as string | undefined,
      timeZone: body.timeZone as string | undefined,
    });
    return c.json({ ...item, changed });
  });

  app.post('/reminders/:id/cancel', (c) => {
    const { item, changed } = service.cancel(c.req.param('id'));
    return c.json({ ...item, changed });
  });

  if (clock instanceof ManualClock) {
    const manual = clock;
    app.get('/admin/clock', (c) => c.json({ now: new Date(manual.now()).toISOString() }));

    app.post('/admin/clock', async (c) => {
      const body = await readBody(c.req.raw);
      if (typeof body.advanceMs === 'number' && Number.isFinite(body.advanceMs) && body.advanceMs >= 0) {
        await manual.advance(body.advanceMs);
      } else if (typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now))) {
        const target = Date.parse(body.now);
        if (target < manual.now()) throw new ServiceError('invalid_request', 'The clock cannot move backwards');
        await manual.advance(target - manual.now());
      } else {
        throw new ServiceError('invalid_request', 'Provide {"advanceMs": <ms>} or {"now": "<ISO instant>"}');
      }
      return c.json({ now: new Date(manual.now()).toISOString() });
    });

    app.post('/admin/tick', async (c) => {
      if (!worker) throw new ServiceError('invalid_request', 'No worker is attached to this server');
      const results = await worker.runUntilIdle();
      return c.json({ now: new Date(manual.now()).toISOString(), processed: results });
    });
  }

  return app;
}
