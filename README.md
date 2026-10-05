# Portable Storybook Upload Service

This project provides a backend service for uploading and managing Storybook builds. It's designed to be highly portable and can be deployed as a standard Node.js application or as a serverless Cloudflare Worker.

## Features

- **Direct Upload**: Upload zipped Storybook builds directly to the service
- **Presigned URL Generation**: Generate secure, short-lived URLs for client-side uploads
- **API Key Authentication**: Secure project-scoped API key authentication via Firebase
- **Build Tracking**: Automatically track builds in Firestore with version history
- **Coverage Uploads**: Upload a coverage report JSON alongside a Storybook build (or separately) and store normalized coverage data on the Firestore build document
- **Auto-incrementing Build Numbers**: Each project gets sequential build numbers
- **Multi-environment Support**: Run on Node.js, Docker, or Cloudflare Workers

This portability is achieved by abstracting both storage and database logic into service interfaces:
- `StorageService` - File storage abstraction (R2/S3)
- `FirestoreService` - Build tracking abstraction (Firestore)

## Project Structure

```
.
├── Dockerfile          # For containerizing the Node.js app
├── README.md           # This file
├── package.json        # Project dependencies and scripts
├── src/
│   ├── app.ts          # Shared Hono application logic and routes
│   ├── entry.node.ts   # Entry point for the Node.js server
│   ├── entry.worker.ts # Entry point for the Cloudflare Worker
│   ├── middleware/
│   │   └── auth.ts     # API key authentication middleware
│   └── services/
│       ├── apikey/     # API key service abstraction and implementations
│       ├── firestore/  # Firestore service for build tracking
│       └── storage/    # Storage service abstraction and implementations
├── docs/               # Additional documentation
├── tsconfig.json       # TypeScript configuration
└── wrangler.toml       # Configuration for the Cloudflare Worker
```

## Architecture: The Portable Storage Service

The core of this project's portability lies in its storage service abstraction.

- **`src/services/storage/storage.service.ts`**: This file defines the `StorageService` interface, which is a contract for all storage operations (e.g., `upload`, `getPresignedUploadUrl`).
- **`src/services/storage/storage.node.ts`**: This file contains `R2S3StorageService`, an implementation of `StorageService` that uses the AWS S3 SDK. It's designed to connect to any S3-compatible object storage, such as Cloudflare R2, AWS S3, or MinIO. This implementation is used in the Node.js environment.
- **`src/services/storage/storage.worker.ts`**: This file also contains a class named `R2S3StorageService`, but it's tailored for the Cloudflare Workers environment. It uses a hybrid approach:
    - For direct uploads to the `/upload` endpoint, it uses the native R2 bucket binding for maximum efficiency.
    - For generating presigned URLs, it uses the S3 SDK, just like the Node.js version.

The application's entry points (`entry.node.ts` and `entry.worker.ts`) are responsible for instantiating the correct storage service implementation and "injecting" it into the Hono application context. This means the shared API logic in `app.ts` can use the storage service without needing to know which environment it's running in.

## Architecture: Firestore Build Tracking

The service includes optional Firestore integration for tracking build metadata and version history.

### Service Abstraction

- **`src/services/firestore/firestore.service.ts`**: Defines the `FirestoreService` interface for build tracking operations
- **`src/services/firestore/firestore.node.ts`**: Node.js implementation using Firebase Admin SDK
- **`src/services/firestore/firestore.worker.ts`**: Cloudflare Worker implementation using Firestore REST API
- **`src/services/firestore/firestore.types.ts`**: Shared type definitions for build records

### Build step events (`build.step`)

Each pipeline step writes one structured log line (schema v1, service `upload`, same destination as the request lines), so a support person can follow a build with `scry-management/scripts/scry-logs.py --env stage --build <id>`. The closed list of steps lives in `src/lib/build-steps.ts` (`BUILD_STEPS`, `BUILD_STEP_OUTCOMES`) and is the same list, with the same strings, in `scry-build-processing-service`. This service emits the first four; build processing emits the rest.

Steps: `upload_received`, `presign`, `complete`, `enqueue`, `queue_pickup`, `lease_wait`, `credits_wait`, `chunk_start`, `chunk_done`, `retry`, `finalise`, `fail`, `dead_letter`, `stall_mark`.

Outcomes: `start`, `ok`, `wait`, `retry`, `fail`, `dead`, `stalled`.

Fields: `step`, `outcome`, `build_id`, `project`, `request_id`, plus `ms`, `attempt`, `chunk`, `chunks_total` and `reason` where they apply. `project` and `build_id` are attached only after the API key was verified for the project. `reason` is one of a closed list of codes (below), never free text or an exception message; `emitBuildStep` turns anything else into `unknown`. This service emits `validation`, `source_not_allowed` and `queue_send_failed`. Failing to log never fails the upload.

Reason codes (closed list `BUILD_STEP_REASONS`, the same list in both repos; the dashboard maps each to plain words):

