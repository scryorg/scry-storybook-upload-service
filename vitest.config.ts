import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Increase timeout for e2e tests
    testTimeout: 60000,
    hookTimeout: 30000,
    
    // Use fewer workers to reduce process management issues
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        // v8 coverage aggregation can be flaky with multiple forks in CI;
        // keep this single-process for stable coverage generation.
        maxForks: 1,
      }
    },
    
    // Sequential execution for e2e tests to avoid conflicts
    fileParallelism: false,
    
    // Better error handling
    bail: 1,
    
    // Environment-specific configurations
    environment: 'node',
    
    // Reporters
    reporters: ['default'],
    
    // Include only unit tests by default, exclude e2e
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    
    // Exclude patterns
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/e2e/**', // Exclude e2e tests from regular test runs
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*'
    ],

    // Running tests sequentially improves stability for v8 coverage file merging.
    // (Vitest will still run test files in parallel unless constrained.)
    maxConcurrency: 1,
    
    // Global setup/teardown
    globalSetup: [],
    
    // Retry failed tests once
    retry: 1,
    
    // Graceful shutdown
    teardownTimeout: 10000,
    
    // Better logging for debugging
    logHeapUsage: true,
    
    // Coverage configuration
    coverage: {
      // Enable coverage collection
      enabled: false, // Enable via CLI with --coverage flag
      
      // Coverage provider (v8 is faster, istanbul has more features)
      provider: 'v8',
      
      // Output directory for coverage reports
      reportsDirectory: './coverage',
      
      // Report formats
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'html', 'lcov'],
      
      // Files to include in coverage
      include: ['src/**/*.ts'],
      
      // Files to exclude from coverage
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-support.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        // Pure type/interface modules (no runtime behavior)
        'src/**/*.types.ts',
        'src/**/*.service.ts',
        // Platform-specific implementations are exercised in their own target env
        'src/**/*.node.ts',
        // Barrel files typically have no meaningful executable logic
        'src/**/index.ts',
        'src/entry.*.ts', // Entry points are thin wrappers
        '**/node_modules/**',
      ],
      
      // Coverage thresholds (fail if below these values)
      thresholds: {
        statements: 70, 
        branches: 60,
        functions: 70,
        lines: 70,
      },
      
      // Clean coverage results before running tests
      clean: true,
      
      // Skip full coverage report if thresholds are met
      skipFull: false,
    },
  },
});
