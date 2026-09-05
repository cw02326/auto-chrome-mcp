import { BACKGROUND_MESSAGE_TYPES, CONTENT_MESSAGE_TYPES } from '@/common/message-types';
import { Flow } from './types';
import {
  listFlows,
  saveFlow,
  getFlow,
  deleteFlow,
  publishFlow,
  unpublishFlow,
  exportFlow,
  exportAllFlows,
  importFlowFromJson,
  listSchedules,
  saveSchedule,
  removeSchedule,
  ensurePublishedSensitiveDefaultsMigrated,
  type FlowSchedule,
} from './flow-store';
import { listRuns } from './flow-store';
// 2026-09-05 사이드패널 1단계 A: 발행 목록 조회. 위 import 블록을 고치지 않으려고 줄을
// 따로 추가했다 (같은 모듈을 두 번 import 해도 문제 없다).
import { listPublished } from './flow-store';
import { STORAGE_KEYS } from '@/common/constants';
import { listTriggers, saveTrigger, deleteTrigger, type FlowTrigger } from './trigger-store';
import { runFlow } from './flow-runner';
import { queryEntryPointTab, runTabFromId, type RunTabContext } from './engine/tab-context';
import { RecorderManager } from './recording/recorder-manager';
import { recordingSession } from './recording/session-manager';
// Browser/content listeners are initialized via RecorderManager.init

// design note: background listener for record & replay; delegates recording to dedicated modules

// Alarm helpers for schedules
async function rescheduleAlarms() {
  const schedules = await listSchedules();
  // Clear existing rr_schedule_* alarms
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((a) => a.name && a.name.startsWith('rr_schedule_'))
      .map((a) => chrome.alarms.clear(a.name)),
  );
  for (const s of schedules) {
    if (!s.enabled) continue;
    const name = `rr_schedule_${s.id}`;
    if (s.type === 'interval') {
      const minutes = Math.max(1, Math.floor(Number(s.when) || 0));
      await chrome.alarms.create(name, { periodInMinutes: minutes });
    } else if (s.type === 'once') {
      const whenMs = Date.parse(s.when);
      if (Number.isFinite(whenMs)) await chrome.alarms.create(name, { when: whenMs });
    } else if (s.type === 'daily') {
      // daily HH:mm local time
      const [hh, mm] = String(s.when || '00:00')
        .split(':')
        .map((x) => Number(x));
      const now = new Date();
      const next = new Date();
      next.setHours(hh || 0, mm || 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      await chrome.alarms.create(name, { when: next.getTime(), periodInMinutes: 24 * 60 });
    }
  }
}

// legacy injection helpers removed — use recording/content-injection when needed

/**
 * 자동 진입점(URL 트리거·DOM 트리거·알람 스케줄)이 쓰는 실행 탭 (2026-09-05 Codex 검토 항목 2).
 *
 * 이 셋은 사용자가 "지금 실행" 을 누른 것이 아니다. 그런데도 예전에는 트리거가 발생한
 * 사용자 탭(또는 알람의 경우 활성 탭)을 그대로 빌려 그 위에서 클릭·입력·이동을 했다.
 * 사용자가 보고 있는 페이지를 자동화가 조작해 버리는 것이다.
 *
 * 이제는 세션 소유의 **새 백그라운드 탭**을 트리거 탭의 창에 열어 거기서 돌고, 끝나면
 * 닫는다. 사용자 탭에서 직접 돌리려면 흐름이 `meta.runInTriggeringTab: true` 를 켜야 한다
 * (트리거 쪽에 같은 값을 둬도 된다).
 */
function wantsTriggeringTab(flow: any, trigger?: any): boolean {
  return flow?.meta?.runInTriggeringTab === true || trigger?.runInTriggeringTab === true;
}

/**
 * 자동 진입점이 만든 탭들.
 *
 * 이 탭도 트리거 URL 로 이동하므로 `webNavigation.onCommitted` 가 다시 뜨고, DOM 감시자도
 * 다시 붙는다. 걸러 내지 않으면 트리거가 자기 자신을 재귀 실행해 탭이 무한히 늘어난다.
 */
const autoRunTabIds = new Set<number>();

/** 이 탭이 자동 실행용으로 만들어진 탭인가 (트리거 재귀 차단용). */
function isAutoRunTab(tabId: number | undefined): boolean {
  return typeof tabId === 'number' && autoRunTabIds.has(tabId);
}

