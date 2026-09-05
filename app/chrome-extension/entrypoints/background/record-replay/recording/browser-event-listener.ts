import { STEP_TYPES } from '@/common/step-types';
import { ensureRecorderInjected, broadcastControlToTab, REC_CMD } from './content-injection';
import type { RecordingSessionManager } from './session-manager';
import type { Step } from '../types';

/**
 * 페이지 이동 녹화 (2026-09-05 사이드패널 1단계 B).
 *
 * 왜 배경(`chrome.webNavigation`)에서 잡는가:
 *   - 전체 문서 이동은 content script 를 통째로 죽인다. 이동을 알아채 보고할 주체가
 *     사라지므로 recorder.js 는 자기가 떠나는 이동을 끝까지 보고할 수 없다.
 *   - SPA 이동(pushState/replaceState)은 **페이지 세계**에서 일어난다. content script 는
 *     격리된 세계에서 돌아 `history.pushState` 를 가로챌 수 없다(MAIN world 주입이
 *     필요한데, 그건 사용자 페이지에 코드를 심는 훨씬 큰 변경이다).
 *   - `webNavigation` 은 둘 다 본다: `onCommitted`(문서 이동),
 *     `onHistoryStateUpdated`(pushState/replaceState), `onReferenceFragmentUpdated`(해시).
 *
 * 그래서 navigate 단계를 만드는 곳은 여기 한 곳뿐이다. recorder.js 는 이동을 만들지 않고,
 * 클릭이 이동을 부를 것 같으면 그 단계에 `expectsNavigation` 힌트만 붙인다.
 *
 * 범위 규칙 (2026-09-05 Codex 교차 리뷰 1·3):
 *   - **녹화 세션에 속한 탭**의 최상위 프레임, 그리고 살아 있는 문서(documentLifecycle
 *     'active')의 이동만 본다. 이 확인이 없으면 사용자가 열어 둔 다른 탭의 자동
 *     새로고침이나 prerender 문서의 이동까지 흐름에 단계로 들어간다.
 *   - 이동 기록은 **await 앞에서 동기로** 끝낸다. `chrome.tabs.get` 을 기다린 뒤 기록하면
 *     연속 이동에서 뒤 이벤트의 주소가 앞 이벤트로 들어가고, 기다리는 사이 녹화가 멈추고
 *     새 세션이 시작되면 옛 이벤트가 새 흐름에 섞인다. 주소는 이벤트가 실어 준
 *     `details.url` 을 그대로 쓴다(커밋된 주소다).
 *   - await 뒤의 작업(주입·브로드캐스트)은 세션 id 를 다시 확인하고 진행한다.
 */

/**
 * 페이지 안의 조작과 무관하게 **사용자가 직접** 일으킨 이동의 transitionType.
 *
 * 이 이동들은 앞선 클릭과 시간이 가까워도 클릭 결과로 합치지 않는다. 재생이 그 주소로 갈
 * 방법이 navigate 단계뿐이기 때문이다(주소창 입력·북마크·검색창·새로고침).
 */
const USER_DRIVEN_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  'typed',
  'generated',
  'keyword',
  'keyword_generated',
  'auto_bookmark',
  'reload',
  'start_page',
  'auto_toplevel',
]);

/** webNavigation 이벤트에서 우리가 읽는 값만 추린 형태. */
interface NavigationDetails {
  tabId: number;
  frameId: number;
  url?: string;
  transitionType?: string;
  transitionQualifiers?: string[];
  documentLifecycle?: string;
}

function qualifiersOf(details: NavigationDetails): string[] {
  return Array.isArray(details?.transitionQualifiers) ? details.transitionQualifiers : [];
}

/** 뒤로/앞으로 이동도 사용자 조작이다 (transitionType 은 원래 이동의 것이 그대로 온다). */
function isForwardBack(details: NavigationDetails): boolean {
  return qualifiersOf(details).includes('forward_back');
}

/** 이 이동이 "사용자 조작만으로 일어난 것" 인가. */
function isUserDrivenNavigation(details: NavigationDetails): boolean {
  if (isForwardBack(details)) return true;
  const type = typeof details?.transitionType === 'string' ? details.transitionType : '';
  return USER_DRIVEN_TRANSITIONS.has(type);
}

/** 리다이렉트로 도달한 이동인가. 같은 클릭이 만든 이동 사슬을 묶는 데 쓴다. */
function isRedirect(details: NavigationDetails): boolean {
  const q = qualifiersOf(details);
  return q.includes('client_redirect') || q.includes('server_redirect');
}

/**
 * 이 이벤트가 **지금 보고 있는 문서**의 것인가.
 *
 * prerender·bfcache 예비 문서도 같은 이벤트를 낸다. 그 이동은 사용자가 실제로 간 곳이
 * 아니므로 단계로 남기면 안 된다. 값이 없는 옛 크롬에서는 종전대로 통과시킨다.
 */
function isActiveDocument(details: NavigationDetails): boolean {
  const lifecycle = details?.documentLifecycle;
  return typeof lifecycle !== 'string' || lifecycle === 'active';
}

