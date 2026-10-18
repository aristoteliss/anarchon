---
title: "Δοκιμές και αποσφαλμάτωση"
description: "Δοκιμάστε handlers και schedules χωρίς server, και εκτελέστε βήμα προς βήμα μια εκτέλεση σε debugger."
---

## Δοκιμή ενός handler

Ένας handler είναι μια συνάρτηση. Οι πιο χρήσιμες δοκιμές τον καλούν απευθείας με ένα context που κατασκευάζετε εσείς. Δεν εμπλέκεται κανένας scheduler.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobContext } from 'anarchon';
import { buildInvoices } from './invoices';

function context(overrides: Partial<JobContext> = {}): JobContext {
  const slot = Date.UTC(2026, 9, 1, 6); // 2026-10-01T06:00:00Z
  return {
    name: 'monthly-invoices',
    slot,
    scheduledAt: new Date(slot),
    instanceId: 'test',
    manual: false,
    attempt: 1,
    reason: 'scheduled',
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('running twice for the same slot creates each invoice once', async () => {
  await buildInvoices(context());
  await buildInvoices(context({ attempt: 2, reason: 'takeover' }));
  assert.equal(await countInvoices(), 3);
});

test('stops when the signal aborts', async () => {
  const controller = new AbortController();
  const run = buildInvoices(context({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
});
```

Αυτές οι δύο δοκιμές καλύπτουν τα δύο πράγματα που οφείλει ένας handler στον scheduler: να είναι ασφαλής στην εκτέλεση δύο φορές (idempotent), και να σταματά όταν του ζητηθεί.

## Δοκιμές με πραγματικό scheduler

Για να δοκιμάσετε τη συνδεσμολογία (wiring), χρησιμοποιήστε το `SqliteBackend` σε ένα προσωρινό αρχείο. Δεν απαιτεί server και συμπεριφέρεται όπως τα production lease backends.

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, SqliteBackend } from 'anarchon';

function testScheduler(instanceId = 'test') {
  const file = join(mkdtempSync(join(tmpdir(), 'cron-test-')), 'jobs.db');
  return new Scheduler({
    backend: new SqliteBackend({ database: file }),
    instanceId,
    unrefTimers: true, // μην κρατάτε τη δοκιμαστική διεργασία ενεργή
  });
}
```

### Εκτέλεση μιας εργασίας χωρίς αναμονή για το πρόγραμμά της

Η μέθοδος `runNow()` εκτελεί την εργασία αμέσως και επιστρέφει την εγγραφή της:

```ts
test('the sync job succeeds', async () => {
  const scheduler = testScheduler();
  scheduler.every('sync', '1h', syncCustomers, { catchUpMs: 0 });
  await scheduler.start();
  try {
    const run = await scheduler.runNow('sync');
    assert.equal(run.status, 'success');
  } finally {
    await scheduler.stop();
  }
});
```

Το `catchUpMs: 0` αποτρέπει τον scheduler από το να εκτελέσει επίσης το πιο πρόσφατο slot κατά την εκκίνηση, κάτι που διαφορετικά θα πρόσθετε μια εκτέλεση που δεν ζητήσατε.

### Δύο instances

Για να διαπιστώσετε ότι μια εκτέλεση πραγματοποιείται μία φορά, μοιράστε το αρχείο ανάμεσα σε δύο schedulers:

```ts
test('two instances, one run per slot', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cron-test-')), 'jobs.db');
  const ran: string[] = [];
  const instances = ['A', 'B'].map(
    (instanceId) => new Scheduler({ backend: new SqliteBackend({ database: file }), instanceId, unrefTimers: true }),
  );
  for (const scheduler of instances) {
    scheduler.every('tick', '1s', (ctx) => void ran.push(`${ctx.slot}`), { catchUpMs: 0 });
  }
  await Promise.all(instances.map((s) => s.start()));
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  await Promise.all(instances.map((s) => s.stop()));

  assert.equal(new Set(ran).size, ran.length, 'no slot ran twice');
});
```

### Η επικύρωση ελέγχεται κατά την καταχώριση

Οι μη έγκυρες επιλογές πετούν σφάλμα (throw) κατά την προσθήκη της εργασίας, επομένως είναι εύκολο να ελεγχθούν χωρίς να ξεκινήσετε τίποτα:

```ts
test('refuses a jitter longer than half the interval', () => {
  const scheduler = testScheduler();
  assert.throws(() => scheduler.every('bad', '2s', () => {}, { jitterMs: 1_500 }), RangeError);
});
```

## Μην κάνετε mock το ρολόι γύρω από ένα πραγματικό backend

Τα εικονικά χρονόμετρα (fake timers) μετακινούν το ρολόι της διεργασίας σας, αλλά το store διατηρεί το δικό του. Σε ένα lease backend, η λήξη της μίσθωσης καθορίζεται από την ώρα του store, επομένως η μετακίνηση ενός εικονικού ρολογιού κατά μία ώρα δεν λήγει τη μίσθωση, και η δοκιμή καταλήγει να ελέγχει κάτι που δεν μπορεί να συμβεί στην πραγματικότητα. Δοκιμάστε τους handlers με ένα εικονικό context, και δοκιμάστε τη συνδεσμολογία με το `runNow()` και μικρά πραγματικά διαστήματα (intervals).

## Αποσφαλμάτωση μιας εκτέλεσης

Το αποθετήριο περιλαμβάνει παραδείγματα φτιαγμένα για debugger. Από ένα αντίγραφο του αποθετηρίου (checkout):

```sh
pnpm install
npx tsx examples/walkthrough.ts
```

Το `examples/walkthrough.ts` εκτελεί δύο instances σε μία διεργασία χρησιμοποιώντας ένα αρχείο SQLite, με μίσθωση 10 λεπτών και όριο καθυστέρησης (lateness limit), ώστε η παραμονή σε ένα breakpoint να μην αλλάζει το αποτέλεσμα. Η κεφαλίδα του απαριθμεί τις συναρτήσεις από τις οποίες διέρχεται μια εκτέλεση, με τη σειρά.

Στο VS Code, ανοίξτε το **Run and Debug**, επιλέξτε **Example: walkthrough (βηματική εκτέλεση μιας διαδρομής (step through one run))** και πατήστε F5. Κάνει παύση ακριβώς πριν από το `start()`. Προχωρήστε βήμα-βήμα (step in) με F11, ή ορίστε breakpoints στα παρακάτω:

| Αρχείο κάτω από το `src/scheduler/` | Συνάρτηση | Τι συμβαίνει εκεί |
| --- | --- | --- |
| `timers.ts` | `arm()` | Υπολογίζεται το επόμενο slot και τίθεται ένα timer |
| `scheduler.ts` | `fire()` | Το timer ενεργοποιήθηκε: η εκτέλεση είναι έτοιμη |
| `lease-runner.ts` | `run()` | Στέλνεται η διεκδίκηση (claim) και διαχειρίζεται το αποτέλεσμά της |
| `lease-runner.ts` | `executeLeased()` | Ξεκινά το heartbeat |
| `executor.ts` | `execute()` | Καλείται ο handler σας, και αποθηκεύεται το αποτέλεσμα |
| `lease-runner.ts` | `watch()` | Ένα εφεδρικό instance προγραμματίζει τον επόμενο έλεγχό του |

:::caution
Ένας debugger σε παύση σταματά το ρολόι της διεργασίας σας αλλά όχι του store. Με κανονικούς χρόνους μίσθωσης, η παύση σε ένα breakpoint για διάστημα μεγαλύτερο από το `leaseMs` αναγκάζει ένα εφεδρικό (backup) instance να αναλάβει την εκτέλεση (takeover). Αυτό είναι η βιβλιοθήκη που λειτουργεί σωστά· αυξήστε το `leaseMs` όσο κάνετε debug.
:::

Άλλα παραδείγματα στο αποθετήριο:

| Παράδειγμα | Τι δείχνει |
| --- | --- |
| [`examples/failover.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/failover.ts) | Τρία instances: ομαλή παράδοση (hand-over), και στη συνέχεια κατάρρευση και ανάληψη (takeover) |
| [`examples/options-and-events.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/options-and-events.ts) | Κάθε επιλογή εργασίας και κάθε συμβάν |
| [`examples/http-api.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/http-api.ts) | Το [Express API](../express/) |
| [`examples/own-clients.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/own-clients.ts) | Χρήση του δικού σας Redis client ή Postgres pool |
| [`examples/basic.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/basic.ts) | Εκτέλεση σε τρία τερματικά και τερματισμός του ενός |
| [`examples/decorators.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators.ts) | Εργασίες που δηλώνονται με τα [`@Every`, `@Cron` και `@At`](../../guides/decorators/) σε μια κλάση, με standard decorators |
| [`examples/decorators-legacy.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-legacy.ts) | Το ίδιο με legacy decorators (`experimentalDecorators`): `@Scheduled()` και `register()` |
| [`examples/decorators-startup.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-startup.ts) | Οι τρεις τρόποι εκκίνησης εργασιών με decorators: `autoStart`, `Scheduler.startAll()`, ή scheduler που δημιουργείται με το χέρι |
| [`examples/decorators-options.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-options.ts) | Schedulers που δημιουργούνται από ρυθμίσεις, scheduler ανά εργασία, πολλά αντικείμενα μιας κλάσης, και δεδομένα εκτέλεσης |
| [`examples/run-data.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/run-data.ts) | [Δεδομένα εκτέλεσης](../../guides/run-data/): του scheduler, μιας εργασίας, μια συνάρτηση που διαβάζεται σε κάθε εκτέλεση, `runNow()` και `setData()` |
| [`examples/nestjs`](https://github.com/aristoteliss/anarchon/tree/main/examples/nestjs) | Μια μικρή εφαρμογή [NestJS](../nestjs/#δήλωση-εργασιών-με-decorators) της οποίας οι providers δηλώνουν εργασίες με decorators. Ελεγμένη σε NestJS 11 και 12 |

Ρυθμίσεις από την πραγματική ζωή: η καθεμία είναι μια κατάσταση που λύνεται με διαφορετικό συνδυασμό επιλογών, και η κεφαλίδα του αρχείου εξηγεί κάθε επιλογή.

| Παράδειγμα | Κατάσταση | Προσέγγιση επιλογών |
| --- | --- | --- |
| [`examples/billing.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/billing.ts) | Χρέωση πελατών μία φορά την ημέρα, και μετά από διακοπή λειτουργίας | `maxAttempts: 1`, `catchUpMs`, `timeoutMs`, `timezone`, εγγραφές με κλειδί το `ctx.slot` |
| [`examples/cache-refresh.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/cache-refresh.ts) | Μια φθηνή ανανέωση κάθε λίγα δευτερόλεπτα σε τρία instances | `jitterMs` για να μοιράζεται, μικρό `maxLateMs`, `catchUpMs: 0`, μικρό `historySize` |
| [`examples/nightly-export.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/nightly-export.ts) | Μια μεγάλη εξαγωγή που διακόπτεται από ένα deploy | `ctx.signal` ανάμεσα στις σελίδες, checkpoint ανά εκτέλεση, `ctx.attempt`, `stop({ timeoutMs })` |
| [`examples/tenants.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/tenants.ts) | Οι ίδιες εργασίες ανά tenant, ο καθένας στη ζώνη ώρας του | μία εργασία ανά tenant, `timezone` και `data` ανά εργασία, συνάρτηση δεδομένων, `remove()`, `runNow()` με δεδομένα |
| [`examples/broker-notifications.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/broker-notifications.ts) | Μόνο RabbitMQ ή NATS: χωρίς μισθώσεις | κάθε εκτέλεση στέλνει ό,τι εκκρεμεί, `maxLateMs` κάτω από τη μνήμη του broker, χωρίς επιλογές μίσθωσης |

## Παρακολούθηση της λειτουργίας ενός instance

Ενεργοποιήστε το ενσωματωμένο log όσο ερευνάτε:

```ts
new Scheduler({ backend, log: true });
```

Ή καταγράψτε κάθε συμβάν με τα δεδομένα του (payload):

```ts
for (const event of ['start', 'success', 'failure', 'interrupted', 'skip', 'lost', 'error'] as const) {
  scheduler.on(event, (payload) => console.log(event, payload));
}
```

Στη συνέχεια συγκρίνετε με την προβολή σε επίπεδο cluster:

```ts
console.table(
  (await scheduler.history('sync', 10)).map((r) => ({
    scheduled: r.scheduledAt.toISOString(),
    by: r.instanceId,
    attempt: r.attempt,
    reason: r.reason,
    status: r.status,
    ms: r.durationMs,
  })),
);
```

## Συνηθισμένες εκπλήξεις

| Τι βλέπετε | Γιατί |
| --- | --- |
| Μια εκτέλεση ξεκινά αμέσως μετά το `start()` με αιτία `catch-up` | Το πιο πρόσφατο slot έπρεπε να είχε εκτελεστεί πρόσφατα και κανείς δεν το εκτέλεσε. Ορίστε `catchUpMs: 0` για να το απενεργοποιήσετε |
| Κάθε instance εκτός από ένα καταγράφει `skipped (taken)` | Αυτό είναι φυσιολογικό: ένας νικητής ανά εκτέλεση |
| `skipped (overlap)` | Η προηγούμενη εκτέλεση αυτής της εργασίας συνεχίζεται ακόμη |
| Μια εκτέλεση εμφανίζεται δύο φορές στο ιστορικό | Μία εγγραφή ανά προσπάθεια: έγινε ανάληψη (taken over) |
| Μια εργασία εκτελείται στο ίδιο instance κάθε φορά | Το `jitterMs` είναι 0, ή το ρολόι αυτού του instance προηγείται |
| Συμβάντα `lost` | Το instance δεν μπόρεσε να ανανεώσει τη μίσθωσή του εγκαίρως: τέθηκε σε παύση, μπλοκαρίστηκε ή αποκόπηκε από το store |

## Επόμενα βήματα

- [Συμβάντα και καταγραφή](../../guides/events-and-logging/)
- [Κύκλος ζωής εκτέλεσης](../../internals/run-lifecycle/)
