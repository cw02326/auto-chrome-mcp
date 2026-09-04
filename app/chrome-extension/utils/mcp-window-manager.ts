/**
 * MCP work-window policy + tracker (auto-chrome-mcp fork).
 *
 * MCP 작업 탭을 "어느 창에" 만들지 결정한다. 두 가지 모드:
 *
 *  - 'dedicated' — MCP 작업 탭들을 별도의 "MCP 작업 창" 하나에 모아 사용자 창과
 *    물리적으로 분리한다. 창은 항상 focused:false 로 만들고, 배치 설정(minimized/offscreen)에
 *    따라 사용자 바탕화면에 나타나지 않게 둔다. 탭 활성화는 이 창 안에서만 일어나므로
 *    사용자가 보던 탭·창은 절대 바뀌지 않는다.
 *
 *  - 'current' (기본) — 사용자가 이미 열어 둔 일반 크롬 창에 **새 탭**을 만든다.
 *    탭은 항상 비활성(백그라운드)으로 생성해 사용자가 보던 탭을 뺏지 않는다.
 *    스크린샷·읽기는 CDP 경로라 탭이 보이지 않아도 정상 동작한다.
 *
 * 어느 모드든 실패는 null 로 흘려보낸다 — 호출부는 반드시 기존 동작으로 graceful fallback.
 *
 * 창 id 는 chrome.storage.session 에 persist + in-memory 캐시
 * (MV3 service worker 가 수시로 죽으므로. 브라우저 재시작 시 초기화 — 의도된 수명)
 */

import { beginFocusWatch, scheduleDeferredUnfocus } from './window-focus-guard';

export type WorkWindowMode = 'current' | 'dedicated';

/**
 * 전용 작업 창을 화면에서 어떻게 숨길지.
 *  - 'minimized'  : 만든 직후 최소화한다. 작업 표시줄에만 남는다. (2026-09-02 실측 기본값)
 *  - 'offscreen'  : 화면 밖 좌표로 민다. **실측(2026-09-02, Chrome/Windows 11)에서는 크롬이
 *                   "Bounds must be at least 50% within visible screen space" 로 거부했다.**
 *                   거부되면 자동으로 최소화로 대체한다.
 *  - 'visible'    : 예전 동작. 보이는 일반 창 — 디버깅용.
 *
 * ⚠️ chrome.windows.create 의 state 인자는 실측에서 무시됐다(만들어 보면 'normal').
 * 그래서 배치는 **창을 만든 뒤 windows.update 로** 적용한다.
 */
export type WorkWindowPlacement = 'minimized' | 'offscreen' | 'visible';

const MODE_STORAGE_KEY = 'mcpWorkWindowMode';
/** v1.3.0 이전의 boolean 설정 — true = dedicated, false = current */
const LEGACY_STORAGE_KEY = 'dedicatedWorkWindow';
const PLACEMENT_STORAGE_KEY = 'mcpWorkWindowPlacement';
const SESSION_KEY = 'mcpWorkWindowId';

const MCP_WINDOW_WIDTH = 1280;
const MCP_WINDOW_HEIGHT = 900;

/** 'offscreen' 배치에서 창을 밀어 둘 좌표. 크롬이 화면 안으로 되돌리면 로그만 남긴다. */
const OFFSCREEN_LEFT = -32000;
const OFFSCREEN_TOP = -32000;
/** 클램핑 판정 허용 오차(px). 크롬은 좌표를 몇 px 조정하는 일이 있다. */
const CLAMP_TOLERANCE_PX = 50;

/** 최소화 전 워밍업(프레임 1장 강제) 소유자 태그와 상한 */
const WARMUP_OWNER = 'work-window-warmup';
/**
 * 워밍업 상한. 그려지는 탭이면 수십 ms 안에 돌아온다 — 이 상한에 걸린다는 것은
 * "이 탭은 프레임을 만들지 못한다" 는 뜻이므로 길게 기다릴 이유가 없다.
 */
const WARMUP_TIMEOUT_MS = 1500;

/**
 * 기본 모드는 'current' — 사용자가 열어 둔 창에 백그라운드 탭을 만든다(2026-09-04 사용자 지시).
 * v1.9.0 에서 잠시 'dedicated' 였으나 작업마다 새 창이 생기는 것이 더 방해가 됐다.
 */
export const DEFAULT_WORK_WINDOW_MODE: WorkWindowMode = 'current';

/**
 * 기본 배치. 2026-09-02 실기 측정으로 확정했다 — 근거는 docs/CHANGELOG.md v1.9.0 과
 * docs/plans/2026-09-02-no-interference-mode-design.md 의 "실측 기록" 절.
 */
export const DEFAULT_WORK_WINDOW_PLACEMENT: WorkWindowPlacement = 'minimized';

