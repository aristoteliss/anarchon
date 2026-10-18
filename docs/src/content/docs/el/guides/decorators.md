---
title: Decorators
description: Δηλώστε εργασίες πάνω στις μεθόδους μιας κλάσης με τα @Cron, @Every και @At. Ένα αντικείμενο προσθέτει μόνο του τις εργασίες του όταν δημιουργείται, και ο scheduler μπορεί να δημιουργηθεί για εσάς από ρυθμίσεις που δίνετε μία φορά.
---

Οι εργασίες μπορούν να δηλωθούν πάνω στις μεθόδους μιας κλάσης, αντί να περνιούνται στα `every()`, `cron()` και `at()`. Όταν δημιουργείται ένα αντικείμενο της κλάσης, προσθέτει μόνο του τις εργασίες του στον scheduler.

```ts
import { At, Cron, Every, type JobContext, RedisBackend, Scheduler } from 'anarchon';

Scheduler.configure({ backend: new RedisBackend({ redis: process.env.REDIS_URL }), autoStart: true });

class Reports {
  constructor(private readonly mailer: Mailer) {}

  @Cron('weekday-digest', '0 8 * * 1-5', { timezone: 'Europe/Athens' })
  async digest(ctx: JobContext) {
    await this.mailer.send(await buildDigest(ctx.scheduledAt));
  }

  @Every('sync-customers', '10s', { timeoutMs: 8_000 })
  async sync() {
    await syncCustomers();
  }

  @At('announce-launch', '2026-12-01T09:00:00Z')
  async announce() {
    await this.mailer.send('We are live');
  }
}

new Reports(mailer); // δημιουργείται και ξεκινά ένας scheduler, και έχει τις τρεις εργασίες
```

Δεν υπάρχει framework εδώ: η `Reports` είναι μια συνηθισμένη κλάση, και το αντικείμενο το δημιουργείτε εσείς ή το αναθέτετε σε έναν container. Οι decorators δεν χρειάζονται `reflect-metadata`.

