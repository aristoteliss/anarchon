---
title: Γρήγορη εκκίνηση
description: Ένας scheduler που εκτελείται ως τρία instances σε πέντε λεπτά, χωρίς ανάγκη εγκατάστασης server.
---

Σε αυτόν τον οδηγό θα γράψετε έναν μικρό scheduler, θα τον εκτελέσετε ως τρία instances και θα παρακολουθήσετε κάθε εκτέλεση να συμβαίνει μία φορά. Στη συνέχεια, θα τερματίσετε ένα instance στη μέση μιας εκτέλεσης και θα δείτε ένα άλλο να ολοκληρώνει την εργασία του.

Χρησιμοποιεί ένα αρχείο SQLite ως το κοινόχρηστο store, επομένως δεν χρειάζεται να εγκαταστήσετε τίποτα εκτός από το Node 22.5 ή νεότερο. Η μετάβαση σε Redis ή PostgreSQL αργότερα είναι αλλαγή μίας γραμμής.

## 1. Δημιουργία του project

```sh
mkdir cron-demo && cd cron-demo
pnpm init
pnpm add anarchon
pnpm add -D tsx
```

## 2. Συγγραφή του scheduler

Δημιουργήστε το `app.ts`:

```ts
import { Scheduler, SqliteBackend } from 'anarchon';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const scheduler = new Scheduler({
    // Όλα τα instances πρέπει να δείχνουν στο ίδιο store. Εδώ: ένα αρχείο.
    backend: new SqliteBackend({ database: './jobs.db' }),
    // Σύντομη μίσθωση, ώστε η ανάληψη (takeover) να παρατηρείται γρήγορα. Η προεπιλογή είναι 30 s.
    leaseMs: 6_000,
    heartbeatMs: 1_000,
    log: true,
  });

  // Μια γρήγορη εργασία, κάθε 10 δευτερόλεπτα
  scheduler.every('sync', '10s', async () => {
    await sleep(200);
  });

  // Μια αργή εργασία: 20 δευτερόλεπτα δουλειάς, κάθε 30 δευτερόλεπτα
  scheduler.every('report', '30s', async (ctx) => {
    for (let second = 0; second < 20; second++) {
      ctx.signal.throwIfAborted(); // καθαρός τερματισμός όταν ζητηθεί
      await sleep(1_000);
    }
  });

  await scheduler.start();
  console.log(`started as ${scheduler.instanceId}`);

  // Καθαρός τερματισμός με Ctrl+C
  process.on('SIGINT', async () => {
    await scheduler.stop();
    process.exit(0);
  });
}

main();
```

## 3. Εκτέλεση τριών instances

Ανοίξτε τρία τερματικά στον φάκελο του project και εκτελέστε την ίδια εντολή στο καθένα:

```sh
npx tsx app.ts
```

Κάθε τερματικό εκτυπώνει το δικό του όνομα, περίπου όπως `started as my-laptop:41822`.

Παρακολουθήστε την έξοδο. Κάθε 10 δευτερόλεπτα, ακριβώς **ένα** τερματικό εκτυπώνει ότι ξεκίνησε το `sync`, και τα άλλα δύο εκτυπώνουν ότι το παρέλειψαν:

```
[anarchon] sync @ 2026-10-10T12:00:10.000Z: started on my-laptop:41822 (attempt 1, scheduled)
[anarchon] sync @ 2026-10-10T12:00:10.000Z: finished in 203 ms
```

```
[anarchon] sync @ 2026-10-10T12:00:10.000Z: skipped (taken)
```

Το ποιο τερματικό κερδίζει αλλάζει από εκτέλεση σε εκτέλεση. Αυτό είναι το αποτέλεσμα της τυχαίας καθυστέρησης (jitter).

