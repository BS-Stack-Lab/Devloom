import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'vendor/**',
      '.tools/**',
      'design/**',
      'p0-spike/**',
      '**/dist/**',
      '**/target/**',
      'node_modules/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
