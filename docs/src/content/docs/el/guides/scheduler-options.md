---
title: Επιλογές scheduler
description: Κάθε επιλογή του new Scheduler(), με παραδείγματα.
---

Το `new Scheduler(options)` δέχεται ένα αντικείμενο. Ένα πράγμα σε αυτό είναι υποχρεωτικό: πού αποθηκεύονται οι εκτελέσεις, ως `backend`. Δεν υποτίθεται κανένα store, οπότε το `new Scheduler()` ρίχνει σφάλμα. Όλα τα υπόλοιπα είναι προαιρετικά.

Δώστε σε κάθε instance μιας υπηρεσίας τις ίδιες επιλογές, εκτός από το `instanceId`.

## Πού αποθηκεύονται οι εκτελέσεις

Το `backend` είναι το store: ένα `RedisBackend` για Redis και Valkey, ή οποιοδήποτε άλλο backend.

```ts
import { PostgresBackend, RedisBackend, Scheduler, SqliteBackend } from 'anarchon';

new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });
new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL }) });             // rediss:// για TLS· χρήστης, κωδικός και βάση δεδομένων μπαίνουν στο URL
new Scheduler({ backend: new RedisBackend({ redis: { host: 'localhost', port: 6390 } }) });  // το Valkey λειτουργεί με τον ίδιο τρόπο
new Scheduler({ backend: new RedisBackend({ redis: existingIoredisClient }) });              // δικός σας client· το stop() τον αφήνει ανοιχτό
new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
```

Η σύνδεση Redis, η στρατηγική και το πρόθεμα κλειδιών είναι επιλογές του `RedisBackend`: δείτε το [Redis και Valkey](../../backends/redis/).

## Ταυτότητα

### `instanceId`

Το όνομα αυτού του instance στο ιστορικό και στα events. Η προεπιλογή είναι `hostname:pid`.

Πρέπει να διαφέρει μεταξύ των instances, διαφορετικά το ιστορικό δεν μπορεί να τα ξεχωρίσει. Ένα όνομα pod είναι πιο ευανάγνωστο από ένα αναγνωριστικό διεργασίας (process id):

```ts
new Scheduler({ backend, instanceId: process.env.POD_NAME });                              // Kubernetes: 'billing-7d9f8c-x2x4q'
new Scheduler({ backend, instanceId: `${os.hostname()}-${process.env.pm_id}` });           // cluster PM2: ένα ανά διεργασία
new Scheduler({ backend, instanceId: process.env.HOSTNAME });                              // Docker: το id του container
```

Χρησιμοποιήστε το για να απαντάτε στο «ποιο instance το εκτέλεσε;» στο ιστορικό, στα logs και στις μετρικές. Δύο instances με το ίδιο id λειτουργούν κανονικά, αλλά το ιστορικό τους δεν ξεχωρίζει.

## Προεπιλογές για κάθε εργασία

Αυτές ορίζουν την προεπιλεγμένη τιμή της [επιλογής εργασίας](../job-options/) με το ίδιο όνομα. Κάθε εργασία μπορεί παρ' όλα αυτά να παρακάμψει την αντίστοιχη επιλογή.

| Επιλογή | Προεπιλογή | Σημασία |
| --- | --- | --- |
| `jitterMs` | `2000` | Μέγιστη τυχαία καθυστέρηση πριν από τη διεκδίκηση (claim). Μειώνεται αυτόματα για μικρά μεσοδιαστήματα |
| `maxLateMs` | `60000` | Παράλειψη μιας εκτέλεσης αν αυτό το instance τη φτάσει αργότερα από αυτό το όριο |
| `historySize` | `1000` | Εκτελέσεις που διατηρούνται ανά εργασία |
| `historyTtlMs` | κανένα | Απόρριψη επιπλέον ιστορικού παλαιότερου από αυτό το διάστημα |
| `timezone` | του διακομιστή | Ζώνη ώρας για τις εκφράσεις cron |

```ts
new Scheduler({
  backend,
  timezone: 'Europe/Athens',
  historySize: 200,
  historyTtlMs: 7 * 24 * 60 * 60_000, // μία εβδομάδα
});
```

Διαφορετικές υπηρεσίες θέλουν διαφορετικές προεπιλογές:

```ts
// Υπηρεσία για μία χώρα: οι ώρες cron είναι τοπικές
new Scheduler({ backend, timezone: 'Europe/Athens' });

// Παγκόσμια υπηρεσία: cron σε UTC, και κάθε εργασία μιας περιοχής ορίζει τη δική της ζώνη
const scheduler = new Scheduler({ backend, timezone: 'UTC' });
scheduler.cron('eu-digest', '0 8 * * *', euDigest, { timezone: 'Europe/Berlin' });

// Πολλές φθηνές εργασίες: μικρότερο ιστορικό, και γρήγορη απόρριψη όταν ένα instance μένει πίσω
new Scheduler({ backend, historySize: 100, maxLateMs: 10_000, jitterMs: 500 });

// Εργασίες υπό έλεγχο: ένας χρόνος ιστορικού βάσει ηλικίας
new Scheduler({ backend, historySize: 5_000, historyTtlMs: 365 * 24 * 60 * 60_000 });
```

:::tip
Ορίζετε πάντα το `timezone` αν χρησιμοποιείτε `cron()`. Η προεπιλογή είναι η τοπική ζώνη του διακομιστή, η οποία μπορεί να διαφέρει μεταξύ του φορητού σας υπολογιστή, του περιβάλλοντος CI και του production.
:::

## Όνομα και δεδομένα

