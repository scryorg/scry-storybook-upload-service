# Dashboard import: R2 CORS for the browser PUT (stage bucket only)

Status: **applied to the stage bucket on 2026-10-02 and checked.** The bucket had no CORS rules before. One rule,
`dashboard-import-browser-put`, was added to `my-storybooks-staging` through the Cloudflare API: origins
`https://dashboard-stage.scrymore.com` and `http://localhost:3000`, methods `PUT`, `GET`, `HEAD`, header `content-type`,
expose `ETag`, max age 3600. A preflight from the stage dashboard origin answered 204 with the matching
`access-control-allow-origin`; a preflight from any other origin answered 403. **Production is not done**
(tracked as F61 of `dashboard-import`): it needs the same rule on `my-storybooks-production` with the production
dashboard origin only. Sections 1 to 3 below remain the way to repeat or undo it.

The dashboard import (feature `dashboard-import`) has the browser `PUT` the bundle zip straight to a presigned R2 URL
returned by `POST /presigned-url/:project/:version/bundle.zip`. A cross-origin `PUT` with `Content-Type` is preflighted,
so the bucket must answer `OPTIONS` with CORS headers.

## Where the PUT goes

`src/services/storage/storage.worker.ts` builds the S3 client with endpoint
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, so the presigned URL is
`https://<account id>.r2.cloudflarestorage.com/my-storybooks-staging/<project>/<version>/builds/<n>/bundle.zip?X-Amz-...`
(path style, bucket `my-storybooks-staging` on stage, `my-storybooks-production` on production). CORS is a bucket setting
and is answered by that host, not by the Worker.

## 1. Mint a real stage presigned URL (API-key path, unchanged)

```bash
# SCRY_STAGE_UPLOAD_URL defaults to storybook-deployment-service-preview.epinnock.workers.dev
curl -sS -X POST \
  -H "X-API-Key: $SCRY_STAGE_FIXTURE_API_KEY" \
  "https://$SCRY_STAGE_UPLOAD_URL/presigned-url/$PROJECT/cors-spike/bundle.zip?source=x-adobe-bridge:other" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["url"])' > /tmp/presigned.txt
```

The build this creates is `bundlePending`; the orphan sweeper removes it. Never put the URL or key in a log.

## 2. Preflight from both origins

```bash
URL="$(cat /tmp/presigned.txt)"
for ORIGIN in https://dashboard-stage.scrymore.com http://localhost:3000; do
  echo "== $ORIGIN"
  curl -sS -i -X OPTIONS "$URL" \
    -H "Origin: $ORIGIN" \
    -H "Access-Control-Request-Method: PUT" \
    -H "Access-Control-Request-Headers: content-type" \
    | grep -i -E '^(HTTP/|access-control-)'
done
```

Pass means, for each origin: a 2xx status with `access-control-allow-origin` equal to the origin,
`access-control-allow-methods` including `PUT`, and `access-control-allow-headers` including `content-type`.
No `access-control-*` lines (or a 403) means CORS is missing.

A real PUT must also expose the ETag:

```bash
curl -sS -i -X PUT "$URL" -H "Origin: https://dashboard-stage.scrymore.com" \
  -H "Content-Type: application/zip" --data-binary @some.zip | grep -i -E '^(HTTP/|etag|access-control-)'
```

(`access-control-expose-headers` must list `ETag`.) Remove the uploaded object afterwards.

## 3. If CORS is missing: add the rule to the STAGE bucket only

`wrangler r2 bucket cors set` **replaces** the whole configuration, so keep what is there. Read it first and add this rule
to the existing list rather than replacing it.

```bash
npx wrangler r2 bucket cors list my-storybooks-staging          # note every existing rule
```

The rule to add (wrangler 4.x file format):

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://dashboard-stage.scrymore.com", "http://localhost:3000"],
        "methods": ["PUT", "HEAD"],
        "headers": ["Content-Type"]
      },
      "exposeHeaders": ["ETag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

```bash
# cors.json = the existing rules plus the rule above
npx wrangler r2 bucket cors set my-storybooks-staging --file cors.json -y
npx wrangler r2 bucket cors list my-storybooks-staging          # confirm, then rerun step 2
```

Do not touch `my-storybooks-production` in this change. The production rule (production dashboard origin only) is a
separate, later step once stage passes. Origins are exact; add the production dashboard origin there, never `*`.

Rollback: `npx wrangler r2 bucket cors set my-storybooks-staging --file <the list from the first command> -y`
(or `cors delete` if there were no rules).
