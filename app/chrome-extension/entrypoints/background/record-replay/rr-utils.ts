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
import { EDGE_LABELS } from 'auto-chrome-mcp-shared';
import {
  RunTabError,
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
async function waitForTabSettled(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    if (!tab || tab.status !== 'loading') return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
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
    // v1.9.0: activation-guard decides whether the new tab may take focus.
    const created = await createTabGuarded(
      { url: urlToOpen, active: true },
      { reason: 'flow:prepare-new-tab' },
    );
    if (typeof created?.id !== 'number') {
      throw new RunTabError('run_tab_missing', 'Could not open a work tab for this run.');
    }
    setRunTab(tab, created.id, created.windowId);
    tabId = created.id;
    await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS);
    try {
      current = await chrome.tabs.get(tabId);
    } catch {
      current = undefined;
    }
    return { tabId, url: current?.url ?? (typeof urlToOpen === 'string' ? urlToOpen : undefined) };
  }

  if (options.startUrl) {
    await chrome.tabs.update(tabId, { url: options.startUrl });
    await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS);
  } else if (options.refresh && isWebUrl(current?.url)) {
    await chrome.tabs.reload?.(tabId);
    await waitForTabSettled(tabId, PREPARE_TAB_TIMEOUT_MS);
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
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
      args: runToolArgs(tab, {
        includeStatic: false,
        // Ensure capture remains active until we explicitly stop it
        maxCaptureTime: Math.min(60_000, Math.max(threshold + 500, 2_000)),
        inactivityTimeout: 0,
      }),
    });
    await new Promise((r) => setTimeout(r, threshold + 200));
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
    await new Promise((r) => setTimeout(r, Math.min(500, threshold)));
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
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {}
      }
    };
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