interface AutoRunTab {
  tab: RunTabContext;
  /**
   * 실행 후 닫아야 하는 탭의 id — **생성 직후 캡처한 불변 값**
   * (2026-09-05 Codex 재확인 항목 5).
   *
   * 예전에는 정리가 `target.tab.tabId` 를 봤다. 그런데 그 필드는 흐름이 실행 중 자기가 연
   * 탭으로 옮겨가면 바뀐다(setRunTab). 그래서 정리는 엉뚱하게 새 탭을 닫고, 정작 자기가
   * 만든 부트스트랩 탭과 재귀 가드 항목(autoRunTabIds)은 그대로 남았다.
   *
   * 사용자 탭을 빌려 도는 경우(runInTriggeringTab)에는 닫을 탭이 없으므로 undefined 다.
   */
  disposableTabId?: number;
}

/**
 * 트리거 실행용 탭을 준비한다.
 *
 * @param sourceTabId  트리거가 발생한 탭 (알람에는 없다).
 * @param url          그 탭이 보고 있던 주소. 새 탭을 이 주소로 연다.
 */
async function openAutoRunTab(
  sourceTabId: number | undefined,
  windowId: number | undefined,
  url: string | undefined,
): Promise<AutoRunTab> {
  let targetWindowId = windowId;
  if (targetWindowId === undefined && typeof sourceTabId === 'number') {
    try {
      targetWindowId = (await chrome.tabs.get(sourceTabId)).windowId;
    } catch {
      targetWindowId = undefined;
    }
  }
  // tab-create-ok: 자동 트리거는 자기 탭을 만들어 쓴다. 백그라운드로 열고 실행이 끝나면
  // 닫으므로 사용자가 보고 있는 탭에는 닿지 않는다.
  const created = await chrome.tabs.create({
    url: url && /^(https?:|file:)/i.test(url) ? url : 'about:blank',
    active: false,
    ...(typeof targetWindowId === 'number' ? { windowId: targetWindowId } : {}),
  });
  if (typeof created?.id !== 'number') {
    throw new Error('trigger: could not open a background tab for this run');
  }
  autoRunTabIds.add(created.id);
  return {
    tab: runTabFromId(created.id, 'explicit', created.windowId, AUTO_RUN_SESSION),
    disposableTabId: created.id,
  };
}

/**
 * 자동 트리거 실행의 컨텍스트 (2026-09-05 발행 전 검토 2).
 *
 * 사용자가 실행을 누른 적이 없는 실행이다. 전역 무간섭 토글이 꺼져 있어도 탭을 앞으로
 * 끌어내면 안 되므로, 모드를 실행 체인에 실어 게이트·활성화 가드가 전역 토글보다 이 값을
 * 먼저 보게 한다. (사이드패널 Run 버튼·컨텍스트 메뉴·단축키는 사용자가 보고 있는 실행이라
 * 해당하지 않는다.)
 */
const AUTO_RUN_SESSION = { effectiveBackgroundMode: true as const };

/** 자동 진입점의 실행 한 건. 빌린 탭이 아니라 자기 탭에서 돌고, 끝나면 치운다. */
async function runFlowFromTrigger(
  flow: any,
  trigger: any,
  source: { tabId?: number; windowId?: number; url?: string },
): Promise<void> {
  let target: AutoRunTab;
  if (wantsTriggeringTab(flow, trigger) && typeof source.tabId === 'number') {
    target = { tab: runTabFromId(source.tabId, 'explicit', source.windowId, AUTO_RUN_SESSION) };
  } else {
    target = await openAutoRunTab(source.tabId, source.windowId, source.url);
  }

  const { disposableTabId } = target;
  try {
    await runFlow(flow, target.tab, { args: trigger?.args || {}, returnLogs: false });
  } finally {
    // run 이 실행 중 스스로 연 탭도 자동 실행이 남긴 흔적이다 — 함께 치운다. 사용자 탭은
    // ownedTabIds 에 들어가지 않으므로 여기에 걸리지 않는다.
    for (const openedTabId of target.tab.ownedTabIds ?? []) {
      if (openedTabId === disposableTabId) continue;
      try {
        await chrome.tabs.remove(openedTabId);
      } catch {
        // 흐름이 이미 닫았을 수 있다.
      }
    }
    if (disposableTabId !== undefined) {
      try {
        await chrome.tabs.remove(disposableTabId);
      } catch {
        // 흐름이 이미 닫았을 수 있다.
      }
      // 탭을 닫은 뒤에 등록을 지운다. 순서를 바꾸면 그 사이에 도착한 이동 이벤트가
      // 트리거를 한 번 더 켠다.
      autoRunTabIds.delete(disposableTabId);
    }
  }
}

