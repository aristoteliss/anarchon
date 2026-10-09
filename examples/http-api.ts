/**
 * A small HTTP API on top of the scheduler (plain node:http, no framework):
 *
 *   GET  /jobs                    jobs on this instance and their next run
 *   GET  /jobs/:name/runs?limit=  latest runs from all instances: who, when, finished, status
 *   GET  /jobs/:name/last         the latest run
 *   POST /jobs/:name/run          run a job now on this instance
 *
 *   npx tsx examples/http-api.ts
 *   curl localhost:3000/jobs/sync/runs?limit=5
 */
import { createServer } from 'node:http';

import { Scheduler } from '../src';

const scheduler = new Scheduler({ redis: process.env.REDIS_URL ?? 'redis://localhost:6379' });
scheduler.every('sync', '10s', async () => {}).cron('digest', '0 */2 * * *', async () => {}, { timezone: 'Europe/Athens' });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };
  try {
    const [, root, name, action] = url.pathname.split('/');
    if (root !== 'jobs') return send(404, { error: 'not found' });
    if (req.method === 'GET' && !name) return send(200, scheduler.jobs());
    if (req.method === 'GET' && name && action === 'runs') {
      return send(200, await scheduler.history(name, Number(url.searchParams.get('limit') ?? 20)));
    }
    if (req.method === 'GET' && name && action === 'last') return send(200, await scheduler.lastRun(name));
    if (req.method === 'POST' && name && action === 'run') return send(200, await scheduler.runNow(name));
    return send(404, { error: 'not found' });
  } catch (error) {
    return send(400, { error: error instanceof Error ? error.message : String(error) });
  }
});

scheduler
  .start()
  .then(() => server.listen(3000, () => console.log('API on http://localhost:3000/jobs')))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

process.on('SIGINT', async () => {
  server.close();
  await scheduler.stop();
  process.exit(0);
});
