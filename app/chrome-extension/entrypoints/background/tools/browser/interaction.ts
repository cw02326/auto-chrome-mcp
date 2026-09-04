import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
// auto-chrome-mcp fork: iframe 안의 요소를 찾기 위한 프레임 탐색 공용 모듈
import {
  isElementNotFoundError,
  probeActionFor,
  resolveFrameInfo,
  searchFramesForTarget,
  type FrameProbeHit,
} from './frame-resolver';
import { waitUntil } from '@/utils/adaptive-wait';
import { redactedArgsForLog } from '@/utils/log-redact';

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  // auto-chrome-mcp fork(A1): 요소가 아직 렌더되지 않았을 때 기다릴 시간(ms).
  // 기본 2000 — SPA/지연 렌더에서 "실패 → wait_for → 재클릭" 왕복을 없앤다. 0 이면 즉시 실패.
  waitForElementMs?: number;
  // auto-chrome-mcp fork: frameId 를 주면 프레임 탐색 없이 해당 프레임에서 바로 실행한다.
  // 생략하면 top frame 을 먼저 시도하고, 요소를 못 찾은 경우에만 iframe 들을 탐색한다.
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

// auto-chrome-mcp fork(A1): 요소 대기 기본값·상한
const DEFAULT_WAIT_FOR_ELEMENT_MS = 2000;
const MAX_WAIT_FOR_ELEMENT_MS = 30000;

function normalizeWaitForElementMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAIT_FOR_ELEMENT_MS;
  return Math.min(MAX_WAIT_FOR_ELEMENT_MS, Math.max(0, value));
}

// ===== auto-chrome-mcp fork: 전송 전 실패에 한해 1회 자동 재시도 =====
//
// click/fill 은 실패하면 그대로 끝나서, 모델이 같은 호출을 손으로 반복하곤 했다.
// "잠깐 뒤면 될 일"만 골라 한 번 더 시도한다.
//
// 다시 시도해도 되는 것은 **dispatch 자체가 일어나지 않은 실패**뿐이다.
// 요소가 가려졌거나(covered/outside_viewport/zero_size/nothing_at_point) detach 돼서 헬퍼가
// 이벤트를 쏘기 전에 되돌아온 경우가 여기 해당한다. 반대로 포트가 끊기거나 컨텍스트가 사라진
// 실패는 **보낸 뒤 응답만 잃은** 것일 수 있다(같은 URL 로 POST, SPA 액션, 새 창). 그때 다시
// 누르면 주문이 두 번 들어간다. 그래서 그런 실패는 재시도하지 않고 원래 오류를 그대로 돌려준다.

export type InteractionRetryReason = 'obstructed' | 'detached';
export type InteractionNoRetryReason = 'post_dispatch_ambiguous' | 'permanent' | 'unclassified';

export interface InteractionRetryDecision {
  retryable: boolean;
  reason: InteractionRetryReason | InteractionNoRetryReason;
}

/** 스크롤·애니메이션으로 해소될 수 있는 가림 유형(click-helper 의 describeObstruction 기준) */
const TRANSIENT_OBSTRUCTION_REASONS = new Set([
  'covered_by_other_element',
  'outside_viewport',
  'nothing_at_point',
  'zero_size',
]);

/**
 * 전송은 됐는데 응답만 잃었을 수 있는 실패 — 클릭이 이미 먹었을지 알 수 없으므로 재시도 금지.
 */
const POST_DISPATCH_AMBIGUOUS_PATTERNS: RegExp[] = [
  /receiving end does not exist/i,
  /could not establish connection/i,
  // 크롬은 상황에 따라 "message port closed" 와 "message channel closed" 를 모두 낸다.
  /message (port|channel) closed/i,
  /frame with id \d+ was removed/i,
  /no frame with id/i,
  /extension context invalidated/i,
];

const DETACHED_PATTERNS: RegExp[] = [
  /not connected/i,
  /no longer (attached|in the document)/i,
  /detached/i,
];

/** 다시 해도 결과가 같은 실패 — 재시도 금지 */
const PERMANENT_PATTERNS: RegExp[] = [
  /not found/i,
  /no element/i,
  /not fillable/i,
  /which is not fillable/i,
  /disabled/i,
  /invalid/i,
  /requires a (numeric|boolean)/i,
  /did not respond to/i,
  /timed out/i,
];

/**
 * 실패가 "전송 전에 멈춘 일시적 실패"인지 판정한다.
 * 재시도하면 안 되는 실패는 왜 안 되는지(reason)를 함께 돌려준다.
 */
