---
title: Decorators
description: "Τα @Every, @Cron, @At και @Scheduled, μαζί με τα Scheduler.configure(), get(), register() και τα υπόλοιπα: υπογραφές, παραδείγματα και τι να προσέξετε."
---

```ts
import { At, Cron, Every, Scheduled, Scheduler } from 'anarchon';
```

Οι decorators δηλώνουν εργασίες πάνω στις μεθόδους μιας κλάσης. Ένα αντικείμενο της κλάσης προσθέτει αυτές τις εργασίες στους schedulers τους όταν δημιουργείται. Οδηγός: [Decorators](../../guides/decorators/).

## Decorators μεθόδων

Και οι τρεις έχουν δύο μορφές: με το όνομα της εργασίας πρώτο, ή χωρίς αυτό. Απλώς καταγράφουν το πρόγραμμα· η εργασία ελέγχεται όταν προστίθεται σε έναν scheduler.

### `@Every`

```ts
Every(name: string, interval: number | string, options?: EveryJobOptions & { scheduler? }): JobDecorator
Every(interval: number | string, options?: EveryJobOptions & { name?, scheduler? }): JobDecorator
```

Δηλώνει μια εργασία μεσοδιαστήματος, όπως το [`every()`](../scheduler/#everyname-interval-handler-options). Το μεσοδιάστημα είναι χιλιοστά του δευτερολέπτου ή string διάρκειας· το μικρότερο είναι 1 δευτερόλεπτο.

```ts
class Customers {
  @Every('sync-customers', '10s', { timeoutMs: 8_000 })
  async sync(ctx: JobContext) {}

  @Every('1h', { name: 'prune-customers', overlap: 'allow' })
  async prune() {}

  @Every(60_000) // ονομάζεται 'Customers-report'
  async report() {}
}
```

### `@Cron`

```ts
Cron(name: string, expression: string, options?: CronJobOptions & { scheduler? }): JobDecorator
Cron(expression: string, options?: CronJobOptions & { name?, scheduler? }): JobDecorator
```

Δηλώνει μια εργασία cron, όπως το [`cron()`](../scheduler/#cronname-expression-handler-options). Η έκφραση έχει 5 πεδία, ή 6 με τα δευτερόλεπτα πρώτα.

```ts
class Reports {
  @Cron('weekday-digest', '0 8 * * 1-5', { timezone: 'Europe/Athens' })
  async digest(ctx: JobContext) {}

  @Cron('month-end', '0 6 1 * *', { scheduler: 'billing', timeoutMs: 30 * 60_000 })
  async close() {}
}
```

:::caution[Δύο strings σημαίνουν όνομα και έκφραση]
Με δύο strings, το πρώτο είναι το όνομα της εργασίας και το δεύτερο η έκφραση. Η ζώνη ώρας μπαίνει στις επιλογές: `@Cron('0 8 * * *', { timezone: 'Europe/Athens' })`. Το `@Cron('0 8 * * *', 'Europe/Athens')` ρίχνει `TypeError` όταν ορίζεται η κλάση, και το μήνυμα δείχνει τη σωστή μορφή.
:::

### `@At`

```ts
At(name: string, when: Date | number | string, options?: JobOptions & { scheduler? }): JobDecorator
At(when: Date | number | string, options?: JobOptions & { name?, scheduler? }): JobDecorator
```

Δηλώνει μια εφάπαξ εργασία, όπως το [`at()`](../scheduler/#atname-when-handler-options). Το `when` είναι `Date`, ms από το 1970, ή ISO string.

```ts
class Launch {
  @At('announce-launch', '2026-12-01T09:00:00Z')
  async announce() {}

  @At(new Date(Date.UTC(2027, 0, 1)), { name: 'new-year', catchUpMs: 60 * 60_000 })
  async newYear() {}
}
```

:::caution[Απόλυτος χρόνος, όχι καθυστέρηση]
Κάθε instance πρέπει να υπολογίζει τον ίδιο χρόνο. Το `@At(Date.now() + 5_000)` είναι διαφορετική στιγμή σε κάθε διεργασία, οπότε κάθε instance εκτελεί την εργασία. Γι' αυτόν τον λόγο δεν υπάρχει `@Timeout`.
:::

### Τι έχουν κοινό και οι τρεις

| | |
| --- | --- |
| Πού | Σε δημόσιες μεθόδους instance. Σε μέθοδο `static` ή `#private` ρίχνουν `TypeError` όταν ορίζεται η κλάση |
| Όνομα | Το πρώτο όρισμα, ή το `name` στις επιλογές, ή `Class-method` όταν δεν δίνεται κανένα από τα δύο |
| Επιλογές | Οι [επιλογές εργασιών](../options/#επιλογές-εργασιών) της αντίστοιχης μεθόδου, μαζί με το [`data`](../../guides/run-data/) |
| `scheduler` | Ο scheduler στον οποίο πηγαίνει η εργασία: ένα όνομα, ή ένας `Scheduler`. Προεπιλογή: ο προεπιλεγμένος scheduler |
| Η μέθοδος | Λαμβάνει το [`JobContext`](../types/#jobcontext), και εκτελείται με το `this` να είναι το αντικείμενο |
| Πολλοί στην ίδια μέθοδο | Επιτρέπεται. Ο καθένας χρειάζεται το δικό του όνομα |
| Κληρονομικότητα | Μια υποκλάση τους κληρονομεί. Μια μέθοδος που κάνει override τους αντικαθιστά |

Η μορφή με το όνομα πρώτο επιλέγεται όταν το δεύτερο όρισμα είναι string ή αριθμός (για το `@At`, και `Date`).

Επειδή το όνομα και το πρόγραμμα μπορούν να είναι και τα δύο strings, δύο ορίσματα σε λάθος σειρά απορρίπτονται όταν ορίζεται η κλάση: ο decorator ρίχνει `TypeError` αν το πρώτο όρισμα μοιάζει με πρόγραμμα και το δεύτερο όχι.

```ts
@Every('1h', 'sync')                 // TypeError: ... the job's name, a string, comes first and the interval second: @Every(name, interval)
@Cron('0 8 * * *', 'Europe/Athens')  // TypeError: ... A time zone goes in the options: @Cron(expression, { timezone })
@At('2026-12-01T09:00:00Z', 'launch') // TypeError: ... @At(name, when)
```

## `@Scheduled()`

```ts
Scheduled(): ScheduledDecorator
```

Ένας decorator κλάσης για projects που γίνονται compile με legacy decorators (`"experimentalDecorators": true`). Κάνει τα αντικείμενα της κλάσης να προσθέτουν τις εργασίες τους όταν δημιουργούνται, κάτι που οι legacy decorators μεθόδων δεν μπορούν να κάνουν μόνοι τους.

```ts
@Scheduled()
class Reports {
  @Every('sync-customers', '10s')
  async sync() {}
}

new Reports(); // προσθέτει το 'sync-customers'
```

| Στυλ decorators | Τι κάνει το `@Scheduled()` |
| --- | --- |
| Standard | Τίποτα. Τα αντικείμενα προσθέτουν ήδη μόνα τους τις εργασίες τους |
| Legacy | Αντικαθιστά την κλάση με μια υποκλάση με το ίδιο όνομα, η οποία προσθέτει τις εργασίες στο τέλος του constructor |

:::caution[Legacy decorators χωρίς `@Scheduled()`]
Με legacy decorators, μια κλάση που δεν έχει ούτε `@Scheduled()` ούτε κλήση `register()` δεν προσθέτει καμία εργασία. Ένας scheduler που ξεκινά [προειδοποιεί γι' αυτό](#εργασίες-που-δεν-προστέθηκαν-ποτέ).
:::

## Schedulers για εργασίες με decorators

### `Scheduler.configure(options)`

```ts
static configure(options: ConfigureOptions): void
static configure(name: string, options: ConfigureOptions): void
```

Αποθηκεύει τις ρυθμίσεις από τις οποίες δημιουργείται ένας scheduler όταν τον χρειαστεί μια εργασία με decorator. Χωρίς όνομα είναι οι ρυθμίσεις του προεπιλεγμένου scheduler· με όνομα, του scheduler που επιλέγουν οι εργασίες με `{ scheduler: name }`. Από μόνο του δεν δημιουργεί τίποτα.

Το `ConfigureOptions` είναι οι [επιλογές του scheduler](../options/#επιλογές-scheduler), με δύο διαφορές:

| Επιλογή | Τύπος | Σημασία |
| --- | --- | --- |
| `backend` | `Backend`, ή `(name: string) => Backend` | Υποχρεωτικό, εκτός αν δοθεί `redis`. Μια συνάρτηση καλείται με το όνομα του scheduler (`'default'` για τον προεπιλεγμένο), ώστε ένα σύνολο ρυθμίσεων να εξυπηρετεί πολλούς schedulers |
| `autoStart` | `boolean`, προεπιλογή `false` | Εκκίνηση του scheduler όταν δημιουργείται. Μια αποτυχία εκκίνησης είναι event `'error'` |

```ts
Scheduler.configure({ redis: process.env.REDIS_URL, autoStart: true });

Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: `cron_${name}` }) });
Scheduler.configure('billing', { redis: process.env.BILLING_REDIS_URL, leaseMs: 10_000 });
```

Ένας ονομασμένος scheduler χωρίς δικές του ρυθμίσεις δημιουργείται από τις προεπιλεγμένες:

| Προεπιλεγμένες ρυθμίσεις | Ένας scheduler με όνομα `reports` παίρνει |
| --- | --- |
| Το `backend` είναι συνάρτηση | `backend('reports')` |
| `redis` | Τις ίδιες ρυθμίσεις σύνδεσης, με το πρόθεμα κλειδιών `<prefix>reports:` (`cron:reports:` από προεπιλογή) |
| Το `backend` είναι αντικείμενο | Τίποτα: η δημιουργία του ρίχνει σφάλμα, επειδή δύο schedulers δεν μπορούν να μοιραστούν ένα αντικείμενο backend |

**Ρίχνει** `TypeError` όταν δεν δίνεται ούτε `backend` ούτε `redis`· `Error` όταν αυτός ο scheduler υπάρχει ήδη, ή όταν ένα αντικείμενο που τον περίμενε δεν μπορεί να προσθέσει τις εργασίες του.

### `Scheduler.get(name?)`

```ts
static get(name?: string): Scheduler
```

Ο προεπιλεγμένος scheduler, ή αυτός με το συγκεκριμένο όνομα. Δημιουργείται από τις ρυθμίσεις του αν δεν υπάρχει ακόμη.

```ts
await Scheduler.get().start();
console.table(Scheduler.get('billing').jobs());
```

**Ρίχνει** `Error` όταν δεν υπάρχει και δεν έχει ρυθμίσεις.

### `Scheduler.all()`, `startAll()`, `stopAll()`

```ts
static all(): Scheduler[]
static startAll(): Promise<void>
static stopAll(options?: { timeoutMs?: number }): Promise<void>
```

Το `all()` είναι ο προεπιλεγμένος scheduler και κάθε scheduler που έχει όνομα. Τα `startAll()` και `stopAll()` τους ξεκινούν και τους σταματούν. Το `startAll()` ξεκινά όλους ακόμη κι αν ένας αποτύχει, και μετά απορρίπτεται με την πρώτη αποτυχία.

```ts
new Jobs();
await Scheduler.startAll();
process.on('SIGTERM', () => Scheduler.stopAll().then(() => process.exit(0)));
```

Ένας scheduler που δημιουργήθηκε χωρίς όνομα και δεν είναι ο προεπιλεγμένος δεν περιλαμβάνεται στο `all()`: ξεκινήστε και σταματήστε τον εσείς.

### `Scheduler.setDefault(scheduler)`

```ts
static setDefault(scheduler: Scheduler | undefined): void
```

Επιλέγει τον προεπιλεγμένο scheduler: αυτόν που παίρνει τις εργασίες με decorators που δεν ονομάζουν κανέναν.

- Χωρίς αυτή την κλήση, είναι ο πρώτος scheduler που δημιουργείται χωρίς `name`, ή αυτός που δημιουργείται από τις προεπιλεγμένες ρυθμίσεις.
- Όταν ο προεπιλεγμένος scheduler σταματήσει, προεπιλεγμένος γίνεται ο επόμενος scheduler χωρίς όνομα που θα δημιουργηθεί ή θα ξεκινήσει.
- Τα αντικείμενα που περίμεναν έναν προεπιλεγμένο scheduler προσθέτουν τις εργασίες τους σε αυτόν που δίνεται εδώ.
- `undefined`: κανένας προεπιλεγμένος scheduler, και κανένα αντικείμενο σε αναμονή.

**Ρίχνει** ό,τι ρίχνει το `register()`, όταν ένα αντικείμενο σε αναμονή δεν μπορεί να προσθέσει τις εργασίες του.

### `Scheduler.reset()`

```ts
static reset(): void
```

Ξεχνά τον προεπιλεγμένο scheduler, τα ονόματα, τις ρυθμίσεις που δόθηκαν στο `configure()` και τα αντικείμενα που περιμένουν έναν scheduler. Δεν σταματά τίποτα. Προορίζεται για tests, ανάμεσα στις περιπτώσεις.

### `new Scheduler({ name })`

Ένας scheduler που δημιουργείτε εσείς παίρνει όνομα με την επιλογή `name`, και οι εργασίες τον επιλέγουν με αυτό το όνομα. Ένας δεύτερος scheduler με το ίδιο όνομα ρίχνει σφάλμα. Ένας σταματημένος scheduler παραχωρεί το όνομά του, και τον ρόλο του προεπιλεγμένου, μέχρι να ξεκινήσει ξανά.

## `scheduler.register(target, options?)`

```ts
register(target: object, options?: RegisterOptions): this

interface RegisterOptions {
  prefix?: string;
  defaults?: JobOptions & { timezone?: string };
}
```

Τοποθετεί κάθε εργασία ενός αντικειμένου σε αυτόν τον scheduler, όποιον scheduler κι αν ονομάζει κάθε εργασία. Το χρειάζεστε για να:

- έχετε πολλά αντικείμενα μιας κλάσης, το καθένα με δικό του `prefix`
- δώσετε επιλογές εργασίας σε κάθε εργασία ενός αντικειμένου, με τα `defaults`
- προσθέσετε ένα αντικείμενο με legacy decorators σε κλάση χωρίς `@Scheduled()`

```ts
for (const tenant of tenants) {
  scheduler.register(new Reports(tenant.mailer), {
    prefix: `${tenant.id}:`,
    defaults: { timezone: tenant.timezone, timeoutMs: 60_000, data: { tenant: tenant.id } },
  });
}
```

| Επιλογή | Σημασία |
| --- | --- |
| `prefix` | Μπαίνει μπροστά από κάθε όνομα εργασίας του αντικειμένου |
| `defaults` | Επιλογές εργασίας για κάθε εργασία του αντικειμένου. Μια επιλογή που ορίζεται σε decorator υπερισχύει· οι ρυθμίσεις του scheduler ισχύουν για ό,τι δεν ορίζει κανένα από τα δύο. Το `timezone` χρησιμοποιείται μόνο από τις εργασίες cron. Το `data` συγχωνεύεται κάτω από τα δεδομένα της ίδιας της εργασίας, δεν αντικαθίσταται από αυτά |

- Προσθέτει όλες τις εργασίες του αντικειμένου ή καμία. Όταν ρίχνει σφάλμα, οι εργασίες του αντικειμένου μένουν όπως ήταν.
- Οι εργασίες αφαιρούνται από τον scheduler που τις είχε.
- Η καταχώριση ενός αντικειμένου ξανά με επιλογές αντικαθιστά τις εργασίες του. Χωρίς επιλογές δεν αλλάζει τίποτα.

**Ρίχνει** `TypeError` εάν η κλάση δεν έχει μεθόδους με decorators (συχνά δόθηκε η κλάση αντί για ένα αντικείμενο) ή μια επιλογή έχει λάθος τύπο· διαφορετικά ό,τι ρίχνουν τα `every()`, `cron()` και `at()`.

## Πότε προστίθενται οι εργασίες

| Το αντικείμενο δημιουργείται | Standard decorators, ή legacy με `@Scheduled()` | Legacy χωρίς `@Scheduled()` |
| --- | --- | --- |
| Όταν κάθε scheduler που ονομάζουν οι εργασίες του υπάρχει ή έχει ρυθμίσεις | Αμέσως | Ποτέ, μέχρι το `register()` |
| Πριν από αυτό | Όταν ξεκινήσει ένας από αυτούς τους schedulers | Ποτέ, μέχρι το `register()` |

Ένα αντικείμενο προσθέτει όλες τις εργασίες του ή καμία. Από τα αντικείμενα που περιμένουν, διατηρείται το νεότερο κάθε κλάσης.

## Εργασίες που δεν προστέθηκαν ποτέ

Όταν ξεκινά ο προεπιλεγμένος scheduler ή ένας ονομασμένος, δίνει μία προειδοποίηση για κάθε δηλωμένη εργασία που κανένα αντικείμενο δεν έχει προσθέσει σε scheduler. Η προειδοποίηση πηγαίνει στον `logger` του scheduler, που είναι η κονσόλα εκτός αν δώσετε άλλον, και κάθε εργασία αναφέρεται μία φορά.

```
[anarchon] @Every "sync-customers" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)
[anarchon] @Cron("0 3 * * *") on the method "cleanup" is not scheduled: no object of its class has been created
```

| Το μήνυμα τελειώνει με | Σημασία | Διόρθωση |
| --- | --- | --- |
| `with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)` | Η κλάση γίνεται compile με legacy decorators και δεν έχει `@Scheduled()`, και κανένα αντικείμενό της δεν καταχωρίστηκε | Κάντε ένα από τα δύο |
| `no object of its class has been created` | Κανένα αντικείμενο της κλάσης δεν είχε προσθέσει τις εργασίες του όταν ξεκίνησε ο scheduler | Δημιουργήστε το αντικείμενο, ή αγνοήστε την προειδοποίηση αν η κλάση δεν προορίζεται να εκτελείται σε αυτή τη διεργασία, ή αν τα αντικείμενά της δημιουργούνται αργότερα |

Είναι προειδοποίηση, όχι σφάλμα: μια κλάση μπορεί να φορτώνεται σκόπιμα σε μια διεργασία που δεν εκτελεί τις εργασίες της, και ένα αντικείμενο που δημιουργείται μετά το `start()` εξακολουθεί να τις προσθέτει.

## Πού εμφανίζονται τα σφάλματα

| Σφάλμα | Από πού ρίχνεται |
| --- | --- |
| `@Every can only decorate a public instance method` | Τον ορισμό της κλάσης |
| Δύο ορίσματα σε λάθος σειρά, όπως `@Every('1h', 'sync')`, ή `name` ή `scheduler` λάθος τύπου | Τον ορισμό της κλάσης |
| Μη έγκυρο πρόγραμμα ή επιλογή, ή `Job "X" is already registered` | Το `new YourClass()` όταν οι schedulers του υπάρχουν ή έχουν ρυθμίσεις· διαφορετικά το `start()` που το προσθέτει, το οποίο απορρίπτεται και αφήνει τον scheduler σταματημένο. Επίσης τα `register()`, `setDefault()` και `configure()` |
| `Scheduler.configure() needs a backend` | Το `configure()` |
| `Scheduler "X" has no settings of its own, and the default settings hold a backend object` | Το `new YourClass()` ή το `Scheduler.get('X')` |
| `There is no scheduler named "X"` | Το `Scheduler.get('X')` |
| `A scheduler named "X" already exists` | Το `new Scheduler({ name: 'X' })`, ή το `start()` ενός σταματημένου του οποίου το όνομα δόθηκε στο μεταξύ σε άλλον |
| `register() needs an object whose class has methods decorated with @Cron, @Every or @At` | Το `register()` |

## Τι να προσέξετε

| Προσοχή | Γιατί | Τι να κάνετε |
| --- | --- | --- |
| Τα προεπιλεγμένα ονόματα ακολουθούν τον κώδικα | Το `Class-method` αλλάζει όταν μετονομάζεται η κλάση ή η μέθοδος, και σε κάθε build αν οι κλάσεις γίνονται minify. Ένα νέο όνομα είναι μια νέα εργασία με νέο ιστορικό | Δώστε όνομα σε κάθε εργασία |
| Ένα αντικείμενο ανά κλάση, εκτός αν το καθένα έχει πρόθεμα | Ένα δεύτερο αντικείμενο δηλώνει τα ίδια ονόματα, οπότε ο constructor του ρίχνει σφάλμα | `register(object, { prefix })` για κάθε αντικείμενο |
| Με προθέματα, καταχωρίστε κάθε αντικείμενο πριν δημιουργήσετε το επόμενο | Με standard decorators ένα αντικείμενο προσθέτει πρώτα τις εργασίες του με τα απλά τους ονόματα, και το `register()` τις μετονομάζει | Δημιουργήστε το αντικείμενο μέσα στην κλήση του `register()` |
| Ο constructor ρίχνει σφάλμα αφού προστέθηκαν οι εργασίες | Με standard decorators οι εργασίες προστίθενται στην αρχή του constructor | Αφαιρέστε τις με βάση το όνομα, ή μην ρίχνετε σφάλμα από τον constructor |
| Οι legacy decorators δεν προσθέτουν τίποτα μόνοι τους | Δεν μπορούν να εκτελέσουν κώδικα όταν δημιουργείται ένα αντικείμενο. Ένας scheduler που ξεκινά προειδοποιεί για τέτοιες εργασίες | `@Scheduled()` στην κλάση, ή `register()` |
| Τυπογραφικό λάθος σε όνομα scheduler | Με ρυθμίσεις Redis ή συνάρτηση backend, ένα άγνωστο όνομα είναι ένας νέος scheduler, που δημιουργείται από τις προεπιλεγμένες ρυθμίσεις | Κρατήστε τα ονόματα σε σταθερές, και ελέγξτε το `Scheduler.all()` |
| Οι schedulers και οι ρυθμίσεις είναι κοινά για τη διεργασία | Είναι κατάσταση του module, όχι ανά test ή ανά request | `Scheduler.reset()` ανάμεσα στα tests |
| Το `autoStart` κρύβει την εκκίνηση | Μια αποτυχία σύνδεσης έρχεται ως event `'error'`, όχι ως απορριφθέν promise | Ακούστε το `'error'`, ή ξεκινήστε εσείς τον scheduler |
| Βραχύβια αντικείμενα | Κάθε νέο αντικείμενο προσπαθεί να προσθέσει τις ίδιες εργασίες, και ρίχνει σφάλμα | Βάλτε decorators μόνο σε μακρόβια services |
| Το πρόγραμμα παγιώνεται όταν ορίζεται η κλάση | Τα ορίσματα ενός decorator υπολογίζονται μία φορά | Για προγράμματα που διαβάζονται αργότερα από ρυθμίσεις, χρησιμοποιήστε τα `every()`, `cron()` ή `at()` |

## Τύποι

| Τύπος | Τι είναι |
| --- | --- |
| `JobDecorator` | Αυτό που επιστρέφουν τα `@Every`, `@Cron` και `@At`: ένας decorator μεθόδου και στα δύο στυλ |
| `ScheduledDecorator` | Αυτό που επιστρέφει το `@Scheduled()`: ένας decorator κλάσης και στα δύο στυλ |
| `DecoratedJobOptions<Options>` | Επιλογές εργασίας συν `name?` και `scheduler?`, για τη μορφή χωρίς το όνομα πρώτο |
| `JobPlacement` | `{ scheduler?: string \| Scheduler }` |
| `RegisterOptions` | Τα `{ prefix?, defaults? }` του `register()` |
| `ConfigureOptions` | Αυτό που δέχεται το `Scheduler.configure()` |
