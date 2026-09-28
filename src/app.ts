// In src/app.ts

import { Hono } from 'hono';
import { deployStamp, type StampBindings } from './deploy-stamp.js';
import { currentTraceContext } from './trace-context.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from 'hono/logger';
import type { StorageService } from './services/storage/storage.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type {
  BuildCoverage,
  BuildProcessingStatus,
  BuildSource,
  BuildValidationIssue,
  CreateBuildData,
  CreateUploadData,
} from './services/firestore/firestore.types.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import { apiKeyAuth, type AuthVariables } from './middleware/auth.js';
import { extractGitContext, normalizeCoverageInput } from './coverage/coverage.js';
import { parseMultipartFormData } from './utils/multipart.js';
import { ciEventFields, mergeCiTimings, parseCiTimings, type CiTimings, type CiTimingsParse } from './ci-timings/ci-timings.js';
import { parseSourceKey } from './bundle/source-key.js';
import { readBoundedZip, DEFAULT_BOUNDED_ZIP_LIMITS, type BoundedZipIssue } from './bundle/bounded-zip.js';
import { validateBundle, type ValidationIssue as ScfValidationIssue } from './vendor/scf/dist/index.js';

// Define the application's environment, including injectable variables.
export type AppEnv = {
  Bindings: StampBindings; // Other bindings will be defined per-target
  Variables: {
    storage: StorageService;
    firestore?: FirestoreService; // Optional to support gradual rollout
    apiKeyService?: ApiKeyService; // Optional for API key authentication
    processingQueue?: Queue; // Optional build processing queue
    cleanupToken?: string;
  } & AuthVariables;
};

const app = new OpenAPIHono<AppEnv>();

// Add request logging middleware
app.use('*', logger());

// Add API key authentication middleware to protected routes
// This middleware validates the X-API-Key header against Firestore-stored keys.
//
// The patterns MUST name the :project segment. apiKeyAuth reads the route's
// project with c.req.param('project'), and a middleware only sees the params of
// its own pattern: mounted on '/upload/*' it saw none, skipped the
// project-mismatch check and validated the key against its own project, so any
// project's key could write to any other project (upload-project-key-scope).
// '/x/:project/*' also matches '/x/:project' itself.
app.use('/upload/:project/*', apiKeyAuth());
app.use('/presigned-url/:project/*', apiKeyAuth());
app.use('/upload-images/:project/*', apiKeyAuth());

/**
 * Which key created a build (upload-project-key-scope): the key's Firestore doc
 * id and the project it belongs to. Never the key value or a hash of it.
 */
function uploadedBy(key: AuthVariables['authenticatedApiKey']): Pick<CreateBuildData, 'uploadedByKeyId' | 'uploadedByKeyProject'> {
  if (!key) return {};
  return { uploadedByKeyId: key.id, uploadedByKeyProject: key.keyProjectId };
}

/**
 * One log line per build-creating upload saying whether CI timings came with it
 * (storybook-preview-ci-runtime). `ci_timings_absent=1` / `ci_timings_invalid=1`
 * are the counters: an older deployer sends none, which is expected and counted,
 * never stored as zeros; a structurally invalid block is counted at warn with
 * its paths. `ci_timings_field_dropped=N` counts single out-of-bounds fields
 * dropped from an otherwise stored block.
 */
function logCiTimings(
  route: string,
  ids: { project: string; version: string; buildNumber?: number },
  parsed: CiTimingsParse
): void {
  const where = `route=${route} project=${ids.project} version=${ids.version} build=${ids.buildNumber ?? 'none'}`;
  if (parsed.status === 'ok') {
    console.log(`[INFO] ci_timings ${where} ci_timings=stored fields=${Object.keys(parsed.ciTimings).join(',')}`);
    if (parsed.dropped.length > 0) {
      console.warn(
        `[WARN] ci_timings ${where} ci_timings_field_dropped=${parsed.dropped.length} out of bounds, not stored; rest stored: ${parsed.dropped.join(', ')}`
      );
    }
  } else if (parsed.status === 'absent') {
    console.log(`[INFO] ci_timings ${where} ci_timings=absent ci_timings_absent=1`);
  } else {
    console.warn(
      `[WARN] ci_timings ${where} ci_timings=invalid ci_timings_invalid=1 not stored; build unaffected: ${parsed.issues.join('; ')}`
    );
  }
}

const PROJECT_SEGMENT_REGEX = /^[a-zA-Z0-9_-]+$/;
const VERSION_SEGMENT_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const FILENAME_SEGMENT_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

// Define Zod schemas for parameters and responses
const ProjectVersionParamsSchema = z.object({
  project: z.string().min(1).regex(PROJECT_SEGMENT_REGEX, 'Project name must contain only alphanumeric characters, hyphens, and underscores').openapi({ example: 'my-project' }),
  version: z
    .string()
    .min(1)
    .max(128)
    .regex(
      VERSION_SEGMENT_REGEX,
      'Version must contain only alphanumeric characters, periods, hyphens, and underscores'
    )
    .openapi({
      example: 'v1.0.0',
      description:
        'Version identifier - supports semantic versions (v1.0.0), PR builds (pr-001), extended versions (v0.0.0.1), and named releases (beta-2024, dev-123, staging, latest)',
      examples: ['v1.0.0', 'pr-001', 'v0.0.0.1', 'beta-2024', 'dev-snapshot-123', 'staging', 'latest', 'main'],
    }),
});

const ProjectVersionFilenameParamsSchema = z.object({
  project: z.string().min(1).regex(PROJECT_SEGMENT_REGEX, 'Project name must contain only alphanumeric characters, hyphens, and underscores').openapi({ example: 'my-project' }),
  version: z
    .string()
    .min(1)
    .max(128)
    .regex(
      VERSION_SEGMENT_REGEX,
      'Version must contain only alphanumeric characters, periods, hyphens, and underscores'
    )
    .openapi({ example: '1.0.0' }),
  filename: z
    .string()
    .min(1)
    .max(128)
    .regex(
      FILENAME_SEGMENT_REGEX,
      'Filename must contain only alphanumeric characters, periods, hyphens, and underscores'
    )
    .openapi({ example: 'storybook.zip' }),
});

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

const UploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  key: z.string(),
  data: z.object({
    url: z.string(),
    path: z.string(),
    versionId: z.string().optional(),
    buildId: z.string().optional(),
    buildNumber: z.number().optional(),
    coverageUrl: z.string().optional(),
  })
});

const PresignedUrlResponseSchema = z.object({
  url: z.string(),
  fields: z.object({
    key: z.string()
  }),
  buildId: z.string().optional(),
  buildNumber: z.number().optional()
});

