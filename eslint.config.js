import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'generated/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-new-func': 'off', // ScriptChecker compiles scripts with the Function constructor on purpose
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
];
