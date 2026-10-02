module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  env: { browser: true, node: true, es2022: true },
  extends: ['eslint:recommended'],
  rules: { 'no-undef': 'off', 'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  overrides: [{
    files: ['packages/core/src/model/**/*.ts', 'packages/core/src/command/**/*.ts', 'packages/core/src/geometry/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['three', 'react', '../render/*', '../session/*'] }] },
  }],
};