/** 이 이벤트를 이동 단계로 기록해도 되는가 (동기 판정만 한다). */
function shouldRecordNavigation(
  session: RecordingSessionManager,
  details: NavigationDetails,
): boolean {
  if (session.getStatus() !== 'recording') return false;
  if (details?.frameId !== 0) return false;
  if (!isActiveDocument(details)) return false;
  if (!session.hasTab(details?.tabId)) return false;
  return !!session.getFlow();
}

/** 이벤트 하나를 세션에 넘긴다. 동기 함수다 (await 뒤로 미루지 않는다). */
function recordNavigationEvent(
  session: RecordingSessionManager,
  details: NavigationDetails,
  options: { spa: boolean },
): void {
  if (!shouldRecordNavigation(session, details)) return;
  const url = details.url || '';
  if (!url) return;
  session.recordNavigation({
    url,
    tabId: details.tabId,
    userDriven: isUserDrivenNavigation(details),
    spa: options.spa,
    redirect: isRedirect(details),
  });
}

/**
 * 이 탭을 녹화 세션에 넣어도 되는가.
 *
 * 이미 세션 탭이면 그대로 참이고, 아니면 **세션 탭이 연 탭**(openerTabId)일 때만 참이다.
 * 링크를 새 탭으로 여는 경우가 여기 해당한다. 그 밖의 탭은 사용자가 따로 쓰던 탭이므로
 * 녹화기를 주입하지도, 세션에 넣지도 않는다 (Codex 교차 리뷰 1).
 */
async function shouldJoinSession(
  session: RecordingSessionManager,
  tabId: number,
): Promise<boolean> {
  if (session.hasTab(tabId)) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    return session.hasTab(tab?.openerTabId);
  } catch {
    return false;
  }
}

/**
 * 이동한 탭에 녹화기를 붙이고 세션 탭으로 등록한다.
 *
 * await 이 들어가므로 시작할 때의 세션 id 를 받아 두고, 끝난 뒤 같은 세션인지 다시 본다.
 */
async function attachRecorderToTab(
  session: RecordingSessionManager,
  tabId: number,
  sessionId: string,
): Promise<void> {
  if (!(await shouldJoinSession(session, tabId))) return;
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  await ensureRecorderInjected(tabId);
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  await broadcastControlToTab(tabId, REC_CMD.START);
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  session.addActiveTab(tabId);
  if (session.getFlow()) session.broadcastTimelineUpdate();
}

export function initBrowserEventListeners(session: RecordingSessionManager): void {
  // 탭 전환은 **사용자가 직접 한 조작**이다. 그 탭에서 녹화를 이어 가겠다는 뜻이므로
  // 여기서는 세션 소속을 따지지 않고 그대로 세션에 넣는다 (기존 동작 유지).
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      if (session.getStatus() !== 'recording') return;
      const sessionId = session.getSessionId();
      const tabId = activeInfo.tabId;
      await ensureRecorderInjected(tabId);
      if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
      await broadcastControlToTab(tabId, REC_CMD.START);
      // Track active tab for targeted STOP later
      session.addActiveTab(tabId);

      const flow = session.getFlow();
      if (!flow) return;
      const tab = await chrome.tabs.get(tabId);
      if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
      const url = tab.url;
      const step: Step = {
        id: '',
        type: STEP_TYPES.SWITCH_TAB,
        ...(url ? { urlContains: url } : {}),
      };
      session.appendSteps([step], { tabId });
    } catch (e) {
      console.warn('onActivated handler failed', e);
    }
  });

  chrome.webNavigation.onCommitted.addListener(async (details) => {
    // 기록은 await 앞에서 동기로 끝낸다 (Codex 교차 리뷰 3).
    const nav = details as unknown as NavigationDetails;
    const sessionId = session.getSessionId();
    try {
      recordNavigationEvent(session, nav, { spa: false });
    } catch (e) {
      console.warn('onCommitted record failed', e);
    }
    try {
      if (session.getStatus() !== 'recording') return;
      if (nav.frameId !== 0 || !isActiveDocument(nav)) return;
      await attachRecorderToTab(session, nav.tabId, sessionId);
    } catch (e) {
      console.warn('onCommitted handler failed', e);
    }
  });

  // SPA 이동: pushState/replaceState. 문서가 바뀌지 않으므로 onCommitted 는 뜨지 않는다.
  chrome.webNavigation.onHistoryStateUpdated?.addListener?.((details) => {
    try {
      recordNavigationEvent(session, details as unknown as NavigationDetails, { spa: true });
    } catch (e) {
      console.warn('onHistoryStateUpdated handler failed', e);
    }
  });

  // 해시 이동(#section). 같은 문서 안이지만 재생하려면 주소가 필요하다.
  chrome.webNavigation.onReferenceFragmentUpdated?.addListener?.((details) => {
    try {
      recordNavigationEvent(session, details as unknown as NavigationDetails, { spa: true });
    } catch (e) {
      console.warn('onReferenceFragmentUpdated handler failed', e);
    }
  });

  // Remove closed tabs from the active set to avoid stale broadcasts
  chrome.tabs.onRemoved.addListener((tabId) => {
    try {
      // Even if not recording, removing is harmless; keep guard for clarity
      if (session.getStatus() !== 'recording') return;
      session.removeActiveTab(tabId);
    } catch (e) {
      console.warn('onRemoved handler failed', e);
    }
  });
}
