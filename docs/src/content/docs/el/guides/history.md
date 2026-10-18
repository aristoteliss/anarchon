---
title: Ιστορικό
description: Μάθετε ποιος εκτέλεσε μια εργασία, πότε τελείωσε και πώς ολοκληρώθηκε, από οποιοδήποτε instance.
---

Κάθε εκτέλεση καταγράφεται στο store. Οποιοδήποτε instance μπορεί να διαβάσει αυτή την εγγραφή, συμπεριλαμβανομένης μιας διεργασίας που δεν εκτελεί καθόλου εργασίες.

```ts
const runs = await scheduler.history('sync', 5); // οι πιο πρόσφατες πρώτα
const last = await scheduler.lastRun('sync');
const next = scheduler.nextRun('sync');
const jobs = scheduler.jobs();
```

## `history(name, limit?)`

Επιστρέφει τις πιο πρόσφατες εκτελέσεις μιας εργασίας από **όλα τα instances**, με τις νεότερες πρώτα. Το `limit` είναι από 1 έως 10000 και έχει προεπιλογή το 20.

```ts
for (const run of await scheduler.history('sync', 5)) {
  console.log(run.scheduledAt.toISOString(), run.instanceId, run.attempt, run.status, run.durationMs);
}
```

```
2026-10-10T12:00:20.000Z api-1 1 success 198
2026-10-10T12:00:10.000Z api-3 1 success 212
2026-10-10T12:00:00.000Z api-2 1 success 205
```

Υπάρχει **μία εγγραφή ανά προσπάθεια**. Μια εκτέλεση της οποίας έγινε ανάληψη (takeover) εμφανίζεται δύο φορές: η προσπάθεια που δεν ολοκληρώθηκε και εκείνη που ολοκληρώθηκε.

```
2026-10-10T12:00:00.000Z api-2 2 success      4010     <- ένα εφεδρικό instance την ολοκλήρωσε
2026-10-10T12:00:00.000Z api-1 1 interrupted           <- ο πρώτος runner της πέθανε
```

Το `history()` λειτουργεί για οποιοδήποτε όνομα εργασίας, ακόμη και αν δεν έχει καταχωριστεί σε αυτό το instance, και συνδέεται αυτόνομα αν δεν έχει κληθεί το `start()`.

## Η εγγραφή εκτέλεσης

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `job` | `string` | Το όνομα της εργασίας |
| `slot` | `number` | Προγραμματισμένη ώρα, ms από το 1970 |
| `scheduledAt` | `Date` | Το `slot` ως Date |
| `instanceId` | `string` | Ποιο instance εκτέλεσε αυτή την προσπάθεια |
| `attempt` | `number` | `1`, ή `2` και άνω όταν ένα εφεδρικό ανέλαβε την εκτέλεση |
| `reason` | `string` | `'scheduled'`, `'manual'`, `'catch-up'` ή `'takeover'` |
| `manual` | `boolean` | `true` για το `runNow()` |
| `status` | `string` | Δείτε παρακάτω |
| `startedAt` | `Date` | Πότε το instance τη διεκδίκησε και την ξεκίνησε |
| `finishedAt` | `Date` | Πότε ολοκληρώθηκε. Λείπει όσο εκτελείται |
| `durationMs` | `number` | Λείπει όσο εκτελείται |
| `error` | `string` | Το μήνυμα σφάλματος, όταν το `status` είναι `'failed'` |

### Κατάσταση

| Κατάσταση | Σημασία |
| --- | --- |
| `running` | Σε εξέλιξη |
| `success` | Ο handler επέστρεψε |
| `failed` | Ο handler πέταξε σφάλμα ή έληξε το timeout |
| `interrupted` | Η προσπάθεια δεν ολοκληρώθηκε: ο runner της πέθανε ή πάγωσε, έχασε την εκτέλεση από εφεδρικό instance ή διακόπηκε |

:::note
Η κατάσταση `interrupted` για έναν νεκρό runner απαιτεί backend μίσθωσης, το οποίο μπορεί να αντιληφθεί ότι ο runner χάθηκε. Στα backends μόνο διεκδίκησης, μια εκτέλεση της οποίας ο runner πέθανε συνεχίζει να εμφανίζεται ως `running`, επειδή τίποτα δεν την ενημερώνει διαφορετικά.
:::

