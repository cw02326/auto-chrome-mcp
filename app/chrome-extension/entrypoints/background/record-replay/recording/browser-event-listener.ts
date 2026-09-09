import { ensureRecorderInjected, broadcastControlToTab, REC_CMD } from './content-injection';
import type { RecordingSessionManager } from './session-manager';

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
 * 녹화·재생이 실제로 다룰 수 있는 주소인가 (설계 2.3).
 *
 * `chrome://`·확장 페이지·웹스토어·`devtools://` 같은 곳은 녹화기를 주입할 수 없고, 재생이
 * 같은 주소를 새 탭으로 열어도 조작할 수 없다. 단계를 남기면 사용자에게 "왜 여기서 멈추지"
 * 만 남으므로 아예 세션에 넣지 않는다.
 *
 * `file:` 은 포함한다. 확장의 파일 URL 접근 권한이 켜져 있으면 주입도 재생도 되고, 시연용
 * 로컬 페이지가 이 부류다. 권한이 꺼져 있으면 주입이 실패해 단계가 생기지 않는다.
 */
export function isRecordableUrl(url: string | undefined | null): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  const value = url.trim();
  if (!/^(https?:|file:)/i.test(value)) return false;
  // 크롬 웹스토어는 http(s) 이지만 확장 스크립트 주입을 브라우저가 막는다. 주입이 안 되는
  // 곳을 세션에 넣으면 단계만 남고 재생은 아무것도 못 한다 (검토 사소).
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(value)) {
    return false;
  }
  return true;
}

/**
 * 실제로 이 탭을 녹화할 수 있는가.
 *
 * `file:` 은 확장에 "파일 URL 접근 허용" 이 켜져 있을 때만 주입된다. 권한을 확인하지 않고
 * 합류 단계부터 기록하면, 재생할 수 없는 단계만 흐름에 남는다 (검토 사소).
 */
export async function isRecordableTabUrl(url: string | undefined | null): Promise<boolean> {
  if (!isRecordableUrl(url)) return false;
  if (!/^file:/i.test(String(url).trim())) return true;
  try {
    const allowed = await chrome.extension?.isAllowedFileSchemeAccess?.();
    return allowed !== false;
  } catch {
    // 확인할 수 없으면 주입 시도까지 가지 않는다.
    return false;
  }
}

/**
 * 이 탭에 녹화기를 다시 붙여도 되는가 (`onCommitted` 경로 전용).
 *
 * **이미 세션에 있는 탭만** 참이다 (2026-09-09 축소 결정). 예전에는 `openerTabId` 가 세션
 * 탭이면 그 탭도 세션에 넣었는데, 그러면 사용자가 **보지도 않은** 탭이 흐름에 들어와 그
 * 탭의 SPA 이동이 `navigate` 단계로 섞였다. 그 단계에는 대상 탭 번호도 선행 전환도 없어
 * 재생의 현재 탭에서 엉뚱한 이동이 일어난다.
 *
 * 이제 세션 합류는 `onActivated` 의 `joinTab` 한 곳에서만 일어난다. 여기는 이미 세션인
 * 탭이 문서를 새로 띄웠을 때 녹화기를 **다시 주입**하는 일만 한다.
 */
function shouldJoinSession(session: RecordingSessionManager, tabId: number): boolean {
  return session.hasTab(tabId);
}

/* ------------------------------------------------------------------ *
 * 단일 기록 큐 (설계 2.3)
 *
 * `onActivated` 는 주입·메시지·`tabs.get` 을 await 한 뒤에야 단계를 기록한다. 그 사이에
 * 다른 이벤트가 끼어들면 주소창으로 연 새 탭에서 `switchTab` 이 `openTab` 보다 앞서는 등
 * 순서가 뒤집힌다. 그래서 브라우저 이벤트는 **받는 즉시 동기로** 큐에 넣고, 단일 소비자가
 * 들어온 순서대로 처리한다. await 은 소비자 안에서만 한다.
 *
 * 콘텐츠 스크립트가 보내는 단계(`appendSteps`)는 이미 동기 경로라 이 큐를 타지 않는다.
 * 한 배치 안의 `openTab`+`switchTab` 사이에는 어떤 await 도 없으므로 순서가 깨지지 않는다.
 * ------------------------------------------------------------------ */

type QueueBody = { kind: 'activated'; tabId: number } | { kind: 'removed'; tabId: number };

/**
 * 큐 항목은 **어느 녹화 세션의 것인지** 를 달고 다닌다 (검토 C4).
 *
 * 항목이 소비되기 전에 녹화가 멈추고 새 세션이 시작될 수 있다. 세션 id 를 확인하지 않으면
 * 이전 세션에서 밀린 탭 전환이 새 흐름의 첫 단계로 들어간다.
 */
type QueueItem = QueueBody & { sessionId: string; seq: number };

export interface RecordQueue {
  push(body: QueueBody): void;
  /** 테스트용: 큐가 빌 때까지 기다린다. */
  settled(): Promise<void>;
}

