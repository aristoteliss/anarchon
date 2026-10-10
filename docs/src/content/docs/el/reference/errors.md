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

## Δημιουργία scheduler

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| `Pass either backend, or the Redis shortcuts (redis, strategy, prefix, idmp), not both` | Δόθηκαν ταυτόχρονα το `backend` και μια επιλογή Redis | Τοποθετήστε τις επιλογές Redis στο `new RedisBackend()`, ή αφαιρέστε το `backend` |
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
| `Job "X": jitterMs + maxLateMs (N ms) must be shorter than how long B remembers a run (M ms)...` | Ένα καθυστερημένο instance θα μπορούσε να διεκδικήσει μια εκτέλεση που το store έχει ξεχάσει | Μειώστε το `maxLateMs`, ή αυξήστε το παράθυρο του backend (`idmp.durationSec`, `scriptWindowMs`, `slotTtlMs`, `duplicateWindowMs`) |
| `Job "X": idmp.maxSize (N) runs × G ms between runs must cover jitterMs + maxLateMs` | Το `'idmp'` διατηρεί πολύ λίγα ID εκτελέσεων για αυτό το μεσοδιάστημα | Αυξήστε το `idmp.maxSize` ή μειώστε το `maxLateMs` |
| `Job "X": historySize (N) runs × G ms between runs must cover jitterMs + maxLateMs ... for the "script" strategy` | Το `'script'` βρίσκει τις διεκδικημένες εκτελέσεις στο stream, το οποίο περικόπτεται στο `historySize` | Αυξήστε το `historySize` ή μειώστε το `maxLateMs` |
| `Job "X": historyTtlMs must be longer than scriptWindowMs` | Ίδιος λόγος, βάσει ηλικίας | Αυξήστε το `historyTtlMs` |
| `Job "X": overlap must be "skip" or "allow"` | Τυπογραφικό λάθος στο `overlap` | Χρησιμοποιήστε ένα από τα δύο |
| `Job "X": with RabbitMQ, job names may only contain letters, digits, "_" and "-"` | Το όνομα γίνεται όνομα ουράς ή subject | Μετονομάστε την εργασία |
| `offsetMs must be a whole number of ms` | Δεκαδικό offset | Χρησιμοποιήστε ακέραια χιλιοστά του δευτερολέπτου |

## Εκκίνηση

| Μήνυμα | Αιτία | Διόρθωση |
| --- | --- | --- |
| Σφάλμα σύνδεσης από τον driver (`ECONNREFUSED`, αποτυχία ταυτοποίησης...) | Το store δεν είναι προσβάσιμο | Ελέγξτε το URL, το δίκτυο και τα διαπιστευτήρια |
| `The "lease" strategy needs Redis 5 or newer` | Πολύ παλιό Redis | Αναβαθμίστε το Redis |
| `The "idmp" strategy needs Redis 8.6 or newer (this server is ...)` | Valkey, ή Redis πριν την έκδοση 8.6 | Χρησιμοποιήστε `'lease'`, `'stream-id'` ή `'script'` |
| `The Postgres backend needs PostgreSQL 9.5 or newer` | Παλιό PostgreSQL | Αναβαθμίστε |
| `The Postgres backend needs "pg"...` | Ο driver δεν είναι εγκατεστημένος | `pnpm add pg`, ή περάστε τον δικό σας client |
| `The SQLite backend needs SQLite 3.35 or newer for RETURNING` | Παλιά βιβλιοθήκη SQLite | Χρησιμοποιήστε νεότερο Node ή το `better-sqlite3` |
| `Could not open "path": this Node has no node:sqlite (Node 22.5+) and "better-sqlite3" isn't installed` | Δεν υπάρχει διαθέσιμος driver SQLite | Χρησιμοποιήστε Node 22.5+, ή `pnpm add better-sqlite3` |
| `database is locked` | Άλλη διεργασία διακράτησε το αρχείο SQLite για περισσότερο από το `busyTimeoutMs` | Αυξήστε το `busyTimeoutMs`· ελέγξτε για κάποιον writer μακράς διάρκειας |
| `The RabbitMQ backend needs RabbitMQ 3.9 or newer for stream queues` | Παλιό RabbitMQ | Αναβαθμίστε |
| `The RabbitMQ backend needs "amqplib"...` | Ο driver δεν είναι εγκατεστημένος | `pnpm add amqplib` |
| `The NATS backend needs JetStream enabled on the server (nats-server -js)` | Το JetStream είναι ανενεργό | Ενεργοποιήστε το |
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
