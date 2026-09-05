// rr-utils.ts — shared helpers for record-replay runner
// Note: comments in English

import {
  TOOL_NAMES,
  topoOrder as sharedTopoOrder,
  mapNodeToStep as sharedMapNodeToStep,
} from 'auto-chrome-mcp-shared';
import type { Edge as DagEdge, NodeBase as DagNode, Step } from './types';
import { handleCallTool } from '../tools';
import { createTab as createTabGuarded } from '@/utils/activation-guard';
import { sleepWithSignal } from '@/utils/tool-watchdog';
import { EDGE_LABELS } from 'auto-chrome-mcp-shared';
import {
  RunTabError,
  markRunOwnedTab,
  resolveRunTab,
  runToolArgs,
  setRunTab,
  type RunTabContext,
} from './engine/tab-context';

export function applyAssign(
  target: Record<string, any>,
  source: any,
  assign: Record<string, string>,
) {
  const getByPath = (obj: any, path: string) => {
    try {
      const parts = path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean);
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = (cur as any)[p as any];
      }
      return cur;
    } catch {
      return undefined;
    }
  };
  for (const [k, v] of Object.entries(assign || {})) {
    target[k] = getByPath(source, String(v));
  }
}

export function expandTemplatesDeep<T = any>(value: T, scope: Record<string, any>): T {
  const replaceOne = (s: string) =>
    s.replace(/\{([^}]+)\}/g, (_m, k) => (scope[k] ?? '').toString());
  const walk = (v: any): any => {
    if (v == null) return v;
    if (typeof v === 'string') return replaceOne(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * 취소되면 남은 시간을 기다리지 않고 곧바로 끝나는 sleep (2026-09-05 Codex 재확인 항목 3).
 *
 * 아래 폴링 루프들은 이미 매 바퀴 `signal.aborted` 를 확인한다. 문제는 확인과 확인 사이의
 * 고정 sleep 이었다 — abort 가 와도 그 sleep 이 끝나야 루프가 다시 돌았다. 루프 쪽 계약은
 * 그대로 두려고 던지지 않고 조용히 끝낸다.
 */
async function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleepWithSignal(ms, signal);
  } catch {
    // 취소됐다 — 호출한 루프가 다음 바퀴에서 곧바로 끝난다.
  }
}

/** How long prepareRunTab waits for a navigation it started to settle. */
const PREPARE_TAB_TIMEOUT_MS = 15_000;

/** True for pages a flow can actually drive. */
function isWebUrl(u?: string | null): boolean {
  return !!u && /^(https?:|file:)/i.test(u);
}

/**
 * Wait until the given tab stops loading. Returns early if the tab is gone or
 * was never loading, so this can never block on a mocked or closed tab.
 */
async function waitForTabSettled(
  tabId: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (signal?.aborted) return;
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    if (!tab || tab.status !== 'loading') return;
    if (Date.now() >= deadline) return;
    await sleepOrAbort(100, signal);
  }
}

/**
 * 두 주소가 "이미 그 페이지" 라고 볼 수 있는가 (2026-09-05 Codex 교차 리뷰 6).
 *
 * 파서가 만든 정규형으로 비교하고, 끝 슬래시만 무시한다. 파싱이 안 되는 입력은 원문 비교다.
 */
export function isSameUrlForPrepare(a?: string | null, b?: string | null): boolean {
  const norm = (u?: string | null): string | null => {
    if (typeof u !== 'string') return null;
    const trimmed = u.trim();
    if (!trimmed) return null;
    let canonical = trimmed;
    try {
      canonical = new URL(trimmed).href;
    } catch {
      // 완전한 URL 이 아니면 원문 그대로 비교한다.
    }
    if (canonical.length > 1 && canonical.endsWith('/') && !canonical.endsWith('://')) {
      canonical = canonical.slice(0, -1);
    }
    return canonical;
  };
  const left = norm(a);
  const right = norm(b);
  return left !== null && right !== null && left === right;
}