function createRecordQueue(session: RecordingSessionManager): RecordQueue {
  const items: QueueItem[] = [];
  let running: Promise<void> = Promise.resolve();
  let draining = false;
  let seq = 0;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (items.length) {
        const item = items.shift() as QueueItem;
        try {
          await handleQueueItem(session, item);
        } catch (e) {
          console.warn('record queue item failed', item?.kind, e);
        }
      }
    } finally {
      draining = false;
    }
  };

  const queue: RecordQueue = {
    push(body: QueueBody): void {
      // 세션 id 와 순번은 **이벤트가 일어난 시점**의 값이다. 소비는 순번대로 하고, 소비
      // 중간의 await 뒤에도 이 세션 id 로 다시 확인한다 (검토 D1).
      items.push({ ...body, sessionId: session.getSessionId(), seq: seq++ } as QueueItem);
      running = running.then(drain, drain);
    },
    async settled(): Promise<void> {
      await running;
    },
  };
  return queue;
}

/** 큐 항목 하나를 처리한다. 여기에서만 await 한다. */
async function handleQueueItem(session: RecordingSessionManager, item: QueueItem): Promise<void> {
  // 만든 세션과 지금 세션이 다르면 버린다 (검토 C4).
  if (item.sessionId && item.sessionId !== session.getSessionId()) return;

  if (item.kind === 'removed') {
    session.removeActiveTab(item.tabId);
    session.forgetTab(item.tabId);
    return;
  }

  if (session.getStatus() !== 'recording') return;

  // kind === 'activated'
  const sessionId = item.sessionId;
  const tabId = item.tabId;

  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab?.url || '';
  } catch {
    return; // 이미 닫힌 탭
  }
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  if (!(await isRecordableTabUrl(url))) {
    notifyTabNotRecordable(tabId, url);
    return;
  }
  // 파일 권한 확인을 기다리는 사이에 녹화가 끝났을 수 있다 (검토 D1).
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;

  // 단계를 먼저 남기고 주입은 그 뒤에 한다 (설계 2.3 의 순서). 주입은 실패할 수 있고,
  // 실패해도 사용자가 이 탭으로 옮겼다는 사실 자체는 흐름에 남아야 한다.
  session.joinTab(tabId, url);

  await ensureRecorderInjected(tabId);
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  await broadcastControlToTab(tabId, REC_CMD.START);
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  if (session.getFlow()) session.broadcastTimelineUpdate();
}

/** 녹화할 수 없는 페이지로 옮겨 갔음을 사이드패널에 한 번 알린다 (표시는 M2). */
const notRecordableNotified = new Set<number>();
function notifyTabNotRecordable(tabId: number, url: string): void {
  if (notRecordableNotified.has(tabId)) return;
  notRecordableNotified.add(tabId);
  try {
    chrome.runtime?.sendMessage?.({ action: 'rr_tab_not_recordable', tabId, url });
  } catch {
    // 사이드패널이 닫혀 있으면 받을 사람이 없다. 무시한다.
  }
}

/**
 * 이미 세션에 있는 탭에 녹화기를 다시 붙인다.
 *
 * await 이 들어가므로 시작할 때의 세션 id 를 받아 두고, 끝난 뒤 같은 세션인지 다시 본다.
 */
async function attachRecorderToTab(
  session: RecordingSessionManager,
  tabId: number,
  sessionId: string,
): Promise<void> {
  if (!shouldJoinSession(session, tabId)) return;
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  await ensureRecorderInjected(tabId);
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  await broadcastControlToTab(tabId, REC_CMD.START);
  if (session.getSessionId() !== sessionId || session.getStatus() !== 'recording') return;
  session.addActiveTab(tabId);
  if (session.getFlow()) session.broadcastTimelineUpdate();
}

export function initBrowserEventListeners(session: RecordingSessionManager): RecordQueue {
  const queue = createRecordQueue(session);

  // 탭 전환은 **사용자가 직접 한 조작**이다. 그 탭에서 녹화를 이어 가겠다는 뜻이므로
  // 여기서는 세션 소속을 따지지 않고 그대로 세션에 넣는다 (사용자 확정 사항, 설계 2.3).
  // 받는 즉시 큐에 넣기만 하고, 판정과 기록은 단일 소비자가 순서대로 한다.
  chrome.tabs.onActivated.addListener((activeInfo) => {
    try {
      if (!activeInfo) return;
      if (session.getStatus() !== 'recording') return;
      queue.push({ kind: 'activated', tabId: activeInfo.tabId });
    } catch (e) {
      console.warn('onActivated handler failed', e);
    }
  });

  // 새 탭 생성 이벤트는 보지 않는다 (2026-09-09 축소 결정).
  //
  // 브라우저는 "이 클릭이 이 탭을 만들었다" 는 인과를 알려 주지 않는다. `openerTabId` 도
  // `sourceTabId` 도 "같은 탭에서 열렸다" 까지만 말해 주므로, 사용자가 같은 탭에서 직접
  // 연 링크나 페이지가 스스로 띄운 광고 탭이 그 자리에 들어올 수 있다. 그래서 새 탭은
  // **사용자가 그 탭을 활성화해 세션에 합류할 때** 그 시점의 실제 주소로만 기록한다.

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
      queue.push({ kind: 'removed', tabId });
    } catch (e) {
      console.warn('onRemoved handler failed', e);
    }
  });

  return queue;
}