## `lastRun(name)`

Η πιο πρόσφατη προσπάθεια, ή `null` αν η εργασία δεν εκτελέστηκε ποτέ.

```ts
const last = await scheduler.lastRun('sync');
const healthy = last?.status === 'success' && Date.now() - last.startedAt.getTime() < 60_000;
```

## `nextRun(name)`

Πότε αναμένεται η επόμενη εκτέλεση μιας καταχωρισμένης εργασίας, ως `Date`, ή `null` αν δεν υπάρχουν άλλες εκτελέσεις (μια εφάπαξ εργασία στο παρελθόν). Η εκτέλεση ξεκινά έως και `jitterMs` αργότερα, σε όποιο instance τη διεκδικήσει.

Προκαλεί σφάλμα (throws) αν η εργασία δεν είναι καταχωρισμένη σε αυτό το instance.

## `jobs()`

Οι εργασίες που έχουν καταχωριστεί σε αυτό το instance.

```ts
console.table(scheduler.jobs());
```

| name | type | schedule | nextRunAt | runningHere |
| --- | --- | --- | --- | --- |
| sync | every | every 10s | 2026-10-10T12:00:10.000Z | 0 |
| digest | cron | cron "0 8 * * 1-5" (Europe/Athens) | 2026-10-12T05:00:00.000Z | 0 |

Το `runningHere` είναι ο αριθμός των εκτελέσεων αυτής της εργασίας που εκτελεί αυτό το instance αυτή τη στιγμή.

## Διεργασία μόνο για ανάγνωση

Ένα dashboard ή ένα admin API δεν χρειάζεται να εκτελεί εργασίες. Δημιουργήστε έναν scheduler που δείχνει στο ίδιο store, μην καταχωρίσετε καμία εργασία και απλώς διαβάστε:

```ts
const reader = new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }) });

app.get('/jobs/:name/runs', async (req, res) => {
  res.json(await reader.history(req.params.name, 50));
});
```

Πρέπει να χρησιμοποιεί το ίδιο store και το ίδιο `prefix` ή `table` με τα instances που εκτελούν τις εργασίες.

## Έλεγχοι υγείας

```ts
app.get('/health/cron', async (_req, res) => {
  const last = await scheduler.lastRun('sync');
  const ageMs = last ? Date.now() - last.startedAt.getTime() : Infinity;
  const ok = last?.status !== 'failed' && ageMs < 3 * 10_000; // το "sync" εκτελείται κάθε 10 δευτ.
  res.status(ok ? 200 : 503).json({ ok, last });
});
```

Ο έλεγχος του **store** αντί της τοπικής κατάστασης σημαίνει ότι ο έλεγχος επιτυγχάνει σε κάθε instance εφόσον κάποιο instance εκτελεί την εργασία, κάτι που είναι το επιθυμητό πίσω από έναν load balancer.

## Πόσο ιστορικό διατηρείται

Οι επιλογές `historySize` (προεπιλογή 1000 εκτελέσεις ανά εργασία) και `historyTtlMs` (χωρίς όριο από προεπιλογή) ελέγχουν τι διατηρείται. Και οι δύο είναι [επιλογές εργασιών](../job-options/#historysize-και-historyttlms) με προεπιλογές σε επίπεδο scheduler.

Το πού αποθηκεύεται εξαρτάται από το backend:

| Backend | Πού αποθηκεύεται το ιστορικό |
| --- | --- |
| Redis / Valkey | Ένα stream διεκδικήσεων και ένα sorted set αποτελεσμάτων, ανά εργασία |
| PostgreSQL / SQLite | Ο πίνακας `<table>_attempts` |
| RabbitMQ | Μια ουρά stream ανά εργασία |
| NATS | Το JetStream stream, στα subjects της εργασίας |

## Επόμενα βήματα

- [Events και καταγραφή](../events-and-logging/)
- [Συνταγή Express](../../recipes/express/): ιστορικό πίσω από ένα HTTP API
