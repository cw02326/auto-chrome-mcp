/**
 * 시험 실행 전용 임시 탭 (2026-09-05 사이드패널 1단계 A).
 *
 * 시험 실행은 사용자가 보고 있는 화면을 빼앗으면 안 된다. 그래서 백그라운드 탭을 직접 열고
 * 그 id 를 실행에 고정한 뒤, **어떤 경로로 끝나든** 그 탭을 닫는다. 탭 정리를 화면 컴포넌트
 * 안에 두면 실패 경로마다 빠뜨리기 쉬워 여기로 뺐다 (의존성을 주입받으므로 단위 테스트에서
 * 탭 생성 실패·실행 실패 양쪽을 그대로 재현할 수 있다).
 */

import type { RunSummary } from './rr-messages';

export interface TemporaryTabRunDeps {
  /** 백그라운드 탭을 연다. 열지 못하면 예외를 던지거나 id 없는 탭을 돌려준다. */
  createTab: (url: string) => Promise<{ id?: number }>;
  /** 문서를 다 읽을 때까지 기다린다. 못 기다려도 실행은 진행한다. */
  waitForTab?: (tabId: number) => Promise<void>;
  /** 그 탭에 고정해 흐름을 실행한다. */
  runFlow: (tabId: number) => Promise<RunSummary>;
  /** 실행이 끝나면 탭을 닫는다. 실패해도 무시한다(흐름이 이미 닫았을 수 있다). */
  removeTab: (tabId: number) => Promise<void>;
}

export interface TemporaryTabRunResult {
  ok: boolean;
  result?: RunSummary;
  /** 실패 사유. 탭을 열지 못했거나 실행이 예외로 끝난 경우다. */
  error?: string;
  /** 열었다가 닫은 탭 id. 탭을 못 열었으면 undefined. */
  tabId?: number;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 새 백그라운드 탭에서 흐름을 한 번 돌리고 탭을 정리한다.
 *
 * 예외를 밖으로 던지지 않는다. 화면은 `ok` 와 `error` 만 보고 결과를 그리면 된다.
 */
export async function runFlowInTemporaryTab(
  deps: TemporaryTabRunDeps,
  url: string,
): Promise<TemporaryTabRunResult> {
  let tabId: number | undefined;
  try {
    const tab = await deps.createTab(url);
    tabId = typeof tab?.id === 'number' ? tab.id : undefined;
    if (typeof tabId !== 'number') {
      // 탭을 못 열었으면 닫을 것도 없다. 여기서 removeTab 을 부르면 남의 탭을 닫는다.
      return { ok: false, error: 'could not open a background tab' };
    }
    if (deps.waitForTab) await deps.waitForTab(tabId);
    const result = await deps.runFlow(tabId);
    return { ok: result.success === true, result, tabId };
  } catch (e) {
    return { ok: false, error: messageOf(e), tabId };
  } finally {
    if (typeof tabId === 'number') {
      try {
        await deps.removeTab(tabId);
      } catch {
        // 흐름이 이미 닫았을 수 있다.
      }
    }
  }
}