/**
 * 현재 작업 창 모드.
 *
 * **확정된 우선순위 (설계 J)**: 신규 키 `mcpWorkWindowMode` > 구버전 키
 * `dedicatedWorkWindow` > 기본값 `'current'`.
 *
 *   1. `mcpWorkWindowMode` 가 'current' | 'dedicated' 이면 그 값.
 *   2. 없으면 구버전 boolean `dedicatedWorkWindow` 를 해석한다 (true → 'dedicated',
 *      false → 'current'). 예전에 토글을 껐던 사용자는 여기서 'current' 로 남는다.
 *   3. **두 키가 모두 없을 때만** 기본값 'current' 가 적용된다.
 *
 * 즉 저장값은 언제나 기본값보다 우선한다. 저장된 설정을 권장값(current)으로 되돌리는 통로는
 * 팝업의 "무간섭 권장 설정으로 되돌리기" 버튼이다.
 */
export async function getWorkWindowMode(): Promise<WorkWindowMode> {
  try {
    const result = await chrome.storage.local.get([MODE_STORAGE_KEY, LEGACY_STORAGE_KEY]);
    const mode = result[MODE_STORAGE_KEY];
    if (mode === 'current' || mode === 'dedicated') return mode;
    const legacy = result[LEGACY_STORAGE_KEY];
    if (legacy === true) return 'dedicated';
    if (legacy === false) return 'current';
    return DEFAULT_WORK_WINDOW_MODE;
  } catch {
    return DEFAULT_WORK_WINDOW_MODE;
  }
}

/**
 * 모드 저장. legacy boolean 도 함께 동기화해 구버전 코드/설정 화면과 어긋나지 않게 한다.
 */
export async function setWorkWindowMode(mode: WorkWindowMode): Promise<void> {
  await chrome.storage.local.set({
    [MODE_STORAGE_KEY]: mode,
    [LEGACY_STORAGE_KEY]: mode === 'dedicated',
  });
}

/** 전용 작업 창 배치. 저장값이 없으면 기본값. */
export async function getWorkWindowPlacement(): Promise<WorkWindowPlacement> {
  try {
    const result = await chrome.storage.local.get([PLACEMENT_STORAGE_KEY]);
    const placement = result[PLACEMENT_STORAGE_KEY];
    if (placement === 'minimized' || placement === 'offscreen' || placement === 'visible') {
      return placement;
    }
    return DEFAULT_WORK_WINDOW_PLACEMENT;
  } catch {
    return DEFAULT_WORK_WINDOW_PLACEMENT;
  }
}

export async function setWorkWindowPlacement(placement: WorkWindowPlacement): Promise<void> {
  await chrome.storage.local.set({ [PLACEMENT_STORAGE_KEY]: placement });
}

/** 하위 호환 wrapper — 'dedicated' 모드인지 여부. */
export async function isDedicatedWindowEnabled(): Promise<boolean> {
  return (await getWorkWindowMode()) === 'dedicated';
}

/** 하위 호환 wrapper. */
export async function setDedicatedWindowEnabled(enabled: boolean): Promise<void> {
  await setWorkWindowMode(enabled ? 'dedicated' : 'current');
}

export const WORK_WINDOW_MODE_STORAGE_KEY = MODE_STORAGE_KEY;
export const DEDICATED_WINDOW_STORAGE_KEY = LEGACY_STORAGE_KEY;
export const WORK_WINDOW_PLACEMENT_STORAGE_KEY = PLACEMENT_STORAGE_KEY;

/**
 * 전용 작업 창 표지 (2026-09-02 독립 검토 반영).
 *
 * 창 id 만 기억하면 크롬이 그 id 를 **다른 창에 재사용**했을 때 사용자 창을 "우리 작업 창"
 * 으로 오인한다. 그러면 activation-guard 가 사용자 탭 활성화를 허용해 버린다.
 * 그래서 id 와 함께 "우리가 만든 창" 이라는 표지를 남기고, 확인할 때 대조한다.
 *
 *  - `createdAt` : 만든 시각(진단용)
 *  - `type`      : 만들 때의 창 type. 지금 창의 type 과 달라지면 다른 창이다.
 *  - `tabIds`    : 우리가 그 창에 만든 탭 id 들. 그중 하나라도 아직 그 창에 있어야 한다.
 *                  (탭 id 는 창 id 보다 훨씬 늦게 재사용된다)
 */
interface WorkWindowMarker {
  id: number;
  createdAt: number;
  type: string;
  tabIds: number[];
}

/** 표지에 남기는 탭 id 최대 개수 (오래된 것부터 버린다) */
const MARKER_MAX_TAB_IDS = 8;

let cachedMarker: WorkWindowMarker | null = null;
let cacheLoaded = false;
// 동시 호출(병렬 navigate)이 창을 두 개 만들지 않도록 생성 중인 promise 를 공유
let creating: Promise<number | null> | null = null;

function normalizeMarker(raw: unknown): WorkWindowMarker | null {
  // 구버전(숫자만 저장) 호환 — 표지가 없으므로 탭 대조는 건너뛴다.
  if (typeof raw === 'number') {
    return { id: raw, createdAt: 0, type: 'normal', tabIds: [] };
  }
  if (raw && typeof raw === 'object') {
    const m = raw as Partial<WorkWindowMarker>;
    if (typeof m.id === 'number') {
      return {
        id: m.id,
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
        type: typeof m.type === 'string' ? m.type : 'normal',
        tabIds: Array.isArray(m.tabIds) ? m.tabIds.filter((t) => typeof t === 'number') : [],
      };
    }
  }
  return null;
}

