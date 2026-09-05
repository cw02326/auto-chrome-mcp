/**
 * 가져오기 미리보기 (2026-09-05 사이드패널 2단계 E).
 *
 * 확인하려는 것.
 *   1. 미리보기 요약이 흐름 수·충돌 수·단계 합을 센다.
 *   2. 충돌이 있으면 기본 모드가 복사다 (덮어쓰기는 되돌릴 수 없어 기본값이 되면 안 된다).
 *   3. 충돌 표시가 한 줄 설명에 들어간다.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_BYTES,
  defaultImportMode,
  describePreviewFlow,
  isEmptyPreview,
  isTooLarge,
  maxImportSizeLabel,
  summarizeImportPreview,
  type ImportPreviewFlow,
} from '@/entrypoints/sidepanel/utils/import-flow';

function t(key: string, subs?: string[]): string {
  return subs && subs.length > 0 ? `${key}(${subs.join('|')})` : key;
}

const clean: ImportPreviewFlow[] = [
  { id: 'f1', name: '주문 확인', stepCount: 6, conflict: false },
  { id: 'f2', name: '재고 확인', stepCount: 4, conflict: false },
];

const conflicting: ImportPreviewFlow[] = [
  { id: 'f1', name: '주문 확인', stepCount: 6, conflict: true },
  { id: 'f3', name: '새 흐름', stepCount: 2, conflict: false },
];

describe('import-flow', () => {
  it('요약이 흐름 수·충돌 수·단계 합을 센다', () => {
    expect(summarizeImportPreview(conflicting)).toEqual({
      total: 2,
      conflicts: 1,
      steps: 8,
      hasConflict: true,
    });
  });

  it('충돌이 없으면 파일에 적힌 id 그대로 넣는다', () => {
    expect(summarizeImportPreview(clean).hasConflict).toBe(false);
    expect(defaultImportMode(clean)).toBe('overwrite');
  });

  it('충돌이 있으면 기본은 복사다', () => {
    expect(defaultImportMode(conflicting)).toBe('copy');
  });

  it('빈 미리보기를 가려낸다', () => {
    expect(isEmptyPreview([])).toBe(true);
    expect(isEmptyPreview(null)).toBe(true);
    expect(isEmptyPreview(clean)).toBe(false);
  });

  it('한 줄 설명에 단계 수와 충돌 여부가 들어간다', () => {
    expect(describePreviewFlow(clean[0], t)).toBe('sidepanel_daily_import_steps(6)');
    expect(describePreviewFlow(conflicting[0], t)).toBe(
      'sidepanel_daily_import_steps(6) · sidepanel_daily_import_conflict',
    );
  });
});

describe('import-flow 파일 크기 상한', () => {
  it('상한을 넘는 파일은 읽기 전에 막는다', () => {
    expect(isTooLarge(MAX_IMPORT_BYTES + 1)).toBe(true);
    expect(isTooLarge(MAX_IMPORT_BYTES)).toBe(false);
    expect(isTooLarge(1024)).toBe(false);
  });

  it('크기를 모르면 막지 않는다', () => {
    expect(isTooLarge(undefined)).toBe(false);
  });

  it('상한을 문구에 넣을 수 있다', () => {
    expect(maxImportSizeLabel()).toBe('5');
  });
});
