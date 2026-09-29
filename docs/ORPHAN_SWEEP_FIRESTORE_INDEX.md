# Firestore index required by the orphan-bundle sweep (ledger F80/F91)

`FirestoreServiceWorker.findOrphanBundleCandidates()` (`src/services/firestore/firestore.worker.ts`)
runs one **collection-group** query across every project's `builds` subcollection:

```
collectionGroup('builds')
  where bundlePending == true
  where createdAt < <cutoff>
  orderBy createdAt ASC
  limit 200
```

Firestore does not auto-create indexes for collection-group queries — not even for a single field —
so this query needs one manually-created **composite** index:

- **Collection group**: `builds`
- **Query scope**: `Collection group`
- **Fields**: `bundlePending` Ascending, then `createdAt` Ascending

Without it, every cron invocation throws `FAILED_PRECONDITION` (caught by the sweep's own per-run
error handling and logged — the Worker invocation itself does not fail — but the sweep does nothing
until the index exists).

## Why this repo doesn't own `firestore.indexes.json`

This service (`scry-storybook-upload-service`) is a Cloudflare Worker with no Firebase CLI project of
its own; the Firestore database it reads/writes is owned and deployed from `scry-developer-dashboard`
(`firestore.indexes.json` + `npm run firestore:deploy:staging` / `firestore:deploy:production`,
`firebase use scry-staging` → `scry-dev-dashboard-stage`, `firebase use scry-production` →
`scry-dev-dashboard`). Add this entry there:

```json
{
  "collectionGroup": "builds",
  "queryScope": "COLLECTION_GROUP",
  "fields": [
    { "fieldPath": "bundlePending", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "ASCENDING" }
  ]
}
```

then run `npm run firestore:deploy:staging` and `npm run firestore:deploy:production` from that repo.
Index builds are asynchronous and can take several minutes on a collection this size; progress is
visible under **Firestore → Indexes** in each Firebase project's console.

## Faster path: create it directly with `gcloud` (no dashboard-repo PR needed)

```bash
gcloud firestore indexes composite create \
  --project=scry-dev-dashboard-stage \
  --collection-group=builds \
  --query-scope=COLLECTION_GROUP \
  --field-config=field-path=bundlePending,order=ascending \
  --field-config=field-path=createdAt,order=ascending

gcloud firestore indexes composite create \
  --project=scry-dev-dashboard \
  --collection-group=builds \
  --query-scope=COLLECTION_GROUP \
  --field-config=field-path=bundlePending,order=ascending \
  --field-config=field-path=createdAt,order=ascending
```

Whichever path is used, `scry-developer-dashboard/firestore.indexes.json` should still gain the same
entry afterwards so `firebase deploy --only firestore:indexes` stays idempotent and doesn't drift from
what's actually live (a manually-`gcloud`-created index that's absent from the checked-in file looks,
to the next person reading that repo, like it doesn't exist).

## Rollout order

Create the index in **both** `scry-dev-dashboard-stage` and `scry-dev-dashboard` — and confirm it has
finished building (state `READY`, not `CREATING`) — before this PR is promoted to that environment.
Deploying the Worker first is harmless (the query just fails closed, logged, until the index is
ready) but means the sweep does nothing in the meantime.

## Read cost this query adds (ledger F91's own ask: state it before shipping)

With a `READY` index, Firestore bills exactly one read per document the query *returns* (the index
walk itself is free) — never per document merely scanned or filtered out, and never proportional to
project count or total build history the way the original per-project scan was.

- **Steady state** (the expected case — most bundle builds resolve via `/bundle/complete` within
  seconds of upload, so few if any still have `bundlePending: true` past the 60-minute cutoff at any
  given moment): on the order of 0–a few reads per run.
- **Worst case** (`limit` fully saturated — 200 builds have been stuck pending for over an hour
  simultaneously, itself a five-alarm signal of a much bigger upstream problem): 200 reads for the
  query, plus up to 1 more read per surviving candidate for the fresh re-check immediately before the
  write (ledger F92's `getBuildOrphanState`) — at most 400 reads that run.
- **Per day**, hourly cadence (ledger F91's other fix — down from every 15 minutes): 24 runs/day, so
  0–a few dozen reads/day steady state, ≤9,600 reads/day pathological worst case, in EITHER
  environment, regardless of how many projects or historical builds exist — flat, not scaling with
  the estate.