export function classifyInteractionFailure(error: unknown): InteractionRetryDecision {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (!text) return { retryable: false, reason: 'unclassified' };

  const response = (error as { response?: { obstruction?: { reason?: string } } })?.response;
  const obstructionReason = response?.obstruction?.reason;
  if (typeof obstructionReason === 'string') {
    // 헬퍼가 진단과 함께 되돌아왔다 = 아직 이벤트를 쏘지 않았다.
    // 다만 가림 진단이 실패한 경우(obstruction_check_failed)는 근거가 없으므로 재시도하지 않는다.
    return TRANSIENT_OBSTRUCTION_REASONS.has(obstructionReason)
      ? { retryable: true, reason: 'obstructed' }
      : { retryable: false, reason: 'permanent' };
  }

  if (POST_DISPATCH_AMBIGUOUS_PATTERNS.some((p) => p.test(text))) {
    return { retryable: false, reason: 'post_dispatch_ambiguous' };
  }
  if (PERMANENT_PATTERNS.some((p) => p.test(text))) {
    return { retryable: false, reason: 'permanent' };
  }
  if (DETACHED_PATTERNS.some((p) => p.test(text))) {
    return { retryable: true, reason: 'detached' };
  }
  // fill-helper 의 "is not visible" 에는 obstruction 진단이 없다 — 등장 애니메이션일 수 있다.
  if (/is not visible/i.test(text)) return { retryable: true, reason: 'obstructed' };
  return { retryable: false, reason: 'unclassified' };
}

/** 재시도 전 안정화 대기 상한(조건이 충족되면 즉시 끝난다) */
const RETRY_STABILIZE_MAX_MS = 300;
const RETRY_STABILIZE_POLL_MS = 50;
/** 재시도 판정용 probe·ref 고정 응답 대기 상한 */
const RETRY_PROBE_TIMEOUT_MS = 500;

interface TargetProbeState {
  found: boolean;
  visible: boolean;
}

export interface RetryReadiness {
  ready: boolean;
  /** 왜 재시도하지 않는지(관측 결과) — 결과에 싣지 않고 로그용으로만 쓴다. */
  detail: string;
  waitedMs: number;
}

/**
 * 첫 시도와 재시도 사이에 문서가 바뀌었는지 본다.
 * URL 이 같아도 같은 주소로 다시 로드하거나 폼을 POST 하면 documentId 가 바뀐다.
 */
export function documentChanged(
  before: { url?: string; documentId?: string },
  after: { url?: string; documentId?: string },
): boolean {
  if (before.url && after.url && before.url !== after.url) return true;
  if (before.documentId && after.documentId && before.documentId !== after.documentId) return true;
  return false;
}

/**
 * 재시도해도 되는 상태가 됐는지 짧게 기다린다.
 *
 * 고정한 요소(ref)를 같은 탭·같은 프레임에서 다시 조회해 쓸 수 있으면 즉시 재시도한다.
 * 측정이 불가능하면(probe 응답 실패) 재시도하지 않는다 — 무엇을 누르게 될지 알 수 없다.
 */
export async function waitForRetryReadiness(options: {
  probeTarget?: (() => Promise<TargetProbeState | null>) | null;
  requireVisible: boolean;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}): Promise<RetryReadiness> {
  const timeoutMs = options.timeoutMs ?? RETRY_STABILIZE_MAX_MS;
  const pollMs = options.pollMs ?? RETRY_STABILIZE_POLL_MS;

  if (!options.probeTarget) {
    // 좌표 클릭처럼 다시 조회할 대상이 없다 — 짧게만 기다렸다가 재시도한다.
    // (좌표는 다시 해석되지 않으므로 "다른 요소를 누를" 위험이 없다.)
    const waited = await waitUntil<null>({
      probe: async () => null,
      done: () => false,
      timeoutMs,
      pollMs,
      immediate: false,
      now: options.now,
    });
    return { ready: true, detail: 'no_probe', waitedMs: waited.waitedMs };
  }

  let probeFailed = false;
  const probed = await waitUntil<TargetProbeState | null>({
    probe: async () => {
      try {
        const state = await options.probeTarget!();
        probeFailed = state === null;
        return state;
      } catch {
        probeFailed = true;
        return null;
      }
    },
    done: (state) => !!state && state.found && (!options.requireVisible || state.visible),
    timeoutMs,
    pollMs,
    now: options.now,
  });

  if (probed.satisfied) {
    return { ready: true, detail: 'target_ready', waitedMs: probed.waitedMs };
  }
  if (probeFailed) {
    // 측정할 수 없었다 — 같은 요소를 누른다는 보장이 없으므로 재시도하지 않는다.
    return { ready: false, detail: 'probe_unavailable', waitedMs: probed.waitedMs };
  }
  return { ready: false, detail: 'target_still_unusable', waitedMs: probed.waitedMs };
}

/** 재시도 판정의 기준값. url 은 **탭**의 주소, frame* 은 실제로 조작할 **프레임**의 것이다. */
interface InteractionBaseline {
  url?: string;
  documentId?: string;
  frameUrl?: string;
}

interface FrameDocumentState {
  documentId?: string;
  /** 프레임 자체의 주소 (top frame 이면 탭 주소와 같다) */
  url?: string;
}

