import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  apiKeyAuth,
  isAuthenticated,
  getAuthenticatedApiKey,
  reportKeyTouchFailure,
  resetKeyTouchReportGate,
  TOUCH_REPORT_WINDOW_MS,
} from './auth.js';
import * as logLib from '../lib/log.js';
import type { ApiKeyService } from '../services/apikey/apikey.service.js';
import type { ValidateApiKeyResult } from '../services/apikey/apikey.types.js';

vi.mock('../lib/log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/log.js')>();
  return { ...actual, reportError: vi.fn(), logWarn: vi.fn() };
});

// Mock API Key Service
const createMockApiKeyService = (validateResult: ValidateApiKeyResult): ApiKeyService => ({
  createApiKey: vi.fn(),
  validateApiKey: vi.fn().mockResolvedValue(validateResult),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined),
});

describe('Auth Middleware', () => {
  let app: Hono<{
    Variables: {
      apiKeyService?: ApiKeyService;
      authenticatedApiKey?: {
        id: string;
        name: string;
        prefix: string;
        projectId: string;
      };
    };
  }>;

  beforeEach(() => {
    app = new Hono();
  });

  describe('apiKeyAuth middleware', () => {
    it('should skip authentication if apiKeyService is not configured', async () => {
      app.use('*', apiKeyAuth());
      app.get('/test', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('success');
    });

    it('should return 401 if X-API-Key header is missing', async () => {
      const mockService = createMockApiKeyService({ valid: false });

      app.use('*', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('*', apiKeyAuth());
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/my-project');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Authentication required');
    });

    it('should return 401 for invalid API key format', async () => {
      const mockService = createMockApiKeyService({ valid: false });

      app.use('*', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('*', apiKeyAuth());
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'invalid-key-format' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid API key format');
    });

    it('should return 403 if API key project does not match route project', async () => {
      const mockService = createMockApiKeyService({ valid: true });

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth());
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/different-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Project mismatch');
      // validateApiKey should NOT be called since we return early
      expect(mockService.validateApiKey).not.toHaveBeenCalled();
    });

    it('should return 401 if API key validation fails', async () => {
      const mockService = createMockApiKeyService({
        valid: false,
        error: 'Invalid or revoked API key',
      });

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth());
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid API key');
    });

    it('should allow request with valid API key', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_my',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth());
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('success');
    });

    it('should set authenticated context for valid API key', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_my',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      let authenticatedContext: any = null;

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth());
      app.get('/test/:project', (c) => {
        authenticatedContext = c.var.authenticatedApiKey;
        return c.json({ message: 'success' });
      });

      await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });

      expect(authenticatedContext).toBeDefined();
      expect(authenticatedContext.id).toBe('key-123');
      expect(authenticatedContext.name).toBe('Test Key');
      expect(authenticatedContext.projectId).toBe('my-project');
    });

    it('should call updateLastUsed when trackUsage is enabled', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_my',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth({ trackUsage: true }));
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });

      // Wait for fire-and-forget call
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockService.updateLastUsed).toHaveBeenCalledWith('my-project', 'key-123');
    });

    it('should skip authentication with optional: true and no API key', async () => {
      const mockService = createMockApiKeyService({ valid: false });

      app.use('*', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('*', apiKeyAuth({ optional: true }));
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/my-project');
      expect(res.status).toBe(200);
    });

    it('should use custom header name when specified', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_my',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth({ headerName: 'Authorization' }));
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      const res = await app.request('/test/my-project', {
        headers: { Authorization: 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });
      expect(res.status).toBe(200);
    });

    it('should skip project validation when validateProjectMatch is false', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_pr',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth({ validateProjectMatch: false }));
      app.get('/test/:project', (c) => c.json({ message: 'success' }));

      // Key is for 'project-a' but route is 'project-b'
      const res = await app.request('/test/project-b', {
        headers: { 'X-API-Key': 'scry_proj_project-a_abcdefghijklmnopqrstuvwxyz123456' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('helper functions', () => {
    it('isAuthenticated should return true when authenticated', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_my',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      let authResult: boolean = false;

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth());
      app.get('/test/:project', (c) => {
        authResult = isAuthenticated(c as any);
        return c.json({ message: 'success' });
      });

      await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });

      expect(authResult).toBe(true);
    });

    it('getAuthenticatedApiKey should return key info when authenticated', async () => {
      const mockService = createMockApiKeyService({
        valid: true,
        apiKey: {
          id: 'key-123',
          name: 'Test Key',
          prefix: 'scry_proj_my',
          status: 'active',
          createdAt: new Date(),
          createdBy: 'user-123',
        },
      });

      let keyInfo: any = null;

      app.use('/test/:project', async (c, next) => {
        c.set('apiKeyService', mockService);
        await next();
      });
      app.use('/test/:project', apiKeyAuth());
      app.get('/test/:project', (c) => {
        keyInfo = getAuthenticatedApiKey(c as any);
        return c.json({ message: 'success' });
      });

      await app.request('/test/my-project', {
        headers: { 'X-API-Key': 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456' },
      });

      expect(keyInfo).toBeDefined();
      expect(keyInfo.id).toBe('key-123');
      expect(keyInfo.name).toBe('Test Key');
    });
  });
});
describe('reportKeyTouchFailure (Sentry throttle)', () => {
  beforeEach(() => {
    resetKeyTouchReportGate();
    vi.mocked(logLib.reportError).mockClear();
    vi.mocked(logLib.logWarn).mockClear();
  });

  it('logs every failure but reports to Sentry once per window (fake clock)', () => {
    let t = 1_000_000;
    const now = () => t;
    const err = new Error('firestore down');

    reportKeyTouchFailure(undefined, err, now);
    t += 1000;
    reportKeyTouchFailure(undefined, err, now);
    t += TOUCH_REPORT_WINDOW_MS - 2000; // still inside the window of the first report
    reportKeyTouchFailure(undefined, err, now);

    expect(logLib.reportError).toHaveBeenCalledTimes(1);
    expect(logLib.logWarn).toHaveBeenCalledTimes(2);

    t += 2000; // window has elapsed since the first report
    reportKeyTouchFailure(undefined, err, now);
    expect(logLib.reportError).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logLib.reportError).mock.calls[1][3]).toBe('apikey_touch_failed');
  });
});
