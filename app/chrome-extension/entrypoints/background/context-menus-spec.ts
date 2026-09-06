/**
 * 컨텍스트 메뉴의 명세와 문구 (2026-09-06).
 *
 * 실제 등록·클릭 처리는 `context-menus.ts` 가 한다. 그쪽은 사이드패널·웹 에디터·요소
 * 마킹·네이티브 호스트를 전부 끌어오는 무거운 모듈이라, 녹화 문구를 갱신하려는 곳
 * (record-replay) 이 그것까지 끌어오지 않도록 가벼운 절반을 여기에 뒀다.
 *
 * 메뉴 구조는 순수 함수 `buildContextMenuSpec(state)` 가 만든다. 크롬 API 없이 순서와
 * 문구를 그대로 검사할 수 있게 하려는 것이다.
 */

import { recordingSession } from './record-replay/recording/session-manager';

const LOG_PREFIX = '[context-menus]';

/* ------------------------------------------------------------------ *
 * 메뉴 id
 * ------------------------------------------------------------------ */

export const MENU_IDS = {
  /** 툴바 아이콘 우클릭 */
  openSidePanel: 'acm_open_sidepanel',
  daily: 'acm_daily',
  record: 'acm_record',
  markers: 'acm_markers',
  separator1: 'acm_separator_1',
  webEditor: 'acm_web_editor',
  quickPanel: 'acm_quick_panel',
  separator2: 'acm_separator_2',
  userscripts: 'acm_userscripts',
  forceReconnect: 'acm_force_reconnect',
  /** 페이지 우클릭 */
  pageRoot: 'acm_page_root',
  pageMarkElement: 'acm_page_mark_element',
  pageWebEditor: 'acm_page_web_editor',
  pageRecord: 'acm_page_record',
} as const;

/**
 * 메뉴가 뜰 자리.
 *
 * 크롬 타입의 `contexts` 는 "적어도 하나" 를 요구하는 튜플이라 그 타입을 그대로 빌려 쓴다.
 * `ContextType` 은 enum 이라 문자열 리터럴과 바로 맞지 않는다.
 */
export type MenuContexts = NonNullable<chrome.contextMenus.CreateProperties['contexts']>;

/** 툴바 아이콘 우클릭만. 'all' 을 쓰면 페이지 메뉴까지 번진다. */
export const ACTION_CONTEXTS: MenuContexts = ['action'];

/**
 * 페이지 우클릭에서 받을 자리. 'action' 을 넣지 않는다.
 *
 * 사용자의 페이지 메뉴를 어지럽히지 않도록 최상위에는 부모 하나만 두고 실제 항목은
 * 그 아래에 접어 둔다.
 */
export const PAGE_CONTEXTS: MenuContexts = [
  'page',
  'frame',
  'selection',
  'link',
  'image',
  'video',
  'audio',
  'editable',
];

/** 녹화 문구가 걸린 항목들. 상태가 바뀌면 이 둘만 갱신한다. */
export const RECORD_MENU_IDS: string[] = [MENU_IDS.record, MENU_IDS.pageRecord];

/* ------------------------------------------------------------------ *
 * 문구
 * ------------------------------------------------------------------ */

/**
 * `_locales` 에 키가 없거나 `chrome.i18n` 을 못 쓸 때의 한국어 폴백.
 *
 * 여기 값은 `_locales/ko/messages.json` 과 같아야 한다. 테스트는 크롬 API 없이 돌기
 * 때문에 이 표를 그대로 본다.
 */
export const MENU_TEXT_KO: Readonly<Record<string, string>> = {
  menu_open_sidepanel: '사이드패널 열기',
  menu_daily_jobs: '매일 작업',
  menu_record_start: '이 탭에서 녹화 시작',
  menu_record_stop: '녹화 중지',
  menu_element_markers: '요소 마킹',
  menu_web_editor_toggle: '웹 에디터 켜기/끄기',
  menu_quick_panel: '빠른 패널',
  menu_userscripts: '유저스크립트 관리',
  menu_force_reconnect: '강제 재연결',
  menu_page_parent: 'Auto Chrome MCP',
  menu_page_mark_element: '이 요소 마킹',
  menu_notification_title: 'Auto Chrome MCP',
  menu_force_reconnect_ok: '강제 재연결 성공 (브리지 pid {0})',
  menu_force_reconnect_fail: '강제 재연결 실패 ({0} 단계)',
};

