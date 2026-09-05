/**
 * 흐름 가져오기 미리보기의 순수 로직 (2026-09-05 사이드패널 2단계 E).
 *
 * 파일을 고르면 백그라운드가 미리보기를 만들어 준다. 화면은 그것을 읽어 "덮어쓸지 복사할지"
 * 를 묻는데, 그 판단과 문구 재료를 여기서 만든다. 충돌이 하나라도 있으면 기본값은 **복사**다.
 * 덮어쓰기는 되돌릴 수 없으므로 사용자가 직접 고르게 한다.
 */

import { getMessage } from '@/utils/i18n';
import type { Translate } from './daily-format';
import type { ImportPreviewEntry } from './daily-messages';

/** 미리보기 한 줄. 이름은 백그라운드 감싸개(D)의 타입을 그대로 쓴다. */
export type ImportPreviewFlow = ImportPreviewEntry;

export type ImportMode = 'copy' | 'overwrite';

/**
 * 가져올 수 있는 파일 크기 상한 (2026-09-05 Codex 리뷰 6항).
 *
 * 흐름 하나는 보통 수십 KB 다. 상한 없이 읽으면 사용자가 실수로 고른 큰 파일을 통째로
 * 메모리에 올린 뒤에야 "흐름이 아니다" 를 알게 된다. 읽기 **전에** 막는다.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** 상한을 넘는가. 넘으면 파일을 읽지 않는다. */
export function isTooLarge(size: number | undefined): boolean {
  return typeof size === 'number' && Number.isFinite(size) && size > MAX_IMPORT_BYTES;
}

/** 상한을 사람이 읽는 단위로 (문구에 넣는다). */
export function maxImportSizeLabel(): string {
  return String(Math.round(MAX_IMPORT_BYTES / (1024 * 1024)));
}

export interface ImportPreviewSummary {
  total: number;
  conflicts: number;
  steps: number;
  /** 하나라도 id 가 겹치는가. */
  hasConflict: boolean;
}

export function summarizeImportPreview(flows: readonly ImportPreviewFlow[]): ImportPreviewSummary {
  const list = Array.isArray(flows) ? flows : [];
  const conflicts = list.filter((f) => f?.conflict === true).length;
  const steps = list.reduce((sum, f) => sum + (Number(f?.stepCount) || 0), 0);
  return { total: list.length, conflicts, steps, hasConflict: conflicts > 0 };
}

/**
 * 기본 모드.
 *
 * 충돌이 있으면 **복사**다. 덮어쓰기는 되돌릴 수 없어 기본값이 되면 안 된다. 충돌이 없으면
 * 새 id 를 만들 이유가 없으므로 파일에 적힌 id 그대로 넣는다(`overwrite`, 덮어쓸 대상이 없다).
 */
export function defaultImportMode(flows: readonly ImportPreviewFlow[]): ImportMode {
  return summarizeImportPreview(flows).hasConflict ? 'copy' : 'overwrite';
}

/** 파일을 읽어 온 JSON 이 흐름을 담고 있는가. */
export function isEmptyPreview(flows: readonly ImportPreviewFlow[] | null | undefined): boolean {
  return !flows || flows.length === 0;
}

/** 미리보기 한 줄의 부가 설명. */
export function describePreviewFlow(flow: ImportPreviewFlow, t: Translate = getMessage): string {
  const steps = t('sidepanel_daily_import_steps', [String(Number(flow?.stepCount) || 0)]);
  if (flow?.conflict) return `${steps} · ${t('sidepanel_daily_import_conflict')}`;
  return steps;
}
