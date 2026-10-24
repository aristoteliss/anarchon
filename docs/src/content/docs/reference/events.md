---
title: Events
description: Every event and every field of its payload.
---

```ts
scheduler.on(event, listener);
scheduler.once(event, listener);
scheduler.off(event, listener);
```

Events describe what happened on **this instance**. Guide: [Events and logging](../../guides/events-and-logging/).

| Event | Payload type | Emitted when |
| --- | --- | --- |
| [`start`](#start) | `RunStartEvent` | This instance won a run and is about to call the handler |
| [`success`](#success) | `RunRecord` | The handler returned |
| [`failure`](#failure) | `RunFailureEvent` | The handler threw, or `timeoutMs` passed |
| [`interrupted`](#interrupted) | `RunInterruptedEvent` | `stop()` or a takeover aborted `ctx.signal`, and the handler then threw |
| [`skip`](#skip) | `SkipEvent` | A run was due and this instance didn't run it |
| [`lost`](#lost) | `LostEvent` | A backup took over a run this instance was executing, or its lease couldn't be renewed in time |
| [`error`](#error) | `SchedulerErrorEvent` | A backend or setup problem |

## `start`

| Field | Type | Meaning |
| --- | --- | --- |
| `job` | `string` | Job name |
| `slot` | `number` | Scheduled time, ms since 1970 |
| `scheduledAt` | `Date` | `slot` as a Date |
| `instanceId` | `string` | This instance |
| `manual` | `boolean` | Started with `runNow()` |
| `attempt` | `number` | `1`, or more after a takeover |
| `reason` | `RunReason` | `'scheduled'`, `'manual'`, `'catch-up'` or `'takeover'` |

## `success`

A [`RunRecord`](../types/#runkey-runevent-runrecord) with `status: 'success'`.

## `failure`

A `RunRecord` with `status: 'failed'`, plus:

| Field | Type | Meaning |
| --- | --- | --- |
| `cause` | `unknown` | The value the handler threw. For a timeout, an `Error` named `TimeoutError` |

`error` holds the same thing as text.

## `interrupted`

A `RunRecord` with `status: 'interrupted'`, plus:

| Field | Type | Meaning |
| --- | --- | --- |
| `cause` | `unknown` | The value the handler threw |
| `handedOver` | `boolean` | Lease backends: the run was given to another instance to finish |

## `skip`

| Field | Type | Meaning |
| --- | --- | --- |
| `job` | `string` | Job name |
| `slot` | `number` | The run that was skipped |
| `scheduledAt` | `Date` | `slot` as a Date |
| `instanceId` | `string` | This instance |
| `reason` | `'taken' \| 'late' \| 'overlap'` | Why |
| `lateMs` | `number` | With `'late'`: how late |

| `reason` | Meaning |
| --- | --- |
| `'taken'` | Another instance won this run |
| `'late'` | This instance, or its claim, was more than `maxLateMs` late |
| `'overlap'` | The previous run of this job is still going |

Background checks don't emit `skip`: a backup's periodic check and the catch-up on start are silent.

## `lost`

| Field | Type | Meaning |
| --- | --- | --- |
| `job` | `string` | Job name |
| `slot` | `number` | The run |
| `scheduledAt` | `Date` | `slot` as a Date |
| `attempt` | `number` | The attempt this instance was running |
| `instanceId` | `string` | This instance |

The run's `ctx.signal` aborts at the same moment.

## `error`

| Field | Type | Meaning |
| --- | --- | --- |
| `error` | `unknown` | What went wrong |
| `job` | `string` | The job, if the problem belongs to one |
| `slot` | `number` | The run, if the problem belongs to one |

Without an `error` listener, these are written with `logger.error`. They never throw into your code.

## The type

```ts
interface SchedulerEvents {
  start: RunStartEvent;
  success: RunRecord;
  failure: RunFailureEvent;
  interrupted: RunInterruptedEvent;
  skip: SkipEvent;
  lost: LostEvent;
  error: SchedulerErrorEvent;
}
```

## Order of events for one run

On the instance that runs it:

```
start  ->  success | failure | interrupted
```

`lost` can occur between `start` and the end, followed by `interrupted` if the handler throws on the abort.

On the instances that don't:

```
skip
```
