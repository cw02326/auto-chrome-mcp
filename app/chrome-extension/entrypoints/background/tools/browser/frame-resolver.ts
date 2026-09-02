/**
 * auto-chrome-mcp fork: iframe(프레임) 인식 요소 탐색 공용 모듈.
 *
 * 배경: content script 는 기본적으로 top frame 에만 주입되기 때문에, 결제 위젯 / 로그인 iframe /
 * 임베드 에디터처럼 대상 요소가 iframe 안에 있으면 chrome_click_element, chrome_fill_or_select,
 * chrome_read_page 가 요소를 찾지 못한다.
 *
 * 이 모듈은 두 가지 기능을 제공한다.
 *  1) searchFramesForTarget(): top frame 에서 "not found" 가 났을 때만 하위 프레임을 열거하고,
 *     각 프레임에 helper 를 주입한 뒤 가벼운 probe 메시지로 셀렉터/ref 존재 여부만 물어본다.
 *  2) listChildFrames() / listAllFrames() / resolveFrameInfo(): read_page 처럼 여러 프레임에서
 *     결과를 모아야 하는 도구를 위한 프레임 열거 유틸.
 *
 * 하위 호환 원칙: 이 모듈은 "top frame 에서 실패했을 때"만 호출된다. 기존 경로(top frame 성공)는
 * 이 모듈을 전혀 거치지 않으므로 동작과 응답이 그대로 유지된다.
 */

/** auto-chrome-mcp fork: click/fill 셀렉터 탐색 시 조사할 최대 프레임 수 */
export const FRAME_SEARCH_MAX_FRAMES = 20;

/** auto-chrome-mcp fork: read_page allFrames 수집 시 사용할 최대 프레임 수(top frame 포함) */
export const FRAME_COLLECT_MAX_FRAMES = 10;

/** auto-chrome-mcp fork: 프레임 하나당 probe 응답 대기 상한 */
export const FRAME_PROBE_TIMEOUT_MS = 1500;

/** auto-chrome-mcp fork: probe 메시지 action 이름 규칙 — `${toolName}_probe_selector` */
export function probeActionFor(toolName: string): string {
  return `${toolName}_probe_selector`;
}

export interface FrameInfo {
  frameId: number;
  frameUrl: string;
}

export interface FrameProbeHit extends FrameInfo {
  /** 해당 프레임에서 요소가 실제로 보이는 상태였는지 */
  visible: boolean;
  tagName?: string | null;
}

export type FrameInjectFn = (tabId: number, files: string[], frameIds?: number[]) => Promise<void>;
export type FrameSendFn = (tabId: number, message: any, frameId?: number) => Promise<any>;

const NOT_FOUND_PATTERNS: RegExp[] = [
  /not found/i,
  /no element/i,
  /cannot find/i,
  /could not be found/i,
  /no matching element/i,
];

const CONNECTION_ERROR_PATTERNS: RegExp[] = [
  /receiving end does not exist/i,
  /could not establish connection/i,
  /message port closed/i,
  /the tab was closed/i,
];

/**
 * auto-chrome-mcp fork: "요소를 못 찾음" 계열 오류인지 판별.
 * 연결/주입 실패(Receiving end does not exist 등)는 프레임 탐색 대상이 아니므로 제외한다.
 */
export function isElementNotFoundError(message: unknown): boolean {
  const text = message instanceof Error ? message.message : String(message ?? '');
  if (!text) return false;
  if (CONNECTION_ERROR_PATTERNS.some((p) => p.test(text))) return false;
  return NOT_FOUND_PATTERNS.some((p) => p.test(text));
}

/**
 * auto-chrome-mcp fork: 탐색 대상이 될 수 있는 프레임 URL 인지 판별.
 * about:blank, 확장/브라우저 내부 페이지는 건너뛴다(about:srcdoc 는 실제 콘텐츠이므로 유지).
 */
export function isProbeableFrameUrl(url: string | undefined | null): boolean {
  const u = String(url ?? '').trim();
  if (!u) return false;
  if (u === 'about:blank') return false;
  if (/^(chrome|chrome-extension|chrome-untrusted|devtools|moz-extension|edge):/i.test(u)) {
    return false;
  }
  return true;
}

/**
 * auto-chrome-mcp fork: 탭의 모든 프레임 열거(top frame 0 포함, frameId 오름차순).
 * webNavigation 권한이 없거나 실패하면 빈 배열을 돌려준다(호출부는 기존 동작으로 폴백).
 */