| Code | Means |
|---|---|
| `ai_timeout` | an AI call or step ran past its deadline |
| `http_429` | a vendor rate-limited the request |
| `http_4xx` | a vendor or service refused the request (other than 429) |
| `http_5xx` | a vendor or service failed on its side |
| `credits_exhausted` | not enough AI credits; the build waits or stops |
| `credits_unavailable` | the credits ledger could not be reached |
| `quota` | a plan or vendor quota was hit |
| `validation` | the upload or its metadata failed a check |
| `source_not_allowed` | the key's source is not allowed for this upload |
| `lease_lost` | the indexing turn was lost or could not be taken |
| `queue_redelivery` | the queue handed the message back |
| `queue_send_failed` | the processing queue refused the message |
| `empty_archive` | the archive listed no stories |
| `stories_dropped` | stories the archive declared were not captured |
| `stories_failed` | stories inside a chunk that ran produced no row |
| `chunks_missing` | chunks never ran (circuit breaker or terminated instance) |
| `stalled_no_story` | stalled before the story count was known |
| `stalled_no_heartbeat` | stalled with no stage progress ever recorded |
| `stalled_total` | stalled: progress stopped for the threshold |
| `dead_letter` | the queue gave up on the message |
| `unknown` | none of the above |

Example line:

```json
{"v":1,"ts":"2026-10-05T20:31:07.412Z","level":"info","service":"upload","env":"staging","msg":"build.step","request_id":"01K6Z3V8Q2W9X4N7B5M1C0D8ER","project":"AbCdEfGhIjKlMnOpQrSt","build_id":"7nQ2xLk9Pq3RsT4uVw5Y","step":"enqueue","outcome":"ok"}
```

The build document also keeps `requestId` and `stepSummary {firstStepAt, lastStep, lastStepAt, outcome, requestId}`. `firstStepAt`, `requestId` are written when the build is created; `lastStep`, `lastStepAt` and `outcome` ride the existing `updateProcessingStatus` (or `updateBuild`) write through nested field-mask paths, so no extra Firestore write is made and `firstStepAt` is never overwritten.

## Architecture: API Key Authentication

The service includes a custom Firebase-based API key authentication system for securing upload endpoints.

### Service Abstraction

- **`src/services/apikey/apikey.service.ts`**: Defines the `ApiKeyService` interface for API key operations
- **`src/services/apikey/apikey.node.ts`**: Node.js implementation using Firebase Admin SDK
- **`src/services/apikey/apikey.worker.ts`**: Cloudflare Worker implementation using Firestore REST API
- **`src/services/apikey/apikey.types.ts`**: Type definitions for API key records
- **`src/services/apikey/apikey.utils.ts`**: Utilities for key generation and hashing
- **`src/middleware/auth.ts`**: Hono middleware for API key validation

### Key Format

API keys follow the format: `scry_proj_{projectId}_{randomString}`

Example: `scry_proj_my-project_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`

### Security Features

- **Raw keys never stored**: Only SHA-256 hashes are stored in Firestore
- **Show-once generation**: Raw keys are only returned once during creation
- **Project-scoped access**: Keys are bound to specific projects
- **Expiration support**: Optional expiration dates for temporary keys
- **Usage tracking**: `lastUsedAt` timestamp updated on each use

### Firestore Data Model

API keys are stored in Firestore:

```
projects/{projectId}/apiKeys/{keyId}
├── id: string
├── name: string          # e.g., "CI/CD Key"
├── prefix: string        # First 12 chars for display
├── hash: string          # SHA-256 hash (raw key NEVER stored)
├── status: 'active' | 'revoked'
├── createdAt: Date
├── createdBy: string
├── lastUsedAt?: Date     # Updated on each auth
├── expiresAt?: Date      # Optional expiration
├── revokedAt?: Date
└── revokedBy?: string
```

For detailed deployment instructions, see:
- **[API_KEY_DEPLOYMENT_GUIDE.md](docs/API_KEY_DEPLOYMENT_GUIDE.md)** - Complete deployment guide
- **[API_KEY_IMPLEMENTATION_CHANGELOG.md](docs/API_KEY_IMPLEMENTATION_CHANGELOG.md)** - Implementation details

### Data Model

Builds are stored in a hierarchical Firestore structure:

```
projects/{projectId}/
  ├── builds/{buildId}          # Build records
  │   ├── id: string
  │   ├── projectId: string
  │   ├── versionId: string
  │   ├── buildNumber: number   # Auto-incrementing
  │   ├── zipUrl: string
  │   ├── status: 'active' | 'archived'
  │   ├── createdAt: Date
  │   └── createdBy: string
  └── counters/builds           # Build number counter
      └── currentBuildNumber: number
```

### Setup

For detailed Firestore setup instructions, see:
- **[SERVICE_ACCOUNT_SETUP.md](implementation/SERVICE_ACCOUNT_SETUP.md)** - Complete guide for configuring Firebase service account
- **[FIRESTORE_INTEGRATION_PLAN.md](implementation/FIRESTORE_INTEGRATION_PLAN.md)** - Architecture and implementation details
- **[IMPLEMENTATION_SUMMARY.md](implementation/IMPLEMENTATION_SUMMARY.md)** - Complete implementation summary

#### Quick Start