/**
 * auto-chrome-mcp fork(F4): 표지 변경을 한 줄로 세운다.
 *
 * registerWorkWindowTab 은 표지를 읽어 복제한 뒤 저장하는 read-modify-write 였다. 두 레인이
 * 동시에 작업 탭을 등록하면 둘 다 옛 표지를 복제하므로 마지막 write 만 남고, 살아남지 못한
 * 탭은 표지에서 사라졌다. 표지에 남은 탭이 먼저 닫히면 "우리가 만든 창" 증명이 깨져
 * 멀쩡한 전용 작업 창을 버리고 새 창을 만든다.
 */
let markerQueue: Promise<unknown> = Promise.resolve();

function withMarkerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = markerQueue.then(fn, fn);
  // 큐는 실패로 멈추지 않는다.
  markerQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let markerLoad: Promise<WorkWindowMarker | null> | null = null;

async function loadMarker(): Promise<WorkWindowMarker | null> {
  if (cacheLoaded) return cachedMarker;
  // 동시 첫 접근이 storage 를 각자 읽지 않게 promise 를 공유한다 (F4).
  if (markerLoad === null) {
    markerLoad = (async () => {
      try {
        const result = await chrome.storage.session.get([SESSION_KEY]);
        cachedMarker = normalizeMarker(result[SESSION_KEY]);
      } catch {
        cachedMarker = null;
      }
      cacheLoaded = true;
      return cachedMarker;
    })();
  }
  return await markerLoad;
}

/** 기록된 창 id (표지 검증 없이 id 만). 'current' 모드의 후보 제외용. */
async function loadCache(): Promise<number | null> {
  return (await loadMarker())?.id ?? null;
}

/** 표지를 그대로 덮어쓴다. 락을 잡지 않으므로 임계 구역 안에서만 부를 것. */
async function writeMarker(marker: WorkWindowMarker | null): Promise<void> {
  cachedMarker = marker;
  cacheLoaded = true;
  try {
    if (marker === null) {
      await chrome.storage.session.remove(SESSION_KEY);
    } else {
      await chrome.storage.session.set({ [SESSION_KEY]: marker });
    }
  } catch {
    // storage.session 실패해도 in-memory 캐시로 동작
  }
}

/**
 * 두 표지가 같은 기록인가 (compare-and-clear 의 비교 기준).
 *
 * 무효화는 "내가 읽은 그 표지" 에만 해야 한다. 판정이 크롬 API 를 기다리는 사이 다른
 * 레인이 새 작업 탭을 등록했거나 창을 다시 만들었으면, 그 새 표지는 지우면 안 된다.
 */
function sameMarker(a: WorkWindowMarker | null, b: WorkWindowMarker | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.createdAt === b.createdAt &&
    a.type === b.type &&
    a.tabIds.length === b.tabIds.length &&
    a.tabIds.every((id, i) => id === b.tabIds[i])
  );
}

/**
 * 전용 작업 창에 우리가 만든 탭을 표지에 등록한다.
 * 창 생성 시 함께 생긴 about:blank 탭은 곧 정리되므로, 작업 탭을 만들 때마다 불러야
 * 표지가 살아 있는 탭을 가리킨다.
 */
export async function registerWorkWindowTab(windowId: number, tabId?: number): Promise<void> {
  if (typeof tabId !== 'number') return;
  // auto-chrome-mcp fork(F4): 읽기·판정·저장이 한 임계 구역이어야 한다. 락을 잡은 안에서는
  // 락을 다시 잡지 않는 writeMarker 를 쓴다 (재진입 = 교착).
  return await withMarkerLock(async () => {
    const marker = await loadMarker();
    if (!marker || marker.id !== windowId) return;
    if (marker.tabIds.includes(tabId)) return;
    const tabIds = [...marker.tabIds, tabId].slice(-MARKER_MAX_TAB_IDS);
    await writeMarker({ ...marker, tabIds });
  });
}

export interface ManagedWindowOptions {
  url?: string;
  width?: number;
  height?: number;
  /**
   * true 면 배치·비포커스 규칙을 건너뛰고 사용자 앞에 띄운다.
   * **강제 포커스 정책을 이미 통과한 호출부만** 넘길 것.
   */
  focused?: boolean;
  /** 배치 설정을 강제로 지정(테스트·디버깅용). 없으면 저장값. */
  placement?: WorkWindowPlacement;
  /**
   * true 면 창을 만든 직후에는 배치를 적용하지 않는다.
   *
   * 전용 작업 창은 about:blank 로 만든 뒤 **그 다음에** 작업 탭이 생긴다. 창을 먼저
   * 최소화해 버리면 나중에 만들어지는 그 탭이 한 번도 그려지지 않아 CDP 캡처가 멎는다
   * (2026-09-02 실측). 그래서 작업 탭을 만든 호출부가 applyWorkWindowPlacement 를
   * 직접 부른다.
   */
  deferPlacement?: boolean;
}

/**
 * 이 확장에서 창을 만드는 **유일한 통로**(설계 H.3).
 *
 * - focused:true 가 아니면 항상 focused:false + 배치 규칙(minimized/offscreen) 적용.
 * - 생성 직전 사용자 창을 기록해 두고, 생성 후 지연 이중 비포커스 + 필요 시 사용자 창 복귀.
 *
 * 실패하면 null — 호출부는 기존 동작으로 fallback 해야 한다.
 */
