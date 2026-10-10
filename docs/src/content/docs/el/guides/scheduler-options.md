---
title: Επιλογές scheduler
description: Κάθε επιλογή του new Scheduler(), με παραδείγματα.
---

Το `new Scheduler(options)` δέχεται ένα αντικείμενο. Όλα σε αυτό είναι προαιρετικά: το `new Scheduler()` συνδέεται στο Redis στο `localhost:6379`.

Δώστε σε κάθε instance μιας υπηρεσίας τις ίδιες επιλογές, εκτός από το `instanceId`.

## Πού αποθηκεύονται οι εκτελέσεις

Επιλέγετε ένα store με έναν από δύο τρόπους, ποτέ και με τους δύο.

### Οι συντομεύσεις Redis

Για το Redis και το Valkey μπορείτε να περάσετε τη σύνδεση απευθείας:

```ts
new Scheduler();                                              // redis://localhost:6379
new Scheduler({ redis: 'redis://cache.internal:6379' });
new Scheduler({ redis: 'rediss://user:secret@host:6380/2' }); // TLS, χρήστης, κωδικός πρόσβασης, βάση δεδομένων 2
new Scheduler({ redis: { host: 'localhost', port: 6390 } });  // το Valkey λειτουργεί με τον ίδιο τρόπο
new Scheduler({ redis: existingIoredisClient });              // δικός σας client· το stop() τον αφήνει ανοιχτό
```

| Επιλογή | Προεπιλογή | Σημασία |
| --- | --- | --- |
| `redis` | `localhost:6379` | Ένα URL, `{ host, port, password, db }`, ή ένας client που έχετε ήδη (ioredis, iovalkey, node-redis, Valkey GLIDE, ή οποιοδήποτε αντικείμενο με μέθοδο `send(command, args)`) |
| `strategy` | `'lease'` | Πώς επιλέγεται ο νικητής. Δείτε το [Redis και Valkey](../../backends/redis/) |
| `prefix` | `'cron:'` | Πρόθεμα κάθε κλειδιού |
| `idmp` | | Ρυθμίσεις για τη στρατηγική `'idmp'` |

### Οποιοδήποτε άλλο backend

```ts
import { PostgresBackend, Scheduler, SqliteBackend } from 'anarchon';

new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
```

Αν περάσετε ταυτόχρονα και `backend` και μια συντόμευση Redis, προκαλείται `TypeError`.

## Ταυτότητα

### `instanceId`

Το όνομα αυτού του instance στο ιστορικό και στα events. Η προεπιλογή είναι `hostname:pid`.

Πρέπει να διαφέρει μεταξύ των instances, διαφορετικά το ιστορικό δεν μπορεί να τα ξεχωρίσει. Ένα όνομα pod είναι πιο ευανάγνωστο από ένα αναγνωριστικό διεργασίας (process id):

```ts
new Scheduler({ redis, instanceId: process.env.POD_NAME });
```

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
  redis,
  timezone: 'Europe/Athens',
  historySize: 200,
  historyTtlMs: 7 * 24 * 60 * 60_000, // μία εβδομάδα
});
```

:::tip
Ορίζετε πάντα το `timezone` αν χρησιμοποιείτε `cron()`. Η προεπιλογή είναι η τοπική ζώνη του διακομιστή, η οποία μπορεί να διαφέρει μεταξύ του φορητού σας υπολογιστή, του περιβάλλοντος CI και του production.
:::

## Χρονισμός μίσθωσης

*Μόνο για backends μίσθωσης.*

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
new Scheduler({ redis, leaseMs: 10_000, heartbeatMs: 2_000 }); // ένας νεκρός runner αντικαθίσταται εντός περίπου 14 δευτ.
```

Το άρθρο [Μισθώσεις](../../internals/leases/) εξηγεί τον μηχανισμό.

## Καταγραφή

| Επιλογή | Προεπιλογή | Σημασία |
| --- | --- | --- |
| `log` | `false` | Εγγραφή μίας γραμμής ανά έναρξη, ολοκλήρωση, αποτυχία, διακοπή, παράλειψη και χαμένη εκτέλεση |
| `logger` | `console` | Πού καταγράφονται αυτές οι γραμμές και τα σφάλματα για τα οποία δεν υπάρχει listener |

```ts
import pino from 'pino';

new Scheduler({ redis, log: true, logger: pino() });
```

Ένας logger χρειάζεται τις μεθόδους `warn` και `error`. Η μέθοδος `info` είναι προαιρετική· χωρίς αυτήν, τα μηνύματα εκτέλεσης πηγαίνουν στο `console.log`. Δείτε τα [Events και καταγραφή](../events-and-logging/).

## Συμπεριφορά διεργασίας

### `unrefTimers`

Από προεπιλογή, τα timers του scheduler διατηρούν τη διεργασία Node ενεργή, κάτι που είναι επιθυμητό για μια υπηρεσία. Ορίστε `unrefTimers: true` για να επιτρέψετε στη διεργασία να τερματίσει ακόμα και όταν υπάρχουν προγραμματισμένες εκτελέσεις. Αυτό είναι χρήσιμο σε scripts και δοκιμές.

```ts
new Scheduler({ backend, unrefTimers: true });
```

## Μια τυπική διαμόρφωση για περιβάλλον παραγωγής

```ts
import pino from 'pino';
import { Scheduler } from 'anarchon';

export const scheduler = new Scheduler({
  redis: process.env.REDIS_URL,
  prefix: 'billing:cron:',          // τα κλειδιά αυτής της ίδιας της υπηρεσίας
  instanceId: process.env.POD_NAME, // ευανάγνωστα ονόματα στο ιστορικό
  timezone: 'Europe/Athens',
  logger: pino(),
  log: true,
});
```

## Πότε προκαλούνται σφάλματα

Ο constructor επικυρώνει τις επιλογές του και παράγει άμεσα εξαίρεση (throws), ώστε μια εσφαλμένη ρύθμιση να μην μπορεί να περάσει σιωπηλά στο production:

| Πρόβλημα | Σφάλμα |
| --- | --- |
| Και ταυτόχρονα `backend` και μια συντόμευση Redis | `TypeError` |
| Το `instanceId` είναι κενό string | `TypeError` |
| Ένας αριθμός είναι αρνητικός, μηδέν όπου δεν επιτρέπεται, ή όχι ακέραιος | `RangeError` |
| Το `heartbeatMs` δεν είναι μικρότερο από το μισό του `leaseMs` | `RangeError` |

Τίποτα δεν συνδέεται κατά την εκτέλεση του constructor. Τα προβλήματα σύνδεσης εμφανίζονται όταν καλείτε το `start()`.

## Επόμενα βήματα

- [Συγγραφή handlers](../writing-handlers/)
- [Κύκλος ζωής](../lifecycle/)