1. Place your `serviceAccount.json` file in the project root
2. Add to `.env` (Node.js):
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json
   FIRESTORE_SERVICE_ACCOUNT_ID=upload-service
   ```
3. Add to `.dev.vars` (Workers) - extract from serviceAccount.json:
   ```bash
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANB...your-key-content...\n-----END PRIVATE KEY-----\n"
   FIRESTORE_SERVICE_ACCOUNT_ID=upload-service
   ```
   
   **Important**: The `FIREBASE_PRIVATE_KEY` must include the literal `\n` characters (not actual newlines). Copy the entire private_key value from your serviceAccount.json file, including the quotes.

The Firestore integration is **optional** - the service will work without it, but uploads won't be tracked in the database.

## Dashboard import door (second auth door)

The dashboard import lets a signed-in browser upload a bundle without an API key. The dashboard checks the
caller's project role and then calls exactly two routes with a signed 60-second assertion in the `X-Scry-Caller`
header instead of `X-API-Key`:

- `POST /presigned-url/:project/:version/bundle.zip`
- `POST /upload/:project/:version/bundle/complete`

Every other route ignores the header and uses the API key as before. The assertion is an HS256 JWT signed with
`SCRY_UPLOAD_ASSERTION_SECRET` (claims `sub`, `aud=scry-upload`, `prj`, `ver`, `src=x-adobe-bridge:*`, `iat`, `exp`,
`jti`; at most 60 s lifetime, 5 s clock skew). Any failure is a single `401 {"error":"unauthorized"}`; the reason is
only in the log (`err_code import_denied_<reason>`). Builds made through the door carry `channel: "dashboard"` and
the creator's uid, and only that caller can complete them. Contract and fixtures:
`docs/dashboard-import-contract.md`, `test-fixtures/dashboard-import/`. Browser PUT needs R2 CORS:
`docs/dashboard-import-cors.md`.

Set the secret (same value as the dashboard's) with `wrangler secret put SCRY_UPLOAD_ASSERTION_SECRET --env <env>`
(Node: the `SCRY_UPLOAD_ASSERTION_SECRET` environment variable). It must be at least 32 bytes; a shorter value is treated as unset (door closed, one warn line). **To switch the door off, unset the secret**
(`wrangler secret delete SCRY_UPLOAD_ASSERTION_SECRET --env <env>`): the header is then ignored everywhere and the
two routes accept API keys only, exactly as before.

## Development Guide

This guide will walk you through setting up and running the service in both the Node.js and Cloudflare Worker environments.

### Prerequisites

- [Node.js](https://nodejs.org/) (v22; CI uses Node 22)
- [Yarn](https://yarnpkg.com/) (or npm)
- [Docker](https://www.docker.com/) (optional, for running the Node.js app in a container)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (for the Worker deployment)
- An S3-compatible object storage bucket (e.g., [Cloudflare R2](https://www.cloudflare.com/products/r2/) or [AWS S3](https://aws.amazon.com/s3/))

### 1. Initial Setup

First, clone the repository and install the dependencies:

```bash
git clone <repository-url>
cd <repository-directory>
yarn install
```

### 2. Environment Configuration

The service requires credentials to connect to your S3-compatible storage. This guide uses Cloudflare R2 as the example provider.

**Step 1: Create an R2 Bucket**

If you don't have one already, create an R2 bucket in the Cloudflare dashboard:
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **R2**
2. Click **Create bucket**
3. Enter a bucket name (e.g., `my-storybooks-staging` or `my-storybooks-production`)
4. Click **Create bucket**

- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)

**Step 2: Enable Public Access (Required for Downloads)**

To allow downloading uploaded files via public URLs, you must enable public access:

1. In the Cloudflare Dashboard, go to **R2** → Select your bucket
2. Go to **Settings** tab → **Public access** section
3. Click **Allow Access** to enable the public domain
4. Confirm the action

Your bucket will now be accessible at: `https://pub-{bucket-name}.{account-id}.r2.dev`

⚠️ **Important**: Without public access enabled, file downloads will fail with an "Authorization" error. The service assumes public buckets for serving uploaded Storybook builds.

**Step 3: Get Your R2 Credentials**

You will need the following information from your Cloudflare account:
- **Account ID**: You can find this in the main dashboard overview.
- **Bucket Name**: The name you gave your R2 bucket.
- **S3 API Credentials**:
    1. Go to the R2 section in the Cloudflare dashboard.
    2. Click on "Manage R2 API Tokens".
    3. Create a new token with "Admin Read & Write" permissions.
    4. Copy the **Access Key ID** and **Secret Access Key**.

#### For Node.js (Local Development)

The Node.js server uses a `.env` file for environment variables. Create a file named `.env` in the project root and add the values you just obtained:

```
# .env

# The port for the Node.js server
PORT=3000

# Your Cloudflare R2 account ID
R2_ACCOUNT_ID="your-account-id"

# Your R2 bucket name
R2_BUCKET_NAME="your-bucket-name"

# Your R2 S3 API credentials
R2_S3_ACCESS_KEY_ID="your-access-key-id"
R2_S3_SECRET_ACCESS_KEY="your-secret-access-key"
```

#### For Cloudflare Workers

The Cloudflare Worker uses `wrangler.toml` for configuration and secrets for credentials.

