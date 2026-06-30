import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'dist',
        'tests',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**'
      ],
      // Vitest 1.x expects the thresholds flat (the old `thresholds.global.*`
      // nesting is silently ignored, which let coverage regress unchecked).
      // These are an enforced FLOOR set just under current real coverage so the
      // gate actually fails on regressions; ratchet them up as tool-handler
      // tests are added (services/utils are already well covered).
      thresholds: {
        branches: 70,
        functions: 40,
        lines: 15,
        statements: 15
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