/**
 * Get the run's tab ready before the first step.
 *
 * Works only on the tab the run was pinned to. Unlike the old ensureTab(), it
 * never queries the active tab and never switches the run onto some other web
 * tab it happens to find: a run without a usable tab fails instead.
 *
 * `tabTarget: 'new'` opens a fresh tab and re-pins the run to it via setRunTab,
 * which is the one sanctioned way for the tab to change here.
 */
export async function prepareRunTab(
  tab: RunTabContext,
  options: {
    tabTarget?: 'current' | 'new';
    startUrl?: string;
    refresh?: boolean;
  } = {},
): Promise<{ tabId: number; url?: string }> {
  // Confirms the pinned tab is still open; throws run_tab_missing otherwise.
  let tabId = await resolveRunTab(tab);
  let current: chrome.tabs.Tab | undefined = await chrome.tabs.get(tabId);

  if (options.tabTarget === 'new') {
    const urlToOpen =
      options.startUrl ||
      (isWebUrl(current?.url) ? (current as chrome.tabs.Tab).url! : 'about:blank');
    // 재생용 탭은 run 창에 백그라운드로 연다 — 사용자의 화면을 빼앗지 않는다.
    const created = await createTabGuarded(
      { url: urlToOpen, active: false, windowId: current?.windowId },
      { reason: 'flow:prepare-new-tab' },
    );
    if (typeof created?.id !== 'number') {
      throw new RunTabError('run_tab_missing', 'Could not open a work tab for this run.');
    }
    // 이 탭은 run 이 만든 것이다. 그래야 이후 스텝이 닫을 수 있고, abort 정리가 치운다.
    markRunOwnedTab(tab, created.id);
    setRunTab(tab, created.id, created.windowId);
    tabId = created.id;
    await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS, tab.signal);
    try {
      current = await chrome.tabs.get(tabId);
    } catch {
      current = undefined;
    }
    return { tabId, url: current?.url ?? (typeof urlToOpen === 'string' ? urlToOpen : undefined) };
  }

  if (options.startUrl) {
    // 이미 그 페이지면 다시 불러오지 않는다 (2026-09-05 Codex 교차 리뷰 6). 도구가 시작
    // URL 로 작업 탭을 방금 열었는데 여기서 또 이동시키면 같은 페이지를 두 번 읽는다.
    // 명시적인 refresh 요청은 아래 분기가 따로 처리한다.
    if (!isSameUrlForPrepare(current?.url, options.startUrl)) {
      await chrome.tabs.update(tabId, { url: options.startUrl });
      await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS, tab.signal);
    } else if (options.refresh) {
      await chrome.tabs.reload?.(tabId);
      await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS, tab.signal);
    }
  } else if (options.refresh && isWebUrl(current?.url)) {
    await chrome.tabs.reload?.(tabId);
    await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS, tab.signal);
  }

  try {
    current = await chrome.tabs.get(tabId);
  } catch {
    current = undefined;
  }
  return { tabId, url: current?.url ?? options.startUrl };
}

/**
 * Wait until the run tab's network goes quiet.
 *
 * Takes the run tab context (not a bare timeout pair) because the capture it
 * starts and stops is a tool call: without `tabId` the work-tab gate would pick
 * the target, which is exactly what the run-tab rule forbids.
 */
export async function waitForNetworkIdle(
  tab: RunTabContext,
  totalTimeoutMs: number,
  idleThresholdMs: number,
) {
  const deadline = Date.now() + Math.max(500, totalTimeoutMs);
  const threshold = Math.max(200, idleThresholdMs);
  while (Date.now() < deadline) {
    // 취소되면 더 기다리지 않는다 (검토 항목 4).
    if (tab.signal?.aborted) return;
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
      args: runToolArgs(tab, {
        includeStatic: false,
        // Ensure capture remains active until we explicitly stop it
        maxCaptureTime: Math.min(60_000, Math.max(threshold + 500, 2_000)),
        inactivityTimeout: 0,
      }),
    });
    await sleepOrAbort(threshold + 200, tab.signal);
    const stopRes = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
      args: runToolArgs(tab, {}),
    });
    const text = (stopRes as any)?.content?.find((c: any) => c.type === 'text')?.text;
    try {
      const json = text ? JSON.parse(text) : null;
      const captureEnd = Number(json?.captureEndTime) || Date.now();
      const reqs: any[] = Array.isArray(json?.requests) ? json.requests : [];
      const lastActivity = reqs.reduce(
        (acc, r) => {
          const t = Number(r.responseTime || r.requestTime || 0);
          return t > acc ? t : acc;
        },
        Number(json?.captureStartTime || 0),
      );
      if (captureEnd - lastActivity >= threshold) return; // idle reached
    } catch {
      // ignore parse errors
    }
    await sleepOrAbort(Math.min(500, threshold), tab.signal);
  }
  throw new Error('wait for network idle timed out');
}