1.  **Open `wrangler.toml`**: This file is in the project root.
2.  **Update Bucket Names**: Change the `bucket_name` and `preview_bucket_name` to your actual R2 bucket names.
3.  **Set Secrets**: For security, you must set your credentials as secrets using the Wrangler CLI. **Do not store secrets directly in `wrangler.toml`**.

    Run the following commands in your terminal and enter the corresponding values when prompted:

    ```bash
    wrangler secret put R2_ACCOUNT_ID
    wrangler secret put R2_S3_ACCESS_KEY_ID
    wrangler secret put R2_S3_SECRET_ACCESS_KEY
    wrangler secret put R2_BUCKET_NAME
    ```

### 3. Building the Code

This is a TypeScript project, so you need to compile the code to JavaScript before running it:

```bash
yarn build
```

### 4. Running the Service

You can now run the service in either environment.

#### As a Node.js Server

To run the service as a local Node.js server:

```bash
yarn start:node
```

The server will be available at `http://localhost:3000`.

#### As a Cloudflare Worker (Local Development)

To run the service locally using the Wrangler development server:

```bash
wrangler dev
```

This will start a local server that simulates the Cloudflare environment, including the R2 binding and secrets you configured.

### 5. Deploying the Service

#### To a Docker Container

The `Dockerfile` is configured to build and run the Node.js application.

```bash
# Build the Docker image
docker build -t storybook-upload-service .

# Run the container
docker run -p 3000:3000 -e R2_ACCOUNT_ID=... -e ... storybook-upload-service
```

#### To Cloudflare Workers

To deploy the service to your Cloudflare account:

```bash
npm run deploy:worker
```

This will upload the worker and configure it according to your `wrangler.toml` file.

## CI/CD Workflows

`.github/workflows/deploy.yml` is the entry point for validation and deployment.
It calls the tests-only reusable `.github/workflows/ci.yml` to install from the
frozen pnpm lockfile, run unit tests with coverage, typecheck, and build. CI uses
Node 22, pnpm 9, and Wrangler 4.99.0.

| Trigger | Result |
|---------|--------|
| Pull request into `stage` or `main` | Tests, coverage, typecheck, and build only |
| Push to `stage` | Validate, deploy `--env staging`, verify staging `/healthz` |
| Push to `main` | Validate, deploy `--env production`, verify production `/healthz`, then best-effort Sentry and Docker publishing |
| Manual dispatch | Validate and deploy the selected `staging` or `production` environment from the selected ref |

Pushes changing only `**/*.md` or `docs/**` do not trigger this workflow. Deploy
runs use concurrency group `deploy-${{ github.ref }}` with cancellation disabled.
Each deploy records its GitHub Environment and health URL. Verification must
report the deployed SHA within six attempts, ten seconds apart, or the job fails.

### Development and promotion

1. Open feature PRs into `stage`; CI runs without deployment credentials.
2. Merge to `stage` to deploy the shared staging Worker.
3. Verify staging, then promote with `scry-management/promote.sh scry-storybook-upload-service`
   (fast-forwards `main` to the tested stage commit after asking).
4. For a hand run, select **Actions → Deploy Service → Run workflow**, choose the
   ref and environment explicitly. Manual dispatch deploys that selected ref.

Jobs run on `vars.RUNNER` (self-hosted) and fall back to `ubuntu-latest`.
There are no per-PR Workers or automated E2E deploy jobs. Existing E2E tests and
scripts remain available for explicit runs against a configured target.

### Environment configuration

| Environment key | Branch | R2 bucket | Worker name |
|-----------------|--------|-----------|-------------|
| `staging` | `stage` | `my-storybooks-staging` | `storybook-deployment-service-preview` |
| `production` | `main` | `my-storybooks-production` | `storybook-deployment-service` |

The former `preview` key is now `staging`; the Worker name and URL are unchanged.
The top-level Wrangler configuration still targets production for compatibility;
the explicit `production` key has the same name, vars, and bindings.

Staging produces to `scry-build-processing-staging`, matching build-processing's
staging consumer. That consumer routes exhausted retries to
`scry-build-processing-staging-dlq`; upload does not produce directly to the DLQ.
Production continues to produce to `scry-build-processing`.

### Secrets per environment

GitHub Environments `staging` and `production` provide the `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` Actions secrets. Each Worker needs:

- The staging Worker (`--env staging`):
  `FIREBASE_PROJECT_ID` (`scry-dev-dashboard-stage`), `FIREBASE_CLIENT_EMAIL`,
  `FIREBASE_PRIVATE_KEY`, `FIRESTORE_SERVICE_ACCOUNT_ID`, and `SENTRY_DSN`.
  Presigned uploads also require `R2_ACCOUNT_ID`, `R2_S3_ACCESS_KEY_ID`, and
  `R2_S3_SECRET_ACCESS_KEY` with access to the staging bucket; `CLEANUP_TOKEN` is
  required only to enable cleanup. See [the secrets guide](docs/GITHUB_ACTIONS_SECRETS.md).
- Production: the same names against `my-storybooks-production` and the
  production Firebase project.