export async function createManagedWindow(
  options: ManagedWindowOptions = {},
): Promise<chrome.windows.Window | null> {
  const { url, width, height, focused = false } = options;

  if (focused) {
    // 강제 포커스 정책을 통과한 명시적 요청 — 예전 동작 그대로.
    const created = await chrome.windows.create({
      url,
      width: typeof width === 'number' ? width : MCP_WINDOW_WIDTH,
      height: typeof height === 'number' ? height : MCP_WINDOW_HEIGHT,
      focused: true,
      type: 'normal',
    });
    return created ?? null;
  }

  const placement = options.placement ?? (await getWorkWindowPlacement());
  // 복귀 대상은 "지금 실제로 포커스를 쥐고 있는 사용자 창" — 창을 만들기 **전에** 기록한다.
  const userWindowId = await getFocusRestoreTargetWindowId();

  const createData: chrome.windows.CreateData = {
    // 절대 focused: true 로 바꾸지 말 것 — 사용자 작업 중 OS 포커스를 뺏는다.
    focused: false,
    url,
    type: 'normal',
  };

  // 배치는 create 인자로 지정하지 않는다 — state 는 무시되고, 좌표는 화면 밖이면 거부된다.
  createData.width = typeof width === 'number' ? width : MCP_WINDOW_WIDTH;
  createData.height = typeof height === 'number' ? height : MCP_WINDOW_HEIGHT;

  // ⚠️ 포커스 감시는 창을 만들기 **전에** 시작한다. 생성과 리스너 등록 사이에 오는
  // 포커스 이벤트를 놓치면 "사용자가 이미 다른 앱으로 갔다"를 못 보고 복귀해 버린다.
  const watch = beginFocusWatch(userWindowId);
  let created: chrome.windows.Window | undefined;
  try {
    created = await chrome.windows.create(createData);
  } catch (error) {
    watch.dispose();
    throw error;
  }
  if (!created) {
    watch.dispose();
    return null;
  }

  // id 가 없는 응답(구버전 목/특이 케이스)이면 배치·복귀 장치는 걸 수 없지만 창 자체는 돌려준다.
  if (typeof created.id !== 'number') {
    watch.dispose();
    return created;
  }

  // 비포커스·복귀 예약을 먼저 걸어 둔다 — 배치(워밍업)에 시간이 걸려도 보호가 늦지 않게.
  watch.arm(created.id);
  if (options.deferPlacement !== true) {
    await applyWorkWindowPlacement(created.id, placement);
  }
  return created;
}

/**
 * 이미 있는 전용 작업 창을 대상으로 포커스 보호를 예약한다 (2026-09-02 독립 검토 반영).
 *
 * **기존 창을 재사용하는 경로에도 반드시 필요하다.** 비포커스 창에 `active:true` 탭을
 * 만들면 그 창이 포커스를 가져간다(실측). 창을 새로 만들 때만 보호를 걸어 두면 두 번째
 * lane, `newTab:true`, 작업 탭이 닫힌 뒤의 재생성부터 보장이 깨진다.
 */
export async function protectWorkWindowFocus(windowId: number): Promise<void> {
  try {
    const userWindowId = await getFocusRestoreTargetWindowId();
    scheduleDeferredUnfocus(windowId, userWindowId);
  } catch (error) {
    console.warn('[mcp-window-manager] 포커스 보호 예약 실패:', error);
  }
}

/**
 * 포커스를 되돌릴 사용자 창 (2026-09-02 독립 검토 반영).
 *
 * `getCurrentUserWindowId()` 는 "탭을 붙일 창"을 고르는 함수라 포커스가 없어도 마지막
 * 포커스 창을 돌려준다. 복귀 대상으로는 그러면 안 된다 — 사용자가 이미 크롬 밖(메모장 등)
 * 에 있는데 크롬 창을 앞으로 끌어내게 된다. **지금 실제로 포커스를 쥔 창만** 복귀 대상이다.
 * 그런 창이 없으면 null 이고, 그러면 비포커스만 걸고 복귀는 하지 않는다.
 */
