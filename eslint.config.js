import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { fileURLToPath } from 'url';
import path from 'path';

// Fallback for import.meta.dirname on older Node 20.x versions
const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Allow explicit any in specific cases (e.g., error handling)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Enforce consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],

      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // No floating promises
      '@typescript-eslint/no-floating-promises': 'off',

      // Require await for async functions
      '@typescript-eslint/require-await': 'off',

      // Allow deprecated APIs (we know what we're using)
      '@typescript-eslint/no-deprecated': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.*'],
  }
);
