import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores first - these apply to all configurations
  {
    ignores: [
      // flat config 의 무접두 패턴은 **설정 파일 위치 기준**이라, 'dist/' 는 루트 dist 만
      // 걸렀다. 워크스페이스 하위 빌드 산출물이 그대로 lint 대상이 돼, 로컬에서 한 번
      // 빌드하고 나면 `npx eslint .` 이 산출물에서만 9천 건 넘게 뱉었다.
      '**/node_modules/',
      '**/dist/',
      '**/.output/',
      '**/.wxt/',
      // 벤더 번들(onnxruntime 등)과 커밋린트 설정은 우리가 고칠 소스가 아니다.
      // 이것들 때문에 로컬 `npx eslint .` 이 554건을 뱉어 실제 신호가 묻혔다.
      '**/public/libs/**',
      'commitlint.config.cjs',
      'node_modules/',
      'dist/',
      '.output/',
      '.wxt/',
      'logs/',
      '*.log',
      '.cache/',
      '.temp/',
      '.idea/',
      '.DS_Store',
      'Thumbs.db',
      '*.zip',
      '*.tar.gz',
      'stats.html',
      'stats-*.json',
      'pnpm-lock.yaml',
      '**/workers/**',
      'app/**/workers/**',
      'packages/**/workers/**',
      'test-inject-script.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Global rule adjustments
  {
    // Allow intentionally empty catch blocks (common in extension code),
    // while keeping other empty blocks reported.
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['app/**/*.{js,jsx,ts,tsx}', 'packages/**/*.{js,jsx,ts,tsx}'],
    ignores: ['**/workers/**'], // Additional ignores for this specific config
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  eslintConfigPrettier,
);