GitHub Sentry secrets remain optional for the best-effort production release
steps; Docker publishing uses `GITHUB_TOKEN`.

### Health and manual deployment

- Staging: <https://upload-stage.scrymore.com/healthz> (also <https://storybook-deployment-service-preview.epinnock.workers.dev/healthz>)
- Production: <https://upload.scrymore.com/healthz> (also <https://storybook-deployment-service.epinnock.workers.dev/healthz>)

Use `pnpm run deploy:staging` or `pnpm run deploy:production` for stamped manual
deployments. `pnpm run deploy:worker` remains an alias for production. Inspect the
Actions logs if validation or the post-deploy commit check fails.

## API Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz`, `GET /health` | none | Deploy stamp (see Deployment identity) |
| `POST /upload/:project/:version` | API key | Upload a Storybook ZIP (optional coverage); queues build processing |
| `POST /upload/:project/:version/coverage` | API key | Attach a coverage report to a build |
| `POST /upload/:project/:version/metadata` | API key | Upload the metadata/screenshot ZIP and queue processing |
| `GET /upload/:project/:version` | API key | File info for an uploaded build |
| `POST /presigned-url/:project/:version/:filename` | API key | Presigned R2 PUT URL + Firestore build record |
| `POST /upload-images/:project`, `.../complete` | API key | Presigned image-set upload for image indexing |
| `DELETE /cleanup/:project/:version` | `CLEANUP_TOKEN` | Delete a build (disabled when the secret is unset) |
| `GET /docs` | none | Swagger UI |

Bindings (`wrangler.toml`): R2 `STORYBOOK_BUCKET` (`my-storybooks-{staging,production}`)
and queue producer `BUILD_PROCESSING_QUEUE` (`scry-build-processing[-staging]`, consumed by
scry-build-processing-service). Queue messages carry trace context for the downstream Langfuse trace.

### Authentication

Protected endpoints require an `X-API-Key` header with a valid API key:

```bash
curl -X POST \
  -H "X-API-Key: scry_proj_my-project_your-api-key-here" \
  https://your-worker.workers.dev/upload/my-project/v1.0.0 \
  ...
```

#### Authentication Errors

| Status | Error | Message |
|--------|-------|---------|
| 401 | Authentication required | Missing X-API-Key header |
| 401 | Invalid API key format | The provided API key has an invalid format |
| 401 | Invalid API key | The provided API key is invalid or has been revoked |
| 403 | Project mismatch | The API key does not belong to the requested project |

### `GET /health`

Health check endpoint (no authentication required).

-   **Success Response** (`200 OK`):
    ```json
    {
      "status": "ok",
      "timestamp": "2025-01-01T00:00:00.000Z"
    }
    ```

### `POST /upload/:project/:version` 🔒

Uploads a zipped Storybook build directly to the service.

#### Optional Coverage (multipart only)

You can include a coverage report JSON file in the same multipart request as the Storybook ZIP.

- Multipart field names:
  - `file`: the Storybook ZIP (required)
  - `coverage`: a JSON file (optional)
  - `coverageJson`: a JSON string field (optional, alternative to `coverage`)

When provided, the service uploads the raw JSON to object storage at:
`{project}/{version}/coverage-report.json`

…and returns `data.coverageUrl`. If Firestore is configured, the service also stores a normalized coverage summary under `build.coverage`.

⚠️ **Requires `X-API-Key` header**

-   **URL Params**:
    -   `project` (string): The name of the project.
    -   `version` (string): The version of the Storybook build.
-   **Body**: The raw binary data of the `.zip` file or multipart form data.
-   **Headers**:
    -   `X-API-Key`: Your project API key (required)
    -   `Content-Type`: `application/zip` or `multipart/form-data`
-   **Success Response** (`201 Created`):
    ```json
    {
      "success": true,
      "message": "Upload successful",
      "key": "my-project/v1.0.0/storybook.zip",
      "data": {
        "url": "https://...",
        "path": "my-project/v1.0.0/storybook.zip",
        "versionId": "...",
        "buildId": "abc123def456",
        "buildNumber": 1,
        "coverageUrl": "https://.../my-project/v1.0.0/coverage-report.json"
      }
    }
    ```

### `POST /upload/:project/:version/coverage` 🔒

Uploads a coverage report for an existing build (found by `project` + `version`).

- Accepts either:
  - `Content-Type: application/json` (JSON body)
  - `multipart/form-data` with `file=@coverage-report.json`

On success:
- raw JSON is uploaded to object storage at `{project}/{version}/coverage-report.json`
- Firestore build document is updated at `build.coverage` (normalized summary + qualityGate)

**Note**: This endpoint requires Firestore to be configured.

### `POST /presigned-url/:project/:version/:filename` 🔒

Generates a presigned URL that can be used for a direct client-side upload.

⚠️ **Requires `X-API-Key` header**

-   **URL Params**:
    -   `project` (string): The name of the project.
    -   `version` (string): The version of the Storybook build.
    -   `filename` (string): The name of the file to be uploaded (e.g., `storybook.zip`).
-   **Headers**:
    -   `X-API-Key`: Your project API key (required)
    -   `Content-Type` (string): The MIME type of the file to be uploaded (e.g., `application/zip`).