// Event-driven navigation wait helper
// Waits for top-frame navigation completion or SPA history updates on the run's
// pinned tab. Falls back to short network idle on timeout.
export async function waitForNavigation(
  tab: RunTabContext,
  timeoutMs?: number,
  prevUrl?: string,
): Promise<void> {
  if (!tab || typeof tab.tabId !== 'number') {
    throw new RunTabError('run_tab_required', 'waitForNavigation needs the run tab.');
  }
  const tabId = await resolveRunTab(tab);
  const timeout = Math.max(1000, Math.min(timeoutMs || 15000, 30000));
  const startedAt = Date.now();
  // 이미 취소됐으면 기다리지 않는다 (검토 항목 4).
  if (tab.signal?.aborted) return;

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: any = null;
    const cleanup = () => {
      try {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
      } catch {}
      try {
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
      } catch {}
      try {
        (chrome.webNavigation as any).onHistoryStateUpdated?.removeListener?.(
          onHistoryStateUpdated,
        );
      } catch {}
      try {
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
      } catch {}
      try {
        tab.signal?.removeEventListener('abort', onAbort);
      } catch {}
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {}
      }
    };
    // 취소되면 대기를 끝낸다 — 아무도 기다리지 않는 페이지 로딩을 붙잡고 있지 않는다.
    const onAbort = () => finish();
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const onCommitted = (details: any) => {
      if (
        details &&
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.timeStamp >= startedAt
      ) {
        // committed observed; we'll wait for completion or SPA fallback
      }
    };
    const onCompleted = (details: any) => {
      if (
        details &&
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.timeStamp >= startedAt
      )
        finish();
    };
    const onHistoryStateUpdated = (details: any) => {
      if (
        details &&
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.timeStamp >= startedAt
      )
        finish();
    };
    const onTabUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') finish();
      if (typeof changeInfo.url === 'string' && (!prevUrl || changeInfo.url !== prevUrl)) finish();
    };
    const onTimeout = async () => {
      cleanup();
      try {
        await waitForNetworkIdle(tab, 2000, 800);
        resolve();
      } catch {
        reject(new Error('navigation timeout'));
      }
    };

    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    try {
      (chrome.webNavigation as any).onHistoryStateUpdated?.addListener?.(onHistoryStateUpdated);
    } catch {}
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    try {
      tab.signal?.addEventListener('abort', onAbort, { once: true });
    } catch {}
    timer = setTimeout(onTimeout, timeout);
  });
}

export function topoOrder(nodes: DagNode[], edges: DagEdge[]): DagNode[] {
  return sharedTopoOrder(nodes, edges as any);
}

// Helper: filter only default edges (no label or label === 'default')
export function defaultEdgesOnly(edges: DagEdge[] = []): DagEdge[] {
  return (edges || []).filter((e) => !e.label || e.label === EDGE_LABELS.DEFAULT);
}

export function mapDagNodeToStep(n: DagNode): Step {
  const s: any = sharedMapNodeToStep(n as any);
  if ((n as any)?.type === 'if') {
    // forward extended conditional config for DAG mode
    const cfg: any = (n as any).config || {};
    if (Array.isArray(cfg.branches)) s.branches = cfg.branches;
    if ('else' in cfg) s.else = cfg.else;
    if (cfg.condition && !s.condition) s.condition = cfg.condition; // backward-compat
  }
  return s as Step;
}