export async function getFocusRestoreTargetWindowId(): Promise<number | null> {
  try {
    const dedicatedId = await loadCache();
    const all = await chrome.windows.getAll({ populate: false });
    const focused = all.find(
      (w) =>
        w.focused === true &&
        w.type === 'normal' &&
        typeof w.id === 'number' &&
        w.id !== dedicatedId &&
        !w.incognito,
    );
    return focused?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 전용 작업 창을 배치 설정대로 화면에서 치운다.
 *
 * **창을 만든 직후뿐 아니라 그 창에 탭을 만든 뒤에도 다시 불러야 한다** — 최소화된 창에
 * 활성 탭을 만들면 크롬이 창을 복원해 사용자 화면에 띄우는 경우가 있다.
 *
 * ⚠️ 최소화 전에 반드시 프레임을 한 번 뽑는다(warmUpWindow). 2026-09-02 실측:
 * **한 번도 그려진 적 없는 창을 최소화하면 그 창의 CDP `Page.captureScreenshot` 이
 * 영영 돌아오지 않는다**(스크린샷 도구가 통째로 멎는다). 한 번 그려진 뒤에 최소화한
 * 창은 그 뒤로 다른 페이지로 이동해도 캡처가 정상이었다. 워밍업에 실패하면 최소화하지
 * 않고 비포커스 상태로 남긴다 — 창이 보이는 것보다 캡처가 죽는 쪽이 더 나쁘다.
 */
export async function applyWorkWindowPlacement(
  windowId: number,
  placement?: WorkWindowPlacement,
): Promise<void> {
  const target = placement ?? (await getWorkWindowPlacement());
  if (target === 'visible') return;

  if (target === 'offscreen' && (await tryPushOffscreen(windowId))) return;

  if (!(await warmUpWindow(windowId))) {
    // 2026-09-02 실측: 비포커스로 되돌린 창이 사용자의 최대화 창에 완전히 가려지면
    // 렌더러가 프레임을 만들지 않는다 → 그 창의 새 탭은 영영 캡처되지 않는다.
    // 캡처가 죽는 것보다는 창이 잠깐 앞에 나오는 편이 낫다. 포커스 보호를 새로 걸고
    // 딱 한 번 앞으로 꺼내 워밍업한 뒤, 아래에서 다시 치운다.
    await protectWorkWindowFocus(windowId);
    try {
      await chrome.windows.update(windowId, { focused: true });
    } catch {
      // 포커스를 못 줘도 아래 재시도는 해 본다.
    }
    if (!(await warmUpWindow(windowId))) {
      console.warn(
        '[mcp-window-manager] 작업 창 워밍업 실패 — 최소화하지 않는다(캡처가 멎는 것을 막기 위해).',
      );
      return;
    }
  }

  try {
    await chrome.windows.update(windowId, { state: 'minimized' });
  } catch (error) {
    console.warn('[mcp-window-manager] 작업 창 최소화 실패:', error);
  }
}

/** 최소화 전에 창이 실제로 한 번 그려지게 만든다. 성공하면 true. */
async function warmUpWindow(windowId: number): Promise<boolean> {
  // cdp-session-manager 는 import 시점에 chrome.debugger 리스너를 등록한다 —
  // 그 API 가 없는 컨텍스트(팝업·테스트)에서 이 모듈을 못 쓰게 되므로 지연 import 한다.
  let cdp: typeof import('./cdp-session-manager').cdpSessionManager;
  let tabId: number | undefined;
  try {
    cdp = (await import('./cdp-session-manager')).cdpSessionManager;
    const win = await chrome.windows.get(windowId);
    // 이미 최소화된 창이면(재적용 경로) 다시 그릴 수단이 없다 — 그대로 둔다.
    if (win?.state === 'minimized') return true;
    const tabs = await chrome.tabs.query({ active: true, windowId });
    tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') return false;
    await cdp.attach(tabId, WARMUP_OWNER);
  } catch {
    return false;
  }

  try {
    const capture = cdp.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 1,
    });
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), WARMUP_TIMEOUT_MS),
    );
    const result = await Promise.race([capture, timeout]);
    return result !== 'timeout';
  } catch {
    return false;
  } finally {
    try {
      await cdp.detach(tabId, WARMUP_OWNER);
    } catch {
      // ignore
    }
  }
}

/**
 * 최소화된 전용 작업 창에 **새 탭을 만들기 전에** 잠깐 창을 되돌린다.
 *
 * 2026-09-02 실측: 최소화된 창에 새로 만든 탭은 한 번도 그려지지 않아 그 탭의 CDP
 * `Page.captureScreenshot` 이 영영 돌아오지 않는다(스크린샷 도구가 멎는다). 창을 만들 때
 * 한 번 워밍업하는 것만으로는 부족하다 — **탭마다** 최초 1회 그려져야 한다.
 * 병렬 lane 처럼 작업 창에 탭이 늘어나는 경우가 정확히 이 상황이다.
 *
 * 되돌리면 그 창이 잠깐 포커스를 가져가므로, 호출부는 **이 함수를 부르기 전에**
 * protectWorkWindowFocus() 로 보호를 예약해야 한다. 탭을 만든 뒤
 * applyWorkWindowPlacement() 가 워밍업하고 다시 최소화한다.
 *
 * @returns 실제로 되돌렸으면 true
 */
export async function prepareWorkWindowForNewTab(windowId: number): Promise<boolean> {
  try {
    const placement = await getWorkWindowPlacement();
    if (placement !== 'minimized') return false;
    const win = await chrome.windows.get(windowId);
    if (win?.state !== 'minimized') return false;
    // 포커스 억제를 명시한다. (실측상 크롬이 복원 시 포커스를 주는 경우가 있어
    //  이 인자만으로 완전히 막히지는 않는다 — CHANGELOG "알려진 한계" 참조)
    await chrome.windows.update(windowId, {
      state: 'normal',
      focused: false,
      drawAttention: false,
    });
    return true;
  } catch (error) {
    console.warn('[mcp-window-manager] 새 탭을 위한 작업 창 복원 실패:', error);
    return false;
  }
}

