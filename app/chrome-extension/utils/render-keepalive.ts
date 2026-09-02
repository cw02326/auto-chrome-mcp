import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * auto-chrome-mcp fork: 백그라운드(비활성) 탭 렌더링 유지.
 *
 * 크롬은 비활성 탭의 렌더링 프레임 생성을 멈춘다. 그래서 백그라운드 작업 탭에서는
 * requestAnimationFrame 이 돌지 않고, 무한 스크롤이 의존하는 IntersectionObserver 가
 * 발화하지 않는다 — 스크롤 위치는 바뀌어도 "다음 페이지 로드"가 영원히 걸리지 않는다.
 * (사용자 눈에는 "20개에서 멈추고 푸터가 뜬다"로 보인다.)
 *
 * 프레임을 강제하는 수단은 CDP `Page.captureScreenshot` 이다. 캡처는 렌더러에 프레임
 * 생산을 요구하므로 숨은 탭에서도 렌더링 라이프사이클이 한 번 돌고, 그때 밀려 있던
 * IntersectionObserver 가 발화한다. 다만 효과는 캡처 직후 300ms 남짓이라 작업이 끝날
 * 때까지 일정 간격으로 계속 눌러 줘야 한다(= frame pump).
 *
 * ⚠️ `Page.startScreencast` 는 쓰지 않는다. 스크린캐스트는 "생산된 프레임을 받아 가는"
 * 수동적 장치라, 프레임이 아예 안 나오는 숨은 탭에서는 첫 프레임이 영원히 오지 않고
 * ack 할 것도 없다. 2026-08-23 실측: force 모드로 15초를 돌려도 페이지의 rAF 는 0회,
 * 수집 개수도 그대로였다(반면 captureScreenshot 1회로 rAF 20프레임 + 다음 페이지 로드).
 *
 * 비용: chrome.debugger attach 이므로 대상 탭에 "디버깅 중" infobar 가 뜬다. 그래서
 * 기본값('auto')은 탭이 실제로 보이지 않을 때만 켠다.
 */

export type RenderMode = 'auto' | 'force' | 'off';

export type RenderAssist =
  /** 탭이 이미 화면에 보이는 상태라 개입하지 않았다 */
  | 'not-needed'
  /** 호출자가 renderMode:'off' 로 껐다 */
  | 'off'
  /** 주기적으로 프레임을 강제해 렌더링을 유지했다 */
  | 'frame-pump'
  /** 개입이 필요했지만 CDP 를 붙일 수 없었다 (DevTools 등이 선점) */
  | 'unavailable';

/**
 * fn 에 넘겨주는 핸들. `assist` 는 **fn 이 끝난 뒤에 읽어야** 정확하다 —
 * 펌프가 도중에 죽으면 'unavailable' 로 내려가기 때문이다.
 */
export interface RenderKeepAlive {
  assist: RenderAssist;
}

const OWNER = 'render-keepalive';

/** 강제한 프레임의 효과가 지속되는 시간(~300ms)보다 짧게 잡아 끊기지 않게 한다. */
const PUMP_INTERVAL_MS = 250;

/** 연속 실패가 이만큼 쌓이면 펌프를 접고 결과에 정직하게 표기한다. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 목적은 그림이 아니라 프레임 생산이므로 가장 싼 인코딩으로 찍는다. */
const CAPTURE_PARAMS = {
  format: 'jpeg',
  quality: 1,
};

/**
 * 탭이 실제로 화면에 그려지는 상태인가.
 * 활성 탭이면서 창이 최소화되지 않았으면 그려진다 (창에 포커스가 없어도 그려진다).
 */
async function isTabRendering(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.state !== 'minimized';
  } catch {
    // 탭/창 조회에 실패하면 보이지 않는다고 보고 보수적으로 개입한다.
    return false;
  }
}

/**
 * fn 이 실행되는 동안 대상 탭의 렌더링을 살려 둔다.
 *
 * fn 에는 실제로 적용된 보조 수단을 담은 핸들을 넘겨주므로, 호출부가 결과에 정직하게
 * 표기할 수 있다 ('bottomReached' 로 오인해 보고하는 일을 막는 것이 이 핸들의 목적이다).
 */
export async function withRenderKeepAlive<T>(
  tabId: number,
  mode: RenderMode,
  fn: (keepAlive: RenderKeepAlive) => Promise<T>,
): Promise<T> {
  if (mode === 'off') return fn({ assist: 'off' });
  if (mode === 'auto' && (await isTabRendering(tabId))) return fn({ assist: 'not-needed' });

  try {
    await cdpSessionManager.attach(tabId, OWNER);
  } catch (error) {
    console.warn(
      `render-keepalive: CDP attach failed for tab ${tabId} — lazy loading may not trigger: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fn({ assist: 'unavailable' });
  }

  const forceFrame = () =>
    cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', CAPTURE_PARAMS);

  const keepAlive: RenderKeepAlive = { assist: 'frame-pump' };
  let pumping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;

  const pump = async () => {
    if (!pumping) return;
    try {
      await forceFrame();
      consecutiveFailures = 0;
    } catch (error) {
      // 작업이 끝나 detach 하는 순간 진행 중이던 캡처가 깨지는 것은 실패가 아니다 —
      // 여기서 걸러 내지 않으면 정상 종료한 호출이 'unavailable' 로 잘못 표시된다.
      if (!pumping) return;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        pumping = false;
        keepAlive.assist = 'unavailable';
        console.warn(
          `render-keepalive: frame pump gave up on tab ${tabId} — lazy loading may stall: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }
    if (pumping) timer = setTimeout(pump, PUMP_INTERVAL_MS);
  };

  try {
    // 첫 캡처는 킥이자 검증이다 — 여기서 실패하면 렌더링을 살릴 수단이 없다.
    await forceFrame();
  } catch (error) {
    console.warn(
      `render-keepalive: captureScreenshot failed for tab ${tabId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    try {
      await cdpSessionManager.detach(tabId, OWNER);
    } catch {
      /* detach 실패는 매니저가 refCount 를 정리한다 */
    }
    return fn({ assist: 'unavailable' });
  }

  pumping = true;
  timer = setTimeout(pump, PUMP_INTERVAL_MS);

  try {
    return await fn(keepAlive);
  } finally {
    pumping = false;
    if (timer !== undefined) clearTimeout(timer);
    try {
      await cdpSessionManager.detach(tabId, OWNER);
    } catch {
      /* 탭이 이미 닫혔을 수 있다 */
    }
  }
}