-   **Success Response** (`200 OK`):
    ```json
    {
      "url": "https://...",
      "fields": {
        "key": "my-project/v1.0.0/storybook.zip"
      },
      "buildId": "abc123def456",
      "buildNumber": 1
    }
    ```

The client can then use the returned `url` to `PUT` the file directly to the storage provider.

### `GET /upload/:project/:version`

Retrieves file information (no authentication required).

-   **URL Params**:
    -   `project` (string): The name of the project.
    -   `version` (string): The version of the Storybook build.
-   **Success Response** (`200 OK`):
    ```json
    {
      "project": "my-project",
      "version": "v1.0.0",
      "key": "my-project/v1.0.0/storybook.zip",
      "available": true
    }
    ```

## Enhanced Setup Guide

### Environment Separation

This project is configured to use different buckets for different environments to ensure safe development:

- **Local Development**: Uses `my-storybooks-staging` bucket for both Node.js and Worker environments
- **Production**: Uses `my-storybooks-production` bucket for deployed Worker

### Credential Configuration

#### Node.js Local Development (.env file)

The `.env` file has been created with staging bucket credentials:

```bash
# .env (automatically configured)
PORT=3000
R2_ACCOUNT_ID=
R2_S3_ACCESS_KEY_ID=
R2_S3_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
```

#### Worker Local Development (.dev.vars file)

The `.dev.vars` file has been configured with staging bucket credentials:

```bash
# .dev.vars (automatically configured)
R2_ACCOUNT_ID=""
R2_S3_ACCESS_KEY_ID=""
R2_S3_SECRET_ACCESS_KEY=""
R2_BUCKET_NAME=""
```

#### Production Deployment

For production, see `PRODUCTION_SETUP.md` for detailed instructions on setting Cloudflare Worker secrets.

## Testing Guide

### Prerequisites for Testing

1. **Build the project**:
   ```bash
   yarn build
   ```

2. **Create a test zip file**:
   ```bash
   echo "test content" > test.txt
   zip test.zip test.txt
   ```

### Testing Node.js Local Server

#### 1. Start the Node.js server:
```bash
yarn start:node
```

#### 2. Test health check:
```bash
curl http://localhost:3000/
```
**Expected Response**: `200 OK` with health information

#### 3. Test direct upload:
```bash
curl -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_test-project_your-api-key-here" \
  --data-binary @test.zip \
  http://localhost:3000/upload/test-project/v1.0.0
```
**Expected Response**: `201 Created`
```json
{
  "message": "Upload successful",
  "data": {
    "url": "https://pub-my-storybooks-staging.{userid}.r2.dev/test-project/v1.0.0/storybook.zip",
    "path": "test-project/v1.0.0/storybook.zip",
    "versionId": "..."
  }
}
```

#### 4. Test presigned URL generation:
```bash
curl -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_test-project_your-api-key-here" \
  http://localhost:3000/presigned-url/test-project/v1.0.0/storybook.zip
```
**Expected Response**: `200 OK`
```json
{
  "url": "https://{userid}.r2.cloudflarestorage.com/my-storybooks-staging/test-project/v1.0.0/storybook.zip?...",
  "key": "test-project/v1.0.0/storybook.zip",
  "buildId": "abc123def456",
  "buildNumber": 1
}
```

**Note**: If Firestore is configured, the response includes [`buildId`](README.md:109) and [`buildNumber`](README.md:110) for tracking. The build record is created in Firestore when the presigned URL is generated, and you can verify it in the Firebase Console under `projects/{project}/builds/{buildId}`.

#### 5. Test file upload using presigned URL:
```bash
# First, get the presigned URL (save the response)
PRESIGNED_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_test-project_your-api-key-here" \
  http://localhost:3000/presigned-url/test-project/v1.0.0/storybook.zip)

# Extract the URL (requires jq)
PRESIGNED_URL=$(echo $PRESIGNED_RESPONSE | jq -r '.url')

# Upload the file directly to R2 using the presigned URL (no API key needed)
curl -X PUT \
  -H "Content-Type: application/zip" \
  --data-binary @test.zip \
  "$PRESIGNED_URL"
```
**Expected Response**: `200 OK` (from R2 directly)

#### 6. Fetch/Download the Uploaded File

After a successful upload, you can fetch the file using the public URL returned in the response:

```bash
# Using the URL from the upload response
curl -o downloaded-storybook.zip \
  "https://pub-my-storybooks-staging.{userid}.r2.dev/test-project/v1.0.0/storybook.zip"

# Or construct the URL using the pattern:
# https://pub-{bucket-name}.{account-id}.r2.dev/{project}/{version}/storybook.zip
curl -o downloaded-storybook.zip \
  "https://pub-my-storybooks-staging.{userid}.r2.dev/test-project/v1.0.0/storybook.zip"
```

**About the Public URL**:
- The `pub-` prefix is automatically added by Cloudflare R2 when public access is enabled on a bucket
- The URL pattern is constructed as: `https://pub-{bucketName}.{accountId}.r2.dev/{path}`
- This is configured in [`storage.node.ts:37`](src/services/storage/storage.node.ts:37) and [`storage.worker.ts:40`](src/services/storage/storage.worker.ts:40)