/**
 * 프레임의 documentId·URL 을 읽는다. webNavigation 이 없거나 실패하면 빈 값(비교 생략).
 */
async function readFrameState(tabId: number, frameId?: number): Promise<FrameDocumentState> {
  try {
    const api = (chrome as { webNavigation?: { getFrame?: (details: unknown) => Promise<any> } })
      ?.webNavigation;
    if (!api || typeof api.getFrame !== 'function') return {};
    const info = await api.getFrame({ tabId, frameId: typeof frameId === 'number' ? frameId : 0 });
    return {
      documentId: typeof info?.documentId === 'string' ? info.documentId : undefined,
      url: typeof info?.url === 'string' ? info.url : undefined,
    };
  } catch {
    return {};
  }
}

export interface InteractionRetryPlan {
  ok: boolean;
  /** 재시도에 고정할 요소 ref (좌표 클릭이면 undefined) */
  pinnedRef?: string;
  detail: string;
}

/**
 * 재시도를 준비한다. 통과하면 "무엇을(ref) 어느 프레임에서" 다시 시도할지가 확정된다.
 *
 * 1) 문서가 바뀌었으면 중단한다(클릭이 이미 먹어 이동했을 수 있다).
 * 2) selector 로 시작한 호출은 여기서 한 번만 ref 로 고정한다. 이후 probe 와 재실행은
 *    그 ref 만 쓰므로, DOM 이 재정렬돼도 다른 요소를 누르지 않는다. 고정에 실패하면(요소가
 *    사라졌으면) 재시도하지 않는다.
 * 3) 고정한 요소가 쓸 수 있는 상태가 될 때까지만 짧게 기다린다.
 */
async function prepareInteractionRetry(options: {
  tabId: number;
  frameId?: number;
  before: InteractionBaseline;
  ref?: string;
  selector?: string;
  getTab: () => Promise<{ url?: string } | null>;
  ensureRef: (selector: string) => Promise<string | null>;
  probeRef: (ref: string) => Promise<TargetProbeState | null>;
}): Promise<InteractionRetryPlan> {
  const tab = await options.getTab();
  if (!tab) return { ok: false, detail: 'tab_gone' };

  // 탭 주소와 **대상 프레임**의 문서를 각각 비교한다. 대상이 iframe 이면 프레임 주소는 탭 주소와
  // 다르므로 섞어서 비교하면 안 된다.
  const frameAfter = await readFrameState(options.tabId, options.frameId);
  if (
    documentChanged(
      { url: options.before.url, documentId: options.before.documentId },
      { url: tab.url, documentId: frameAfter.documentId },
    )
  ) {
    return { ok: false, detail: 'navigated' };
  }
  if (documentChanged({ url: options.before.frameUrl }, { url: frameAfter.url })) {
    return { ok: false, detail: 'navigated' };
  }

  let pinnedRef = options.ref;
  if (!pinnedRef && options.selector) {
    pinnedRef = (await options.ensureRef(options.selector)) ?? undefined;
    if (!pinnedRef) return { ok: false, detail: 'target_gone' };
  }

  const readiness = await waitForRetryReadiness({
    requireVisible: true,
    probeTarget: pinnedRef ? () => options.probeRef(pinnedRef as string) : null,
  });
  if (!readiness.ready) return { ok: false, detail: readiness.detail };

  return { ok: true, pinnedRef, detail: readiness.detail };
}

/** 재시도 전송 뒤 응답을 잃었을 때 붙이는 경고 — 이미 먹었을 수 있다. */
const RETRY_RESPONSE_LOST_NOTE =
  '; retry response lost: the action may have already taken effect, verify page state before retrying';

