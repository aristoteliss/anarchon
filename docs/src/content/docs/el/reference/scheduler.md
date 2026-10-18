---
title: Scheduler
description: Κάθε μέθοδος και ιδιότητα της κλάσης Scheduler.
---

```ts
import { Scheduler } from 'anarchon';
```

## Κατασκευαστής (Constructor)

```ts
new Scheduler(options: SchedulerOptions)
```

Δημιουργεί έναν scheduler. Τίποτα δεν συνδέεται μέχρι το `start()`. Το `backend` είναι υποχρεωτικό: δεν υποτίθεται κανένα store. Δείτε [Επιλογές](../options/#επιλογές-scheduler).

**Ρίχνει** `TypeError` όταν δεν δίνεται `backend`, ή το `instanceId` είναι κενό· `RangeError` όταν ένας αριθμός είναι εκτός ορίων, ή το `heartbeatMs` δεν είναι μικρότερο από το μισό του `leaseMs`.

## Ιδιότητες

| Ιδιότητα | Τύπος | Σημασία |
| --- | --- | --- |
| `instanceId` | `string` | Το όνομα αυτού του instance στο ιστορικό και στα συμβάντα |
| `backend` | `Backend` | Το backend σε χρήση. Το `backend.name` είναι π.χ. `'redis:lease'` ή `'postgres'` |
| `name` | `string \| undefined` | Το όνομα με το οποίο οι εργασίες με decorators επιλέγουν αυτόν τον scheduler, αν έχει |

## Ορισμός εργασιών

Και οι τρεις επιστρέφουν τον scheduler, επομένως υποστηρίζουν αλυσιδωτή κλήση.

### `every(name, interval, handler, options?)`

```ts
every(name: string, interval: number | string, handler: JobHandler, options?: EveryJobOptions): this
```

Προσθέτει μια εργασία μεσοδιαστήματος. Το `interval` είναι σε ms ή συμβολοσειρά διάρκειας (`'10s'`, `'35m'`, `'1h30m'`, `'2d'`). Ελάχιστο 1 δευτερόλεπτο. Οι εκτελέσεις τοποθετούνται σε ένα πλέγμα UTC.

**Ρίχνει** `RangeError` για μη έγκυρο ή πολύ μικρό μεσοδιάστημα, ή μη ασφαλείς χρονισμούς· `Error` εάν το όνομα έχει ήδη καταχωρηθεί.

### `cron(name, expression, handler, options?)`

```ts
cron(name: string, expression: string, handler: JobHandler, options?: CronJobOptions): this
```

Προσθέτει μια εργασία cron. Πέντε πεδία, ή έξι με πρώτα τα δευτερόλεπτα.

**Ρίχνει** `Error` για μη έγκυρη έκφραση ή διπλότυπο όνομα· `RangeError` εάν η έκφραση δεν πρόκειται να εκτελεστεί ποτέ στο μέλλον, ή για μη ασφαλείς χρονισμούς.

### `at(name, when, handler, options?)`

```ts
at(name: string, when: Date | number | string, handler: JobHandler, options?: JobOptions): this
```

Προσθέτει μια εφάπαξ εργασία. Το `when` είναι `Date`, ms από το 1970, ή ISO string.

**Ρίχνει** `RangeError` για μη έγκυρη ημερομηνία.

### `register(target, options?)`

```ts
register(target: object, options?: { prefix?: string; defaults?: JobOptions & { timezone?: string } }): this
```

Τοποθετεί σε αυτόν τον scheduler κάθε εργασία που έχει δηλωθεί με τα `@Cron`, `@Every` και `@At` στην κλάση του αντικειμένου, όποιον scheduler κι αν ονομάζει κάθε decorator. Κάθε εργασία καλεί τη μέθοδό της πάνω σε αυτό το αντικείμενο και ονομάζεται `Class-method`, εκτός αν ο decorator δίνει όνομα. Προσθέτει όλες τις εργασίες ή καμία.

Ένα αντικείμενο με decorators προσθέτει μόνο του τις εργασίες του όταν δημιουργείται, οπότε το καλείτε για να αποφασίσετε κάτι για ένα αντικείμενο: το `prefix` μπαίνει μπροστά από κάθε όνομα εργασίας, ώστε να συνυπάρχουν πολλά αντικείμενα μιας κλάσης, και τα `defaults` είναι επιλογές εργασίας για κάθε εργασία του αντικειμένου. Έτσι προστίθεται επίσης ένα αντικείμενο με legacy decorators σε κλάση χωρίς `@Scheduled()`. Η καταχώριση ενός αντικειμένου ξανά με επιλογές αντικαθιστά τις εργασίες του· χωρίς επιλογές δεν αλλάζει τίποτα.

**Ρίχνει** `TypeError` εάν η κλάση δεν έχει μεθόδους με decorators· διαφορετικά ό,τι ρίχνουν τα `every()`, `cron()` και `at()`.

Οδηγός: [Decorators](../../guides/decorators/#πολλά-αντικείμενα-μιας-κλάσης). Αναφορά: [Decorators](../decorators/).

### `remove(name)`

```ts
remove(name: string): boolean
```

Σταματά τον προγραμματισμό μιας εργασίας σε αυτό το instance. Επιστρέφει `false` εάν καμία εργασία δεν έχει αυτό το όνομα. Το ιστορικό διατηρείται· μια εκτέλεση που βρίσκεται σε εξέλιξη εδώ θα ολοκληρωθεί.

Οδηγός: [Ορισμός εργασιών](../../guides/defining-jobs/).

## Κύκλος ζωής

### `start()`

```ts
start(): Promise<void>
```

Συνδέεται, προετοιμάζει τις εργασίες, τις προγραμματίζει, και σε ένα backend μίσθωσης (lease) ανακτά ημιτελείς και χαμένες εκτελέσεις. Δεν κάνει τίποτα εάν εκτελείται ήδη.

**Απορρίπτει** όταν το backend δεν είναι προσβάσιμο ή είναι πολύ παλιό. Ο scheduler παραμένει σταματημένος.

**Ρίχνει** `Error` εάν κληθεί κατά την εκκίνηση ή τον τερματισμό.

### `stop(options?)`

```ts
stop(options?: { timeoutMs?: number }): Promise<void>
```

Σταματά τον προγραμματισμό, ακυρώνει το `ctx.signal` των εκτελούμενων εργασιών, περιμένει έως και `timeoutMs` (προεπιλογή 30000) για αυτές, και κλείνει τις συνδέσεις που άνοιξε το backend. Η εκ νέου κλήση του κατά τη διάρκεια τερματισμού επιστρέφει το ίδιο promise.

### `runNow(name, options?)`

```ts
runNow(name: string, options?: { data?: JobData }): Promise<RunRecord>
```

Εκτελεί μια εργασία τώρα σε αυτό το instance. Χωρίς αποδιπλασιασμό, δεν επιχειρείται ποτέ ξανά, καταγράφεται με `manual: true`. Επιλύεται με την εγγραφή της εκτέλεσης όταν ολοκληρωθεί ο handler. Το `data` είναι δεδομένα για αυτή τη μία εκτέλεση, πάνω από της εργασίας και του scheduler: δείτε [Δεδομένα εκτέλεσης](../../guides/run-data/).

**Ρίχνει** `Error` εάν η εργασία δεν είναι καταχωρημένη εδώ ή ο scheduler δεν έχει ξεκινήσει.

Οδηγός: [Κύκλος ζωής](../../guides/lifecycle/).

### `setData(data)`

```ts
setData(data: JobData | undefined): this
```

Αντικαθιστά το `data` του scheduler, τα δεδομένα που δίνονται σε κάθε handler ως `ctx.data` κάτω από τα δεδομένα κάθε εργασίας. Οι εκτελέσεις που ξεκινούν μετά παίρνουν τα νέα· όσες βρίσκονται σε εξέλιξη κρατούν τα δικά τους. Το `undefined` το αφαιρεί.

Οδηγός: [Δεδομένα εκτέλεσης](../../guides/run-data/).

## Schedulers για εργασίες με decorators

Στατικές μέθοδοι που δημιουργούν, βρίσκουν, ξεκινούν και σταματούν τους schedulers στους οποίους πηγαίνουν οι εργασίες με decorators. Περιγράφονται στην [αναφορά των Decorators](../decorators/#schedulers-για-εργασίες-με-decorators).

| Μέθοδος | Τι κάνει |
| --- | --- |
| `Scheduler.configure(options)`, `Scheduler.configure(name, options)` | Αποθηκεύει τις ρυθμίσεις από τις οποίες δημιουργείται ένας scheduler όταν τον χρειαστεί μια εργασία. Το backend είναι υποχρεωτικό |
| `Scheduler.get(name?)` | Ο προεπιλεγμένος scheduler ή ένας ονομασμένος, που δημιουργείται από τις ρυθμίσεις του αν δεν υπάρχει |
| `Scheduler.all()` | Ο προεπιλεγμένος scheduler και κάθε ονομασμένος |
| `Scheduler.startAll()`, `Scheduler.stopAll(options?)` | Ξεκινούν ή σταματούν όλους |
| `Scheduler.setDefault(scheduler)` | Επιλέγει τον προεπιλεγμένο scheduler |
| `Scheduler.reset()` | Ξεχνά schedulers, ονόματα και ρυθμίσεις. Για tests |

## Ανάγνωση

### `history(name, limit?)`

```ts
history(name: string, limit?: number): Promise<RunRecord[]>
```

Οι πιο πρόσφατες εκτελέσεις από όλα τα instances, με τις νεότερες πρώτες, μία εγγραφή ανά προσπάθεια. Το `limit` είναι από 1 έως 10000, προεπιλογή 20. Λειτουργεί για οποιοδήποτε όνομα εργασίας και πριν από το `start()`.

**Ρίχνει** `RangeError` για όριο εκτός εύρους.

### `lastRun(name)`

```ts
lastRun(name: string): Promise<RunRecord | null>
```

Η πιο πρόσφατη προσπάθεια, ή `null` εάν η εργασία δεν εκτελέστηκε ποτέ.

### `nextRun(name)`

```ts
nextRun(name: string): Date | null
```

Πότε είναι προγραμματισμένη η επόμενη εκτέλεση μιας καταχωρημένης εργασίας, ή `null` εάν δεν έχει άλλες εκτελέσεις.

**Ρίχνει** `Error` εάν η εργασία δεν είναι καταχωρημένη εδώ.

### `jobs()`

```ts
jobs(): JobInfo[]
```

Οι εργασίες που είναι καταχωρημένες σε αυτό το instance: `name`, `type`, `schedule`, `nextRunAt`, `runningHere`.

Οδηγός: [Ιστορικό](../../guides/history/).

## Συμβάντα

```ts
on<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this
once<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this
off<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this
```

Δείτε [Συμβάντα](../events/).

## Εξαγωγές βιβλιοθήκης (Exports)

Όλα όσα εξάγει το πακέτο.

| Export | Είδος | Σκοπός |
| --- | --- | --- |
| `Scheduler` | class | Ο scheduler |
| `RedisBackend` | class | [Redis και Valkey](../../backends/redis/) |
| `ValkeyBackend` | class | [Redis και Valkey](../../backends/redis/) |
| `PostgresBackend` | class | [PostgreSQL](../../backends/postgres/) |
| `SqliteBackend` | class | [SQLite και libSQL](../../backends/sqlite/) |
| `RabbitMQBackend` | class | [RabbitMQ](../../backends/rabbitmq/) |
| `NatsBackend` | class | [NATS](../../backends/nats/) |
| `SqlBackend` | αφηρημένη κλάση (abstract class) | Βάση των δύο SQL backends |
| `LeaseStore` | class | Η υλοποίηση μίσθωσης (lease) του Redis |
| `Cron`, `Every`, `At` | decorators | [Δήλωση εργασιών στις μεθόδους μιας κλάσης](../../guides/decorators/) |
| `Scheduled` | decorator | Για κλάσεις που γίνονται compile με [legacy decorators](../../guides/decorators/#οι-legacy-decorators-χρειάζονται-το-scheduled) |
| `parseDuration`, `formatDuration` | functions | `'1h30m'` σε ms, και αντίστροφα |
| `buildHistory` | function | Συνδέει τις διεκδικήσεις και τα αποτελέσματα μιας εργασίας σε εγγραφές ιστορικού, για ένα [δικό σας backend](../../backends/custom/) |
| `fromIORedis`, `fromNodeRedis`, `fromValkeyGlide` | functions | Προσαρμογή ενός Redis client σε `{ send }` |
| `fromPgPool`, `fromPgClient`, `fromPostgresJs` | functions | Προσαρμογή ενός Postgres client σε `{ all, transaction }` |
| `fromSqliteDatabase`, `fromLibsql` | functions | Προσαρμογή μιας SQLite βάσης δεδομένων ή libSQL client |
| Types | types | Δείτε [Τύποι](../types/) |

Σπάνια χρειάζεστε τους adapters `from...`: κάθε backend αναγνωρίζει αυτούς τους clients αυτόματα. Εξάγονται για τη δημιουργία δικών σας client wrappers.

### `parseDuration` και `formatDuration`

```ts
import { formatDuration, parseDuration } from 'anarchon';

parseDuration('1h30m'); // 5400000
parseDuration('500ms'); // 500
parseDuration(10_000);  // 10000
formatDuration(5_400_000); // '1h30m'
```
