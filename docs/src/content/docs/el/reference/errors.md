---
title: Σφάλματα
description: Τα σφάλματα που ρίχνει το anarchon, τι σημαίνει το καθένα και πώς διορθώνεται.
---

Το anarchon ελέγχει τις ρυθμίσεις νωρίς και αναφέρει τι δεν πάει καλά. Τα σφάλματα εμφανίζονται σε τρεις χρονικές στιγμές.

| Πότε | Τι |
| --- | --- |
| `new Scheduler()`, `every()`, `cron()`, `at()` | Μη έγκυρες επιλογές. Ρίχνονται σύγχρονα |
| `start()` | Το store δεν είναι προσβάσιμο, είναι πολύ παλιό, ή λείπει ένας driver. Το promise απορρίπτεται |
| Κατά την εκτέλεση | Προβλήματα με το store. Αναφέρονται ως [συμβάντα `error`](../events/#error), δεν ρίχνονται ποτέ |

## Κωδικοί σφαλμάτων

Κάθε σφάλμα που ρίχνει το anarchon έχει `code`. Ελέγχετε τον κωδικό, όχι το μήνυμα: τα μηνύματα μπορεί να αλλάξουν διατύπωση σε οποιαδήποτε έκδοση, οι κωδικοί μένουν. Το σφάλμα κρατά την κλάση του (`TypeError`, `RangeError` ή `Error`).

```ts
import { isAnarchonError } from 'anarchon';

try {
  scheduler.every(name, interval, handler, options);
} catch (error) {
  if (isAnarchonError(error, 'ANARCHON_UNKNOWN_OPTION')) return badRequest(error.message);
  throw error;
}
```

| Κωδικός | Σημασία |
| --- | --- |
| `ANARCHON_INVALID_ARGUMENT` | Μια τιμή ή ένα όρισμα που δεν μπορεί να χρησιμοποιηθεί: αριθμός εκτός ορίων, μη έγκυρη έκφραση cron ή ημερομηνία, backend που λείπει |
| `ANARCHON_UNKNOWN_OPTION` | Μια επιλογή που το αντικείμενο δεν έχει, συχνά ορθογραφικό λάθος |
| `ANARCHON_UNSUPPORTED` | Μια έγκυρη επιλογή που το backend ή η στρατηγική δεν μπορεί να τηρήσει, όπως το `overlap` στο RabbitMQ |
| `ANARCHON_UNSAFE_JOB` | Ρυθμίσεις εργασίας που θα επέτρεπαν σε ένα καθυστερημένο instance να εκτελέσει μια εργασία δύο φορές |
| `ANARCHON_SERVER` | Ο server είναι πολύ παλιός, ή του λείπει μια δυνατότητα που χρειάζεται το backend |
| `ANARCHON_MISSING_DRIVER` | Το πακέτο driver ενός backend δεν είναι εγκατεστημένο |
| `ANARCHON_STATE` | Μια κλήση που η κατάσταση του scheduler δεν επιτρέπει, όπως `runNow()` πριν από το `start()` |
| `ANARCHON_JOB_EXISTS`, `ANARCHON_UNKNOWN_JOB` | Ένα όνομα εργασίας που είναι πιασμένο, ή δεν είναι καταχωρισμένο |
| `ANARCHON_SCHEDULER_EXISTS`, `ANARCHON_NO_SCHEDULER` | Ένα όνομα scheduler που είναι πιασμένο, ή που δεν αντιστοιχεί ούτε σε scheduler ούτε σε ρυθμίσεις |
| `ANARCHON_STORE` | Το store αρνήθηκε μια εγγραφή |
| `ANARCHON_STORE_FORMAT` | Το store περιέχει δεδομένα που έγραψε μια νεότερη έκδοση του anarchon: τρέξτε μία έκδοση σε όλα τα instances |
| `ANARCHON_CONTRACT` | Ένα backend απέτυχε σε έναν έλεγχο του `backendContract()` από το `anarchon/testing`: το μήνυμα λέει τι αναμενόταν |
| `ANARCHON_INTERNAL` | Σφάλμα του anarchon: παρακαλούμε αναφέρετέ το |

Νέοι κωδικοί μπορεί να προστεθούν σε minor έκδοση, οπότε κρατήστε έναν κλάδο default όταν κάνετε switch πάνω τους.

## Δημιουργία scheduler

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| `A scheduler needs a backend, e.g. backend: new RedisBackend({ redis: url }). No store is assumed` | Στο `new Scheduler()` δεν δόθηκε `backend` | Δώστε `backend` |
| `instanceId must be a non-empty string` | `instanceId: ''`, συχνά μια μη ορισμένη μεταβλητή περιβάλλοντος | Ελέγξτε τη μεταβλητή, ή παραλείψτε την επιλογή |
| `heartbeatMs (N) must be under half of leaseMs (M), so a lease is renewed at least twice` | Το `heartbeatMs` είναι πολύ κοντά στο `leaseMs` | Μειώστε το `heartbeatMs` ή αυξήστε το `leaseMs` |
| `X must be a positive whole number (got N)` | Ένας χρονισμός είναι μηδέν, αρνητικός ή δεκαδικός | Χρησιμοποιήστε ακέραια χιλιοστά του δευτερολέπτου |
| `Unknown strategy "X"` | Τυπογραφικό λάθος στο `strategy` | `'lease'`, `'stream-id'`, `'idmp'` ή `'script'` |

## Προσθήκη εργασίας

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| `Job name must be a non-empty string` | Κενό ή απόν όνομα | Δώστε ένα όνομα στην εργασία |
| `Job "X" is already registered` | Το ίδιο όνομα δύο φορές στον ίδιο scheduler | Χρησιμοποιήστε διακριτά ονόματα, ή καλέστε πρώτα το `remove()` |
| `Job "X": handler must be a function` | Τα ορίσματα είναι σε λάθος σειρά, ή λείπει ο handler | `every(name, interval, handler, options)` |
| `Job "X": the interval must be at least 1s (got N ms)` | `every()` με λιγότερο από ένα δευτερόλεπτο | Ένα δευτερόλεπτο είναι το ελάχιστο |
| `Invalid duration: "X" (examples: "10s", "35m", "1h30m")` | Μια συμβολοσειρά μεσοδιαστήματος που το anarchon δεν μπορεί να διαβάσει | Χρησιμοποιήστε `ms`, `s`, `m`, `h`, `d` |
| `Job "X": invalid cron "E": ...` | Κακοσχηματισμένη έκφραση cron | Πέντε πεδία, ή έξι με πρώτα τα δευτερόλεπτα |
| `Cron expression "E" never runs in the future` | Η έκφραση δεν ταιριάζει με καμία μελλοντική ημερομηνία | Ελέγξτε τα πεδία ημέρας και μήνα |
| `Job "X": invalid date ...` | `at()` με κάτι που δεν είναι ημερομηνία | Περάστε ένα `Date`, ms, ή μια συμβολοσειρά ISO |
| `Job "X": jitterMs (N) must be under half the time between runs (M ms)` | Το jitter είναι πολύ μεγάλο για το μεσοδιάστημα | Μειώστε το `jitterMs`, ή αφήστε το μη ορισμένο |
| `Job "X": maxLateMs (N) must be bigger than jitterMs (M)` | Ένα instance που περιμένει όλο το jitter του θα ήταν ήδη καθυστερημένο | Αυξήστε το `maxLateMs` ή μειώστε το `jitterMs` |
| `Job "X": jitterMs + maxLateMs (N ms) must be shorter than how long B remembers a run (M ms)...` | Ένα καθυστερημένο instance θα μπορούσε να διεκδικήσει μια εκτέλεση που το store έχει ξεχάσει | Μειώστε το `maxLateMs`, ή αυξήστε το παράθυρο του backend (`strategy.durationSec`, `strategy.windowMs`, `slotTtlMs`, `duplicateWindowMs`) |
| `Job "X": the idmp strategy's maxSize (N) runs × G ms between runs must cover jitterMs + maxLateMs` | Το `'idmp'` διατηρεί πολύ λίγα ID εκτελέσεων για αυτό το μεσοδιάστημα | Αυξήστε το `strategy.maxSize` ή μειώστε το `maxLateMs` |
| `Job "X": historySize (N) runs × G ms between runs must cover jitterMs + maxLateMs ... for the "script" strategy` | Το `'script'` βρίσκει τις διεκδικημένες εκτελέσεις στο stream, το οποίο περικόπτεται στο `historySize` | Αυξήστε το `historySize` ή μειώστε το `maxLateMs` |
| `Job "X": historyTtlMs must be longer than the script strategy's windowMs` | Ίδιος λόγος, βάσει ηλικίας | Αυξήστε το `historyTtlMs` |
| `Job "X": overlap must be "skip" or "allow"` | Τυπογραφικό λάθος στο `overlap` | Χρησιμοποιήστε ένα από τα δύο |
| `Job "X": overlap needs a backend with leases (...); B has none` (επίσης `maxAttempts`, `catchUpMs`) | Μια επιλογή μίσθωσης σε RabbitMQ, ή NATS, Redis ή Valkey χωρίς τη στρατηγική `lease`. Ο κώδικας με τύπους δεν μεταγλωττίζεται· το σφάλμα αφορά decorators και JavaScript | Αφαιρέστε την επιλογή, ή χρησιμοποιήστε backend με μισθώσεις |
| `leaseMs needs a backend with leases (...); B has none` (επίσης `heartbeatMs`) | Το ίδιο, στο `new Scheduler()` | Αφαιρέστε την επιλογή, ή χρησιμοποιήστε backend με μισθώσεις |
| `Job "X": a one-off job takes no overlap` | `at()` με `overlap` | Αφαιρέστε το: μια εφάπαξ εργασία δεν έχει προηγούμενη εκτέλεση |
| `Job "X": historyTtlMs is not supported by B, which keeps history by count (historySize) only` | `historyTtlMs` σε RabbitMQ ή NATS, στην εργασία ή στον scheduler | Χρησιμοποιήστε το `historySize` |
| `X: unknown option "K" (did you mean "M"?)` | Μια επιλογή με λάθος όνομα ή σε λάθος θέση: το `X` είναι `new Scheduler()`, `Job "name"`, `register()`, ένα backend, κ.ο.κ. Ελέγχονται και επιλογές από ρυθμίσεις ή JavaScript | Χρησιμοποιήστε το όνομα που προτείνει, ή αφαιρέστε την επιλογή |
| `The "S" strategy has no setting "K"` | Ρύθμιση άλλης στρατηγικής, π.χ. `{ name: 'lease', windowMs }` | Μεταφέρετέ τη στη στρατηγική όπου ανήκει |
| `Job "X": with RabbitMQ, job names may only contain letters, digits, "_" and "-"` | Το όνομα γίνεται όνομα ουράς ή subject | Μετονομάστε την εργασία |
| `offsetMs must be a whole number of ms` | Δεκαδικό offset | Χρησιμοποιήστε ακέραια χιλιοστά του δευτερολέπτου |

## Decorators

Μια εργασία που δηλώνεται με decorator προστίθεται όταν δημιουργείται το αντικείμενό της, ή όταν ξεκινά ο scheduler αν το αντικείμενο δημιουργήθηκε πρώτο. Επομένως τα παραπάνω σφάλματα της «Προσθήκης εργασίας» μπορούν να προέλθουν και από το `new YourClass()` και από το `start()`. Δείτε [Decorators](../decorators/#πού-εμφανίζονται-τα-σφάλματα).

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| `@Every can only decorate a public instance method` (επίσης `@Cron`, `@At`) | Ο decorator βρίσκεται σε μέθοδο `static` ή `#private`, ή σε κάτι που δεν είναι μέθοδος | Βάλτε τον σε δημόσια μέθοδο instance |
| `Job "X" is already registered`, από έναν constructor | Δημιουργήθηκε δεύτερο αντικείμενο της ίδιας κλάσης με decorators, ή δύο μέθοδοι έχουν το ίδιο όνομα | Δημιουργήστε ένα αντικείμενο ανά κλάση· δώστε σε κάθε decorator το δικό του όνομα |
| `register() needs an object whose class has methods decorated with @Cron, @Every or @At` | Δόθηκε η κλάση αντί για ένα αντικείμενο, ή η κλάση δεν έχει μεθόδους με decorators | Δώστε ένα αντικείμενο: `scheduler.register(new Reports())` |
| `@Cron("0 8 * * *", "Europe/Athens"): with two strings, the first is the job's name and the second the cron expression...` | Ως δεύτερο string δόθηκε ζώνη ώρας, ή το όνομα | `@Cron('0 8 * * *', { timezone: 'Europe/Athens' })`, ή `@Cron(name, expression)` |
| `@Every("1h", "sync"): the job's name, a string, comes first and the interval second...` (επίσης `@At`) | Το όνομα και το πρόγραμμα είναι σε λάθος σειρά, ή το όνομα δεν είναι string | `@Every('sync', '1h')` |
| Προειδοποίηση: `@Every "X" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)` | Legacy decorators (`experimentalDecorators`), χωρίς `@Scheduled()` στην κλάση, και κανένα αντικείμενο καταχωρισμένο όταν ξεκίνησε ο scheduler | Προσθέστε το `@Scheduled()`, ή καλέστε το `scheduler.register(object)` |
| Προειδοποίηση: `@Cron("...") on the method "X" is not scheduled: no object of its class has been created` | Δεν υπήρχε αντικείμενο της κλάσης όταν ξεκίνησε ο scheduler | Δημιουργήστε το αντικείμενο. Αγνοήστε την αν η κλάση δεν προορίζεται να εκτελείται σε αυτή τη διεργασία |
| `Job "X" is already registered. To use several objects of one class, register each of them with a prefix of its own...` | Δημιουργήθηκε δεύτερο αντικείμενο μιας κλάσης με decorators | `scheduler.register(new Reports(), { prefix: 'a:' })` για κάθε αντικείμενο, που δημιουργείται μέσα στην κλήση |
| `Scheduler.configure() needs a backend, e.g. backend: new RedisBackend({ redis: url })` | Ρυθμίσεις χωρίς backend. Δεν υποτίθεται κανένα | Προσθέστε `backend` |
| `The default scheduler already exists: configure it before it is created` (και για ονομασμένο) | Το `configure()` κλήθηκε αφού δημιουργήθηκε ο scheduler | Καλέστε πρώτα το `configure()`, κατά την εκκίνηση |
| `Scheduler "X" has no settings of its own, and the default settings hold a backend object...` | Μια εργασία ονομάζει τον scheduler `X`, που μπορεί να δημιουργηθεί μόνο από τις προεπιλεγμένες ρυθμίσεις, και αυτές περιέχουν ένα αντικείμενο backend | `Scheduler.configure('X', { ... })`, ή κάντε το προεπιλεγμένο `backend` συνάρτηση του ονόματος |
| `There is no default scheduler...`, `There is no scheduler named "X"...` | Το `Scheduler.get()` δεν βρήκε scheduler ούτε ρυθμίσεις | Δημιουργήστε τον, ή καλέστε το `configure()` |
| `A scheduler named "X" already exists` | Δόθηκε το ίδιο `name` σε δύο schedulers | Χρησιμοποιήστε έναν, ή άλλο όνομα |

## Εκκίνηση

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| Σφάλμα σύνδεσης από τον driver (`ECONNREFUSED`, αποτυχία ταυτοποίησης...) | Το store δεν είναι προσβάσιμο | Ελέγξτε το URL, το δίκτυο και τα διαπιστευτήρια |
| `The "lease" strategy needs Redis 5 or newer` | Πολύ παλιό Redis | Αναβαθμίστε το Redis |
| `The "idmp" strategy needs Redis 8.6 or newer (this server is ...)` | Valkey, ή Redis πριν την έκδοση 8.6 | Χρησιμοποιήστε `'lease'`, `'stream-id'` ή `'script'` |
| `The Postgres backend needs PostgreSQL 9.5 or newer` | Παλιό PostgreSQL | Αναβαθμίστε |
| `The Postgres backend needs "pg"...` | Ο driver δεν είναι εγκατεστημένος | `pnpm add pg`, ή περάστε τον δικό σας client |
| `The SQLite backend needs SQLite 3.35 or newer for RETURNING` | Παλιά βιβλιοθήκη SQLite | Χρησιμοποιήστε νεότερο Node ή το `better-sqlite3` |
| `Could not open "path": this Node has no node:sqlite (Node 22.13+, or 22.5+ with --experimental-sqlite) and "better-sqlite3" isn't installed` | Δεν υπάρχει διαθέσιμος driver SQLite | Χρησιμοποιήστε Node 22.13+ (22.5 έως 22.12 με `--experimental-sqlite`), ή `pnpm add better-sqlite3` |
| `database is locked` | Άλλη διεργασία διακράτησε το αρχείο SQLite για περισσότερο από το `busyTimeoutMs` | Αυξήστε το `busyTimeoutMs`· ελέγξτε για κάποιον writer μακράς διάρκειας |
| `The RabbitMQ backend needs RabbitMQ 3.9 or newer for stream queues` | Παλιό RabbitMQ | Αναβαθμίστε |
| `The RabbitMQ backend needs "amqplib"...` | Ο driver δεν είναι εγκατεστημένος | `pnpm add amqplib` |
| `The NATS backend needs JetStream enabled on the server (nats-server -js)` | Το JetStream είναι ανενεργό | Ενεργοποιήστε το |
| `The NATS "lease" strategy needs nats-server 2.10 or newer, which reports its clock` | Παλαιότερος NATS server | Αναβαθμίστε, ή χρησιμοποιήστε `strategy: 'msg-id'` |
| `The NATS "lease" strategy needs "@nats-io/kv"...` | Ο client του key-value δεν είναι εγκατεστημένος | `pnpm add @nats-io/kv` |
| `NatsBackend: with strategy "lease", the stream name "S" may only contain letters, digits, "_" and "-"...` | Το όνομα του stream δεν μπορεί να δώσει όνομα στο bucket `<stream>_RUNS` | Μετονομάστε το stream |
| `NatsBackend: unknown strategy "X" (use "msg-id" or "lease")` | Τυπογραφικό λάθος στο `strategy` | Χρησιμοποιήστε ένα από τα δύο |
| `Job "X": other instances wrote its state N times in a row while this one tried to; try again` | NATS `lease`: κάθε εγγραφή έχασε από την εγγραφή ενός άλλου instance | Συνήθως τίποτα: το επόμενο claim ή heartbeat προσπαθεί ξανά |
| `The NATS key "X" holds a value that is not the state of anarchon runs` | Κάτι άλλο εκτός του anarchon έγραψε στο bucket `<stream>_RUNS` | Δώστε στο anarchon δικό του stream (και άρα δικό του bucket) |
| `Cannot start while stopping` | Το `start()` κλήθηκε ενώ βρίσκεται σε εξέλιξη ένα `stop()` | Κάντε await πρώτα το `stop()` |
| `Invalid table name "X"` | Το `table` δεν είναι απλό αναγνωριστικό (προαιρετικά `schema.table`) | Χρησιμοποιήστε γράμματα, ψηφία και `_` |
| `A custom SQL client needs both all() and transaction()` | Ελλιπής προσαρμογέας | Παρέχετε και τις δύο συναρτήσεις |

Εάν το `start()` απορριφθεί, ο scheduler επιστρέφει σε αδρανή κατάσταση. Μπορείτε να διορθώσετε την αιτία και να καλέσετε ξανά το `start()`.

## Κλήση μεθόδων

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| `Unknown job "X"` | `runNow()` ή `nextRun()` για εργασία που δεν είναι καταχωρημένη σε αυτό το instance | Καταχωρήστε την εδώ, ή καλέστε μια διεργασία που την περιλαμβάνει |
| `Call start() before runNow()` | Ο scheduler δεν εκτελείται | Κάντε await πρώτα το `start()` |
| `limit must be a whole number from 1 to 10000` | `history()` με μη έγκυρο όριο | Συχνά μια τιμή από query string που δεν αναλύθηκε σωστά: επικυρώστε την |
| `Could not start a manual run of "X"` | Ζητήθηκαν δέκα χειροκίνητες εκτελέσεις μιας εργασίας μέσα στα ίδια λίγα χιλιοστά του δευτερολέπτου | Δοκιμάστε ξανά |

## Κατά την εκτέλεση

Προβλήματα με το store κατά την κανονική λειτουργία **δεν ρίχνονται**. Φτάνουν ως συμβάντα `error`:

```ts
scheduler.on('error', (e) => {
  logger.error({ err: e.error, job: e.job, slot: e.slot }, 'scheduler backend problem');
});
```

| Περίπτωση | Τι συμβαίνει |
| --- | --- |
| Μια διεκδίκηση δεν μπόρεσε να σταλεί | Αυτό το instance παραλείπει την εκτέλεση. Ένα άλλο instance μπορεί ακόμα να την κερδίσει |
| Ένα heartbeat απέτυχε | Δοκιμάζεται ξανά στο επόμενο heartbeat. Εάν οι αποτυχίες διαρκέσουν περισσότερο από τη μίσθωση, αναλαμβάνει ένα εφεδρικό instance |
| Το αποτέλεσμα δεν μπόρεσε να αποθηκευτεί | Η εργασία εκτελέστηκε, αλλά η εγγραφή ιστορικού της παραμένει `running` ή γίνεται `interrupted` |
| Ένας listener έριξε σφάλμα | Καταγράφεται στο log· τίποτα άλλο δεν επηρεάζεται |

Χωρίς listener για το `error`, αυτά καταγράφονται με το `logger.error`.

## Σφάλματα από τον handler σας

Ένα σφάλμα που ρίχνει ένας handler δεν είναι σφάλμα του anarchon. Η εκτέλεση καταγράφεται ως `failed` με το όνομα και το μήνυμα του σφάλματος, και το συμβάν `failure` μεταφέρει την τιμή που ρίχτηκε ως `cause`. Μηνύματα μεγαλύτερα από 2000 χαρακτήρες περικόπτονται στο ιστορικό.

| Καταγεγραμμένο σφάλμα | Σημασία |
| --- | --- |
| `TimeoutError: Timed out after N ms` | Πέρασε το `timeoutMs` της εργασίας |
| `AbortError: The scheduler is stopping` | `ctx.signal.throwIfAborted()` μετά το `stop()`. Η εκτέλεση είναι `interrupted`, όχι `failed` |
| `AbortError: This run was taken over by another instance` | Το ίδιο, μετά από ανάληψη |
