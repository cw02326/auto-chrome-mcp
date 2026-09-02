// jest config — auto-chrome-mcp fork policy:
// - coverageThreshold removed (upstream 의 80% global threshold 가 회귀 통합 테스트
//   추가만으로는 못 채워서 PR 흡수 검증을 차단함). 우리는 회귀 충실성 우선,
//   coverage 는 측정만 (CI 의 self-test.yml 에서 report 만 출력).
// - regression 통합 테스트는 src/**/regression/**/*.test.ts 패턴으로 모음.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/scripts/**/*'],
  coverageDirectory: 'coverage',
  // coverageThreshold 제거 — 회귀 충실성 우선, coverage 보고만.

  // ts-jest .js extension resolution (NodeNext / ESM 호환):
  // src 의 코드가 '../constant/index.js' 식으로 import 하면 ts-jest 가 .ts 로 resolve 못함.
  // baseline server.test.ts 가 이 이유로 항상 fail 이었던 걸 우리 fork 에서 fix.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
