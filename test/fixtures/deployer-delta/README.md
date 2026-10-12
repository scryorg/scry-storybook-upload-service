# deployer-delta fixtures

Recorded by `src/delta/delta.deployer.test.ts` (`RECORD_FIXTURES=1 npx vitest run src/delta/delta.deployer.test.ts`); the test fails when a
committed file is out of date. scry-node copies them to `test/fixtures/deployer-delta/` and builds its requests and fake answers from them.

- `manifest-request.json`: POST /delta/{project}/manifest body, storybook source, `transfers: ["r2-presigned", "basic"]`
- `manifest-response-basic.json`: the answer to the same request with `transfers: ["basic"]` (links to the Scry API, `transfer: "basic"`)
- `manifest-response-r2.json`: the answer when `r2-presigned` is honoured (links to R2 with a signed `x-amz-checksum-sha256` header, `transfer: "r2-presigned"`)
- `commit-request.json` / `commit-response.json`: POST .../commit body and the 202 answer
- `commit-409.json`: the `missing_blobs` answer (`count`, `missing`, `request_id`); the id is a stand-in, the service mints its own

Pre-change reference (no `transfers`, byte for byte what Scry Sync 0.1.7 gets): `../delta-legacy/manifest-response.json`, recorded from stage `85aa920`.