/** 배치 재적용을 조금 뒤에 한 번 더 — 탭 생성 직후 크롬이 창을 되살리는 경우 대비. */
export function reapplyWorkWindowPlacementSoon(windowId: number, delayMs = 800): void {
  setTimeout(() => {
    void applyWorkWindowPlacement(windowId);
  }, delayMs);
}

/**
 * 'offscreen' 배치 시도. 성공하면 true.
 *
 * 실측(2026-09-02): 크롬은 화면 밖 좌표를 아예 거부한다
 * ("Invalid value for bounds. Bounds must be at least 50% within visible screen space").
 * 좌표를 받아들이더라도 화면 안으로 되돌리는(클램핑) 환경이 있으므로 결과를 다시 읽어 확인한다.
 * 둘 중 하나라도 걸리면 false 를 돌려주고 호출부가 최소화로 대체한다.
 */
async function tryPushOffscreen(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.update(windowId, { left: OFFSCREEN_LEFT, top: OFFSCREEN_TOP });
    const after = await chrome.windows.get(windowId);
    const clamped =
      typeof after?.left === 'number' && after.left > OFFSCREEN_LEFT + CLAMP_TOLERANCE_PX;
    if (!clamped) return true;
    console.warn(
      '[mcp-window-manager] offscreen 좌표가 클램핑됐다 (left=' +
        String(after?.left) +
        ') — 최소화로 대체한다.',
    );
    return false;
  } catch (error) {
    console.warn(
      '[mcp-window-manager] offscreen 배치를 크롬이 거부했다 — 최소화로 대체한다:',
      error,
    );
    return false;
  }
}

/**
 * "MCP 작업 창" id 를 반환. 없거나 이미 닫혔으면 새로 만든다 (항상 비포커스 + 배치 적용).
 * 어떤 이유로든 실패하면 null — 호출부는 기존 동작으로 fallback 해야 한다.
 */
export async function getOrCreateMcpWindow(): Promise<number | null> {
  try {
    const stored = await loadMarker();
    if (stored !== null) {
      // id 생존만 보면 크롬이 그 id 를 재사용했을 때 사용자 창을 작업 창으로 쓰게 된다.
      // isMcpWindow 와 **같은 완전 검증**을 거친다(표지 완전성 + type + 우리 탭 존재).
      // 어긋났으면 verifyWorkWindowMarker 가 compare-and-clear 로 이미 처리했다.
      if (await verifyWorkWindowMarker(stored.id)) return stored.id;
    }

    if (creating) return await creating;

    // 무효화·생성·기록을 한 임계 구역에서 끝낸다. 예전에는 판정 밖에서 persistMarker(null)
    // 을 한 번 더 불러, 그 사이 다른 레인이 만든 새 표지까지 지워 버렸다.
    creating = withMarkerLock(async () => {
      const current = await loadMarker();
      // 락을 기다리는 사이 다른 호출이 창을 만들었으면 그 표지를 믿고 그대로 쓴다.
      if (current !== null && !sameMarker(current, stored)) return current.id;
      // 여기까지 왔으면 표지는 (a) 판정이 이미 지웠거나 (b) stored 그대로다.
      if (current !== null) await writeMarker(null);

      // 배치(최소화)는 작업 탭이 만들어진 뒤에 적용한다 — 위 deferPlacement 주석 참조.
      const created = await createManagedWindow({ url: 'about:blank', deferPlacement: true });
      if (!created || typeof created.id !== 'number') return null;
      const firstTabId = created.tabs?.[0]?.id;
      await writeMarker({
        id: created.id,
        createdAt: Date.now(),
        type: created.type ?? 'normal',
        tabIds: typeof firstTabId === 'number' ? [firstTabId] : [],
      });
      return created.id;
    });

    try {
      return await creating;
    } finally {
      creating = null;
    }
  } catch (error) {
    console.warn('[mcp-window-manager] Failed to get/create MCP work window:', error);
    return null;
  }
}

/**
 * 'current' 모드용 — 사용자가 이미 열어 둔 창 중 작업 탭을 붙일 창 id.
 *
 * 선택 규칙 (앞순위부터):
 *   1) 마지막으로 포커스됐던 창이 적격이면 그 창
 *   2) 현재 포커스된 적격 창
 *   3) 남은 적격 창 중 첫 번째
 *
 * 적격 = type 'normal' (팝업·개발자도구·앱 창 제외) + 시크릿 아님(확장 권한 밖) +
 *        이전에 만들어 둔 전용 MCP 작업 창이 아님.
 * 열린 일반 창이 하나도 없으면 null — 호출부가 새 창 생성으로 fallback 한다.
 */
export async function getCurrentUserWindowId(): Promise<number | null> {
  try {
    const dedicatedId = await loadCache();
    const all = await chrome.windows.getAll({ populate: false });
    const usable = all.filter(
      (w) =>
        w.type === 'normal' && typeof w.id === 'number' && w.id !== dedicatedId && !w.incognito,
    );
    if (usable.length === 0) return null;

    try {
      const last = await chrome.windows.getLastFocused({ populate: false });
      const match = usable.find((w) => w.id === last?.id);
      if (match?.id !== undefined) return match.id;
    } catch {
      // getLastFocused 실패 — 아래 순위로 진행
    }

    const focused = usable.find((w) => w.focused);
    const picked = focused ?? usable[0];
    return picked.id ?? null;
  } catch (error) {
    console.warn('[mcp-window-manager] Failed to resolve current user window:', error);
    return null;
  }
}