⚠️ **Troubleshooting**: If you get an "Authorization" or "InvalidArgument" error, your bucket doesn't have public access enabled. See the [Environment Configuration](#2-environment-configuration) section for setup instructions.

**Verify the downloaded file**:
```bash
# Check file size
ls -lh downloaded-storybook.zip

# Verify it's a valid zip
unzip -t downloaded-storybook.zip

# Compare with original
diff test.zip downloaded-storybook.zip
```

**Note**: The public URL is accessible to anyone with the link. The R2 bucket must have public access enabled for the URL to work.

### Testing Cloudflare Worker Local Development

#### 1. Start the Worker development server:
```bash
wrangler dev
```

#### 2. Test health check:
```bash
curl http://localhost:8787/health
```
**Expected Response**: `200 OK` with health information

#### 3. Test direct upload:
```bash
curl -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_test-project_your-api-key-here" \
  --data-binary @test.zip \
  http://localhost:8787/upload/test-project/v1.0.0
```
**Expected Response**: `201 Created` (same format as Node.js)

#### 4. Test presigned URL generation:
```bash
curl -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_test-project_your-api-key-here" \
  http://localhost:8787/presigned-url/test-project/v1.0.0/storybook.zip
```
**Expected Response**: `200 OK`
```json
{
  "url": "https://{userid}.r2.cloudflarestorage.com/my-storybooks-staging/test-project/v1.0.0/storybook.zip?...",
  "key": "test-project/v1.0.0/storybook.zip",
  "buildId": "abc123def456",
  "buildNumber": 1
}
```

**Note**: With Firestore configured, the build record is automatically created and tracked with an auto-incrementing build number.

#### 5. Test file upload using presigned URL:
```bash
# Get presigned URL (same commands as Node.js, but port 8787)
PRESIGNED_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_test-project_your-api-key-here" \
  http://localhost:8787/presigned-url/test-project/v1.0.0/storybook.zip)

PRESIGNED_URL=$(echo $PRESIGNED_RESPONSE | jq -r '.url')

# Upload directly to R2 (no API key needed for presigned URL)
curl -X PUT \
  -H "Content-Type: application/zip" \
  --data-binary @test.zip \
  "$PRESIGNED_URL"
```

#### 6. Fetch/Download the Uploaded File

After uploading, fetch the file using the public R2 URL:

```bash
# Download from staging bucket
curl -o downloaded-storybook.zip \
  "https://pub-my-storybooks-staging.{userid}.r2.dev/test-project/v1.0.0/storybook.zip"

# Verify download
unzip -t downloaded-storybook.zip
```

### Verifying File Access

After successful uploads, verify that files are accessible via R2 public URLs:

```bash
# For staging bucket (local development)
curl https://pub-my-storybooks-staging.{userid}.r2.dev/test-project/v1.0.0/storybook.zip

# For production bucket (after production deployment)
curl https://pub-my-storybooks-production.{userid}.r2.dev/test-project/v1.0.0/storybook.zip
```

### Error Handling

Common error responses:

- **400 Bad Request**: Missing required parameters or invalid Content-Type
- **401 Unauthorized**: Missing or invalid API key
- **403 Forbidden**: Invalid credentials, bucket permissions, or API key project mismatch
- **500 Internal Server Error**: Configuration issues (check credentials)

**R2 Public Access Errors**:
If downloads fail with errors like:
```xml
<Error>
<Code>InvalidArgument</Code>
<Message>Authorization</Message>
</Error>
```

This means your R2 bucket doesn't have public access enabled. To fix:
1. Go to Cloudflare Dashboard → **R2** → Select your bucket
2. Go to **Settings** → **Public access**
3. Click **Allow Access**
4. Wait a few moments for the change to propagate
5. Retry your download

The service requires public buckets to serve uploaded Storybook builds via the `https://pub-{bucket}.{account}.r2.dev` domain.

### Performance Comparison

Both upload methods (direct and presigned URL) should work efficiently:

- **Direct Upload**: File goes through your service to R2
- **Presigned URL**: File goes directly from client to R2 (bypasses your service for the actual upload)

Use presigned URLs for large files or when you want to reduce server load.

### Testing Production Deployment with Firebase Build Tracking

Once deployed to production, you can test the presigned URL generation and verify Firebase build tracking:

```bash
# First, create an API key for your project (see API_KEY_DEPLOYMENT_GUIDE.md)

# Generate presigned URL (creates build record in Firestore)
PRESIGNED_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/zip" \
  -H "X-API-Key: scry_proj_myproject_your-api-key-here" \
  https://your-worker.workers.dev/presigned-url/myproject/0.0.1/storybook.zip)

# View the response with build tracking info
echo $PRESIGNED_RESPONSE | jq '.'
```

**Expected Response**:
```json
{
  "url": "https://...r2.cloudflarestorage.com/.../storybook.zip?X-Amz-Signature=...",
  "key": "myproject/0.0.1/storybook.zip",
  "buildId": "xyz789abc123",
  "buildNumber": 5
}
```

