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
  CreateBuildData,
  CreateUploadData,
} from './services/firestore/firestore.types.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import { apiKeyAuth, type AuthVariables } from './middleware/auth.js';
import { extractGitContext, normalizeCoverageInput } from './coverage/coverage.js';
import { parseMultipartFormData } from './utils/multipart.js';

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
      try {
        const buildData: CreateBuildData = {
          versionId: version,
          zipUrl: result.url,
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

        // Opens the funnel (playbook §5.5): uploaded -> processed -> indexed ->
        // searched. Not awaited, and trackEvent swallows its own errors — an
        // upload that succeeded must not fail because analytics did not land.
        void firestore.trackEvent?.('storybook_uploaded', {
          projectId: project,
          buildId,
          buildNumber,
          versionId: version,
        });

        // Enqueue build for async processing (LLM inspection, embeddings, vector DB)
        const processingQueue = c.get('processingQueue');
        if (processingQueue && buildId) {
          try {
            await processingQueue.send({
              projectId: project,
              versionId: version,
              buildId,
              zipKey: key,
              timestamp: Date.now(),
              // Carries the trace across the queue; see src/trace-context.ts.
              trace: currentTraceContext(),
            });
            console.log(`[INFO] Build queued for processing: buildId=${buildId}`);
          } catch (queueError) {
            // Log error but don't fail the upload
            console.error('Queue error (upload succeeded):', queueError);
          }
        }
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
            contentType: z.string().optional()
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
  
  try {
    const body = await c.req.json();
    contentType = body.contentType || contentType;
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
      
      console.log(`[INFO] Creating build for presigned upload: project=${project}, version=${version}, zipUrl=${zipUrl}`);
      const build = await firestore.createBuild(project, {
        versionId: version,
        zipUrl: zipUrl
      });
      buildId = build.id;
      buildNumber = build.buildNumber;
      
      console.log(`[INFO] Build record created for presigned upload: ID=${buildId}, Number=${buildNumber}`);

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
