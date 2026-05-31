import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.strictTypeChecked,
  ...ts.configs.stylisticTypeChecked,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte', '.svelte.ts'],
      },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: ts.parser },
    },
  },
  {
    files: ['**/*.svelte.ts'],
    languageOptions: { parser: ts.parser },
  },
  {
    rules: {
      // Ban any
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // TypeScript handles undefined globals; ESLint's no-undef doesn't understand TS types
      'no-undef': 'off',

      // no-non-null-assertion is stricter; non-nullable-type-assertion-style conflicts with it
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',

      // noUncheckedIndexedAccess makes all array access return T | undefined; using ! for
      // bounds-checked loops is the idiomatic fix and much cleaner than adding guards everywhere.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    ignores: ['src/wasm/**', 'dist/**', 'node_modules/**'],
  },
);