/**
 * 표지를 끝까지 대조한다 — **기록은 고치지 않고** 판정만 돌려준다.
 *
 * 대조 항목:
 *   1. 표지가 완전한가 — 구버전(숫자만 저장) 형식이거나 우리가 만든 탭 기록이 없으면
 *      "우리가 만든 창" 이라고 증명할 수단이 없다. 신뢰하지 않는다.
 *   2. 창이 아직 살아 있는가.
 *   3. 창 type 이 만들 때와 같은가 — 크롬이 id 를 다른 창에 재사용했는지 본다.
 *   4. 우리가 만든 탭이 그 창에 아직 하나라도 있는가 — 탭 목록을 못 읽으면(populate 실패)
 *      증명 불가로 보고 false.
 *
 * 크롬 API 를 기다리는 구간이라 **락을 쥐지 않는다.** 무효화(clear)는 락 안에서
 * compare-and-clear 로 처리한다 — 판정 도중 다른 레인이 심은 새 표지를 지우지 않기 위해서다.
 */
async function judgeMarker(
  windowId: number,
  marker: WorkWindowMarker,
): Promise<{ ok: boolean; clear: boolean; reason?: string }> {
  if (marker.id !== windowId) return { ok: false, clear: false };

  // (1) 불완전한 표지는 신뢰하지 않는다.
  if (marker.createdAt <= 0 || !marker.type || marker.tabIds.length === 0) {
    return {
      ok: false,
      clear: true,
      reason: '작업 창 표지가 불완전하다(구버전 형식·탭 기록 없음)',
    };
  }

  let win: chrome.windows.Window | undefined;
  try {
    // (2) 창 생존
    win = await chrome.windows.get(windowId, { populate: true });
  } catch {
    // 창이 이미 닫혔다. 기록 정리는 onRemoved 리스너와 호출부가 한다.
    return { ok: false, clear: false };
  }
  if (!win) return { ok: false, clear: false };

  // (3) type 일치
  if (typeof win.type === 'string' && win.type !== marker.type) {
    return { ok: false, clear: true, reason: '기록된 작업 창과 type 이 다르다(창 id 재사용)' };
  }

  // (4) 우리가 만든 탭이 아직 그 창에 있는가
  if (!Array.isArray(win.tabs)) {
    return { ok: false, clear: true, reason: '작업 창의 탭 목록을 읽지 못했다' };
  }
  const liveTabIds = new Set(win.tabs.map((t) => t.id));
  if (!marker.tabIds.some((id) => liveTabIds.has(id))) {
    return { ok: false, clear: true, reason: '기록된 작업 탭이 그 창에 하나도 없다' };
  }

  return { ok: true, clear: false };
}

/**
 * 판정에서 읽었던 표지와 지금 표지가 같을 때만 지운다 (compare-and-clear).
 *
 * 예전에는 판정과 무효화가 따로 놀았다. verifyWorkWindowMarker 가 chrome.windows.get 을
 * 기다리는 사이 registerWorkWindowTab 이 살아 있는 새 작업 탭을 표지에 등록해도, 판정이
 * 끝나면 그 새 표지를 통째로 지웠다. 멀쩡한 전용 작업 창을 버리고 새 창을 만들 뿐 아니라,
 * 그 사이 isMcpWindow 가 false 를 답해 activation-guard 가 작업 창을 사용자 창으로 오인했다.
 */
async function clearMarkerIfUnchanged(
  snapshot: WorkWindowMarker,
  reason: string,
): Promise<boolean> {
  return await withMarkerLock(async () => {
    const current = await loadMarker();
    if (!sameMarker(current, snapshot)) {
      console.warn(
        '[mcp-window-manager] 판정 도중 표지가 갱신됐다 — 새 표지는 지우지 않는다: ' + reason,
      );
      return false;
    }
    console.warn(`[mcp-window-manager] ${reason} — 기록을 지우고 새로 만든다.`);
    await writeMarker(null);
    return true;
  });
}

/**
 * 표지를 대조하고, 어긋났으면 compare-and-clear 로 기록을 비운다.
 */
async function verifyWorkWindowMarker(windowId: number): Promise<boolean> {
  const snapshot = await loadMarker();
  if (snapshot === null || snapshot.id !== windowId) return false;

  const verdict = await judgeMarker(windowId, snapshot);
  if (verdict.ok) return true;
  if (verdict.clear) {
    await clearMarkerIfUnchanged(snapshot, verdict.reason ?? '작업 창 표지가 어긋났다');
  }
  return false;
}

/**
 * 주어진 창이 현재의 "MCP 작업 창" 인지 확인.
 *
 * id 일치만으로는 부족하다 — 크롬이 창 id 를 재사용하면 사용자 창을 작업 창으로 오인하고,
 * activation-guard 가 사용자 탭 활성화를 허용해 버린다. 표지를 끝까지 대조한다.
 *
 * 판정 결과는 캐시하지 않는다 — 창이 닫힌 직후에도 "우리 창" 이라고 답하면 안 된다.
 */