/** 재시도 결과를 원래 오류 문구 뒤에 덧붙일 꼬리표(기존 문구는 그대로 둔다) */
function retryNoteFor(error: unknown): string {
  const meta = (
    error as { acmRetry?: { retried: boolean; reason: string; responseLost?: boolean } }
  )?.acmRetry;
  if (meta?.retried) {
    // 재시도까지 응답을 잃었으면 "아무 일도 없었다"고 읽히면 안 된다.
    return ` (retried once: ${meta.reason}${meta.responseLost ? RETRY_RESPONSE_LOST_NOTE : ''})`;
  }
  const noRetry = (error as { acmNoRetry?: string })?.acmNoRetry;
  if (noRetry === 'post_dispatch_ambiguous') {
    return ' (not retried: post_dispatch_ambiguous; the action may have already taken effect, verify page state before retrying)';
  }
  return '';
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * auto-chrome-mcp fork: top frame 에서 요소를 못 찾았을 때 하위 iframe 들을 탐색한다.
   * probe 는 조회 전용 메시지라 부수효과가 없다.
   */
  private async findTargetFrame(
    tabId: number,
    target: { selector?: string; ref?: string; isXPath?: boolean },
  ): Promise<FrameProbeHit | null> {
    return searchFramesForTarget({
      tabId,
      probeFile: 'inject-scripts/click-helper.js',
      probeAction: probeActionFor(this.name),
      selector: target.selector,
      ref: target.ref,
      isXPath: target.isXPath,
      inject: (id, files, frameIds) =>
        this.injectContentScript(id, files, false, 'ISOLATED', false, frameIds),
      send: (id, message, frameId) => this.sendMessageToTab(id, message, frameId),
    });
  }

  /**
   * auto-chrome-mcp fork: 재시도 판정용 — 같은 탭·같은 프레임에서 **고정한 ref** 의 상태만
   * 다시 조회한다. selector 를 다시 해석하지 않으므로 DOM 이 재정렬돼도 대상이 바뀌지 않는다.
   */
  private async probeRefState(
    tabId: number,
    frameId: number | undefined,
    ref: string,
  ): Promise<TargetProbeState | null> {
    const response = await this.sendMessageToTab(
      tabId,
      { action: probeActionFor(this.name), ref, isXPath: false },
      frameId,
      RETRY_PROBE_TIMEOUT_MS,
    );
    if (!response) return null;
    return { found: response.found === true, visible: response.visible === true };
  }

  /**
   * auto-chrome-mcp fork: 재시도 직전에 selector 를 **한 번만** ref 로 고정한다.
   *
   * 같은 탭·같은 프레임에서만 조회하며, 못 찾으면 null 을 돌려 재시도 자체를 막는다.
   * injectContentScript 는 `${this.name}_ping` 으로 "이미 있음"을 판정하는데 그 ping 은
   * click/fill 헬퍼의 것이라 여기서는 쓸 수 없다 — ref 헬퍼는 직접 주입한다(재주입은 무해하다).
   */
  private async pinRefForSelector(
    tabId: number,
    frameId: number | undefined,
    selector: string,
  ): Promise<string | null> {
    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof frameId === 'number') target.frameIds = [frameId];
      await chrome.scripting.executeScript({
        target,
        files: ['inject-scripts/accessibility-tree-helper.js'],
        world: 'ISOLATED',
      } as never);
    } catch {
      // 이미 주입돼 있거나 주입이 불가능한 문서 — 아래에서 응답으로 판정한다.
    }
    try {
      const resolved = await this.sendMessageToTab(
        tabId,
        { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector, isXPath: false },
        frameId,
        RETRY_PROBE_TIMEOUT_MS,
      );
      return resolved && resolved.success && resolved.ref ? String(resolved.ref) : null;
    } catch {
      return null;
    }
  }

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;
    const waitForElementMs = normalizeWaitForElementMs(args.waitForElementMs);

    console.log(`Starting click operation with options:`, redactedArgsForLog(args));

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = args.ref;
      let finalSelector = selector;

      // auto-chrome-mcp fork: frameId 를 명시하면 그 프레임만 대상으로 하고 탐색을 건너뛴다.
      const explicitFrameId = typeof frameId === 'number' ? frameId : undefined;
      // auto-chrome-mcp fork: 생략하면 top frame(0)으로 **정규화**한다.
      // frameId 를 비워 두면 chrome.tabs.sendMessage 가 탭의 모든 프레임에 뿌려져, 첫 시도에
      // 응답한 프레임과 pin/probe/재전송이 향하는 프레임이 달라질 수 있다(다른 요소를 누르게 된다).
      // helper 주입도 어차피 top frame 만 대상이므로 0 으로 고정하는 편이 실제 동작과 일치한다.
      let targetFrameId: number = explicitFrameId ?? 0;
      let resolvedFrame: FrameProbeHit | null = null;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          [targetFrameId],
        );

        let resolved: any = null;
        let resolveError: string | null = null;
        try {
          resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            targetFrameId,
          );
        } catch (error) {
          resolveError = error instanceof Error ? error.message : String(error);
        }

        // auto-chrome-mcp fork: top frame 에서 XPath 를 못 찾으면 iframe 들을 탐색해 다시 시도한다.
        if (!(resolved && resolved.success && resolved.ref) && explicitFrameId === undefined) {
          const hit = await this.findTargetFrame(tab.id, { selector, isXPath: true });
          if (hit) {
            try {
              await this.injectContentScript(
                tab.id,
                ['inject-scripts/accessibility-tree-helper.js'],
                false,
                'ISOLATED',
                false,
                [hit.frameId],
              );
              const retried = await this.sendMessageToTab(
                tab.id,
                {
                  action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                  selector,
                  isXPath: true,
                },
                hit.frameId,
              );
              if (retried && retried.success && retried.ref) {
                resolved = retried;
                resolveError = null;
                targetFrameId = hit.frameId;
                resolvedFrame = hit;
              }
            } catch {
              // 프레임 재시도 실패는 무시하고 아래에서 원래 오류를 반환한다.
            }
          }
        }

        if (resolved && resolved.success && resolved.ref) {
          finalRef = resolved.ref;
          finalSelector = undefined; // Use ref instead of selector
        } else if (resolveError !== null) {
          return createErrorResponse(`Error resolving XPath: ${resolveError}`);
        } else {
          return createErrorResponse(
            `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
          );
        }
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/click-helper.js'],
        false,
        'ISOLATED',
        false,
        [targetFrameId],
      );

      const clickMessage = {
        action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
        selector: finalSelector,
        coordinates,
        ref: finalRef,
        waitForNavigation,
        timeout,
        double: args.double === true,
        button,
        bubbles,
        cancelable,
        modifiers,
        waitForElementMs,
      };

      // Send click message to content script
      const tabId = tab.id;
      const urlBefore = tab.url;
      // auto-chrome-mcp fork: 재시도 직전 "그 사이 문서가 바뀌었는지" 비교할 기준값.
      // URL 이 같아도 같은 주소로 다시 로드하거나 POST 하면 documentId 가 바뀐다.
      // iframe 폴백으로 대상 프레임이 바뀌면 아래 deliver 에서 그 프레임 기준으로 다시 잡는다.
      let frameBefore = await readFrameState(tabId, targetFrameId);
      const deliver = async (): Promise<any> => {
        try {
          return await this.sendMessageToTab(tabId, clickMessage, targetFrameId);
        } catch (error) {
          // auto-chrome-mcp fork: top frame 에서 "요소 없음"이면 iframe 들을 탐색해 재시도한다.
          // 좌표 클릭, 명시적 frameId, 연결 오류 등은 기존과 동일하게 그대로 실패시킨다.
          const message = error instanceof Error ? error.message : String(error);
          const canSearchFrames =
            explicitFrameId === undefined &&
            !coordinates &&
            (!!finalSelector || !!finalRef) &&
            isElementNotFoundError(message);
          if (!canSearchFrames) throw error;

          const hit = await this.findTargetFrame(tabId, {
            selector: finalSelector,
            ref: finalRef,
          });
          if (!hit) throw error; // 못 찾으면 원래 오류를 그대로 전달(하위 호환)

          resolvedFrame = hit;
          targetFrameId = hit.frameId;
          // auto-chrome-mcp fork: 기준값을 top frame 에서 잡아 두면 프레임이 바뀐 것만으로
          // documentId 가 달라져 "이동했다"고 오판하고 재시도가 항상 막힌다.
          // 대상 프레임이 확정된 지금, 그 프레임의 문서를 기준값으로 다시 잡는다.
          frameBefore = await readFrameState(tabId, hit.frameId);
          return await this.sendMessageToTab(tabId, clickMessage, hit.frameId);
        }
      };

      let result: any;
      let retried = false;
      let retryReason: InteractionRetryReason | null = null;
      try {
        result = await deliver();
      } catch (error) {
        // auto-chrome-mcp fork: 전송 전에 멈춘 실패만 1회 재시도한다 (스키마 변경 없음).
        const decision = classifyInteractionFailure(error);
        if (!decision.retryable) {
          if (decision.reason === 'post_dispatch_ambiguous') {
            (error as { acmNoRetry?: string }).acmNoRetry = decision.reason;
          }
          throw error;
        }
        const reason = decision.reason as InteractionRetryReason;

        const plan = await prepareInteractionRetry({
          tabId,
          frameId: targetFrameId,
          before: { url: urlBefore, documentId: frameBefore.documentId, frameUrl: frameBefore.url },
          ref: finalRef,
          selector: coordinates && !finalSelector ? undefined : finalSelector,
          getTab: () => this.tryGetTab(tabId),
          ensureRef: (selector) => this.pinRefForSelector(tabId, targetFrameId, selector),
          probeRef: (ref) => this.probeRefState(tabId, targetFrameId, ref),
        });
        if (!plan.ok) {
          console.warn(`chrome_click_element: not retried after ${reason}: ${plan.detail}`);
          throw error;
        }

        try {
          // 헬퍼가 떨어졌을 수 있으므로 같은 탭·같은 프레임에 다시 주입한다.
          await this.injectContentScript(
            tabId,
            ['inject-scripts/click-helper.js'],
            false,
            'ISOLATED',
            false,
            [targetFrameId],
          );
          // 재시도는 고정한 요소·프레임으로만 간다 — 프레임을 다시 검색하지 않는다.
          const retryMessage = plan.pinnedRef
            ? { ...clickMessage, ref: plan.pinnedRef, selector: undefined }
            : clickMessage;
          result = await this.sendMessageToTab(tabId, retryMessage, targetFrameId);
          retried = true;
          retryReason = reason;
        } catch (retryError) {
          console.warn(
            `chrome_click_element: retry after ${reason} failed: ${
              retryError instanceof Error ? retryError.message : String(retryError)
            }`,
          );
          // auto-chrome-mcp fork: 재시도를 보낸 뒤 응답을 잃었으면(포트·컨텍스트 끊김) 그 동작이
          // 이미 먹었을 수 있다. 원래 오류만 돌려주면 "아무 일도 없었다"로 읽혀 두 번 실행된다.
          const responseLost =
            classifyInteractionFailure(retryError).reason === 'post_dispatch_ambiguous';
          (
            error as {
              acmRetry?: {
                retried: boolean;
                reason: InteractionRetryReason;
                responseLost: boolean;
              };
            }
          ).acmRetry = { retried: true, reason, responseLost };
          throw error; // 원래 오류를 그대로 보고한다
        }
      }

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      const payload: Record<string, any> = {
        success: true,
        message: result.message || 'Click operation successful',
        elementInfo: result.elementInfo,
        navigationOccurred: result.navigationOccurred,
        clickMethod,
      };

      // auto-chrome-mcp fork: 일시적 실패로 한 번 다시 시도했음을 알린다.
      if (retried && retryReason) {
        payload.retried = true;
        payload.retryReason = retryReason;
      }

      // auto-chrome-mcp fork(A3): 요소에 직접 이벤트를 쐈지만 클릭 시점에 가려져 있던 경우 경고.
      // 사이트가 무시했을 수 있으므로 모델이 결과를 확인하도록 유도한다.
      if (result.obstruction) {
        payload.obstruction = result.obstruction;
        if (result.warning) payload.warning = result.warning;
      }

      // auto-chrome-mcp fork: top frame 이 아닌 프레임에서 실행된 경우에만 프레임 정보를 덧붙인다.
      // (top frame 기본 경로의 응답 형식은 그대로 유지)
      if (targetFrameId !== 0) {
        payload.frameId = targetFrameId;
        const info = resolvedFrame ?? (await resolveFrameInfo(tab.id, targetFrameId));
        payload.frameUrl = info?.frameUrl ?? null;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      const message = error instanceof Error ? error.message : String(error);

      // auto-chrome-mcp fork(A3): 클릭이 "가려져서" 실패한 경우 무엇이 가리는지 함께 보고한다.
      // (기존에는 elementFromPoint 로 알아내고도 버려서 모델이 같은 시도를 반복했다.)
      const diag = (error as Error & { response?: any })?.response;
      // auto-chrome-mcp fork: 재시도 여부는 **기존 오류 문구 뒤 꼬리표**로만 알린다.
      // (응답 형태를 JSON 으로 바꾸면 기존 호출부의 문자열 처리가 깨진다.)
      const note = retryNoteFor(error);

      if (diag && diag.obstruction) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Error performing click: ${message}${note}`,
                elementInfo: diag.elementInfo ?? null,
                obstruction: diag.obstruction,
              }),
            },
          ],
          isError: true,
        };
      }

      return createErrorResponse(`Error performing click: ${message}${note}`);
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  // auto-chrome-mcp fork: frameId 를 주면 프레임 탐색 없이 해당 프레임에서 바로 실행한다.
  // 생략하면 top frame 을 먼저 시도하고, 요소를 못 찾은 경우에만 iframe 들을 탐색한다.
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  // auto-chrome-mcp fork(A1): 입력 대상이 아직 렌더되지 않았을 때 기다릴 시간(ms). 기본 2000.
  waitForElementMs?: number;
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * auto-chrome-mcp fork: top frame 에서 요소를 못 찾았을 때 하위 iframe 들을 탐색한다.
   * probe 는 조회 전용 메시지라 부수효과가 없다.
   */
  private async findTargetFrame(
    tabId: number,
    target: { selector?: string; ref?: string; isXPath?: boolean },
  ): Promise<FrameProbeHit | null> {
    return searchFramesForTarget({
      tabId,
      probeFile: 'inject-scripts/fill-helper.js',
      probeAction: probeActionFor(this.name),
      selector: target.selector,
      ref: target.ref,
      isXPath: target.isXPath,
      inject: (id, files, frameIds) =>
        this.injectContentScript(id, files, false, 'ISOLATED', false, frameIds),
      send: (id, message, frameId) => this.sendMessageToTab(id, message, frameId),
    });
  }

  /**
   * auto-chrome-mcp fork: 재시도 판정용 — 같은 탭·같은 프레임에서 **고정한 ref** 의 상태만
   * 다시 조회한다. selector 를 다시 해석하지 않는다.
   */
  private async probeRefState(
    tabId: number,
    frameId: number | undefined,
    ref: string,
  ): Promise<TargetProbeState | null> {
    const response = await this.sendMessageToTab(
      tabId,
      { action: probeActionFor(this.name), ref, isXPath: false },
      frameId,
      RETRY_PROBE_TIMEOUT_MS,
    );
    if (!response) return null;
    return { found: response.found === true, visible: response.visible === true };
  }

  /**
   * auto-chrome-mcp fork: 재시도 직전에 selector 를 **한 번만** ref 로 고정한다.
   *
   * 같은 탭·같은 프레임에서만 조회하며, 못 찾으면 null 을 돌려 재시도 자체를 막는다.
   * injectContentScript 는 `${this.name}_ping` 으로 "이미 있음"을 판정하는데 그 ping 은
   * click/fill 헬퍼의 것이라 여기서는 쓸 수 없다 — ref 헬퍼는 직접 주입한다(재주입은 무해하다).
   */
  private async pinRefForSelector(
    tabId: number,
    frameId: number | undefined,
    selector: string,
  ): Promise<string | null> {
    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof frameId === 'number') target.frameIds = [frameId];
      await chrome.scripting.executeScript({
        target,
        files: ['inject-scripts/accessibility-tree-helper.js'],
        world: 'ISOLATED',
      } as never);
    } catch {
      // 이미 주입돼 있거나 주입이 불가능한 문서 — 아래에서 응답으로 판정한다.
    }
    try {
      const resolved = await this.sendMessageToTab(
        tabId,
        { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector, isXPath: false },
        frameId,
        RETRY_PROBE_TIMEOUT_MS,
      );
      return resolved && resolved.success && resolved.ref ? String(resolved.ref) : null;
    } catch {
      return null;
    }
  }

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, redactedArgsForLog(args));

    if (!selector && !ref) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector');
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = ref;
      let finalSelector = selector;

      // auto-chrome-mcp fork: frameId 를 명시하면 그 프레임만 대상으로 하고 탐색을 건너뛴다.
      const explicitFrameId = typeof frameId === 'number' ? frameId : undefined;
      // auto-chrome-mcp fork: 생략하면 top frame(0)으로 **정규화**한다.
      // frameId 를 비워 두면 chrome.tabs.sendMessage 가 탭의 모든 프레임에 뿌려져, 첫 시도에
      // 응답한 프레임과 pin/probe/재전송이 향하는 프레임이 달라질 수 있다(다른 요소를 누르게 된다).
      // helper 주입도 어차피 top frame 만 대상이므로 0 으로 고정하는 편이 실제 동작과 일치한다.
      let targetFrameId: number = explicitFrameId ?? 0;
      let resolvedFrame: FrameProbeHit | null = null;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          [targetFrameId],
        );

        let resolved: any = null;
        let resolveError: string | null = null;
        try {
          resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            targetFrameId,
          );
        } catch (error) {
          resolveError = error instanceof Error ? error.message : String(error);
        }

        // auto-chrome-mcp fork: top frame 에서 XPath 를 못 찾으면 iframe 들을 탐색해 다시 시도한다.
        if (!(resolved && resolved.success && resolved.ref) && explicitFrameId === undefined) {
          const hit = await this.findTargetFrame(tab.id, { selector, isXPath: true });
          if (hit) {
            try {
              await this.injectContentScript(
                tab.id,
                ['inject-scripts/accessibility-tree-helper.js'],
                false,
                'ISOLATED',
                false,
                [hit.frameId],
              );
              const retried = await this.sendMessageToTab(
                tab.id,
                {
                  action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                  selector,
                  isXPath: true,
                },
                hit.frameId,
              );
              if (retried && retried.success && retried.ref) {
                resolved = retried;
                resolveError = null;
                targetFrameId = hit.frameId;
                resolvedFrame = hit;
              }
            } catch {
              // 프레임 재시도 실패는 무시하고 아래에서 원래 오류를 반환한다.
            }
          }
        }

        if (resolved && resolved.success && resolved.ref) {
          finalRef = resolved.ref;
          finalSelector = undefined; // Use ref instead of selector
        } else if (resolveError !== null) {
          return createErrorResponse(`Error resolving XPath: ${resolveError}`);
        } else {
          return createErrorResponse(
            `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
          );
        }
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/fill-helper.js'],
        false,
        'ISOLATED',
        false,
        [targetFrameId],
      );

      const fillMessage = {
        action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
        selector: finalSelector,
        ref: finalRef,
        value,
        // auto-chrome-mcp fork(A1): 아직 렌더되지 않은 입력칸을 짧게 기다린다.
        waitForElementMs: normalizeWaitForElementMs(args.waitForElementMs),
      };

      // Send fill message to content script
      const tabId = tab.id;
      const urlBefore = tab.url;
      // auto-chrome-mcp fork: 재시도 직전 "그 사이 문서가 바뀌었는지" 비교할 기준값.
      // URL 이 같아도 같은 주소로 다시 로드하거나 POST 하면 documentId 가 바뀐다.
      // iframe 폴백으로 대상 프레임이 바뀌면 아래 deliver 에서 그 프레임 기준으로 다시 잡는다.
      let frameBefore = await readFrameState(tabId, targetFrameId);
      const deliver = async (): Promise<any> => {
        try {
          return await this.sendMessageToTab(tabId, fillMessage, targetFrameId);
        } catch (error) {
          // auto-chrome-mcp fork: top frame 에서 "요소 없음"이면 iframe 들을 탐색해 재시도한다.
          const message = error instanceof Error ? error.message : String(error);
          const canSearchFrames =
            explicitFrameId === undefined &&
            (!!finalSelector || !!finalRef) &&
            isElementNotFoundError(message);
          if (!canSearchFrames) throw error;

          const hit = await this.findTargetFrame(tabId, {
            selector: finalSelector,
            ref: finalRef,
          });
          if (!hit) throw error; // 못 찾으면 원래 오류를 그대로 전달(하위 호환)

          resolvedFrame = hit;
          targetFrameId = hit.frameId;
          // auto-chrome-mcp fork: 기준값을 top frame 에서 잡아 두면 프레임이 바뀐 것만으로
          // documentId 가 달라져 "이동했다"고 오판하고 재시도가 항상 막힌다.
          // 대상 프레임이 확정된 지금, 그 프레임의 문서를 기준값으로 다시 잡는다.
          frameBefore = await readFrameState(tabId, hit.frameId);
          return await this.sendMessageToTab(tabId, fillMessage, hit.frameId);
        }
      };

      let result: any;
      let retried = false;
      let retryReason: InteractionRetryReason | null = null;
      try {
        result = await deliver();
      } catch (error) {
        // auto-chrome-mcp fork: 전송 전에 멈춘 실패만 1회 재시도한다 (스키마 변경 없음).
        const decision = classifyInteractionFailure(error);
        if (!decision.retryable) {
          if (decision.reason === 'post_dispatch_ambiguous') {
            (error as { acmNoRetry?: string }).acmNoRetry = decision.reason;
          }
          throw error;
        }
        const reason = decision.reason as InteractionRetryReason;

        const plan = await prepareInteractionRetry({
          tabId,
          frameId: targetFrameId,
          before: { url: urlBefore, documentId: frameBefore.documentId, frameUrl: frameBefore.url },
          ref: finalRef,
          selector: finalSelector,
          getTab: () => this.tryGetTab(tabId),
          ensureRef: (selector) => this.pinRefForSelector(tabId, targetFrameId, selector),
          probeRef: (ref) => this.probeRefState(tabId, targetFrameId, ref),
        });
        if (!plan.ok) {
          console.warn(`chrome_fill_or_select: not retried after ${reason}: ${plan.detail}`);
          throw error;
        }

        try {
          await this.injectContentScript(
            tabId,
            ['inject-scripts/fill-helper.js'],
            false,
            'ISOLATED',
            false,
            [targetFrameId],
          );
          // 재시도는 고정한 요소·프레임으로만 간다 — 프레임을 다시 검색하지 않는다.
          const retryMessage = plan.pinnedRef
            ? { ...fillMessage, ref: plan.pinnedRef, selector: undefined }
            : fillMessage;
          result = await this.sendMessageToTab(tabId, retryMessage, targetFrameId);
          retried = true;
          retryReason = reason;
        } catch (retryError) {
          console.warn(
            `chrome_fill_or_select: retry after ${reason} failed: ${
              retryError instanceof Error ? retryError.message : String(retryError)
            }`,
          );
          // auto-chrome-mcp fork: 재시도를 보낸 뒤 응답을 잃었으면(포트·컨텍스트 끊김) 그 동작이
          // 이미 먹었을 수 있다. 원래 오류만 돌려주면 "아무 일도 없었다"로 읽혀 두 번 실행된다.
          const responseLost =
            classifyInteractionFailure(retryError).reason === 'post_dispatch_ambiguous';
          (
            error as {
              acmRetry?: {
                retried: boolean;
                reason: InteractionRetryReason;
                responseLost: boolean;
              };
            }
          ).acmRetry = { retried: true, reason, responseLost };
          throw error; // 원래 오류를 그대로 보고한다
        }
      }

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      const payload: Record<string, any> = {
        success: true,
        message: result.message || 'Fill operation successful',
        elementInfo: result.elementInfo,
      };

      // auto-chrome-mcp fork: 일시적 실패로 한 번 다시 시도했음을 알린다.
      if (retried && retryReason) {
        payload.retried = true;
        payload.retryReason = retryReason;
      }

      // auto-chrome-mcp fork: top frame 이 아닌 프레임에서 실행된 경우에만 프레임 정보를 덧붙인다.
      if (targetFrameId !== 0) {
        payload.frameId = targetFrameId;
        const info = resolvedFrame ?? (await resolveFrameInfo(tab.id, targetFrameId));
        payload.frameUrl = info?.frameUrl ?? null;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      const message = error instanceof Error ? error.message : String(error);
      // auto-chrome-mcp fork: 재시도 여부는 기존 오류 문구 뒤 꼬리표로만 알린다.
      return createErrorResponse(`Error filling element: ${message}${retryNoteFor(error)}`);
    }
  }
}

export const fillTool = new FillTool();