| Επιλογή | Προεπιλογή | Σημασία |
| --- | --- | --- |
| `name` | κανένα | Ένα όνομα για τον scheduler, μοναδικό μέσα στη διεργασία. Οι εργασίες που δηλώνονται με decorators επιλέγουν scheduler με αυτό: δείτε [Decorators](../decorators/#επιλογή-scheduler-για-μια-εργασία) |
| `data` | κανένα | Δεδομένα για τις εκτελέσεις κάθε εργασίας, που διαβάζονται στον handler ως `ctx.data`: μια τιμή, ή μια συνάρτηση που καλείται όταν ξεκινά μια εκτέλεση. Δείτε [Δεδομένα εκτέλεσης](../run-data/) |

```ts
// Δύο schedulers σε μία διεργασία: οι εργασίες με decorators επιλέγουν έναν με το όνομα
new Scheduler({ name: 'billing', backend: new PostgresBackend({ connection: billingPool }) });
new Scheduler({ name: 'reports', backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'reports:cron:' }) });

// Κοινές εξαρτήσεις για κάθε handler, χωρίς globals
new Scheduler({ backend, data: { db, mailer, environment: process.env.APP_ENV } });

// Δεδομένα που διαβάζονται στην αρχή κάθε εκτέλεσης: ένα feature flag όπως είναι τώρα
new Scheduler({ backend, data: async () => ({ dryRun: await flags.isOn('jobs-dry-run') }) });
```

## Χρονισμός μίσθωσης

*Μόνο για backends μίσθωσης.* Με RabbitMQ, NATS, ή Redis/Valkey χωρίς τη στρατηγική `lease`, το `new Scheduler()` δεν προσφέρει τα `leaseMs` και `heartbeatMs`, και τα απορρίπτει αν οριστούν παρ' όλα αυτά.

| Επιλογή | Προεπιλογή | Σημασία |
| --- | --- | --- |
| `leaseMs` | `30000` | Πόσο διαρκεί η μίσθωση μιας εκτελούμενης εργασίας χωρίς heartbeat |
| `heartbeatMs` | `5000`, ή `leaseMs / 6` αν είναι μικρότερο | Πόσο συχνά ανανεώνει τη μίσθωσή του ο runner, και πόσο συχνά τα εφεδρικά instances τον ελέγχουν (κάθε 1 έως 2 heartbeats) |

Το `heartbeatMs` πρέπει να είναι μικρότερο από το μισό του `leaseMs`, ώστε μια μίσθωση να ανανεώνεται τουλάχιστον δύο φορές πριν λήξει.

Αυτοί οι δύο αριθμοί καθορίζουν πόσο γρήγορα αντικαθίσταται ένας νεκρός runner:

```mermaid
flowchart LR
  crash["ο runner πεθαίνει"] --> expire["η μίσθωση λήγει<br/>έως και leaseMs αργότερα"] --> notice["ένα εφεδρικό instance ελέγχει<br/>εντός 2 heartbeats"] --> takeover["ανάληψη (takeover)"]
```

Επομένως, μια εκτέλεση που κατέρρευσε αναλαμβάνεται το πολύ `leaseMs + 2 × heartbeatMs` μετά το τελευταίο heartbeat του runner. Με τις προεπιλεγμένες τιμές αυτό είναι 40 δευτερόλεπτα.

| Στόχος | Ρύθμιση | Συμβιβασμός |
| --- | --- | --- |
| Ταχύτερο failover | `leaseMs: 6_000, heartbeatMs: 1_000` | Περισσότερη κίνηση heartbeats. Μια παύση μεγαλύτερη από 6 δευτερόλεπτα (ένα παρατεταμένο GC, μια σύντομη διακοπή δικτύου) προκαλεί ανάληψη (takeover) ενώ ο αρχικός runner είναι ακόμη ζωντανός |
| Ανοχή σε παρατεταμένες παύσεις | `leaseMs: 120_000` | Ένας πραγματικά νεκρός runner αντικαθίσταται μόνο μετά από 2 λεπτά |

```ts
new Scheduler({ backend, leaseMs: 10_000, heartbeatMs: 2_000 }); // ένας νεκρός runner αντικαθίσταται εντός περίπου 14 δευτ.
new Scheduler({ backend, leaseMs: 60_000 });                     // εργασίες που μπλοκάρουν το event loop για δευτερόλεπτα
new Scheduler({ backend, leaseMs: 6_000, heartbeatMs: 1_000 });  // σύντομες εργασίες όπου μετρά η γρήγορη ανάληψη
```

Αυξήστε το `leaseMs` όταν ένας υγιής runner μπορεί να σωπαίνει για λίγο: handlers βαριοί σε CPU που μπλοκάρουν το event loop, ένα store μακριά, ένας debugger. Μειώστε το όταν ένας νεκρός runner πρέπει να αντικαθίσταται γρήγορα και οι παύσεις είναι σπάνιες.

Το άρθρο [Μισθώσεις](../../internals/leases/) εξηγεί τον μηχανισμό.

## Καταγραφή

| Επιλογή | Προεπιλογή | Σημασία |
| --- | --- | --- |
| `log` | `false` | Εγγραφή μίας γραμμής ανά έναρξη, ολοκλήρωση, αποτυχία, διακοπή, παράλειψη και χαμένη εκτέλεση |
| `logger` | `console` | Πού καταγράφονται αυτές οι γραμμές και τα σφάλματα για τα οποία δεν υπάρχει listener |

```ts
import pino from 'pino';

new Scheduler({ backend, log: true, logger: pino() });
new Scheduler({ backend, log: true, logger: pino().child({ component: 'scheduler' }) });     // γραμμές με ετικέτα
new Scheduler({ backend, logger: winston.createLogger({ transports: [new winston.transports.Console()] }) }); // μόνο σφάλματα
new Scheduler({ backend, log: process.env.NODE_ENV !== 'production' });                    // γραμμές εκτελέσεων μόνο στην ανάπτυξη
```

Ένας logger χρειάζεται τις μεθόδους `warn` και `error`. Η μέθοδος `info` είναι προαιρετική· χωρίς αυτήν, τα μηνύματα εκτέλεσης πηγαίνουν στο `console.log`. Δείτε τα [Events και καταγραφή](../events-and-logging/).

## Συμπεριφορά διεργασίας

### `unrefTimers`

Από προεπιλογή, τα timers του scheduler διατηρούν τη διεργασία Node ενεργή, κάτι που είναι επιθυμητό για μια υπηρεσία. Ορίστε `unrefTimers: true` για να επιτρέψετε στη διεργασία να τερματίσει ακόμα και όταν υπάρχουν προγραμματισμένες εκτελέσεις. Αυτό είναι χρήσιμο σε scripts και δοκιμές.

```ts
new Scheduler({ backend, unrefTimers: true });
```

```ts
// Ένα script μίας χρήσης: εκτελεί την εργασία μία φορά τώρα, και η διεργασία τερματίζει μόνη της
const scheduler = new Scheduler({ backend, unrefTimers: true });
scheduler.every('backfill', '1d', backfill);
await scheduler.start();
await scheduler.runNow('backfill');
await scheduler.stop();
```

## Διαμορφώσεις ανά περιβάλλον

Πλήρεις διαμορφώσεις για συνηθισμένα μέρη όπου τρέχει μια υπηρεσία. Όλα τα instances της υπηρεσίας χρησιμοποιούν την ίδια.

### Παραγωγή σε Kubernetes, με Redis

```ts
import pino from 'pino';
import { RedisBackend, Scheduler } from 'anarchon';

export const scheduler = new Scheduler({
  backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }), // τα κλειδιά αυτής της ίδιας της υπηρεσίας
  instanceId: process.env.POD_NAME, // ευανάγνωστα ονόματα στο ιστορικό
  timezone: 'Europe/Athens',
  logger: pino(),
  log: true,
});
// Στο SIGTERM: await scheduler.stop({ timeoutMs: 20_000 }), μέσα στο grace period του pod
```

### Παραγωγή με PostgreSQL, δίπλα στα δεδομένα της εφαρμογής

```ts
export const scheduler = new Scheduler({
  backend: new PostgresBackend({ connection: pool, table: 'scheduler.runs' }), // το pool της εφαρμογής· πίνακες σε δικό τους schema
  instanceId: process.env.HOSTNAME,
  timezone: 'UTC',
  historyTtlMs: 90 * 24 * 60 * 60_000, // 90 ημέρες ιστορικού, με ερωτήματα SQL
});
```

### Ένα μηχάνημα, πολλές διεργασίες (PM2, cluster), με SQLite

```ts
export const scheduler = new Scheduler({
  backend: new SqliteBackend({ database: '/var/lib/app/jobs.db', busyTimeoutMs: 10_000 }),
  instanceId: `${os.hostname()}-${process.env.pm_id ?? process.pid}`,
  timezone: 'Europe/Athens',
});
```

### Ένα stack μόνο με RabbitMQ ή NATS

```ts
export const scheduler = new Scheduler({
  backend: new NatsBackend({ servers: process.env.NATS_URL, replicas: 3 }),
  instanceId: process.env.POD_NAME,
  maxLateMs: 60_000, // κάτω από το duplicateWindowMs (5 λεπτά από προεπιλογή)
  historySize: 200,  // το ιστορικό κρατιέται μόνο βάσει πλήθους
  // χωρίς leaseMs ή heartbeatMs: ένας broker δεν έχει μισθώσεις
});
```

### Τοπική ανάπτυξη

```ts
export const scheduler = new Scheduler({
  backend: new SqliteBackend({ database: './dev-jobs.db' }), // κανένας server
  timezone: 'Europe/Athens',
  log: true,                      // μία γραμμή ανά εκτέλεση στο τερματικό
  leaseMs: 10 * 60_000,           // ένα breakpoint δεν κάνει έναν εφεδρικό να αναλάβει την εκτέλεση
});
```

### Δοκιμές

```ts
const scheduler = new Scheduler({
  backend: new SqliteBackend({ database: ':memory:' }),
  unrefTimers: true, // ο test runner μπορεί να τερματίσει
  jitterMs: 0,       // οι εκτελέσεις ξεκινούν στην ώρα τους
});
afterEach(() => scheduler.stop());
```

Ο [φάκελος examples](https://github.com/aristoteliss/anarchon/tree/main/examples) έχει εκτελέσιμες διαμορφώσεις για πραγματικές καταστάσεις: `billing.ts`, `cache-refresh.ts`, `nightly-export.ts`, `tenants.ts` και `broker-notifications.ts`.

## Πότε προκαλούνται σφάλματα

Ο constructor επικυρώνει τις επιλογές του και παράγει άμεσα εξαίρεση (throws), ώστε μια εσφαλμένη ρύθμιση να μην μπορεί να περάσει σιωπηλά στο production:

| Πρόβλημα | Σφάλμα |
| --- | --- |
| Χωρίς `backend` | `TypeError` |
| Το `instanceId` είναι κενό string | `TypeError` |
| Ένας αριθμός είναι αρνητικός, μηδέν όπου δεν επιτρέπεται, ή όχι ακέραιος | `RangeError` |
| Το `heartbeatMs` δεν είναι μικρότερο από το μισό του `leaseMs` | `RangeError` |
| `leaseMs` ή `heartbeatMs` με backend χωρίς μισθώσεις | `TypeError` |

Τίποτα δεν συνδέεται κατά την εκτέλεση του constructor. Τα προβλήματα σύνδεσης εμφανίζονται όταν καλείτε το `start()`.

## Επόμενα βήματα

- [Συγγραφή handlers](../writing-handlers/)
- [Κύκλος ζωής](../lifecycle/)