export async function listAllFrames(
  tabId: number,
  maxFrames: number = FRAME_SEARCH_MAX_FRAMES,
): Promise<FrameInfo[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames || !Array.isArray(frames)) return [];
    const seen = new Set<number>();
    const out: FrameInfo[] = [];
    for (const f of frames) {
      const frameId = typeof f?.frameId === 'number' ? f.frameId : -1;
      if (frameId < 0 || seen.has(frameId)) continue;
      seen.add(frameId);
      out.push({ frameId, frameUrl: String(f?.url ?? '') });
    }
    out.sort((a, b) => a.frameId - b.frameId);
    return out.slice(0, Math.max(0, maxFrames));
  } catch (error) {
    console.warn('[frame-resolver] getAllFrames failed:', error);
    return [];
  }
}

/**
 * auto-chrome-mcp fork: top frame(0) 을 제외한 탐색 가능한 하위 프레임만 열거.
 */
export async function listChildFrames(
  tabId: number,
  maxFrames: number = FRAME_SEARCH_MAX_FRAMES,
): Promise<FrameInfo[]> {
  // 필터링 후 cap 을 적용해야 하므로 넉넉히 받아온 뒤 자른다.
  const all = await listAllFrames(tabId, Number.MAX_SAFE_INTEGER);
  const filtered = all.filter((f) => f.frameId !== 0 && isProbeableFrameUrl(f.frameUrl));
  return filtered.slice(0, Math.max(0, maxFrames));
}

/**
 * auto-chrome-mcp fork: 특정 frameId 의 URL 조회(응답에 frameUrl 을 실어주기 위한 용도).
 */
export async function resolveFrameInfo(tabId: number, frameId: number): Promise<FrameInfo | null> {
  const all = await listAllFrames(tabId, Number.MAX_SAFE_INTEGER);
  return all.find((f) => f.frameId === frameId) ?? null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

export interface SearchFramesParams {
  tabId: number;
  /** probe action 을 구현한 helper 파일 (예: 'inject-scripts/click-helper.js') */
  probeFile: string;
  /** probe 메시지 action (예: 'chrome_click_element_probe_selector') */
  probeAction: string;
  selector?: string;
  ref?: string;
  /** selector 가 XPath 인 경우 true */
  isXPath?: boolean;
  inject: FrameInjectFn;
  send: FrameSendFn;
  maxFrames?: number;
}

/**
 * auto-chrome-mcp fork: 하위 프레임들을 돌면서 셀렉터/ref 가 존재하는 첫 프레임을 찾는다.
 *
 * - 프레임마다 개별적으로 helper 를 주입한다(injectContentScript 의 ping 은 frameIds[0] 만 확인하므로
 *   여러 frameId 를 한 번에 넘기면 일부 프레임에 주입이 누락될 수 있다).
 * - probe 는 부수효과가 없는 조회 전용 메시지이며, 응답은 {found, visible} 형태다.
 * - 보이는(visible) 프레임을 우선 선택하고, 없으면 found 인 첫 프레임을 선택한다.
 */
export async function searchFramesForTarget(
  params: SearchFramesParams,
): Promise<FrameProbeHit | null> {
  const {
    tabId,
    probeFile,
    probeAction,
    selector,
    ref,
    isXPath,
    inject,
    send,
    maxFrames = FRAME_SEARCH_MAX_FRAMES,
  } = params;

  if (!selector && !ref) return null;

  const frames = await listChildFrames(tabId, maxFrames);
  if (frames.length === 0) return null;

  const probeOne = async (frame: FrameInfo): Promise<FrameProbeHit | null> => {
    try {
      await inject(tabId, [probeFile], [frame.frameId]);
    } catch (error) {
      // 주입 불가(예: 접근 제한 프레임)는 조용히 건너뛴다.
      return null;
    }
    try {
      const resp = await withTimeout(
        send(tabId, { action: probeAction, selector, ref, isXPath: !!isXPath }, frame.frameId),
        FRAME_PROBE_TIMEOUT_MS,
        `frame ${frame.frameId} probe`,
      );
      if (resp && resp.found === true) {
        return {
          frameId: frame.frameId,
          frameUrl: frame.frameUrl,
          visible: resp.visible === true,
          tagName: typeof resp.tagName === 'string' ? resp.tagName : null,
        };
      }
    } catch (error) {
      // probe 실패한 프레임은 후보에서 제외
    }
    return null;
  };

  const settled = await Promise.allSettled(frames.map((f) => probeOne(f)));
  const hits: FrameProbeHit[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) hits.push(s.value);
  }
  if (hits.length === 0) return null;

  // 프레임 순서를 유지한 채, 보이는 요소를 가진 프레임을 우선한다.
  hits.sort((a, b) => a.frameId - b.frameId);
  return hits.find((h) => h.visible) ?? hits[0];
}
