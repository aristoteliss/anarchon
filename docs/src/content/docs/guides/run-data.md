---
title: Run data
description: Give a job's runs the data they need, such as a permission, a tenant or a fresh token, and read it in the handler as ctx.data.
---

A handler is an ordinary function, so it can use whatever is in scope around it. The `data` option is for what isn't: values you decide where the job is defined or where the scheduler is created, and want in the handler when a run starts.

```ts
const scheduler = new Scheduler({ backend, data: { tenant: 'acme' } });

scheduler.every('export', '1h', async (ctx: JobContext<{ tenant: string; permission: string }>) => {
  await exportFor(ctx.data.tenant, ctx.data.permission);
}, { data: { permission: 'reports:export' } });
```

Each run receives it as `ctx.data`. It is `undefined` when you gave none.

## Where the data comes from

| Given in | Applies to | Example |
| --- | --- | --- |
| The scheduler's options | Every job of the scheduler | `new Scheduler({ data: { tenant: 'acme' } })` |
| `register()` defaults | Every job of one decorated object | `scheduler.register(object, { defaults: { data: { tenant: 'acme' } } })` |
| A job's options | That job | `scheduler.every(name, '1h', run, { data: { permission: 'export' } })` |
| A decorator | That job | `@Every('export', '1h', { data: { permission: 'export' } })` |
| `runNow()` | One manual run | `scheduler.runNow('export', { data: { requestedBy: user.id } })` |

They are layers, from the most general to the most specific, in the order of the table. Two plain objects are merged, and the more specific one's keys win. Any other value (a string, a number, an array, a class instance) replaces what is under it.

```ts
const scheduler = new Scheduler({ backend, data: { tenant: 'acme', region: 'eu' } });
scheduler.every('export', '1h', run, { data: { region: 'us', permission: 'export' } });

await scheduler.runNow('export');
// ctx.data: { tenant: 'acme', region: 'us', permission: 'export' }

await scheduler.runNow('export', { data: { permission: 'admin' } });
// ctx.data: { tenant: 'acme', region: 'us', permission: 'admin' }
```

## Reading it when the run starts

`data` can be a function. It is called when each run starts, so the handler gets the value as it is at that moment: a token that expires, the permissions a user has now, a feature flag.

```ts
scheduler.every('sync', '5m', sync, {
  data: async (run) => ({
    token: await auth.tokenFor('sync-service'),   // fresh for this run
    startedBy: run.manual ? 'operator' : 'schedule',
  }),
});
```

The function receives the run: everything in [`ctx`](../writing-handlers/#the-context-ctx) except `data` itself, including `signal`. It may be async.

| If the function | Then |
| --- | --- |
| Throws or rejects | The run fails with that error, like a handler that throws. The handler isn't called |
| Is slower than the job's `timeoutMs` | The run times out |

:::note[A function is always called]
To pass a function as the data itself, put it in an object: `{ data: { notify: sendMail } }`.
:::

## Changing it while the scheduler runs

`setData()` replaces the scheduler's data. Runs that start afterwards get the new one; runs in progress keep theirs.

```ts
scheduler.setData({ tenant: 'acme', features: await loadFeatures() });
events.on('features-changed', (features) => scheduler.setData({ tenant: 'acme', features }));
```

For a single run, pass `data` to `runNow()`:

```ts
app.post('/jobs/:name/run', async (req, res) => {
  const run = await scheduler.runNow(req.params.name, { data: { requestedBy: req.user.id } });
  res.json({ status: run.status });
});
```

## Typing it

`ctx.data` is `unknown` unless you say what it is. Name the type in the handler:

```ts
interface ExportData {
  tenant: string;
  permission: string;
}

scheduler.every('export', '1h', async (ctx: JobContext<ExportData>) => {
  ctx.data.tenant; // string
});

class Reports {
  @Every('export', '1h')
  async export(ctx: JobContext<ExportData>) {}
}
```

The type is your statement about what you configured: anarchon doesn't check the value against it.

## What run data is not

- **Not shared between instances.** Each instance builds the data of the runs it executes, from its own settings. Give every instance the same ones, like the jobs themselves.
- **Not stored.** It isn't written to the store or to history, so it can hold secrets and objects such as a database client.
- **Not a per-run payload from another instance.** A run is defined by its time, not by a message. To hand work from one place to another, use a queue.

A runnable example is in the repository as [`examples/run-data.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/run-data.ts): `pnpm example:run-data`.

## Next

- [Writing handlers](../writing-handlers/): the rest of `ctx`
- [Decorators](../decorators/): data on decorated jobs and objects
- [Scheduler API](../../reference/scheduler/#setdatadata)
