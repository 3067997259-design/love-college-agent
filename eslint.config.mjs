import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**', '.local-data/**', '.cache/**', 'test-results/**', 'playwright-report/**',
    // 定稿时留下的美术处理脚本是当时的记录，不再改动；仍在用的工具放在 art/tools
    'art/retouch/**', 'art/film-frozen/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // 用 Electron 跑的美术工具脚本是 CommonJS
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/clock/**'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'Date', message: 'Read time and format dates through the injected clock.' },
        { name: 'setTimeout', message: 'Schedule through the injected clock.' },
        { name: 'setInterval', message: 'Schedule through the injected clock.' },
      ],
      'no-restricted-properties': ['error', ...['globalThis', 'window', 'self'].flatMap((object) =>
        ['Date', 'setTimeout', 'setInterval'].map((property) => ({ object, property, message: 'Use the injected clock.' })))],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron', 'better-sqlite3', 'imapflow', 'mailparser', '**/main/**', '**/preload/**'] }],
    },
  },
)