:::note[Legacy decorators]
Με `experimentalDecorators` στο `tsconfig.json`, βάλτε επίσης το `@Scheduled()` στην κλάση. Δείτε [Legacy decorators](#οι-legacy-decorators-χρειάζονται-το-scheduled).
:::

## Δύο τρόποι για να υπάρχει scheduler

Μια εργασία με decorator χρειάζεται έναν scheduler στον οποίο θα πάει. Είτε δίνετε τις ρυθμίσεις μία φορά και τον δημιουργεί το anarchon, είτε τον δημιουργείτε εσείς.

| | Ρυθμίσεις: `Scheduler.configure()` | Με το χέρι: `new Scheduler()` |
| --- | --- | --- |
| Ο scheduler δημιουργείται | Όταν δημιουργηθεί το πρώτο αντικείμενο που τον χρειάζεται | Όταν γράψετε `new Scheduler(...)` |
| Backend | Πρέπει να δοθεί. Δεν υποτίθεται κανένα | Πρέπει να δοθεί. Δεν υποτίθεται κανένα |
| Εκκίνηση | Με `autoStart: true`, ή από εσάς | Από εσάς |
| Παίρνετε το αντικείμενο με | `Scheduler.get()` | Τη μεταβλητή στην οποία το αναθέσατε |

### Από ρυθμίσεις

```ts
Scheduler.configure({
  backend: new PostgresBackend({ connection: process.env.DATABASE_URL }),
  timezone: 'Europe/Athens',
  autoStart: true,
});
```

Το `configure()` δέχεται τις [επιλογές του scheduler](../scheduler-options/) και το `autoStart`. Δεν δημιουργεί τίποτα: ο scheduler δημιουργείται όταν δημιουργηθεί ένα αντικείμενο με εργασίες με decorators, ή όταν καλέσετε το `Scheduler.get()`.

- **Το backend είναι υποχρεωτικό.** Χωρίς `backend`, το `configure()` ρίχνει σφάλμα: ένας scheduler δεν δημιουργείται ποτέ σε store που δεν επιλέξατε εσείς.
- **Η εκκίνηση είναι δική σας απόφαση.** Με `autoStart: true` ο scheduler ξεκινά όταν δημιουργείται, και μια αποτυχία εκκίνησης αναφέρεται ως [event `'error'`](../events-and-logging/). Χωρίς αυτό, τίποτα δεν συνδέεται μέχρι να τον ξεκινήσετε:

  ```ts
  await Scheduler.get().start();   // ένας scheduler
  await Scheduler.startAll();      // ο προεπιλεγμένος και κάθε ονομασμένος
  ```

- **Σταματήστε τους στο shutdown** με `await Scheduler.stopAll()`, ώστε οι εργασίες που εκτελούνται να παραδοθούν.

### Με το χέρι

```ts
const scheduler = new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL }) });
new Reports(mailer);
await scheduler.start();
```

Ο πρώτος scheduler που δημιουργείτε χωρίς `name` είναι ο **προεπιλεγμένος scheduler**: παίρνει τις εργασίες με decorators που δεν ονομάζουν άλλον.

## Οι τρεις decorators

Κάθε decorator δέχεται τα ίδια ορίσματα με τη μέθοδο που αντικαθιστά, χωρίς τον handler.

| Decorator | Ίδιο με | Πρόγραμμα |
| --- | --- | --- |
| `@Every(name?, interval, options?)` | [`every()`](../defining-jobs/#εργασίες-μεσοδιαστήματος-every) | Χιλιοστά του δευτερολέπτου ή string διάρκειας όπως `'10s'` |
| `@Cron(name?, expression, options?)` | [`cron()`](../defining-jobs/#εργασίες-cron-cron) | Μια έκφραση cron με 5 ή 6 πεδία |
| `@At(name?, when, options?)` | [`at()`](../defining-jobs/#εφάπαξ-εργασίες-at) | Ένα `Date`, ms από το 1970, ή ISO string |

Οι επιλογές είναι οι [επιλογές εργασιών](../job-options/) της αντίστοιχης μεθόδου (`timeoutMs`, `overlap`, `maxAttempts`, `catchUpMs`, `timezone`, [`data`](../run-data/) και οι υπόλοιπες), συν δύο του ίδιου του decorator:

| Επιλογή | Σημασία |
| --- | --- |
| `name` | Το όνομα της εργασίας, όταν δεν είναι το πρώτο όρισμα |
| `scheduler` | Ο scheduler στον οποίο πηγαίνει η εργασία: ένα όνομα ή ένας `Scheduler`. Προεπιλογή: ο προεπιλεγμένος scheduler |

Η μέθοδος λαμβάνει το ίδιο [`ctx`](../writing-handlers/) με κάθε handler, και μπορεί να το αγνοήσει. Μία μέθοδος μπορεί να φέρει περισσότερους από έναν decorators, τον καθένα με το δικό του όνομα:

```ts
class Sync {
  @Every('sync-fast', '10s')
  @Cron('sync-nightly', '0 3 * * *')
  async run() {}
}
```

## Ονομασία μιας εργασίας

Υπάρχουν τρεις τρόποι, και μπορούν να συνδυαστούν στην ίδια κλάση.

```ts
class Customers {
  @Every('sync-customers', '10s')           // το όνομα πρώτο, όπως στο scheduler.every()
  async sync() {}

  @Every('1h', { name: 'prune-customers' }) // το όνομα στις επιλογές
  async prune() {}

  @Every('1d')                              // χωρίς όνομα: 'Customers-report'
  async report() {}
}
```

Χωρίς όνομα, μια εργασία ονομάζεται `Class-method`.

:::caution[Δώστε όνομα στις εργασίες]
Το όνομα είναι η ταυτότητα της εργασίας στο store, και κάθε instance πρέπει να χρησιμοποιεί το ίδιο. Ένα προεπιλεγμένο όνομα αλλάζει όταν μετονομάζετε την κλάση ή τη μέθοδο, και σε κάθε build αν ένας minifier μετονομάζει τις κλάσεις. Κάθε αλλαγή ξεκινά ένα νέο ιστορικό, και κατά τη διάρκεια ενός rolling deploy το παλιό και το νέο όνομα εκτελούνται παράλληλα. Ένα όνομα που γράφετε εσείς δεν αλλάζει ποτέ.
:::

Το όνομα μπαίνει πρώτο και το πρόγραμμα δεύτερο. Δύο ορίσματα σε λάθος σειρά, όπως `@Every('1h', 'sync')` ή `@Cron('0 8 * * *', 'Europe/Athens')`, ρίχνουν `TypeError` όταν ορίζεται η κλάση, με τη σωστή μορφή στο μήνυμα.

## Επιλογή scheduler για μια εργασία

Μια εργασία πηγαίνει στον προεπιλεγμένο scheduler, εκτός αν ο decorator της ορίζει άλλον. Οι εργασίες που δίνουν το ίδιο όνομα μοιράζονται έναν scheduler, οπότε δέκα εργασίες μπορούν να βρίσκονται σε έναν scheduler, σε δέκα, ή σε οτιδήποτε ενδιάμεσο.

```ts
class Jobs {
  @Cron('job-1', '*/10 * * * * *')                            // ο προεπιλεγμένος scheduler
  one() {}

  @Cron('job-2', '*/10 * * * * *', { scheduler: 'billing' })  // ο scheduler με όνομα 'billing'
  two() {}

  @Every('job-3', '5s', { scheduler: 'billing' })             // ο ίδιος με του job-2
  three() {}

  @Every('job-4', '5s', { scheduler: reports })               // ένας Scheduler που δημιουργήσατε
  four() {}
}
```

Ένας ονομασμένος scheduler που δεν υπάρχει ακόμη δημιουργείται την πρώτη φορά που τον χρειάζεται μια εργασία. Οι ρυθμίσεις του είναι, με αυτή τη σειρά:

| Ρυθμίσεις | Παράδειγμα |
| --- | --- |
| Οι δικές του | `Scheduler.configure('billing', { backend: new RedisBackend({ redis: BILLING_REDIS_URL }), leaseMs: 10_000 })` |
| Οι προεπιλεγμένες, όταν το `backend` είναι συνάρτηση του ονόματος | `Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: 'cron_' + name }) })` |

Στο Redis, η συνάρτηση δίνει σε κάθε όνομα το δικό του πρόθεμα κλειδιών: `backend: (name) => new RedisBackend({ redis: REDIS_URL, prefix: 'cron:' + name + ':' })`.

Έτσι δύο schedulers δεν μοιράζονται ποτέ κατά λάθος την κατάσταση των εργασιών. Αν οι προεπιλεγμένες ρυθμίσεις περιέχουν ένα αντικείμενο backend, ένας ονομασμένος scheduler χωρίς δικές του ρυθμίσεις δεν μπορεί να δημιουργηθεί, επειδή δύο schedulers δεν μπορούν να μοιραστούν ένα αντικείμενο backend: το σφάλμα σας λέει να ρυθμίσετε αυτό το όνομα ή να κάνετε το `backend` συνάρτηση.

Ένας scheduler που δημιουργείτε εσείς παίρνει όνομα με το `new Scheduler({ name: 'billing', ... })`. Τα ονόματα είναι μοναδικά μέσα στη διεργασία.

## Πότε ένα αντικείμενο αποκτά τις εργασίες του

| Το αντικείμενο δημιουργείται | Οι εργασίες του προστίθενται |
| --- | --- |
| Όταν κάθε scheduler που ονομάζουν οι εργασίες του υπάρχει ή έχει ρυθμίσεις | Αμέσως. Το `new Reports()` ρίχνει σφάλμα αν μια εργασία δεν είναι έγκυρη ή το όνομά της υπάρχει ήδη |
| Πριν από αυτό | Όταν ξεκινήσει ένας από αυτούς τους schedulers. Το `start()` απορρίπτεται αν μια εργασία δεν είναι έγκυρη ή το όνομά της υπάρχει ήδη, και ο scheduler παραμένει σταματημένος |

Επομένως η σειρά δεν έχει σημασία, και αυτό ακριβώς χρειάζεται ένας container dependency injection: μπορεί να δημιουργήσει τα services σας πριν ή μετά τον scheduler. Ένα αντικείμενο προσθέτει όλες τις εργασίες του ή καμία.

Μια εργασία που προστίθεται έτσι είναι μια κανονική εργασία. Τα `remove()`, `runNow()`, `history()` και τα [events](../events-and-logging/) λειτουργούν πάνω της με βάση το όνομα.

### Εργασίες που δηλώθηκαν αλλά δεν προστέθηκαν ποτέ

Ένας decorator δεν κάνει τίποτα μέχρι να υπάρξει ένα αντικείμενο της κλάσης του. Όταν ξεκινά ο προεπιλεγμένος scheduler ή ένας ονομασμένος, προειδοποιεί μία φορά για κάθε δηλωμένη εργασία που κανένα αντικείμενο δεν έχει προσθέσει, μέσω του [`logger`](../scheduler-options/) του (η κονσόλα από προεπιλογή):

```
[anarchon] @Cron("0 3 * * *") on the method "cleanup" is not scheduled: no object of its class has been created
```

Είναι προειδοποίηση και όχι σφάλμα, επειδή μια κλάση μπορεί να φορτώνεται σκόπιμα σε μια διεργασία που δεν την εκτελεί, και ένα αντικείμενο που δημιουργείται μετά το `start()` εξακολουθεί να προσθέτει τις εργασίες του.

## Πολλά αντικείμενα μιας κλάσης

Τα ονόματα εργασιών είναι μοναδικά μέσα σε έναν scheduler, οπότε ένα δεύτερο αντικείμενο της ίδιας κλάσης απορρίπτεται: ο constructor του ρίχνει `Job "..." is already registered`. Για να έχετε πολλά, καταχωρίστε το καθένα με δικό του πρόθεμα:

```ts
for (const tenant of tenants) {
  scheduler.register(new Reports(tenant.mailer), {
    prefix: `${tenant.id}:`,                                      // 'acme:weekday-digest', 'acme:sync-customers'
    defaults: { timezone: tenant.timezone, timeoutMs: 60_000 },   // για κάθε εργασία αυτού του αντικειμένου
  });
}
```

Το `register(object, options)` αποφασίζει πράγματα για ένα αντικείμενο:

| Επιλογή | Σημασία |
| --- | --- |
| `prefix` | Μπαίνει μπροστά από κάθε όνομα εργασίας του αντικειμένου |
| `defaults` | [Επιλογές εργασιών](../job-options/) για κάθε εργασία του αντικειμένου. Μια επιλογή που ορίζεται σε decorator υπερισχύει, και οι ρυθμίσεις του scheduler ισχύουν για ό,τι δεν ορίζει κανένα από τα δύο. Το `timezone` χρησιμοποιείται μόνο από τις εργασίες cron |

Η κλήση τοποθετεί επίσης **κάθε** εργασία του αντικειμένου σε αυτόν τον scheduler, όποιον scheduler κι αν ονομάζει ένας decorator. Η καταχώριση ενός αντικειμένου ξανά με επιλογές αντικαθιστά τις εργασίες του· χωρίς επιλογές δεν αλλάζει τίποτα.

:::caution[Καταχωρίστε κάθε αντικείμενο πριν δημιουργήσετε το επόμενο]
Με standard decorators ένα αντικείμενο προσθέτει τις εργασίες του όταν δημιουργείται, με τα απλά τους ονόματα, και το `register()` τις μετονομάζει στη συνέχεια. Δύο αντικείμενα που δημιουργούνται το ένα μετά το άλλο, πριν καταχωριστεί κάποιο, θα διεκδικούσαν και τα δύο τα απλά ονόματα, και ο δεύτερος constructor ρίχνει σφάλμα. Δημιουργήστε κάθε αντικείμενο μέσα στην κλήση του `register()`, όπως παραπάνω.
:::

## Οι legacy decorators χρειάζονται το `@Scheduled()`

Οι standard decorators μπορούν να εκτελέσουν κώδικα όταν δημιουργείται ένα αντικείμενο, και έτσι ένα αντικείμενο προσθέτει τις εργασίες του. Οι legacy decorators (`experimentalDecorators`, το στυλ που χρησιμοποιούν το NestJS και το Angular) δεν μπορούν, οπότε η κλάση χρειάζεται έναν ακόμη decorator:

```ts
import { Every, Scheduled } from 'anarchon';

@Scheduled()
class Reports {
  @Every('sync-customers', '10s')
  async sync() {}
}
```

Το `@Scheduled()` δεν αλλάζει τίποτα με standard decorators, οπότε ο κώδικας που το έχει λειτουργεί και στα δύο στυλ. Με legacy decorators αντικαθιστά την κλάση με μια υποκλάση με το ίδιο όνομα, η οποία προσθέτει τις εργασίες στο τέλος του constructor.

Αν προτιμάτε να μην αλλάξει η κλάση, παραλείψτε το `@Scheduled()` και καλέστε εσείς το `scheduler.register(object)`.

| | Standard decorators | Legacy decorators |
| --- | --- | --- |
| `tsconfig.json` | Καμία ρύθμιση | `"experimentalDecorators": true` |
| `@Every`, `@Cron`, `@At` σε μεθόδους | Ναι | Ναι |
| Ένα αντικείμενο προσθέτει τις εργασίες του όταν δημιουργείται | Πάντα | Μόνο με `@Scheduled()` στην κλάση |
| `@Scheduled()` | Δεν χρειάζεται, και δεν βλάπτει | Χρειάζεται, εκτός αν καλείτε το `register()` |

:::caution[Χωρίς κανένα από τα δύο, οι εργασίες δεν προστίθενται]
Με legacy decorators, μια κλάση που δεν έχει `@Scheduled()` και της οποίας τα αντικείμενα δεν περνιούνται ποτέ στο `register()` δεν προσθέτει καμία εργασία. Ο scheduler σας το λέει όταν ξεκινά:

```
[anarchon] @Every "sync-customers" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)
```
:::

Το Node.js δεν εκτελεί από μόνο του τη σύνταξη των decorators, οπότε ο κώδικας πρέπει να γίνει compile. Τόσο το `tsc` όσο και το `tsx` το κάνουν. Οι standard decorators χρειάζονται TypeScript 5.0 ή νεότερη· το `emitDecoratorMetadata` δεν χρειάζεται ποτέ.

## Δεδομένα για τις εκτελέσεις: `data`

Μια εργασία χρειάζεται συχνά κάτι που δεν μπορεί να πάρει από το περιβάλλον της: το δικαίωμα με το οποίο εκτελείται, τον tenant για τον οποίο εκτελείται, ένα token που πρέπει να είναι φρέσκο. Δώστε το ως `data`, και κάθε εκτέλεση το λαμβάνει ως `ctx.data`:

```ts
class Reports {
  @Cron('export', '0 2 * * *', { data: { permission: 'reports:export' } })
  async export(ctx: JobContext<{ tenant: string; permission: string }>) {
    await exportFor(ctx.data.tenant, ctx.data.permission);
  }
}

scheduler.register(new Reports(), { prefix: 'acme:', defaults: { data: { tenant: 'acme' } } });
```

Τα δεδομένα του scheduler, του αντικειμένου (από το `register()`) και της εργασίας συγχωνεύονται, με τα πιο ειδικά από πάνω. Δείτε [Δεδομένα εκτέλεσης](../run-data/).

## Σε tests

Ο προεπιλεγμένος scheduler, οι ονομασμένοι και οι ρυθμίσεις είναι κοινά για ολόκληρη τη διεργασία. Επαναφέρετέ τα ανάμεσα στα tests, ώστε ένα αντικείμενο από ένα test να μην καταλήξει στον scheduler του επόμενου:

```ts
afterEach(async () => {
  await Scheduler.stopAll();
  Scheduler.reset(); // κανένας scheduler, καμία ρύθμιση, κανένα αντικείμενο σε αναμονή
});
```

Ένα service με μεθόδους με decorators μπορεί να δημιουργηθεί σε ένα unit test χωρίς κανέναν scheduler ή ρυθμίσεις: τίποτα δεν εκτελείται, και οι μέθοδοί του μπορούν να κληθούν απευθείας.

## Οι εφάπαξ εργασίες δέχονται απόλυτο χρόνο

Το `@At` δέχεται μια χρονική στιγμή, όχι μια καθυστέρηση. Κάθε instance πρέπει να συμφωνεί για το πότε είναι προγραμματισμένη μια εκτέλεση, και το «5 δευτερόλεπτα μετά την εκκίνηση αυτής της διεργασίας» είναι διαφορετική στιγμή σε κάθε instance, οπότε το καθένα θα εκτελούσε την εργασία. Γι' αυτό δεν υπάρχει `@Timeout`.

Για να εκτελέσετε κάτι μία φορά ανά deployment, υπολογίστε έναν χρόνο στον οποίο συμφωνούν όλα τα instances, για παράδειγμα από τη χρονική σήμανση του release:

```ts
class Migration {
  @At('backfill-2026-12', process.env.RELEASED_AT ?? '2026-12-01T09:00:00Z')
  async backfill() {}
}
```

## Κληρονομικότητα

Μια υποκλάση κληρονομεί τις εργασίες της γονικής της. Τα προεπιλεγμένα ονόματα χρησιμοποιούν την υποκλάση. Μια μέθοδος που κάνει override μια μέθοδο με decorator την αντικαθιστά, μαζί με τους decorators της: βάλτε decorator στο override για να διατηρήσετε την εργασία.

```ts
class Base {
  @Every('10s')
  async sync() {}
}

class Customers extends Base {}

new Customers(); // προσθέτει το 'Customers-sync'
```

## Όρια

- Μόνο οι δημόσιες μέθοδοι instance μπορούν να είναι εργασίες. Ένας decorator σε μέθοδο `static` ή `#private` ρίχνει `TypeError` όταν ορίζεται η κλάση.
- Το πρόγραμμα ενός decorator παγιώνεται όταν ορίζεται η κλάση. Για πρόγραμμα που προέρχεται από ρυθμίσεις που διαβάζονται αργότερα, χρησιμοποιήστε τα `every()`, `cron()` ή `at()`.
- Με standard decorators, ένα αντικείμενο προσθέτει τις εργασίες του στην αρχή του constructor του. Αν στη συνέχεια ο constructor ρίξει σφάλμα, οι εργασίες παραμένουν στον scheduler: αφαιρέστε τις με βάση το όνομα.
- Το `Scheduler.configure()` πρέπει να κληθεί πριν υπάρξει ο scheduler που περιγράφει. Μετά ρίχνει σφάλμα.

## Παραδείγματα προς εκτέλεση

| Παράδειγμα | Τι δείχνει | Εκτέλεση |
| --- | --- | --- |
| [`examples/decorators.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators.ts) | Standard decorators, χωρίς `@Scheduled()` | `pnpm example:decorators` |
| [`examples/decorators-legacy.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-legacy.ts) | Legacy decorators: `@Scheduled()` και `register()` | `pnpm example:decorators:legacy` |
| [`examples/decorators-startup.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-startup.ts) | Οι τρεις τρόποι εκκίνησης: `autoStart`, `Scheduler.startAll()`, ή scheduler που δημιουργείται με το χέρι | `pnpm example:decorators:startup auto` |
| [`examples/decorators-options.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-options.ts) | Schedulers που δημιουργούνται από ρυθμίσεις, scheduler ανά εργασία, πολλά αντικείμενα μιας κλάσης, και δεδομένα εκτέλεσης | `pnpm example:decorators:options` |
| [`examples/nestjs`](https://github.com/aristoteliss/anarchon/tree/main/examples/nestjs) | Μια εφαρμογή NestJS, ελεγμένη σε NestJS 11 και 12 | `pnpm --filter anarchon-example-nestjs start` |

Δεν χρειάζονται server: οι εργασίες συντονίζονται μέσω ενός αρχείου SQLite στον φάκελο temp.

## Επόμενα βήματα

- [Δεδομένα εκτέλεσης](../run-data/): τιμές για τις εκτελέσεις, σταθερές ή διαβασμένες όταν ξεκινά κάθε εκτέλεση
- [Επιλογές εργασιών](../job-options/): τι δέχονται οι επιλογές κάθε decorator
- [NestJS](../../recipes/nestjs/#δήλωση-εργασιών-με-decorators): providers που δηλώνουν εργασίες
- [Αναφορά decorators](../../reference/decorators/): κάθε υπογραφή, πού εμφανίζονται τα σφάλματα και τι να προσέξετε