/** 사용자에게 보이는 문구. `chrome.i18n` 을 먼저 보고, 없으면 한국어 폴백. */
export function menuText(key: string, substitutions?: string[]): string {
  try {
    const message = chrome?.i18n?.getMessage?.(key, substitutions);
    if (message) return message;
  } catch {
    // i18n 이 없는 환경(테스트)에서는 폴백으로 간다.
  }

  let fallback = MENU_TEXT_KO[key] ?? key;
  if (substitutions?.length) {
    substitutions.forEach((value, index) => {
      fallback = fallback.replace(`{${index}}`, value);
    });
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * 메뉴 명세 (순수 함수)
 * ------------------------------------------------------------------ */

export interface ContextMenuState {
  /** 지금 녹화 중인가. 녹화 항목의 문구와 동작이 여기서 갈린다. */
  recording: boolean;
}

export interface ContextMenuItemSpec {
  id: string;
  contexts: MenuContexts;
  type?: 'normal' | 'separator';
  title?: string;
  parentId?: string;
}

/** 녹화 항목의 현재 문구. */
export function recordMenuTitle(state: ContextMenuState): string {
  return state.recording ? menuText('menu_record_stop') : menuText('menu_record_start');
}

/**
 * 만들 메뉴를 순서대로 돌려준다. 크롬 API 를 부르지 않는다.
 *
 * 부모는 자식보다 반드시 앞에 온다. `chrome.contextMenus.create` 는 부모가 이미 있어야
 * `parentId` 를 받아 주기 때문이다.
 */
export function buildContextMenuSpec(state: ContextMenuState): ContextMenuItemSpec[] {
  const recordTitle = recordMenuTitle(state);

  return [
    // 툴바 아이콘 우클릭
    {
      id: MENU_IDS.openSidePanel,
      contexts: ACTION_CONTEXTS,
      title: menuText('menu_open_sidepanel'),
    },
    { id: MENU_IDS.daily, contexts: ACTION_CONTEXTS, title: menuText('menu_daily_jobs') },
    { id: MENU_IDS.record, contexts: ACTION_CONTEXTS, title: recordTitle },
    { id: MENU_IDS.markers, contexts: ACTION_CONTEXTS, title: menuText('menu_element_markers') },
    { id: MENU_IDS.separator1, contexts: ACTION_CONTEXTS, type: 'separator' },
    {
      id: MENU_IDS.webEditor,
      contexts: ACTION_CONTEXTS,
      title: menuText('menu_web_editor_toggle'),
    },
    { id: MENU_IDS.quickPanel, contexts: ACTION_CONTEXTS, title: menuText('menu_quick_panel') },
    { id: MENU_IDS.separator2, contexts: ACTION_CONTEXTS, type: 'separator' },
    { id: MENU_IDS.userscripts, contexts: ACTION_CONTEXTS, title: menuText('menu_userscripts') },
    {
      id: MENU_IDS.forceReconnect,
      contexts: ACTION_CONTEXTS,
      title: menuText('menu_force_reconnect'),
    },

    // 페이지 우클릭 (부모 하나 아래로)
    { id: MENU_IDS.pageRoot, contexts: PAGE_CONTEXTS, title: menuText('menu_page_parent') },
    {
      id: MENU_IDS.pageMarkElement,
      contexts: PAGE_CONTEXTS,
      parentId: MENU_IDS.pageRoot,
      title: menuText('menu_page_mark_element'),
    },
    {
      id: MENU_IDS.pageWebEditor,
      contexts: PAGE_CONTEXTS,
      parentId: MENU_IDS.pageRoot,
      title: menuText('menu_web_editor_toggle'),
    },
    {
      id: MENU_IDS.pageRecord,
      contexts: PAGE_CONTEXTS,
      parentId: MENU_IDS.pageRoot,
      title: recordTitle,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 상태 읽기
 * ------------------------------------------------------------------ */

/**
 * 지금 녹화 중인지 동기로 읽는다.
 *
 * 사이드패널이 쓰는 `RR_GET_RECORDING_SNAPSHOT` 과 같은 진실(배경의 세션 관리자)을 본다.
 * 메시지를 거치지 않는 이유는 클릭 처리에 await 을 넣을 수 없기 때문이다.
 * `chrome.sidePanel.open()` 은 사용자 제스처 안에서만 열려서, 앞에 await 이 하나라도
 * 있으면 크롬이 거절한다.
 */
export function readContextMenuState(): ContextMenuState {
  try {
    const status = recordingSession.getStatus();
    return { recording: status === 'recording' || status === 'paused' || status === 'stopping' };
  } catch {
    return { recording: false };
  }
}

/**
 * 녹화 항목의 문구만 갈아 끼운다.
 *
 * 녹화가 시작·중지될 때 record-replay 가 부른다. 메뉴 전체를 다시 만들면 사용자가 메뉴를
 * 펼쳐 둔 사이에 항목이 사라졌다 나타나므로 제목만 고친다. 메뉴가 아직 없으면 조용히
 * 넘어간다. 다음 기동 때 만들어지고, 클릭 순간에는 어차피 상태를 다시 읽는다.
 */
export function syncRecordingMenuTitles(): void {
  const update = (chrome as any)?.contextMenus?.update;
  if (typeof update !== 'function') return;

  const title = recordMenuTitle(readContextMenuState());
  for (const id of RECORD_MENU_IDS) {
    try {
      const updating = update.call((chrome as any).contextMenus, id, { title });
      if (updating && typeof updating.catch === 'function') {
        updating.catch(() => undefined);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} 메뉴 문구 갱신 실패(무시): ${id}`, error);
    }
  }
}
