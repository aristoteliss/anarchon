/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * An Express API on top of the scheduler: list the jobs, read their history, run one now.
 *
 *   npx tsx examples/http-api.ts                 # SQLite file in the temp folder
 *   BACKEND=redis npx tsx examples/http-api.ts   # see examples/shared.ts
 *
 *   curl localhost:3000/jobs                      jobs on this instance and their next run
 *   curl localhost:3000/jobs/sync/runs?limit=5    latest runs from all instances
 *   curl localhost:3000/jobs/sync/last            the latest run
 *   curl -X POST localhost:3000/jobs/sync/run     run it now, on this instance
 *
 * Start it twice (PORT=3001 for the second) to see runs spread over both instances in /runs.
 * Every request is also in examples/http-api.http, to send from VS Code with the REST Client extension.
 */
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

const PORT = Number(process.env.PORT ?? 3000);

const scheduler = new Scheduler({
  backend: backendFromEnv('http'),
  instanceId: `api-${PORT}`,
});

scheduler
  .every('sync', '10s', async () => {
    await sleep(300);
  })
  .cron('digest', '0 */2 * * *', async () => {}, { timezone: 'Europe/Athens' });

scheduler.on('success', (run) =>
  say(`${run.job} ran here in ${run.durationMs} ms`),
);

const app = express();

app.get('/jobs', (_req, res) => {
  res.json(scheduler.jobs());
});

app.get('/jobs/:name/runs', async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const runs = await scheduler.history(req.params.name, limit);
  res.json(runs);
});

app.get('/jobs/:name/last', async (req, res) => {
  const run = await scheduler.lastRun(req.params.name);
  res.json(run);
});

app.post('/jobs/:name/run', async (req, res) => {
  // Resolves when the job has finished, with its record
  const run = await scheduler.runNow(req.params.name);
  res.json(run);
});

// An unknown job name or a bad limit throws: answer 400 with the message
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(400).json({ error: message });
});

async function main() {
  await scheduler.start();
  const server = app.listen(PORT, () =>
    say(`API on http://localhost:${PORT}/jobs (${scheduler.backend.name})`),
  );

  const shutdown = async () => {
    server.close();
    await scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