export async function isMcpWindow(windowId: number | undefined | null): Promise<boolean> {
  if (typeof windowId !== 'number') return false;
  try {
    return await verifyWorkWindowMarker(windowId);
  } catch {
    return false;
  }
}

/** 기록된 전용 작업 창 id (없으면 null). 창 생존 확인은 하지 않는다. */
export async function getMcpWindowId(): Promise<number | null> {
  try {
    return await loadCache();
  } catch {
    return null;
  }
}

/**
 * onRemoved 처리 본체 (테스트에서 직접 부를 수 있게 분리).
 *
 * 크롬은 창 id 를 재사용한다. 이전 작업 창의 지연된 onRemoved(id) 가 marker lock 뒤에서
 * 대기하는 동안 **같은 id 로 새 작업 창**이 생기면, id 만 비교하는 예전 코드는 새 표지를
 * 지웠다. 그러면 isMcpWindow() 가 false 가 되어 새 작업 창을 사용자 창으로 오인하고,
 * activation-guard 가 사용자 탭 활성화를 허용한다.
 *
 * 판정 기준은 **창 생존**이다 (2026-09-04 Codex 3차 검토로 순서 교체):
 *   1. **창 생존 확인이 먼저** — 그 id 의 창이 지금도 존재하면(chrome.windows.get 성공)
 *      크롬이 id 를 재사용한 **새 작업 창**이다. onRemoved 는 옛 창의 소멸이므로 지우지 않는다.
 *   2. 창이 없으면 진짜 닫힌 것이다 — 스냅샷(snapshotAtEvent) 일치 여부와 무관하게 지운다.
 *      예전에는 스냅샷 대조가 먼저였는데, 이벤트 이후 registerWorkWindowTab() 이 tabIds 만
 *      갱신하면 sameMarker() 가 false 가 되어 생존 확인도 못 하고 반환했고, 창이 닫혔는데
 *      표지가 남았다(stale marker → isMcpWindow 가 닫힌 창을 계속 작업 창으로 봤다).
 */
async function handleWindowRemoved(
  windowId: number,
  snapshotAtEvent: WorkWindowMarker | null,
): Promise<void> {
  await withMarkerLock(async () => {
    try {
      const marker = await loadMarker();
      if (marker === null || marker.id !== windowId) return;

      // (1) **창 생존 확인이 먼저다.** 그 id 의 창이 지금도 살아 있으면 재사용된 새 작업
      //     창이다 — 지우지 않는다. 없으면 창이 실제로 닫힌 것이므로 이 id 의 표지는
      //     어떤 스냅샷과도 무관하게 무효다.
      let stillExists = false;
      try {
        const win = await chrome.windows.get(windowId);
        stillExists = !!win;
      } catch {
        stillExists = false; // 창이 실제로 닫혔다.
      }
      if (stillExists) {
        console.warn(
          '[mcp-window-manager] onRemoved 된 id 로 창이 다시 존재한다(id 재사용) — 표지를 지우지 않는다.',
        );
        return;
      }

      // (2) 스냅샷 대조는 이제 **로그용**이다. 예전에는 이 판정이 (1) 보다 앞에 있어서,
      //     스냅샷 이후 registerWorkWindowTab() 이 tabIds 만 갱신하면(=sameMarker false)
      //     창이 진짜 닫혔는데도 표지가 남았다(stale marker). 창이 없다는 사실이
      //     스냅샷 일치 여부보다 강한 신호이므로 여기서는 지운다.
      if (snapshotAtEvent !== null && !sameMarker(marker, snapshotAtEvent)) {
        console.warn(
          '[mcp-window-manager] onRemoved 처리 중 표지가 갱신됐지만 창이 닫혀 있다 — 낡은 표지를 지운다.',
        );
      }

      await writeMarker(null);
    } catch {
      // ignore
    }
  });
}

// 사용자가 "MCP 작업 창"을 직접 닫으면 기록을 비운다 → 다음 요청 때 새 창 생성.
// (popup 등 chrome.windows 를 못 쓰는 컨텍스트에서 import 돼도 죽지 않도록 가드)
try {
  chrome.windows?.onRemoved?.addListener((windowId) => {
    // 이벤트 시점의 표지를 **동기로** 스냅샷 잡아 둔다. 임계 구역에 들어갈 때쯤이면 다른
    // 레인이 같은 id 로 새 작업 창을 만들어 표지를 갈아 끼웠을 수 있기 때문이다.
    const snapshotAtEvent = cachedMarker;
    void handleWindowRemoved(windowId, snapshotAtEvent);
  });
} catch {
  // ignore
}

/**
 * 테스트 전용 훅 — 프로덕션 경로는 위 addListener 를 쓴다. onRemoved 리스너는 모듈
 * import 시점에 등록되므로 테스트에서 그 콜백을 직접 잡기 어렵다. 재사용 경합을 결정적으로
 * 재현하기 위해 본체를 이렇게 노출한다.
 */
export const __testing = {
  handleWindowRemoved,
};
