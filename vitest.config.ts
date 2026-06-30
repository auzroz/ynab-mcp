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
      // Enforced gate — current coverage is ~94% lines / ~84% branches.
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