:::note
Αμέσως μετά την εκκίνηση ενός instance ενδέχεται να δείτε εκτελέσεις με ένδειξη `catch-up` αντί για `scheduled`, καθώς και μια εκτέλεση του `report` με ένδειξη `skipped (overlap)`. Κατά την εκκίνηση, το anarchon εκτελεί την πιο πρόσφατη εκτέλεση αν δεν την έχει εκτελέσει ήδη κάποιος άλλος, ενώ μια νέα εκτέλεση του `report` παραλείπεται εφόσον η προηγούμενη βρίσκεται ακόμα σε εξέλιξη. Και τα δύο εξηγούνται στις [Μισθώσεις](../../internals/leases/).
:::

## 4. Ομαλός τερματισμός του runner

Περιμένετε μέχρι ένα τερματικό να εκτυπώσει ότι ξεκίνησε το `report`, και στη συνέχεια πατήστε **Ctrl+C** σε αυτό το τερματικό.

Μέσα σε ένα ή δύο δευτερόλεπτα, ένα άλλο τερματικό εκτυπώνει:

```
[anarchon] report @ 2026-10-10T12:00:30.000Z: started on my-laptop:41907 (attempt 2, takeover)
```

Το instance που τερματίστηκε *παρέδωσε την εκτέλεση (hand-over)*. Αυτό ακριβώς συμβαίνει σε κάθε rolling deploy.

## 5. Βίαιος τερματισμός του runner

Εκκινήστε ξανά το instance που είχε σταματήσει. Περιμένετε να ξεκινήσει το `report` κάπου, και στη συνέχεια τερματίστε βίαια αυτή τη διεργασία από ένα τέταρτο τερματικό:

```sh
kill -9 <pid>   # ο αριθμός μετά την άνω και κάτω τελεία στο όνομα του instance
```

Αυτή τη φορά δεν παραδίδεται τίποτα: η διεργασία απλώς εξαφανίστηκε. Περίπου 6 δευτερόλεπτα αργότερα (η μίσθωση που ορίσατε), ένας εφεδρικός (backup) παρατηρεί ότι η μίσθωση δεν ανανεώθηκε και αναλαμβάνει την εκτέλεση (takeover):

```
[anarchon] report @ 2026-10-10T12:01:00.000Z: started on my-laptop:41822 (attempt 2, takeover)
```

## Τι μόλις συνέβη

```mermaid
sequenceDiagram
  participant A as Instance A
  participant B as Instance B
  participant S as jobs.db
  A->>S: claim report @ 12:01:00
  S-->>A: won (attempt 1)
  B->>S: claim report @ 12:01:00
  S-->>B: running, so B becomes a backup
  loop κάθε δευτερόλεπτο
    A->>S: heartbeat: η μίσθωση λήγει σε 6 s
  end
  Note over A: kill -9
  loop κάθε 1 έως 2 δευτερόλεπτα
    B->>S: είναι η μίσθωση ακόμα ενεργή;
  end
  Note over S: 6 s χωρίς heartbeat
  B->>S: claim attempt 2
  S-->>B: won (attempt 2)
  Note over B: εκτελεί ξανά την εργασία
```

## Μετάβαση σε πραγματικό store

Αλλάξτε μία γραμμή. Όλα τα υπόλοιπα παραμένουν ίδια.

```ts
// Redis ή Valkey
const scheduler = new Scheduler({ redis: 'redis://localhost:6379' });

// PostgreSQL
import { PostgresBackend } from 'anarchon';
const scheduler = new Scheduler({
  backend: new PostgresBackend({ connection: process.env.DATABASE_URL }),
});
```

## Επόμενα βήματα

- [Βασικές έννοιες](../core-concepts/): ορισμός των slot, claim, jitter και lease
- [Ορισμός εργασιών](../../guides/defining-jobs/): εκφράσεις cron, χρονικά διαστήματα και μεμονωμένες εργασίες
- [Decorators](../../guides/decorators/): δηλώστε τις ίδιες εργασίες πάνω στις μεθόδους μιας κλάσης
- [Συγγραφή handlers](../../guides/writing-handlers/): τι περιέχει το `ctx` και γιατί έχει σημασία το `ctx.signal`