const CleanupResponseSchema = z.object({
  message: z.string()
});

const ErrorResponseSchema = z.object({
  error: z.string()
});

const AuthErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string()
});

// Health check route
const StampSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  env: z.enum(['staging', 'production', 'dev']),
  commit: z.string(),
  branch: z.string().nullable(),
  builtAt: z.string().nullable(),
  deployId: z.string().nullable(),
  actor: z.string().nullable(),
});

app.openapi(createRoute({
  method: 'get',
  path: '/healthz',
  responses: {
    200: {
      description: 'Deployment stamp',
      content: { 'application/json': { schema: StampSchema } },
    },
  },
}), (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(deployStamp(c.env), 200);
});

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'Health status',
      content: {
        'application/json': {
          schema: StampSchema.extend({
            status: z.literal('ok'),
            timestamp: z.string().datetime()
          })
        }
      }
    }
  }
});

app.openapi(healthRoute, (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ...deployStamp(c.env), status: 'ok' as const, timestamp: new Date().toISOString() });
});

// Upload route
const uploadRoute = createRoute({
  method: 'post',
  path: '/upload/:project/:version',
  request: {
    params: ProjectVersionParamsSchema
  },
  responses: {
    201: {
      description: 'Upload successful',
      content: {
        'application/json': {
          schema: UploadResponseSchema
        }
      }
    },
    400: {
      description: 'No file provided, empty file, or validation error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema
        }
      }
    },
    401: {
      description: 'Unauthorized - Invalid or missing API key',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema
        }
      }
    },
    403: {
      description: 'Forbidden - API key does not belong to the requested project',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema
        }
      }
    },
    413: {
      description: 'File too large',
      content: {
        'application/json': {
          schema: ErrorResponseSchema
        }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema
        }
      }
    }
  }
});

app.openapi(uploadRoute, async (c) => {
  try {
    const storage = c.var.storage;
    const firestore = c.var.firestore;
    const { project, version } = c.req.valid('param');
    console.log(`[INFO] Upload request received: project=${project}, version=${version}`);

    // Validate project and version
    if (!project || project.trim() === '') {
      return c.json({ error: 'Project name is required' }, 400);
    }
    if (!version || version.trim() === '') {
      return c.json({ error: 'Version is required' }, 400);
    }

    const filename = 'storybook.zip'; // Default or from form
    const key = `${project}/${version}/${filename}`;

    // Enforce a simple request size limit. For large bodies, some runtimes may
    // fail while streaming/parsing; checking Content-Length allows us to return
    // a consistent 413 response early when available.
    const maxSize = 5 * 1024 * 1024; // 5MB
    const contentLengthHeader = c.req.header('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isNaN(contentLength) && contentLength > maxSize) {
        return c.json({ error: 'File too large. Maximum size is 5MB' }, 413);
      }
    }

    // Handle both multipart form data and raw binary uploads
    let file: File;
    let coveragePayload: unknown | undefined;
    let coverageUrl: string | undefined;
    // Optional `ciTimings` form field (JSON), same contract as the presigned body.
    let ciTimingsRaw: string | undefined;

    const contentType = c.req.header('content-type') || '';
    console.log(`[INFO] Upload content-type: ${contentType || 'unknown'}`);

    if (contentType.includes('multipart/form-data')) {
      // Handle multipart form data
      try {
        // First try Hono's built-in formData method
        const formData = await c.req.formData();
        file = formData.get('file') as File;

        if (!file || file.size === 0) {
          throw new Error('No file in FormData');
        }

        const coverageFile = formData.get('coverage') as File | null;
        const coverageJson = formData.get('coverageJson') as string | null;
        const ciTimingsField = formData.get('ciTimings');
        if (typeof ciTimingsField === 'string') ciTimingsRaw = ciTimingsField;

        if (coverageFile) {
          const text = await coverageFile.text();
          try {
            coveragePayload = JSON.parse(text);
          } catch {
            return c.json({ error: 'Invalid coverage JSON' }, 400);
          }
        } else if (coverageJson) {
          try {
            coveragePayload = JSON.parse(coverageJson);
          } catch {
            return c.json({ error: 'Invalid coverage JSON' }, 400);
          }
        }
      } catch (formDataError) {
        console.log(
          'Hono FormData parsing failed, trying busboy fallback:',
          formDataError instanceof Error ? formDataError.message : String(formDataError)
        );

        // Fallback to busboy parser for Node.js compatibility
        try {
          const parsed = await parseMultipartFormData(c.req.raw);
          file = parsed.files.file;

          if (!file || file.size === 0) {
            return c.json({ error: 'No file provided or empty file' }, 400);
          }

          const coverageFile = parsed.files.coverage;
          const coverageJson = parsed.fields.coverageJson;
          if (typeof parsed.fields.ciTimings === 'string') ciTimingsRaw = parsed.fields.ciTimings;

          if (coverageFile) {
            const text = await coverageFile.text();
            try {
              coveragePayload = JSON.parse(text);
            } catch {
              return c.json({ error: 'Invalid coverage JSON' }, 400);
            }
          } else if (coverageJson) {
            try {
              coveragePayload = JSON.parse(coverageJson);
            } catch {
              return c.json({ error: 'Invalid coverage JSON' }, 400);
            }
          }
        } catch (busboyError) {
          console.error('Busboy parsing failed:', busboyError);
          return c.json(
            {
              error:
                'Failed to parse file upload. Please ensure you are sending a valid multipart/form-data request with a file field named "file".',
            },
            400
          );
        }
      }

      // If coverage was provided, upload the raw JSON to storage.
      if (coveragePayload) {
        try {
          const coverageKey = `${project}/${version}/coverage-report.json`;
          const coverageBody = new Blob([JSON.stringify(coveragePayload)]).stream();
          const coverageResult = await storage.upload(coverageKey, coverageBody, 'application/json');
          coverageUrl = coverageResult.url;
        } catch (coverageUploadError) {
          console.error('Coverage upload error:', coverageUploadError);
          return c.json({ error: 'Failed to upload coverage report' }, 500);
        }
      }
    } else {
      // Handle raw binary upload (e.g., application/zip, application/octet-stream)
      try {
        const body = await c.req.arrayBuffer();
        if (!body || body.byteLength === 0) {
          return c.json({ error: 'No file data received' }, 400);
        }
        
        // Determine the MIME type from the Content-Type header or default to application/zip
        const mimeType = contentType || 'application/zip';
        file = new File([body], filename, { type: mimeType });
        
        console.log(`Received raw binary upload: ${body.byteLength} bytes, type: ${mimeType}`);
      } catch (bodyError) {
        console.error('Raw body parsing failed:', bodyError);
        return c.json({ error: 'Failed to parse raw file upload' }, 400);
      }
    }

    console.log(`[INFO] Upload parsed: fileSize=${file.size}, hasCoverage=${Boolean(coveragePayload)}`);

    // Check file size limit (5MB)
    if (file.size > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 5MB' }, 413);
    }

    const fileContentType = file.type || 'application/zip';
    const body = file.stream();

    const result = await storage.upload(key, body, fileContentType);
    console.log(`[INFO] Upload stored: key=${key}, url=${result.url}`);

    // Create Firestore build record if Firestore is configured
    let buildId: string | undefined;
    let buildNumber: number | undefined;
    
    if (firestore) {
      let ciParsed: CiTimingsParse = { status: 'absent' };
      if (ciTimingsRaw !== undefined) {
        try {
          ciParsed = parseCiTimings(JSON.parse(ciTimingsRaw));
        } catch {
          ciParsed = { status: 'invalid', issues: ['ciTimings: not JSON'] };
        }
      }
      const ciTimings = ciParsed.status === 'ok' ? ciParsed.ciTimings : undefined;
      try {
        const buildData: CreateBuildData = {
          versionId: version,
          zipUrl: result.url,
          ...uploadedBy(c.var.authenticatedApiKey),
          ...(ciTimings ? { ciTimings } : {}),
          ...(coveragePayload && coverageUrl
            ? {
                coverage: normalizeCoverageInput(coveragePayload, {
                  reportUrl: coverageUrl,
                }) as BuildCoverage,
              }
            : {}),
          // The coverage report has always carried the commit and branch; the
          // build document has never kept them, so a search result could name
          // the deploy but not the code (P13a).
          ...extractGitContext(coveragePayload),
        };

        console.log(`[INFO] Creating build: project=${project}, version=${version}, zipUrl=${result.url}, hasCoverage=${Boolean(buildData.coverage)}`);
        const build = await firestore.createBuild(project, buildData);
        buildId = build.id;
        buildNumber = build.buildNumber;
        console.log(`[INFO] Build created: id=${buildId}, number=${buildNumber}`);
        logCiTimings('upload', { project, version, buildNumber }, ciParsed);

        // Opens the funnel (playbook §5.5): uploaded -> processed -> indexed ->
        // searched. Not awaited, and trackEvent swallows its own errors — an
        // upload that succeeded must not fail because analytics did not land.
        void firestore.trackEvent?.('storybook_uploaded', {
          projectId: project,
          buildId,
          buildNumber,
          versionId: version,
          ...ciEventFields(ciTimings),
        });

        // This route is unused by the deployer (`scry-node` uses the presigned-url + /metadata
        // flow; grep across every repo on this box found only this repo's own e2e tests calling it
        // directly — capture-sources ledger F2). It used to also enqueue `key` (this multipart/raw
        // body, stored as `storybook.zip`) as the processing zipKey, which would have build
        // processing read that raw upload as a static site and index it as unmatched raw images —
        // the same class of bug the metadata route exists to avoid. Fixed by no longer enqueuing:
        // the route still stores the file and creates the build (both exercised by the e2e suite),
        // it just no longer tells the queue there is metadata-shaped content to process.
      } catch (firestoreError) {
        // Log error but don't fail the upload
        console.error('Firestore error (upload succeeded):', firestoreError);
      }
    }

    return c.json(
      {
        success: true,
        message: 'Upload successful',
        key: key,
        data: {
          ...result,
          ...(buildId && { buildId }),
          ...(buildNumber !== undefined && { buildNumber }),
          ...(coverageUrl && { coverageUrl }),
        },
      },
      201
    );
  } catch (error) {
    console.error('Upload error:', error);
    return c.json({
      error: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, 500);
  }
});

const CoverageUploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  buildId: z.string(),
  coverageUrl: z.string().optional(),
});

const MetadataUploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  queued: z.boolean(),
  buildNumber: z.number(),
  zipKey: z.string(),
});

// Coverage upload route - upload JSON and update build
const coverageUploadRoute = createRoute({
  method: 'post',
  path: '/upload/:project/:version/coverage',
  request: {
    params: ProjectVersionParamsSchema,
  },
  responses: {
    201: {
      description: 'Coverage upload successful',
      content: {
        'application/json': {
          schema: CoverageUploadResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid coverage data',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Build not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(coverageUploadRoute, async (c) => {
  try {
    const storage = c.var.storage;
    const firestore = c.var.firestore;
    const { project, version } = c.req.valid('param');
    const requestId = c.req.header('cf-ray') || 'unknown';
    const contentTypeHeader = c.req.header('content-type') || '';

    console.log('[COVERAGE] Request received', {
      requestId,
      project,
      version,
      contentType: contentTypeHeader,
      hasFirestore: !!firestore,
    });

    if (!firestore) {
      console.error('[COVERAGE] Firestore not configured', { requestId });
      return c.json({ error: 'Firestore not configured' }, 500);
    }

    // Find the build for this version
    console.log('[COVERAGE] Looking up build', { requestId, project, version });
    const build = await firestore.getBuildByVersion(project, version);
    if (!build) {
      console.warn('[COVERAGE] Build not found', { requestId, project, version });
      return c.json({ error: 'Build not found for this version' }, 404);
    }
    console.log('[COVERAGE] Build found', { requestId, buildId: build.id, buildNumber: build.buildNumber });

    // Handle both JSON body and multipart form data
    const contentType = contentTypeHeader;
    let coveragePayload: unknown;

    if (contentType.includes('multipart/form-data')) {
      // Handle multipart - coverage JSON file upload
      try {
        console.log('[COVERAGE] Parsing multipart form data (Hono)', { requestId });
        const formData = await c.req.formData();
        const file = (formData.get('file') as File | null) || (formData.get('coverage') as File | null);

        if (!file) {
          console.warn('[COVERAGE] No coverage file provided in multipart', { requestId });
          return c.json({ error: 'No coverage file provided' }, 400);
        }

        const fileContent = await file.text();
        console.log('[COVERAGE] Multipart file parsed', {
          requestId,
          filename: file.name,
          size: file.size,
          type: file.type,
        });
        coveragePayload = JSON.parse(fileContent);
      } catch (e) {
        // Fallback to busboy parser for Node.js compatibility
        try {
          console.log('[COVERAGE] Multipart parse failed, trying busboy fallback', { requestId });
          const parsed = await parseMultipartFormData(c.req.raw);
          const file = parsed.files.file || parsed.files.coverage;

          if (!file) {
            console.warn('[COVERAGE] No coverage file provided in busboy', { requestId });
            return c.json({ error: 'No coverage file provided' }, 400);
          }

          const fileContent = await file.text();
          console.log('[COVERAGE] Busboy file parsed', {
            requestId,
            filename: file.name,
            size: file.size,
            type: file.type,
          });
          coveragePayload = JSON.parse(fileContent);
        } catch {
          console.error('[COVERAGE] Invalid coverage JSON after multipart parsing', { requestId });
          return c.json({ error: 'Invalid coverage JSON' }, 400);
        }
      }
    } else {
      try {
        console.log('[COVERAGE] Parsing JSON body', { requestId });
        coveragePayload = await c.req.json();
      } catch {
        console.error('[COVERAGE] Invalid JSON body', { requestId });
        return c.json({ error: 'Invalid coverage JSON' }, 400);
      }
    }

    console.log('[COVERAGE] Coverage payload received', {
      requestId,
      payloadType: typeof coveragePayload,
      payloadKeys: coveragePayload && typeof coveragePayload === 'object' ? Object.keys(coveragePayload as Record<string, unknown>) : [],
    });

    // Always upload raw JSON to R2
    const coverageKey = `${project}/${version}/coverage-report.json`;
    const coverageBody = new Blob([JSON.stringify(coveragePayload)]).stream();
    console.log('[COVERAGE] Uploading coverage JSON to storage', { requestId, coverageKey });
    const coverageResult = await storage.upload(coverageKey, coverageBody, 'application/json');
    console.log('[COVERAGE] Coverage JSON uploaded', { requestId, coverageUrl: coverageResult.url });

    let coverage: BuildCoverage;
    try {
      coverage = normalizeCoverageInput(coveragePayload, {
        reportUrl: coverageResult.url,
      }) as BuildCoverage;
    } catch (e) {
      console.error('[COVERAGE] Coverage normalization failed', {
        requestId,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ error: 'Invalid coverage data' }, 400);
    }

    // Update build with coverage data
    console.log('[COVERAGE] Updating build coverage', { requestId, buildId: build.id });
    await firestore.updateBuildCoverage(project, build.id, coverage);
    console.log('[COVERAGE] Build coverage updated', { requestId, buildId: build.id });

    // And with where the build came from. Separate from the coverage write
    // because provenance is not coverage data and outlives it: the build
    // document is what the indexer reads to stamp build_sha on every row.
    // Failure here must not fail an upload that has already succeeded — the
    // rows simply report their freshness as unknown.
    const gitContext = extractGitContext(coveragePayload);
    if (gitContext.commitSha || gitContext.branch) {
      try {
        await firestore.updateBuild(project, build.id, gitContext);
        console.log('[COVERAGE] Build provenance recorded', {
          requestId,
          buildId: build.id,
          commitSha: gitContext.commitSha,
          branch: gitContext.branch,
        });
      } catch (e) {
        console.warn('[COVERAGE] Could not record build provenance', {
          requestId,
          buildId: build.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return c.json(
      {
        success: true,
        message: 'Coverage uploaded successfully',
        buildId: build.id,
        coverageUrl: coverageResult.url,
      },
      201
    );
  } catch (error) {
    console.error('Coverage upload error:', error);
    return c.json(
      {
        error: `Coverage upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      500
    );
  }
});

/**
 * Where a build came from, sent by the CLI alongside the metadata ZIP.
 *
 * Query parameters rather than a body field because the body is the ZIP. Both
 * are optional: a deploy from a machine with no git context sends neither, and
 * the build keeps no commit rather than an invented one (P13a).
 */
const BuildProvenanceQuerySchema = z.object({
  commitSha: z
    .string()
    .regex(/^[0-9a-fA-F]{7,40}$/, 'commitSha must be a hex git object name')
    .optional()
    .openapi({ example: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }),
  branch: z.string().min(1).max(255).optional().openapi({ example: 'main' }),
});

const metadataUploadRoute = createRoute({
  method: 'post',
  path: '/upload/:project/:version/metadata',
  request: {
    params: ProjectVersionParamsSchema,
    query: BuildProvenanceQuerySchema,
  },
  responses: {
    201: {
      description: 'Metadata ZIP uploaded',
      content: {
        'application/json': {
          schema: MetadataUploadResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request payload or missing prior build',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(metadataUploadRoute, async (c) => {
  try {
    const { project, version } = c.req.valid('param');
    const { commitSha, branch } = c.req.valid('query');
    const storage = c.var.storage;
    const firestore = c.var.firestore;
    const queue = c.var.processingQueue;

    const body = await c.req.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return c.json({ error: 'No file provided' }, 400);
    }

    if (!firestore) {
      return c.json({ error: 'Firestore not configured' }, 500);
    }

    const build = await firestore.getLatestBuild(project, version);
    if (!build) {
      return c.json(
        {
          error: 'No build found for this project and version. Upload storybook.zip first.',
        },
        400
      );
    }

    const zipKey = `${project}/${version}/builds/${build.buildNumber}/metadata-screenshots.zip`;
    await storage.upload(zipKey, new Blob([body]).stream(), 'application/zip');

    // Record provenance before the build is queued, so the indexer finds it on
    // the document when it reads the build (it stamps build_sha on every row it
    // writes). Best effort: a build that indexes without a SHA reports its
    // freshness as unknown, which is strictly better than not indexing.
    if (commitSha || branch) {
      try {
        await firestore.updateBuild(project, build.id, {
          ...(commitSha ? { commitSha } : {}),
          ...(branch ? { branch } : {}),
        });
      } catch (e) {
        console.warn('[METADATA] Could not record build provenance', {
          buildId: build.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    let queued = false;
    if (queue) {
      await queue.send({
        projectId: project,
        versionId: version,
        buildId: build.id,
        zipKey,
        timestamp: Date.now(),
        trace: currentTraceContext(),
      });
      queued = true;
    }

    const queuedStatus: BuildProcessingStatus = 'queued';
    if (firestore.updateProcessingStatus) {
      await firestore.updateProcessingStatus(project, build.id, queuedStatus);
    } else {
      await firestore.updateBuild(project, build.id, { processingStatus: queuedStatus });
    }

    return c.json(
      {
        success: true,
        message: queued ? 'Metadata ZIP uploaded and processing queued' : 'Metadata ZIP uploaded',
        queued,
        buildNumber: build.buildNumber,
        zipKey,
      },
      201
    );
  } catch (error) {
    console.error('Metadata upload error:', error);
    return c.json(
      { error: `Metadata upload failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      500
    );
  }
});

/**
 * CI timings: the deployer's final record (storybook-preview-ci-runtime, ISSUES.md #54).
 *
 * The presigned-URL call stores the pre-upload part (analyze, execute, archive,
 * counts, versions, runner, CI ids, budget) when it creates the build; this
 * route merges what is only known after the metadata ZIP (uploadMs,
 * deployerTotalMs, jobElapsedMs / jobTimeSource / jobTimeReason).
 *
 * Keyed by the buildId the presigned-URL (`buildId`) and direct upload
 * (`data.buildId`) responses return, not the build number: the per-project
 * counter is not atomic, so two concurrent uploads can share a number.
 *
 * Auth is the upload API-key middleware, like every other upload route: the
 * key must belong to :project. The build must exist under that project with
 * that version, else 404. Idempotent: the same record twice leaves the same
 * document. A 404 from a service without this route is expected by the
 * deployer (it logs "not stored" and carries on).
 */
const CiTimingsParamsSchema = ProjectVersionParamsSchema.extend({
  buildId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, 'buildId must be a Firestore document id')
    .openapi({ example: 'q3Xk9TzP0aBcDeFgHiJk' }),
});

const CiTimingsResponseSchema = z.object({
  success: z.boolean(),
  buildId: z.string(),
  buildNumber: z.number(),
  stored: z.array(z.string()),
  /** Fields that were out of bounds and not stored (counted as ci_timings_field_dropped). */
  dropped: z.array(z.string()),
});

const ciTimingsRoute = createRoute({
  method: 'post',
  path: '/upload/:project/:version/builds/:buildId/ci-timings',
  request: {
    params: CiTimingsParamsSchema,
  },
  responses: {
    200: {
      description: 'CI timings merged into the build document',
      content: { 'application/json': { schema: CiTimingsResponseSchema } },
    },
    400: {
      description: 'Body is not a ciTimings record, or nothing in it was storable (the error names the paths)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: AuthErrorResponseSchema } },
    },
    403: {
      description: 'API key does not belong to the requested project',
      content: { 'application/json': { schema: AuthErrorResponseSchema } },
    },
    404: {
      description: 'No build with that id for this project and version',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

app.openapi(ciTimingsRoute, async (c) => {
  const { project, version, buildId } = c.req.valid('param');
  const firestore = c.var.firestore;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON: {"ciTimings": {...}}' }, 400);
  }
  // Accept {ciTimings: {...}} (the presigned body's key) or the bare record.
  const record =
    body && typeof body === 'object' && !Array.isArray(body) && 'ciTimings' in (body as object)
      ? (body as { ciTimings: unknown }).ciTimings
      : body;
  const parsed = parseCiTimings(record);
  if (parsed.status === 'invalid') {
    console.warn(
      `[WARN] ci_timings route=ci-timings project=${project} version=${version} buildId=${buildId} ci_timings_invalid=1: ${parsed.issues.join('; ')}`
    );
    return c.json({ error: `Invalid ciTimings: ${parsed.issues.join('; ')}` }, 400);
  }
  if (parsed.status === 'absent') {
    return c.json({ error: 'No ciTimings fields to store' }, 400);
  }

  if (!firestore) {
    return c.json({ error: 'Firestore not configured' }, 500);
  }

  try {
    // getBuild reads projects/{project}/builds/{buildId}, so a build of another
    // project is simply not found; the projectId check is belt and braces.
    const build = await firestore.getBuild(project, buildId);
    if (!build || build.versionId !== version || (build.projectId && build.projectId !== project)) {
      return c.json({ error: 'Build not found for this project, version and build id' }, 404);
    }

    const merged = mergeCiTimings(build.ciTimings, parsed.ciTimings);
    await firestore.updateBuild(project, build.id, { ciTimings: merged });
    logCiTimings('ci-timings', { project, version, buildNumber: build.buildNumber }, parsed);

    return c.json(
      {
        success: true,
        buildId: build.id,
        buildNumber: build.buildNumber,
        stored: Object.keys(parsed.ciTimings),
        dropped: parsed.dropped,
      },
      200
    );
  } catch (error) {
    console.error('CI timings error:', error);
    return c.json(
      { error: `CI timings failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      500
    );
  }
});

// File retrieval route
const retrievalRoute = createRoute({
  method: 'get',
  path: '/upload/:project/:version',
  request: {
    params: ProjectVersionParamsSchema
  },
  responses: {
    200: {
      description: 'File information retrieved',
      content: {
        'application/json': {
          schema: z.object({
            project: z.string(),
            version: z.string(),
            key: z.string(),
            available: z.boolean()
          })
        }
      }
    },
    404: {
      description: 'File not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema
        }
      }
    }
  }
});

app.openapi(retrievalRoute, async (c) => {
  const { project, version } = c.req.valid('param');
  const key = `${project}/${version}/storybook.zip`;
  
  // For now, return a simple response. In a real implementation, 
  // you might check if the file exists in storage
  return c.json({
    project,
    version,
    key,
    available: true
  }, 200);
});

// ============= CAPTURE SOURCES: SCF BUNDLE ROUTES =============
//
// contract §9: a bundle can be uploaded (any source — a web Storybook, React Native, a Playwright
// crawl, …) without a prior storybook.zip. Two calls, mirroring the upload-images shape below:
// a presigned PUT that creates the build with its `source`, then a `/complete` that validates the
// uploaded ZIP with the vendored `@scrymore/scf` validator (src/vendor/scf/) and only then enqueues
// it. Auth is the same project-scoped API key middleware as every other upload route (`/presigned-
// url/:project/*`, `/upload/:project/*`; G3) — nothing new to wire up here.

const ValidationIssueSchema = z.object({
  code: z.string(),
  id: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
});

/**
 * The whole bundle ZIP, as HEAD-checked before download. The spec (spec/scf-1.0.md) bounds each
 * image (20 MB, 16384px) but sets no bundle-wide cap; this is a server-side default protecting the
 * upload service itself, independent of the vendored validator's own per-image/per-file limits.
 *
 * Ledger F32: this used to be 300 MiB and was still fully buffered into one in-memory `Buffer`
 * before this route did anything else with it — well past what a Cloudflare Worker's ~128 MB
 * isolate can hold, so any legitimately large bundle reliably crashed the request with an
 * out-of-memory error rather than reaching a clean 422. The route below now reads the object as a
 * true stream (`readBoundedZip`, ledger F31/F49) and never buffers more than a small bounded
 * window of it at once, so this cap can be — and is — sized to what a real bundle needs rather than
 * to what used to fit in memory. Kept equal to `bounded-zip.ts`'s own `maxRawBytes` (the same cap,
 * enforced a second time here as a cheap pre-download HEAD check) — one number, not two to drift.
 */
const MAX_BUNDLE_ZIP_BYTES = DEFAULT_BOUNDED_ZIP_LIMITS.maxRawBytes;

const BundleSourceQuerySchema = z.object({
  source: z
    .string()
    .min(1)
    .max(100)
    .openapi({
      example: 'storybook-rn:ios',
      description:
        'sourceKeyOf(manifest) = "<kind>:<platform|web>" (contract §2/§9): a registered source.kind ' +
        '(or an x-<name> vendor kind) and a registered source.platform, joined by ":". Computed by the ' +
        'adapter/CLI before the bundle exists, so it is validated here without reading any bundle content.',
    }),
});

const presignedBundleUrlRoute = createRoute({
  method: 'post',
  path: '/presigned-url/:project/:version/bundle.zip',
  request: {
    params: ProjectVersionParamsSchema,
    query: BundleSourceQuerySchema,
  },
  responses: {
    200: {
      description: 'Presigned PUT for an SCF bundle; the build is created with its source recorded',
      content: { 'application/json': { schema: PresignedUrlResponseSchema } },
    },
    400: {
      description: 'Missing or invalid ?source=<sourceKey>',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized - Invalid or missing API key',
      content: { 'application/json': { schema: AuthErrorResponseSchema } },
    },
    403: {
      description: "Forbidden - API key does not belong to the requested project",
      content: { 'application/json': { schema: AuthErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

app.openapi(presignedBundleUrlRoute, async (c) => {
  try {
    const storage = c.var.storage;
    const firestore = c.var.firestore;
    const { project, version } = c.req.valid('param');
    const { source: rawSource } = c.req.valid('query');

    const parsedSource = parseSourceKey(rawSource);
    if (!parsedSource) {
      return c.json(
        {
          error: `Invalid source: ${JSON.stringify(rawSource)}. Expected "<kind>:<platform>" with a registered kind (or x-<name>) and a registered platform.`,
        },
        400
      );
    }

    if (!firestore) {
      return c.json({ error: 'Firestore not configured' }, 500);
    }

    console.log(
      `[INFO] Presigned bundle URL request: project=${project}, version=${version}, source=${rawSource}`
    );

    const source: BuildSource = { kind: parsedSource.kind, platform: parsedSource.platform };

    // The build is created first (unlike the generic presigned-url route above, which historically
    // computes its flat key before a build exists): that gives us buildNumber up front, so the
    // stored key can follow the same `builds/{n}/…` layout the metadata route already uses, instead
    // of a flat `{project}/{version}/bundle.zip`. zipUrl is left blank, same as the standalone image
    // upload route (imageUploadInitRoute) — nothing reads it for a bundle build, which never gets a
    // "View" button (no static site to view).
    const build = await firestore.createBuild(project, {
      versionId: version,
      zipUrl: '',
      source,
      ...uploadedBy(c.var.authenticatedApiKey),
    });

    const key = `${project}/${version}/builds/${build.buildNumber}/bundle.zip`;
    const data = await storage.getPresignedUploadUrl(key, 'application/zip');

    console.log(
      `[INFO] Bundle build created: id=${build.id}, number=${build.buildNumber}, key=${key}, source=${rawSource}`
    );

    return c.json(
      {
        url: data.url,
        fields: { key: data.key },
        buildId: build.id,
        buildNumber: build.buildNumber,
      },
      200
    );
  } catch (error) {
    console.error('Presigned bundle URL error:', error);
    return c.json(
      { error: `Presigned bundle URL failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      500
    );
  }
});

const BundleCompleteBodySchema = z.object({
  buildId: z
    .string()
    .min(1)
    .max(128)
    .openapi({ description: 'The Firestore build id the presigned-url/bundle.zip call returned.' }),
  zipKey: z
    .string()
    .min(1)
    .max(512)
    .openapi({ description: 'The key the client PUT the bundle ZIP to (the presigned URL fields.key).' }),
});

const BundleCompleteResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  queued: z.boolean(),
  buildId: z.string(),
  buildNumber: z.number(),
  warnings: z.array(ValidationIssueSchema).optional(),
});

const BundleRejectedResponseSchema = z.object({
  success: z.boolean(),
  error: z.string(),
  errors: z.array(ValidationIssueSchema),
});

const bundleCompleteRoute = createRoute({
  method: 'post',
  path: '/upload/:project/:version/bundle/complete',
  request: {
    params: ProjectVersionParamsSchema,
    body: { content: { 'application/json': { schema: BundleCompleteBodySchema } } },
  },
  responses: {
    200: {
      description: 'Bundle accepted (G7) and queued for processing',
      content: { 'application/json': { schema: BundleCompleteResponseSchema } },
    },
    400: {
      description: 'Bundle object not found, or buildId/zipKey do not match this project/version',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized - Invalid or missing API key',
      content: { 'application/json': { schema: AuthErrorResponseSchema } },
    },
    403: {
      description: "Forbidden - API key does not belong to the requested project",
      content: { 'application/json': { schema: AuthErrorResponseSchema } },
    },
    404: {
      description: 'Build not found for this project',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description:
        'Bundle rejected by the vendored SCF validator, same messages as the CLI (G7). The uploaded ' +
        'object is deleted and the build is marked failed with these messages.',
      content: { 'application/json': { schema: BundleRejectedResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

app.openapi(bundleCompleteRoute, async (c) => {
  try {
    const { project, version } = c.req.valid('param');
    const { buildId, zipKey } = c.req.valid('json');
    const storage = c.var.storage;
    const firestore = c.var.firestore;
    const queue = c.var.processingQueue;

    if (!firestore) {
      return c.json({ error: 'Firestore not configured' }, 500);
    }

    // zipKey is caller-supplied (the client's own record of the presigned URL's key). The API key
    // already scopes the caller to :project; this additionally stops them asking the validator to
    // read and enqueue an object outside their own build's namespace.
    const expectedPrefix = `${project}/${version}/builds/`;
    if (!zipKey.startsWith(expectedPrefix) || !zipKey.endsWith('/bundle.zip')) {
      return c.json({ error: `zipKey must be under ${expectedPrefix} and end in /bundle.zip` }, 400);
    }

    const build = await firestore.getBuild(project, buildId);
    if (!build) {
      return c.json({ error: 'Build not found' }, 404);
    }
    if (build.versionId !== version) {
      return c.json({ error: 'Build does not belong to this project/version' }, 400);
    }

    // Reject the bundle: delete the uploaded object, mark the build failed with the same messages
    // the caller gets back (so the Builds tab can show why), then respond 422 (contract §9).
    // Best-effort on both writes — a rejection response must still reach the caller even if the
    // cleanup half-fails; the object then just outlives its failed build, same as any other
    // best-effort write in this file (e.g. the metadata route's provenance backfill).
    const reject = async (issues: BuildValidationIssue[]) => {
      await storage.delete(zipKey).catch((e) => {
        console.warn('[BUNDLE] Could not delete rejected object', {
          zipKey,
          error: e instanceof Error ? e.message : String(e),
        });
      });
      await firestore
        .updateBuild(project, buildId, { processingStatus: 'failed', validationErrors: issues })
        .catch((e) => {
          console.warn('[BUNDLE] Could not mark build failed', {
            buildId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      return c.json({ success: false, error: 'Bundle rejected', errors: issues }, 422);
    };

    // HEAD/size check (contract §1) before reading anything.
    const meta = await storage.head(zipKey);
    if (!meta || meta.size === 0) {
      return c.json({ error: 'Bundle object not found. Upload it to the presigned URL first.' }, 400);
    }
    if (meta.size > MAX_BUNDLE_ZIP_BYTES) {
      return reject([
        {
          code: 'BUNDLE_TOO_LARGE',
          message: `Bundle is ${meta.size} bytes, over the ${MAX_BUNDLE_ZIP_BYTES} byte limit.`,
        },
      ]);
    }

    // A genuine two-pass, never-buffer-the-whole-object read (ledger F31/F32/F49): the central
    // directory (range-GET of the object's tail, bounded) is the sole source of truth for every
    // entry's name/size/CRC — archiver (our own CLI's and sbcov's zip writer) sets every entry's
    // general-purpose "data descriptor follows" bit, which zeroes those fields in the LOCAL header
    // alone, so trusting the local header (as this route used to) would reject every real bundle.
    // Real (measured, not declared) per-entry and total decompressed sizes, compression ratio, path
    // traversal, symlinks, and each entry's real CRC-32 are all checked as its data actually streams
    // through, before any member is handed to the shared validator — see bundle/bounded-zip.ts.
    const zipResult = await readBoundedZip(storage, zipKey, meta.size, DEFAULT_BOUNDED_ZIP_LIMITS);
    if (!zipResult.ok) {
      return reject(zipResult.issues);
    }

    // The shared, vendored validator (contract §2/G7): schema, member allow-list by content sniff,
    // duplicate/shared-image checks, link safety, sourceText opt-in — same code the CLI runs.
    const validation = await validateBundle(zipResult.files);
    if (!validation.ok) {
      return reject(validation.errors);
    }

    let queued = false;
    if (queue) {
      await queue.send({
        projectId: project,
        versionId: version,
        buildId,
        zipKey,
        format: 'scf',
        timestamp: Date.now(),
        trace: currentTraceContext(),
      });
      queued = true;
    }

    const queuedStatus: BuildProcessingStatus = 'queued';
    if (firestore.updateProcessingStatus) {
      await firestore.updateProcessingStatus(project, buildId, queuedStatus);
    } else {
      await firestore.updateBuild(project, buildId, { processingStatus: queuedStatus });
    }

    return c.json(
      {
        success: true,
        message: queued ? 'Bundle validated and processing queued' : 'Bundle validated (no processing queue configured)',
        queued,
        buildId,
        buildNumber: build.buildNumber,
        ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
      },
      200
    );
  } catch (error) {
    console.error('Bundle complete error:', error);
    return c.json(
      { error: `Bundle complete failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      500
    );
  }
});

// Presigned URL route
const presignedUrlRoute = createRoute({
  method: 'post',
  path: '/presigned-url/:project/:version/:filename',
  request: {
    params: ProjectVersionFilenameParamsSchema,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            contentType: z.string().optional(),
            // Validated in the handler, not here: an invalid block must not
            // fail the upload, only go unstored (and counted).
            ciTimings: z.unknown().optional().openapi({
              description: 'Pre-upload CI timings from the deployer (storybook-preview-ci-runtime). Optional; stored on the build as ciTimings.',
            }),
          })
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Presigned URL data with build tracking',
      content: {
        'application/json': {
          schema: PresignedUrlResponseSchema
        }
      }
    },
    401: {
      description: 'Unauthorized - Invalid or missing API key',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema
        }
      }
    },
    403: {
      description: 'Forbidden - API key does not belong to the requested project',
      content: {
        'application/json': {
          schema: AuthErrorResponseSchema
        }
      }
    }
  }
});

app.openapi(presignedUrlRoute, async (c) => {
  const storage = c.var.storage;
  const firestore = c.var.firestore;
  const { project, version, filename } = c.req.valid('param');
  
  let contentType = 'application/octet-stream';
  let ciTimingsInput: unknown;
  
  try {
    const body = await c.req.json();
    contentType = body.contentType || contentType;
    ciTimingsInput = body?.ciTimings;
  } catch (e) {
    // If no JSON body, use default content type
  }

  console.log(`[INFO] Presigned URL request: project=${project}, version=${version}, filename=${filename}, contentType=${contentType}`);

  const key = `${project}/${version}/${filename}`;

  const data = await storage.getPresignedUploadUrl(key, contentType);

  // Only create Firestore build record for ZIP files (primary build artifact)
  // Coverage and other supplementary files should not create new builds
  const isZipFile = filename.toLowerCase().endsWith('.zip');
  console.log(`[INFO] Presigned URL build tracking: firestore=${Boolean(firestore)}, isZip=${isZipFile}`);
  let buildId: string | undefined;
  let buildNumber: number | undefined;
  
  if (firestore && isZipFile) {
    try {
      // Construct the URL that will be available after upload
      const zipUrl = data.url.split('?')[0]; // Remove query parameters to get the base URL
      
      const ciParsed = parseCiTimings(ciTimingsInput);
      const ciTimings: CiTimings | undefined = ciParsed.status === 'ok' ? ciParsed.ciTimings : undefined;

      console.log(`[INFO] Creating build for presigned upload: project=${project}, version=${version}, zipUrl=${zipUrl}`);
      const build = await firestore.createBuild(project, {
        versionId: version,
        zipUrl: zipUrl,
        ...uploadedBy(c.var.authenticatedApiKey),
        ...(ciTimings ? { ciTimings } : {}),
      });
      buildId = build.id;
      buildNumber = build.buildNumber;
      
      console.log(`[INFO] Build record created for presigned upload: ID=${buildId}, Number=${buildNumber}`);
      logCiTimings('presigned-url', { project, version, buildNumber }, ciParsed);

      // Opens the funnel (playbook §5.5). This is the route the deployer
      // actually uses — the emitter was first added only to POST /upload, a
      // direct multipart path nothing in the real flow takes, so the event never
      // fired despite being deployed. The PMF tracker caught it by noticing
      // builds that were processed and indexed with no upload recorded: a
      // contradiction rather than a drop-off.
      void firestore.trackEvent?.('storybook_uploaded', {
        projectId: project,
        buildId,
        buildNumber,
        versionId: version,
        ...ciEventFields(ciTimings),
      });
    } catch (firestoreError) {
      // Log error but don't fail the presigned URL generation
      console.error('Firestore error (presigned URL succeeded):', firestoreError);
    }
  }

  // Format response to match test expectations and include build data
  return c.json({
    url: data.url,
    fields: {
      key: data.key
    },
    ...(buildId && { buildId }),
    ...(buildNumber !== undefined && { buildNumber })
  }, 200);
});

// Cleanup route
const cleanupRoute = createRoute({
  method: 'delete',
  path: '/cleanup/:project/:version',
  request: {
    params: ProjectVersionParamsSchema
  },
  responses: {
    200: {
      description: 'Cleanup completed',
      content: {
        'application/json': {
          schema: CleanupResponseSchema
        }
      }
    },
    401: {
      description: 'Unauthorized cleanup request',
      content: {
        'application/json': {
          schema: ErrorResponseSchema
        }
      }
    },
    404: {
      description: 'Cleanup endpoint disabled',
      content: {
        'application/json': {
          schema: ErrorResponseSchema
        }
      }
    }
  }
});

app.openapi(cleanupRoute, async (c) => {
  const configuredCleanupToken = c.var.cleanupToken;
  if (!configuredCleanupToken) {
    return c.json({ error: 'Cleanup endpoint is disabled' }, 404);
  }

  const cleanupHeader = c.req.header('X-Cleanup-Token') || '';
  if (!constantTimeEquals(cleanupHeader, configuredCleanupToken)) {
    return c.json({ error: 'Unauthorized cleanup request' }, 401);
  }

  const storage = c.var.storage;
  const { project, version } = c.req.valid('param');
  const prefix = `${project}/${version}/`;

  await storage.deleteByPrefix(prefix);

  return c.json({ message: 'Cleanup completed' }, 200);
});

// ============= IMAGE UPLOAD ROUTES =============

const ImageUploadInitResponseSchema = z.object({
  success: z.boolean(),
  uploadId: z.string(),
  uploadNumber: z.number(),
  presignedUrl: z.string(),
  zipKey: z.string(),
});

const ImageUploadCompleteResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  queued: z.boolean(),
});

const ProjectParamSchema = z.object({
  project: z.string().min(1).regex(PROJECT_SEGMENT_REGEX, 'Project name must contain only alphanumeric characters, hyphens, and underscores').openapi({ example: 'my-project' }),
});

const ImageUploadCompleteBodySchema = z.object({
  uploadId: z.string().min(1, 'uploadId is required'),
  zipKey: z.string().min(1, 'zipKey is required'),
});

// POST /upload-images/:project — Initialize upload, create Firestore record, return presigned URL
const imageUploadInitRoute = createRoute({
  method: 'post',
  path: '/upload-images/:project',
  request: {
    params: ProjectParamSchema,
  },
  responses: {
    201: {
      description: 'Upload initialized with presigned URL',
      content: {
        'application/json': {
          schema: ImageUploadInitResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request',
      content: {
        'application/json': { schema: ErrorResponseSchema },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': { schema: ErrorResponseSchema },
      },
    },
  },
});

app.openapi(imageUploadInitRoute, async (c) => {
  try {
    const { project } = c.req.valid('param');
    const storage = c.var.storage;
    const firestore = c.var.firestore;

    if (!firestore) {
      return c.json({ error: 'Firestore not configured' }, 500);
    }

    // Parse optional body for image count
    let imageCount = 0;
    try {
      const body = await c.req.json();
      imageCount = body.imageCount || 0;
    } catch {
      // No body is ok
    }

    // Create upload record in Firestore
    const upload = await firestore.createUpload(project, {
      imageCount,
      zipUrl: '', // Will be set after upload
    });

    // Generate presigned URL for ZIP upload
    const zipKey = `${project}/uploads/${upload.uploadNumber}/images.zip`;
    const presignedData = await storage.getPresignedUploadUrl(zipKey, 'application/zip');

    return c.json(
      {
        success: true,
        uploadId: upload.id,
        uploadNumber: upload.uploadNumber,
        presignedUrl: presignedData.url,
        zipKey,
      },
      201
    );
  } catch (error) {
    console.error('Image upload init error:', error);
    return c.json(
      { error: `Upload initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      500
    );
  }
});

// POST /upload-images/:project/complete — Signal upload complete, enqueue for processing
const imageUploadCompleteRoute = createRoute({
  method: 'post',
  path: '/upload-images/:project/complete',
  request: {
    params: ProjectParamSchema,
    body: {
      content: {
        'application/json': {
          schema: ImageUploadCompleteBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Upload queued for processing',
      content: {
        'application/json': {
          schema: ImageUploadCompleteResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request',
      content: {
        'application/json': { schema: ErrorResponseSchema },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': { schema: ErrorResponseSchema },
      },
    },
  },
});

app.openapi(imageUploadCompleteRoute, async (c) => {
  try {
    const { project } = c.req.valid('param');
    const firestore = c.var.firestore;
    const queue = c.var.processingQueue;

    if (!firestore) {
      return c.json({ error: 'Firestore not configured' }, 500);
    }

    const { uploadId, zipKey } = c.req.valid('json');

    // Update upload status to queued
    await firestore.updateUploadProcessingStatus(project, uploadId, 'queued');

    // Enqueue for worker processing
    let queued = false;
    if (queue) {
      await queue.send({
        type: 'upload',
        projectId: project,
        uploadId,
        zipKey,
        timestamp: Date.now(),
        trace: currentTraceContext(),
      });
      queued = true;
    }

    return c.json({
      success: true,
      message: queued ? 'Upload queued for processing' : 'Upload recorded (no processing queue configured)',
      queued,
    }, 200);
  } catch (error) {
    console.error('Image upload complete error:', error);
    return c.json(
      { error: `Upload completion failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      500
    );
  }
});

// Serve OpenAPI spec
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Storybook Upload Service API',
    version: '1.0.0',
    description: 'A portable Storybook upload service for Cloudflare Workers and Node.js'
  }
});

// Serve interactive docs with Swagger UI
app.get('/docs', swaggerUI({
  url: '/openapi.json'
}));

// Export the app instance to be used by the entry points.
export { app };

// Export the type for use in route definitions.
export type ApiRoutes = typeof app;
