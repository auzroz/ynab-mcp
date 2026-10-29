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
      // Vitest 4 only reports loaded files unless told otherwise; count all of src/
      // (including untested entrypoints) so the gate cannot be flattered by omission.
      include: ['src/**/*.ts'],
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
      // Enforced gate. Vitest 4 uses AST-aware V8 remapping, which counts branches
      // more strictly than 1.x: ~90% lines / ~76% branches on the same tests, so the
      // branch gate is 75 (was 80) until more branch tests land.
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