async function startRecording(
  meta?: Partial<Flow>,
  options?: { tabId?: number },
): Promise<{ success: boolean; error?: string }> {
  return await RecorderManager.start(meta, options);
}

async function stopRecording(): Promise<{ success: boolean; flow?: Flow; error?: string }> {
  return await RecorderManager.stop();
}

export function initRecordReplayListeners() {
  // Storage state sync is handled within session manager and recorder manager
  // 발행 스냅샷에 남아 있는 sensitive 변수 기본값을 한 번 걷어 낸다. 새 발행은
  // publishFlow 가 이미 막지만, 그 전에 저장된 레코드는 워커가 뜰 때 정리해야 한다
  // (2026-09-05 Codex 최종 확인 5).
  //
  // 이 호출은 일부러 await 하지 않고 메시지 리스너를 곧바로 연다(2026-09-05 발행 차단
  // 지적 대응, 택한 방식: 리스너 선(先) 오픈 + 락으로 순서 보장). initRecordReplayListeners
  // 는 동기 함수이고 다른 호출부·테스트가 "호출 즉시 리스너가 등록돼 있다" 는 전제로
  // 짜여 있어, await 을 끼워 넣으면 리스너 등록 자체가 (실제 IndexedDB 왕복만큼) 밀린다.
  // 대신 flow-store.ts 의 publishFlow/unpublishFlow/migratePublishedSensitiveDefaults 는
  // 모두 같은 모듈 단일 락(withPublishedLock)을 거치도록 고쳤다 - 마이그레이션이 끝나기
  // 전에 들어온 RR_PUBLISH_FLOW/RR_UNPUBLISH_FLOW 메시지도 그 락 뒤에 순서대로 줄을 서고,
  // 마이그레이션은 자기 차례에 항상 "현재" 레코드를 다시 읽어 판단하므로 이미 발행
  // 해제됐거나 재발행된 레코드를 되돌리지 않는다. 즉 리스너가 마이그레이션보다 먼저 열려도
  // 데이터 레이스는 나지 않는다. 마이그레이션 자체의 실패는 내부에서 이미 잡아
  // (ensurePublishedSensitiveDefaultsMigrated 가 catch 후 0 을 돌려준다) 여기서 별도
  // try/catch 가 필요 없다.
  void ensurePublishedSensitiveDefaultsMigrated();
  // On startup, re-schedule alarms
  rescheduleAlarms().catch(() => {});
  // Initialize trigger engine (contextMenus/commands/url/dom)
  initTriggerEngine().catch(() => {});
  // Initialize recorder manager (wires browser and content listeners)
  RecorderManager.init().catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      // rr_recorder_event 交由 ContentMessageHandler 处理
      switch (message?.type) {
        case BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING: {
          // tabId 가 오면 그 탭에서 녹화한다 (팝업이 눌린 순간의 탭). 없으면 예전처럼
          // 진입점 헬퍼가 활성 탭을 찾는다.
          startRecording(
            message.meta,
            typeof message.tabId === 'number' ? { tabId: message.tabId } : undefined,
          )
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING: {
          stopRecording()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_PAUSE_RECORDING: {
          RecorderManager.pause()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_RESUME_RECORDING: {
          RecorderManager.resume()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_STATUS: {
          const status = recordingSession.getStatus();
          const session = recordingSession.getSession();
          sendResponse({
            success: true,
            status,
            sessionId: session.sessionId,
            originTabId: session.originTabId,
          });
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS: {
          listFlows()
            .then((flows) => sendResponse({ success: true, flows }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW: {
          getFlow(message.flowId)
            .then((flow) => sendResponse({ success: !!flow, flow }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_FLOW: {
          deleteFlow(message.flowId)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW: {
          // 호출자가 흐름 본문을 함께 보냈고 그 id 가 요청 id 와 같으면 저장소를 다시 읽지
          // 않고 그 내용을 발행한다 (2026-09-05 시연 지적 3항). 사이드패널은 방금 저장한
          // 객체를 그대로 실어 보내므로, 저장과 발행 사이의 읽기 한 번이 통째로 사라진다.
          const suppliedFlow =
            message.flow && message.flow.id === message.flowId ? (message.flow as Flow) : null;
          (suppliedFlow ? Promise.resolve(suppliedFlow) : getFlow(message.flowId))
            .then(async (flow) => {
              if (!flow) return sendResponse({ success: false, error: 'flow not found' });
              const info = await publishFlow(flow, message.slug);
              sendResponse({ success: true, published: info });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_UNPUBLISH_FLOW: {
          unpublishFlow(message.flowId)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW: {
          getFlow(message.flowId)
            .then(async (flow) => {
              if (!flow) return sendResponse({ success: false, error: 'flow not found' });
              // Entry point: the user pressed Run in the side panel while looking
              // at the page they want automated, so the tab is resolved once here
              // and pinned. The engine never asks again.
              const tab =
                typeof message.tabId === 'number'
                  ? runTabFromId(message.tabId, 'explicit')
                  : await queryEntryPointTab('sidepanel');
              const result = await runFlow(flow, tab, message.options || {});
              sendResponse({ success: true, result });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW: {
          const flow = message.flow as Flow;
          if (!flow || !flow.id) {
            sendResponse({ success: false, error: 'invalid flow' });
            return true;
          }
          saveFlow(flow)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_FLOW: {
          exportFlow(message.flowId)
            .then((json) => sendResponse({ success: true, json }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_ALL: {
          exportAllFlows()
            .then((json) => sendResponse({ success: true, json }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW: {
          importFlowFromJson(message.json)
            .then((flows) => sendResponse({ success: true, imported: flows.length, flows }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_RUNS: {
          listRuns()
            .then((runs) => sendResponse({ success: true, runs }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        // 2026-09-05 사이드패널 1단계 A 에서 추가한 조회 두 개.
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_PUBLISHED: {
          listPublished()
            .then((published) => sendResponse({ success: true, published }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_SNAPSHOT: {
          // 녹화 중 표시(빨간 점·경과 시간·단계 수)의 진실은 백그라운드다. 사이드패널을
          // 닫았다 열어도 이 응답 하나로 화면이 복원된다. 상태만 주는
          // RR_GET_RECORDING_STATUS 는 그대로 두고 별도 메시지로 붙였다.
          const snapshotSession = recordingSession.getSession();
          const snapshotFlow = recordingSession.getFlow();
          sendResponse({
            success: true,
            status: recordingSession.getStatus(),
            sessionId: snapshotSession.sessionId,
            originTabId: snapshotSession.originTabId,
            startUrl: snapshotSession.startUrl ?? snapshotFlow?.startUrl,
            flowId: snapshotFlow?.id,
            flowName: snapshotFlow?.name,
            startTitle: snapshotFlow?.meta?.startTitle,
            stepCount: Array.isArray(snapshotFlow?.nodes) ? snapshotFlow.nodes.length : 0,
            startedAt: snapshotFlow?.meta?.createdAt,
          });
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_TRIGGERS: {
          listTriggers()
            .then((triggers) => sendResponse({ success: true, triggers }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_TRIGGER: {
          const t = message.trigger as FlowTrigger;
          if (!t || !t.id || !t.type || !t.flowId) {
            sendResponse({ success: false, error: 'invalid trigger' });
            return true;
          }
          saveTrigger(t)
            .then(async () => {
              await refreshTriggers();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_TRIGGER: {
          const id = String(message.id || '');
          if (!id) {
            sendResponse({ success: false, error: 'invalid id' });
            return true;
          }
          deleteTrigger(id)
            .then(async () => {
              await refreshTriggers();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_REFRESH_TRIGGERS: {
          refreshTriggers()
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_SCHEDULES: {
          listSchedules()
            .then((s) => sendResponse({ success: true, schedules: s }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SCHEDULE_FLOW: {
          const s = message.schedule as FlowSchedule;
          if (!s || !s.id || !s.flowId) {
            sendResponse({ success: false, error: 'invalid schedule' });
            return true;
          }
          saveSchedule(s)
            .then(async () => {
              await rescheduleAlarms();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_UNSCHEDULE_FLOW: {
          const scheduleId = String(message.scheduleId || '');
          if (!scheduleId) {
            sendResponse({ success: false, error: 'invalid scheduleId' });
            return true;
          }
          removeSchedule(scheduleId)
            .then(async () => {
              await rescheduleAlarms();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
      }
    } catch (err) {
      sendResponse({ success: false, error: (err as any)?.message || String(err) });
    }
    return false;
  });

  // Trigger engine: contextMenus/commands/url/dom
  if ((chrome as any).contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      try {
        const triggers = await listTriggers();
        const t = triggers.find(
          (x) => x.type === 'contextMenu' && (x as any).menuId === info.menuItemId,
        );
        if (!t || t.enabled === false) return;
        const flow = await getFlow(t.flowId);
        if (!flow) return;
        // The click tells us which tab the user invoked the menu on.
        const runTab =
          typeof tab?.id === 'number'
            ? runTabFromId(tab.id, 'explicit', tab.windowId)
            : await queryEntryPointTab('sidepanel');
        await runFlow(flow, runTab, { args: t.args || {}, returnLogs: false });
      } catch {}
    });
  }
  chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
      const triggers = await listTriggers();
      const t = triggers.find((x) => x.type === 'command' && (x as any).commandKey === command);
      if (!t || t.enabled === false) return;
      const flow = await getFlow(t.flowId);
      if (!flow) return;
      // The shortcut fires on the tab the user is on; pin that one.
      const runTab =
        typeof tab?.id === 'number'
          ? runTabFromId(tab.id, 'explicit', tab.windowId)
          : await queryEntryPointTab('sidepanel');
      await runFlow(flow, runTab, { args: t.args || {}, returnLogs: false });
    } catch {}
  });
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    try {
      if (details.frameId !== 0) return;
      // 자동 실행용으로 우리가 연 탭은 트리거 대상이 아니다. 이 탭도 같은 주소로 이동하므로
      // 거르지 않으면 트리거가 자기 자신을 다시 켜서 탭이 무한히 늘어난다.
      if (isAutoRunTab(details.tabId)) return;
      const url = details.url || '';
      // Ensure core content scripts are injected for this tab (pre-heat for replay)
      await ensureCoreInjected(details.tabId);
      // Ensure DOM observer is active on this tab (if triggers exist)
      try {
        const { [STORAGE_KEYS.RR_TRIGGERS]: stored } =
          (await chrome.storage.local.get(STORAGE_KEYS.RR_TRIGGERS)) || {};
        const triggers: any[] = Array.isArray(stored) ? stored : [];
        const domTriggers = triggers
          .filter((x) => x.type === 'dom' && x.enabled !== false)
          .map((x: any) => ({
            id: x.id,
            selector: x.selector,
            appear: x.appear !== false,
            once: x.once !== false,
            debounceMs: x.debounceMs ?? 800,
          }));
        if (typeof details.tabId === 'number') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: details.tabId, allFrames: true },
              files: ['inject-scripts/dom-observer.js'],
              world: 'ISOLATED',
            } as any);
            await chrome.tabs.sendMessage(details.tabId, {
              action: 'set_dom_triggers',
              triggers: domTriggers,
            } as any);
          } catch {}
        }
      } catch {}
      const triggers = await listTriggers();
      const list = triggers.filter((x) => x.type === 'url' && x.enabled !== false) as any[];
      for (const t of list) {
        if (matchUrl(url, (t as any).match || [])) {
          const flow = await getFlow(t.flowId);
          if (!flow) continue;
          // 사용자가 보고 있는 탭을 빌리지 않는다: 같은 주소로 세션 소유 탭을 열어 거기서 돈다.
          await runFlowFromTrigger(flow, t, { tabId: details.tabId, url });
        }
      }
    } catch {}
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message && message.action === 'dom_trigger_fired') {
        const id = message.triggerId;
        const senderTabId = sender?.tab?.id;
        const senderWindowId = sender?.tab?.windowId;
        // 자동 실행 탭에서 올라온 신호는 무시한다 (재귀 방지).
        if (isAutoRunTab(senderTabId)) {
          sendResponse({ ok: true, skipped: 'auto-run-tab' });
          return true;
        }
        listTriggers().then(async (arr) => {
          const t = arr.find((x) => x.id === id && x.type === 'dom');
          if (!t || t.enabled === false) return;
          const flow = await getFlow(t.flowId);
          if (!flow) return;
          // The content script that fired the trigger identifies its own tab.
          if (typeof senderTabId !== 'number') return;
          let senderUrl: string | undefined;
          try {
            senderUrl = (await chrome.tabs.get(senderTabId)).url ?? undefined;
          } catch {
            senderUrl = undefined;
          }
          await runFlowFromTrigger(flow, t, {
            tabId: senderTabId,
            windowId: senderWindowId,
            url: senderUrl,
          });
        });
        sendResponse({ ok: true });
        return true;
      }
    } catch {}
    return false;
  });
}

function matchUrl(
  u: string,
  rules: Array<{ kind: 'url' | 'domain' | 'path'; value: string }>,
): boolean {
  try {
    const url = new URL(u);
    for (const r of rules || []) {
      const v = String(r.value || '');
      if (r.kind === 'url' && u.startsWith(v)) return true;
      if (r.kind === 'domain' && url.hostname.includes(v)) return true;
      if (r.kind === 'path' && url.pathname.startsWith(v)) return true;
    }
  } catch {}
  return false;
}

// Track context menu IDs created by record-replay to avoid removing other menus
const rrContextMenuIds = new Set<string>();

async function refreshContextMenus(triggers: FlowTrigger[]) {
  if (!(chrome as any).contextMenus?.create) return;

  // Remove only our own menu items
  await removeRecordReplayMenus();

  // Create menus for enabled context menu triggers
  for (const t of triggers) {
    if (t.type !== 'contextMenu' || t.enabled === false) continue;
    const id = `rr_menu_${t.id}`;
    (t as any).menuId = id;

    try {
      await chrome.contextMenus.create({
        id,
        title: (t as any).title || '运行工作流',
        contexts: (t as any).contexts || ['all'],
      });
      rrContextMenuIds.add(id);
    } catch (err) {
      console.warn('[RecordReplay] Failed to create context menu:', err);
    }
  }
}

async function removeRecordReplayMenus() {
  if (!(chrome as any).contextMenus?.remove) {
    rrContextMenuIds.clear();
    return;
  }

  const pending = Array.from(rrContextMenuIds.values()).map((id) =>
    chrome.contextMenus.remove(id).catch(() => {}),
  );

  if (pending.length) await Promise.all(pending);
  rrContextMenuIds.clear();
}

async function refreshTriggers() {
  try {
    const triggers = await listTriggers();
    await refreshContextMenus(triggers);
    await chrome.storage.local.set({ [STORAGE_KEYS.RR_TRIGGERS]: triggers });
    const domTriggers = triggers
      .filter((x) => x.type === 'dom' && x.enabled !== false)
      .map((x: any) => ({
        id: x.id,
        selector: x.selector,
        appear: x.appear !== false,
        once: x.once !== false,
        debounceMs: x.debounceMs ?? 800,
      }));
    // tab-scan-ok: seeding the DOM observer means injecting into every open tab.
    // This only installs a listener; it does not run or target a flow.
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: true },
          files: ['inject-scripts/dom-observer.js'],
          world: 'ISOLATED',
        } as any);
        await chrome.tabs.sendMessage(t.id, {
          action: 'set_dom_triggers',
          triggers: domTriggers,
        } as any);
      } catch {}
    }
  } catch {}
}

// Backward-compatible init function; initialize all trigger-related hooks/state
async function initTriggerEngine() {
  await refreshTriggers();
}

// Ensure core content scripts are present for a tab after navigation
async function ensureCoreInjected(tabId?: number) {
  try {
    if (typeof tabId !== 'number') return;
    // Ping accessibility helper
    const ok = await pingTab(tabId, CONTENT_MESSAGE_TYPES.ACCESSIBILITY_TREE_HELPER_PING);
    if (!ok) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['inject-scripts/inject-bridge.js', 'inject-scripts/accessibility-tree-helper.js'],
        world: 'ISOLATED',
      } as any);
    }
  } catch {}
}

async function pingTab(tabId: number, action: string): Promise<boolean> {
  try {
    const resp: any = await chrome.tabs.sendMessage(tabId, { action } as any);
    if (!resp) return false;
    // Helpers generally respond { status: 'pong' } or { ok: true }
    return resp.status === 'pong' || resp.ok === true;
  } catch {
    return false;
  }
}

// Alarm listener executes scheduled flows
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm?.name || !alarm.name.startsWith('rr_schedule_')) return;
    const id = alarm.name.slice('rr_schedule_'.length);
    const schedules = await listSchedules();
    const s = schedules.find((x) => x.id === id && x.enabled);
    if (!s) return;
    const flow = await getFlow(s.flowId);
    if (!flow) return;
    // 스케줄 실행에는 시작 탭이 없다. 예전에는 사용자의 활성 탭을 잡아 거기서 돌렸다 —
    // 사용자가 뭘 보고 있든 자동화가 그 페이지를 조작했다. 이제는 자기 백그라운드 탭을
    // 열어 돌고 닫는다.
    await runFlowFromTrigger(flow, s, {});
  } catch (e) {
    // swallow to not spam logs
  }
});
