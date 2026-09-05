// engine/policies/retry.ts — unified retry/backoff policy

import { sleepWithSignal } from '@/utils/tool-watchdog';

export type BackoffKind = 'none' | 'exp';

export interface RetryOptions {
  count?: number; // max attempts beyond the first run
  intervalMs?: number;
  backoff?: BackoffKind;
  /**
   * 취소 신호. 재시도 간격도 이것을 본다 — 취소된 run 이 백오프를 다 기다린 뒤에야
   * 멈추는 일이 없게 한다 (2026-09-05 Codex 재확인 항목 3).
   */
  signal?: AbortSignal;
}

export async function withRetry<T>(
  run: () => Promise<T>,
  onRetry?: (attempt: number, err: any) => Promise<void> | void,
  opts?: RetryOptions,
): Promise<T> {
  const max = Math.max(0, Number(opts?.count ?? 0));
  const base = Math.max(0, Number(opts?.intervalMs ?? 0));
  const backoff = (opts?.backoff || 'none') as BackoffKind;
  let attempt = 0;
  while (true) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= max) throw e;
      if (onRetry) await onRetry(attempt, e);
      const delay = base > 0 ? (backoff === 'exp' ? base * Math.pow(2, attempt) : base) : 0;
      if (delay > 0) await sleepWithSignal(delay, opts?.signal);
      attempt += 1;
    }
  }
}