**Upload the file using the presigned URL**:
```bash
# Extract the presigned URL
PRESIGNED_URL=$(echo $PRESIGNED_RESPONSE | jq -r '.url')

# Upload your file directly to R2
curl -X PUT \
  -H "Content-Type: application/zip" \
  --data-binary @test.zip \
  "$PRESIGNED_URL"
```

**Verify the build in Firebase Console**:
1. Go to your Firebase project at `https://console.firebase.google.com`
2. Navigate to **Firestore Database**
3. Find the build record at: `projects/myproject/builds/{buildId}`
4. Check the build metadata:
   - [`buildNumber`](README.md:110): Auto-incremented sequence number
   - [`projectId`](README.md:109): "myproject"
   - [`versionId`](README.md:109): "0.0.1"
   - [`zipUrl`](README.md:109): The R2 public URL
   - [`createdAt`](README.md:109): Timestamp of generation
   - [`status`](README.md:109): "active"

The build counter is stored at `projects/myproject/counters/builds` and increments atomically for each new build.

**Download the uploaded file from production**:
```bash
# Fetch the file using the zipUrl from the response or construct the URL
curl -o production-storybook.zip \
  "https://pub-my-storybooks-production.{userid}.r2.dev/myproject/0.0.1/storybook.zip"

# Verify the download
unzip -t production-storybook.zip
ls -lh production-storybook.zip
```

**Access via Browser**:
You can also access the uploaded Storybook directly in a browser by visiting:
```
https://pub-my-storybooks-production.{userid}.r2.dev/myproject/0.0.1/storybook.zip
```

The `zipUrl` field in the build record stored in Firestore contains this exact public URL for easy reference.

## API Key Management

### Creating API Keys

API keys can be created through:

1. **Firebase Console** - Manually create documents in `projects/{projectId}/apiKeys`
2. **Dashboard API** - Implement management endpoints in your dashboard
3. **CLI Script** - Use the provided scripts in the deployment guide

For detailed instructions, see [API_KEY_DEPLOYMENT_GUIDE.md](docs/API_KEY_DEPLOYMENT_GUIDE.md).

### Key Generation Script

```bash
# Generate a new API key locally
node -e "
const crypto = require('crypto');
const projectId = 'your-project-id';
const randomPart = crypto.randomBytes(32).toString('base64url');
const rawKey = \`scry_proj_\${projectId}_\${randomPart}\`;
const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
console.log('Raw Key (save this!):', rawKey);
console.log('Hash (store in Firestore):', hash);
console.log('Prefix:', rawKey.slice(0, 12));
"
```

### Revoking Keys

To revoke an API key:
1. Navigate to `projects/{projectId}/apiKeys/{keyId}` in Firebase Console
2. Set `status` to `"revoked"`
3. Optionally set `revokedAt` and `revokedBy` fields

Revoked keys are immediately rejected by the authentication middleware.

## Documentation

Additional documentation is available in the `docs/` directory:

- [API_KEY_DEPLOYMENT_GUIDE.md](docs/API_KEY_DEPLOYMENT_GUIDE.md) - Complete API key deployment guide
- [API_KEY_IMPLEMENTATION_CHANGELOG.md](docs/API_KEY_IMPLEMENTATION_CHANGELOG.md) - Implementation details
- [API_KEY_IMPLEMENTATION.md](docs/API_KEY_IMPLEMENTATION.md) - Technical specification
- [PRESIGNED_URL_TROUBLESHOOTING.md](docs/PRESIGNED_URL_TROUBLESHOOTING.md) - Troubleshooting presigned URLs
- [PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md) - Production deployment guide
- [STORAGE_FLOW_OVERVIEW.md](docs/STORAGE_FLOW_OVERVIEW.md) - Storage architecture overview

Developed 2026 by Scry


### Deployment identity

Production health: `https://upload.scrymore.com/healthz` (stage: `https://upload-stage.scrymore.com/healthz`).
`GET /healthz` is public and returns `ok`, `service` (the deployed Worker name),
`env`, `commit`, `branch`, `builtAt`, `deployId`, and `actor`. `/health` returns the
same stamp plus its existing `status` and `timestamp`. Both use
`Cache-Control: no-store`.

CI injects the commit, branch, UTC build time, run ID, actor, and Sentry release as
Worker vars. It verifies the target environment commit immediately after deployment
(up to six attempts, ten seconds apart). Sentry and Docker publishing run after
verification and are best effort; a failed verification means the deployment
has not been confirmed, even if Wrangler's deploy step succeeded.

Use `pnpm run deploy:production` or `pnpm run deploy:staging` for stamped manual deploys.
These use the current git commit and branch, build time, and actor `manual`;
`deployId` is null. The existing `storybook-deployment-service-preview` Worker is the staging target.

Workers load local credentials from `.dev.vars`; `npm run dev:worker` overrides
`SCRY_ENV` to `dev`. `npm run dev:node` uses `.env.local` and sets `SCRY_ENV=dev`.
The Node entry reads the same `SCRY_*` variables from its process environment.
Missing environment/commit values default to `dev`; missing optional metadata is
null. Only stamp fields are exposed. Wrangler is pinned to 4.99.0 for deploy tag
and message support and uses Node 22 in CI.
