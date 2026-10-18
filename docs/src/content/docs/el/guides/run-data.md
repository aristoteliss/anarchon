---
title: Δεδομένα εκτέλεσης
description: Δώστε στις εκτελέσεις μιας εργασίας τα δεδομένα που χρειάζονται, όπως ένα δικαίωμα, έναν tenant ή ένα φρέσκο token, και διαβάστε τα στον handler ως ctx.data.
---

Ένας handler είναι μια συνηθισμένη συνάρτηση, οπότε μπορεί να χρησιμοποιήσει ό,τι βρίσκεται στο scope γύρω του. Η επιλογή `data` είναι για ό,τι δεν βρίσκεται εκεί: τιμές που αποφασίζετε εκεί όπου ορίζεται η εργασία ή δημιουργείται ο scheduler, και τις θέλετε στον handler όταν ξεκινά μια εκτέλεση.

```ts
const scheduler = new Scheduler({ backend, data: { tenant: 'acme' } });

scheduler.every('export', '1h', async (ctx: JobContext<{ tenant: string; permission: string }>) => {
  await exportFor(ctx.data.tenant, ctx.data.permission);
}, { data: { permission: 'reports:export' } });
```

Κάθε εκτέλεση τα λαμβάνει ως `ctx.data`. Είναι `undefined` όταν δεν έχετε δώσει κανένα.

## Από πού προέρχονται τα δεδομένα

| Δίνονται σε | Ισχύουν για | Παράδειγμα |
| --- | --- | --- |
| Τις επιλογές του scheduler | Κάθε εργασία του scheduler | `new Scheduler({ data: { tenant: 'acme' } })` |
| Τα `defaults` του `register()` | Κάθε εργασία ενός αντικειμένου με decorators | `scheduler.register(object, { defaults: { data: { tenant: 'acme' } } })` |
| Τις επιλογές μιας εργασίας | Αυτή την εργασία | `scheduler.every(name, '1h', run, { data: { permission: 'export' } })` |
| Έναν decorator | Αυτή την εργασία | `@Every('export', '1h', { data: { permission: 'export' } })` |
| Το `runNow()` | Μία χειροκίνητη εκτέλεση | `scheduler.runNow('export', { data: { requestedBy: user.id } })` |

Είναι στρώματα, από το πιο γενικό στο πιο ειδικό, με τη σειρά του πίνακα. Δύο απλά αντικείμενα συγχωνεύονται, και τα κλειδιά του πιο ειδικού υπερισχύουν. Οποιαδήποτε άλλη τιμή (string, αριθμός, πίνακας, instance κλάσης) αντικαθιστά ό,τι βρίσκεται από κάτω της.

```ts
const scheduler = new Scheduler({ backend, data: { tenant: 'acme', region: 'eu' } });
scheduler.every('export', '1h', run, { data: { region: 'us', permission: 'export' } });

await scheduler.runNow('export');
// ctx.data: { tenant: 'acme', region: 'us', permission: 'export' }

await scheduler.runNow('export', { data: { permission: 'admin' } });
// ctx.data: { tenant: 'acme', region: 'us', permission: 'admin' }
```

## Ανάγνωση όταν ξεκινά η εκτέλεση

Το `data` μπορεί να είναι συνάρτηση. Καλείται όταν ξεκινά κάθε εκτέλεση, οπότε ο handler παίρνει την τιμή όπως είναι εκείνη τη στιγμή: ένα token που λήγει, τα δικαιώματα που έχει τώρα ένας χρήστης, ένα feature flag.

```ts
scheduler.every('sync', '5m', sync, {
  data: async (run) => ({
    token: await auth.tokenFor('sync-service'),   // φρέσκο για αυτή την εκτέλεση
    startedBy: run.manual ? 'operator' : 'schedule',
  }),
});
```

Η συνάρτηση λαμβάνει την εκτέλεση: ό,τι υπάρχει στο [`ctx`](../writing-handlers/) εκτός από το ίδιο το `data`, μαζί με το `signal`. Μπορεί να είναι async.

| Αν η συνάρτηση | Τότε |
| --- | --- |
| Ρίξει σφάλμα ή απορριφθεί | Η εκτέλεση αποτυγχάνει με αυτό το σφάλμα, όπως ένας handler που ρίχνει σφάλμα. Ο handler δεν καλείται |
| Είναι πιο αργή από το `timeoutMs` της εργασίας | Η εκτέλεση λήγει λόγω timeout |

:::note[Μια συνάρτηση καλείται πάντα]
Για να περάσετε μια συνάρτηση ως τα ίδια τα δεδομένα, βάλτε τη μέσα σε ένα αντικείμενο: `{ data: { notify: sendMail } }`.
:::

## Αλλαγή τους ενώ ο scheduler εκτελείται

Το `setData()` αντικαθιστά τα δεδομένα του scheduler. Οι εκτελέσεις που ξεκινούν μετά παίρνουν τα νέα· όσες βρίσκονται σε εξέλιξη κρατούν τα δικά τους.

```ts
scheduler.setData({ tenant: 'acme', features: await loadFeatures() });
events.on('features-changed', (features) => scheduler.setData({ tenant: 'acme', features }));
```

Για μία μόνο εκτέλεση, δώστε `data` στο `runNow()`:

```ts
app.post('/jobs/:name/run', async (req, res) => {
  const run = await scheduler.runNow(req.params.name, { data: { requestedBy: req.user.id } });
  res.json({ status: run.status });
});
```

## Τύπος των δεδομένων

Το `ctx.data` είναι `unknown`, εκτός αν πείτε τι είναι. Ονομάστε τον τύπο στον handler:

```ts
interface ExportData {
  tenant: string;
  permission: string;
}

scheduler.every('export', '1h', async (ctx: JobContext<ExportData>) => {
  ctx.data.tenant; // string
});

class Reports {
  @Every('export', '1h')
  async export(ctx: JobContext<ExportData>) {}
}
```

Ο τύπος είναι η δική σας δήλωση για το τι ρυθμίσατε: το anarchon δεν ελέγχει την τιμή απέναντί του.

## Τι δεν είναι τα δεδομένα εκτέλεσης

- **Δεν μοιράζονται μεταξύ instances.** Κάθε instance φτιάχνει τα δεδομένα των εκτελέσεων που τρέχει το ίδιο, από τις δικές του ρυθμίσεις. Δώστε σε κάθε instance τις ίδιες, όπως και τις ίδιες τις εργασίες.
- **Δεν αποθηκεύονται.** Δεν γράφονται στο store ούτε στο ιστορικό, οπότε μπορούν να περιέχουν μυστικά και αντικείμενα όπως έναν database client.
- **Δεν είναι payload ανά εκτέλεση από άλλο instance.** Μια εκτέλεση ορίζεται από τον χρόνο της, όχι από ένα μήνυμα. Για να μεταφέρετε δουλειά από ένα σημείο σε άλλο, χρησιμοποιήστε μια ουρά.

Ένα εκτελέσιμο παράδειγμα βρίσκεται στο repository ως [`examples/run-data.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/run-data.ts): `pnpm example:run-data`.

## Επόμενα βήματα

- [Συγγραφή handlers](../writing-handlers/): το υπόλοιπο `ctx`
- [Decorators](../decorators/): δεδομένα σε εργασίες και αντικείμενα με decorators
- [Scheduler API](../../reference/scheduler/#setdatadata)
