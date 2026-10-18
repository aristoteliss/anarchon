---
title: Συμβάντα
description: Κάθε συμβάν και κάθε πεδίο του payload του.
---

```ts
scheduler.on(event, listener);
scheduler.once(event, listener);
scheduler.off(event, listener);
```

Τα συμβάντα περιγράφουν τι συνέβη σε **αυτό το instance**. Οδηγός: [Συμβάντα και καταγραφή](../../guides/events-and-logging/).

| Συμβάν | Τύπος payload | Εκπέμπεται όταν |
| --- | --- | --- |
| [`start`](#start) | `RunStartEvent` | Αυτό το instance κέρδισε μια εκτέλεση και πρόκειται να καλέσει τον handler |
| [`success`](#success) | `RunRecord` | Ο handler επέστρεψε |
| [`failure`](#failure) | `RunFailureEvent` | Ο handler έριξε σφάλμα, ή πέρασε το `timeoutMs` |
| [`interrupted`](#interrupted) | `RunInterruptedEvent` | Το `stop()` ή μια ανάληψη ακύρωσε το `ctx.signal`, και στη συνέχεια ο handler έριξε σφάλμα |
| [`skip`](#skip) | `SkipEvent` | Μια εκτέλεση ήταν προγραμματισμένη και αυτό το instance δεν την εκτέλεσε |
| [`lost`](#lost) | `LostEvent` | Ένα εφεδρικό instance ανέλαβε μια εκτέλεση που εκτελούσε αυτό το instance |
| [`error`](#error) | `SchedulerErrorEvent` | Πρόβλημα στο backend ή στη ρύθμιση παραμέτρων |

## `start`

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `job` | `string` | Όνομα εργασίας |
| `slot` | `number` | Προγραμματισμένος χρόνος, ms από το 1970 |
| `scheduledAt` | `Date` | Το `slot` ως Date |
| `instanceId` | `string` | Αυτό το instance |
| `manual` | `boolean` | Ξεκίνησε με `runNow()` |
| `attempt` | `number` | `1`, ή περισσότερο μετά από ανάληψη |
| `reason` | `RunReason` | `'scheduled'`, `'manual'`, `'catch-up'` ή `'takeover'` |

## `success`

Ένα [`RunRecord`](../types/#runkey-runevent-runrecord) με `status: 'success'`.

## `failure`

Ένα `RunRecord` με `status: 'failed'`, συν:

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `cause` | `unknown` | Η τιμή που έριξε ο handler. Για timeout, ένα `Error` με όνομα `TimeoutError` |

Το `error` περιέχει το ίδιο πράγμα ως κείμενο.

## `interrupted`

Ένα `RunRecord` με `status: 'interrupted'`, συν:

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `cause` | `unknown` | Η τιμή που έριξε ο handler |
| `handedOver` | `boolean` | Backends μίσθωσης: η εκτέλεση παραδόθηκε σε άλλο instance για ολοκλήρωση |

## `skip`

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `job` | `string` | Όνομα εργασίας |
| `slot` | `number` | Η εκτέλεση που παραλείφθηκε |
| `scheduledAt` | `Date` | Το `slot` ως Date |
| `instanceId` | `string` | Αυτό το instance |
| `reason` | `'taken' \| 'late' \| 'overlap'` | Αιτία |
| `lateMs` | `number` | Με `'late'`: πόσο καθυστέρησε |

| `reason` | Σημασία |
| --- | --- |
| `'taken'` | Ένα άλλο instance κέρδισε αυτή την εκτέλεση |
| `'late'` | Αυτό το instance, ή η διεκδίκησή του, καθυστέρησε περισσότερο από το `maxLateMs` |
| `'overlap'` | Η προηγούμενη εκτέλεση αυτής της εργασίας βρίσκεται ακόμη σε εξέλιξη |

Οι έλεγχοι παρασκηνίου δεν εκπέμπουν `skip`: ο περιοδικός έλεγχος ενός εφεδρικού instance και η ανάκτηση κατά την εκκίνηση είναι σιωπηλοί.

## `lost`

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `job` | `string` | Όνομα εργασίας |
| `slot` | `number` | Η εκτέλεση |
| `scheduledAt` | `Date` | Το `slot` ως Date |
| `attempt` | `number` | Η προσπάθεια που εκτελούσε αυτό το instance |
| `instanceId` | `string` | Αυτό το instance |

Το `ctx.signal` της εκτέλεσης ακυρώνεται την ίδια στιγμή.

## `error`

| Πεδίο | Τύπος | Σημασία |
| --- | --- | --- |
| `error` | `unknown` | Τι πήγε στραβά |
| `job` | `string` | Η εργασία, εάν το πρόβλημα ανήκει σε κάποια |
| `slot` | `number` | Η εκτέλεση, εάν το πρόβλημα ανήκει σε κάποια |

Χωρίς listener για το `error`, αυτά καταγράφονται με το `logger.error`. Δεν εκσφενδονίζονται ποτέ στον κώδικά σας.

## Ο τύπος

```ts
interface SchedulerEvents {
  start: RunStartEvent;
  success: RunRecord;
  failure: RunFailureEvent;
  interrupted: RunInterruptedEvent;
  skip: SkipEvent;
  lost: LostEvent;
  error: SchedulerErrorEvent;
}
```

## Σειρά συμβάντων για μία εκτέλεση

Στο instance που την εκτελεί:

```
start  ->  success | failure | interrupted
```

Το `lost` μπορεί να συμβεί μεταξύ του `start` και του τέλους, ακολουθούμενο από το `interrupted` εάν ο handler ρίξει σφάλμα κατά την ακύρωση.

Στα instances που δεν την εκτελούν:

```
skip
```
