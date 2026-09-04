/**
 * auto-chrome-mcp fork: 산출물 경로 헬퍼 단위 테스트.
 *
 * 지키는 것 셋.
 *  1. 모든 산출물은 `mcp-screenshots/YYYY-MM-DD/` 안에 들어간다 (다운로드 폴더 루트 오염 금지).
 *  2. 사용자가 준 이름이 무엇이든 그 폴더 밖으로 나갈 수 없다 (basename 만 쓴다).
 *  3. 날짜·시각은 로컬 시간이다 — 브리지의 자동 정리가 같은 로컬 날짜로 판정하기 때문에
 *     여기서 UTC 를 쓰면 자정 근처 폴더가 하루 어긋나 잘못 보관된다.
 */
import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_ROOT,
  artifactDateFolder,
  artifactFilename,
  artifactTimeSuffix,
} from '../../utils/artifact-path';

// 2026-09-05 14:07:09 로컬
const NOW = new Date(2026, 8, 5, 14, 7, 9);

describe('artifactDateFolder / artifactTimeSuffix', () => {
  it('로컬 날짜와 시각을 0 채움으로 만든다', () => {
    expect(artifactDateFolder(NOW)).toBe('2026-09-05');
    expect(artifactTimeSuffix(NOW)).toBe('140709');
    expect(artifactDateFolder(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(artifactTimeSuffix(new Date(2026, 0, 1, 0, 0, 0))).toBe('000000');
  });

  it('UTC 가 아니라 로컬 시간을 쓴다', () => {
    // 로컬 자정 직후는 UTC 기준으로 전날일 수 있다. 폴더는 로컬 날짜여야 한다.
    const justAfterMidnight = new Date(2026, 8, 5, 0, 30, 0);
    expect(artifactDateFolder(justAfterMidnight)).toBe('2026-09-05');
  });
});

describe('artifactFilename', () => {
  it('kind, 이름, 시각, 확장자를 규칙대로 잇는다', () => {
    expect(artifactFilename('screenshot', 'login', 'png', NOW)).toBe(
      'mcp-screenshots/2026-09-05/screenshot_login_140709.png',
    );
  });

  it('이름이 없으면 kind 와 시각만 남는다', () => {
    expect(artifactFilename('gif', undefined, 'gif', NOW)).toBe(
      'mcp-screenshots/2026-09-05/gif_140709.gif',
    );
    expect(artifactFilename('gif', '   ', 'gif', NOW)).toBe(
      'mcp-screenshots/2026-09-05/gif_140709.gif',
    );
  });

  it('경로 구분자가 들어와도 마지막 조각만 쓴다 (루트 밖으로 못 나간다)', () => {
    const cases = [
      '../../../evil',
      '..\\..\\evil',
      '/etc/passwd',
      'C:/Windows/System32/evil',
      'sub/dir/shot',
      '....//evil',
    ];
    for (const raw of cases) {
      const out = artifactFilename('screenshot', raw, 'png', NOW);
      expect(out.startsWith(`${ARTIFACT_ROOT}/2026-09-05/`)).toBe(true);
      expect(out.split('/')).toHaveLength(3);
      expect(out).not.toContain('..');
    }
  });

  it('허용되지 않는 문자는 밑줄로 바꾸고 길이를 자른다', () => {
    expect(artifactFilename('screenshot', '보고서 v2!', 'png', NOW)).toBe(
      'mcp-screenshots/2026-09-05/screenshot_v2_140709.png',
    );
    const long = 'a'.repeat(200);
    const out = artifactFilename('pdf', long, 'pdf', NOW);
    expect(out).toBe(`mcp-screenshots/2026-09-05/pdf_${'a'.repeat(60)}_140709.pdf`);
  });

  it('이름에 같은 확장자가 이미 붙어 있으면 두 번 붙이지 않는다', () => {
    expect(artifactFilename('gif', 'demo.gif', 'gif', NOW)).toBe(
      'mcp-screenshots/2026-09-05/gif_demo_140709.gif',
    );
    expect(artifactFilename('pdf', 'notice.pdf', '.pdf', NOW)).toBe(
      'mcp-screenshots/2026-09-05/pdf_notice_140709.pdf',
    );
  });

  it('이름이 kind 와 같으면 한 번만 쓴다', () => {
    expect(artifactFilename('screenshot', 'screenshot', 'png', NOW)).toBe(
      'mcp-screenshots/2026-09-05/screenshot_140709.png',
    );
  });

  it('확장자는 점·대문자·금지문자를 정리한다', () => {
    expect(artifactFilename('trace', 'run', '.JSON', NOW)).toBe(
      'mcp-screenshots/2026-09-05/trace_run_140709.json',
    );
    expect(artifactFilename('trace', 'run', '', NOW)).toBe(
      'mcp-screenshots/2026-09-05/trace_run_140709.bin',
    );
  });
});
