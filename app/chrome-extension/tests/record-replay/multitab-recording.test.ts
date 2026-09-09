/**
 * multitab-recording.test.ts
 *
 * 여러 탭 녹화 규칙 (2026-09-09 설계 2부, 같은 날 축소 개정).
 *
 * 축소 결정의 요지: **새 탭은 사용자가 그 탭을 볼 때, 그때의 실제 주소로만 남긴다.**
 * 링크 클릭을 "그 href 로 새 탭 열기" 로 미리 바꿔 두고 나중에 실제 탭과 주소로 짝짓던
 * 방식은, `/orders?id=1` 과 `/orders?id=2` 처럼 비슷한 주소를 가리지 못해 서로 다른 업무
 * 대상을 한 번호로 합쳤다. 짝짓기를 통째로 없앴다.
 *
 * 이 파일이 못박는 것:
 *   (a) 새 탭이 흐름에 들어오는 경로는 `joinTab` 하나뿐이고, 주소는 합류 시점의 실제 값이다.
 *   (b) 주소가 비슷한 두 탭도 각각 자기 번호와 자기 `openTab` 을 받는다.
 *   (c) 번호가 붙은 탭에는 **항상** 그 탭을 만드는 단계가 흐름에 있다.
 *   (d) `target=_blank` 클릭 자체는 흐름에 아무 단계도 남기지 않는다.
 *   (e) 활성화하지 않은 자식 탭은 `onCommitted` 가 와도 세션에 합류하지 않는다.
 *   (f) 녹화할 수 없는 페이지(chrome://, 웹스토어 등)는 세션에 들어오지 않는다.
 *   (g) 큐 항목은 세션 경계를 넘지 않고 순서도 뒤집히지 않는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordingSessionManager } from '@/entrypoints/background/record-replay/recording/session-manager';
import {
  initBrowserEventListeners,
  isRecordableUrl,
  type RecordQueue,
} from '@/entrypoints/background/record-replay/recording/browser-event-listener';
import type { Flow, NodeBase, Step } from '@/entrypoints/background/record-replay/types';

const TAB_ID = 42;
const CHILD_TAB = 43;
const SECOND_CHILD_TAB = 44;
const OUTSIDE_TAB = 77;
const START_URL = 'https://example.com/start';

/** 스텁 탭 상태. `tabs.get` 이 여기서 답한다. */
let tabUrls: Map<number, string>;
/** 등록된 `webNavigation.onCommitted` 리스너. 테스트가 직접 발생시킨다. */
let committedListeners: Array<(details: Record<string, unknown>) => Promise<void> | void>;

function installChrome(): void {
  committedListeners = [];
  tabUrls = new Map([
    [TAB_ID, START_URL],
    [CHILD_TAB, 'https://example.com/page2'],
    [SECOND_CHILD_TAB, 'https://example.com/orders?id=2'],
    [OUTSIDE_TAB, 'https://mail.test/inbox'],
  ]);
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension-id', lastError: undefined, sendMessage: vi.fn() },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const url = tabUrls.get(tabId);
        if (url === undefined) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tabId, url, status: 'complete', windowId: 1 };
      }),
      sendMessage: vi.fn(async () => undefined),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => true) },
    webNavigation: {
      onCommitted: {
        addListener: (fn: (details: Record<string, unknown>) => Promise<void> | void) =>
          committedListeners.push(fn),
        removeListener: vi.fn(),
      },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onReferenceFragmentUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      getAllFrames: vi.fn(async () => [{ frameId: 0 }]),
    },
    windows: {
      get: vi.fn(async () => ({ id: 1, type: 'normal' })),
      update: vi.fn(async () => ({})),
      getAll: vi.fn(async () => []),
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
  });
}

function makeFlow(): Flow {
  return {
    id: 'multitab-rec',
    name: 'multitab rec',
    version: 1,
    nodes: [],
    edges: [],
    variables: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

function nodesOf(session: RecordingSessionManager): NodeBase[] {
  return session.getFlow()?.nodes ?? [];
}

function shapeOf(session: RecordingSessionManager): Array<Record<string, unknown>> {
  return nodesOf(session).map((n) => ({
    type: n.type,
    ...(n.config as Record<string, unknown>),
  }));
}

describe('여러 탭 녹화: 새 탭은 합류할 때 실제 주소로 남는다', () => {
  let session: RecordingSessionManager;

  beforeEach(async () => {
    installChrome();
    session = new RecordingSessionManager();
    await session.startSession(makeFlow(), TAB_ID, START_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) 합류하는 탭은 그때의 실제 주소로 openTab{joined} + switchTab 을 받는다', () => {
    session.joinTab(CHILD_TAB, 'https://example.com/orders?id=1');

    expect(shapeOf(session)).toEqual([
      { type: 'openTab', url: 'https://example.com/orders?id=1', tabRef: 1, origin: 'joined' },
      { type: 'switchTab', tabRef: 1 },
    ]);
    const meta = session.getFlow()?.meta as { features?: string[]; minEngine?: string };
    expect(meta.features).toContain('multitab');
    expect(meta.minEngine).toBe('1.14.0');
  });

  it('(b) 주소가 비슷한 두 탭도 각각 자기 번호와 자기 openTab 을 받는다', () => {
    // 예전에는 쿼리를 지우고 접두사로 비교해 두 탭이 한 번호로 합쳐졌다. 그러면 재생 때
    // id=2 로 하려던 조작이 id=1 페이지에서 일어난다.
    session.joinTab(CHILD_TAB, 'https://example.com/orders?id=1');
    session.joinTab(SECOND_CHILD_TAB, 'https://example.com/orders?id=2');

    expect(session.tabRefFor(CHILD_TAB)).toBe(1);
    expect(session.tabRefFor(SECOND_CHILD_TAB)).toBe(2);
    expect(shapeOf(session)).toEqual([
      { type: 'openTab', url: 'https://example.com/orders?id=1', tabRef: 1, origin: 'joined' },
      { type: 'switchTab', tabRef: 1 },
      { type: 'openTab', url: 'https://example.com/orders?id=2', tabRef: 2, origin: 'joined' },
      { type: 'switchTab', tabRef: 2 },
    ]);
  });

  it('이미 아는 탭으로 돌아가면 전환만 남는다', () => {
    session.joinTab(CHILD_TAB, 'https://example.com/orders?id=1');
    session.joinTab(TAB_ID, START_URL);
    session.joinTab(CHILD_TAB, 'https://example.com/orders?id=1');

    const shapes = shapeOf(session);
    expect(shapes.filter((st) => st.type === 'openTab')).toHaveLength(1);
    expect(shapes.at(-1)).toEqual({ type: 'switchTab', tabRef: 1 });
  });

  it('(c) 번호가 붙은 탭에는 반드시 그 탭을 만드는 단계가 있다', () => {
    session.joinTab(OUTSIDE_TAB, 'https://mail.test/inbox');
    session.joinTab(TAB_ID, START_URL);
    session.joinTab(CHILD_TAB, 'https://example.com/page2');

    const shapes = shapeOf(session);
    for (const tabId of [OUTSIDE_TAB, CHILD_TAB]) {
      const ref = session.tabRefFor(tabId);
      expect(ref).toBeDefined();
      expect(shapes.filter((st) => st.type === 'openTab' && st.tabRef === ref)).toHaveLength(1);
    }
    // 0번(시작 탭)은 흐름이 시작하는 탭이라 여는 단계가 필요 없다.
    expect(session.tabRefFor(TAB_ID)).toBe(0);
    expect(shapes.filter((st) => st.type === 'openTab' && st.tabRef === 0)).toHaveLength(0);
  });

  it('일시정지 중에는 합류해도 단계를 만들지 않는다', () => {
    session.pause();
    session.joinTab(OUTSIDE_TAB, 'https://mail.test/inbox');
    expect(nodesOf(session)).toHaveLength(0);
  });

  it('(f) 녹화할 수 있는 주소 판정', () => {
    // 웹스토어는 http(s) 이지만 확장 스크립트 주입을 브라우저가 막는다.
    expect(isRecordableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isRecordableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isRecordableUrl('https://example.com/')).toBe(true);
    expect(isRecordableUrl('http://example.com/')).toBe(true);
    expect(isRecordableUrl('file:///C:/demo/index.html')).toBe(true);
    expect(isRecordableUrl('chrome://extensions')).toBe(false);
    expect(isRecordableUrl('chrome-extension://abc/page.html')).toBe(false);
    expect(isRecordableUrl('about:blank')).toBe(false);
    expect(isRecordableUrl('devtools://devtools/bundled/x.html')).toBe(false);
    expect(isRecordableUrl(undefined)).toBe(false);
  });
});

/**
 * 실제 큐를 돌려 이벤트 순서와 세션 경계를 검증한다 (검토 D1).
 */
describe('녹화 이벤트 큐', () => {
  let session: RecordingSessionManager;
  let queue: RecordQueue;

  beforeEach(async () => {
    vi.useFakeTimers();
    installChrome();
    session = new RecordingSessionManager();
    queue = initBrowserEventListeners(session);
    await session.startSession(makeFlow(), TAB_ID, START_URL);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('(h) 활성화 순서대로 기록되고 마지막 전환이 뒤집히지 않는다', async () => {
    queue.push({ kind: 'activated', tabId: CHILD_TAB });
    queue.push({ kind: 'activated', tabId: OUTSIDE_TAB });
    await queue.settled();

    const shapes = shapeOf(session);
    // 두 탭 모두 "주소로 여는 단계 + 전환" 을 순서대로 받는다.
    expect(shapes.map((st) => `${st.type}:${String(st.tabRef)}`)).toEqual([
      'openTab:1',
      'switchTab:1',
      'openTab:2',
      'switchTab:2',
    ]);
    // 마지막 전환은 나중에 활성화한 탭이다.
    expect(shapes.at(-1)).toEqual({ type: 'switchTab', tabRef: 2 });
  });

  it('(h) 이전 세션에서 밀린 항목은 새 세션에 들어가지 않는다', async () => {
    queue.push({ kind: 'activated', tabId: OUTSIDE_TAB });
    // 소비되기 전에 녹화가 끝나고 새 세션이 시작된다.
    await session.stopSession();
    await session.startSession(makeFlow(), TAB_ID, START_URL);
    await vi.advanceTimersByTimeAsync(100);
    await queue.settled();

    expect(nodesOf(session)).toHaveLength(0);
  });

  it('(f) 녹화할 수 없는 페이지로 옮겨 가면 단계가 생기지 않는다', async () => {
    tabUrls.set(OUTSIDE_TAB, 'chrome://extensions');
    queue.push({ kind: 'activated', tabId: OUTSIDE_TAB });
    await queue.settled();

    expect(nodesOf(session)).toHaveLength(0);
    expect(session.tabRefFor(OUTSIDE_TAB)).toBeUndefined();
  });

  it('(e) 활성화하지 않은 자식 탭은 onCommitted 가 와도 합류하지 않는다', async () => {
    // 세션 탭이 연 탭이 스스로 이동한다. 사용자는 그 탭을 본 적이 없다.
    for (const fn of committedListeners) {
      await fn({
        tabId: CHILD_TAB,
        frameId: 0,
        url: 'https://example.com/child-spa',
        transitionType: 'link',
        transitionQualifiers: [],
        documentLifecycle: 'active',
      });
    }
    await queue.settled();

    // 세션에 들어오지도, 단계를 남기지도 않는다. 예전에는 opener 가 세션 탭이라는 이유로
    // 합류시켜, 이 탭의 이동이 재생의 현재 탭에서 일어났다.
    expect(session.hasTab(CHILD_TAB)).toBe(false);
    expect(nodesOf(session)).toHaveLength(0);

    // 사용자가 그 탭을 실제로 누르면 그때 합류한다.
    queue.push({ kind: 'activated', tabId: CHILD_TAB });
    await queue.settled();
    expect(session.hasTab(CHILD_TAB)).toBe(true);
    expect(shapeOf(session)[0]).toMatchObject({ type: 'openTab', origin: 'joined' });
  });
});

describe('recorder.js 의 target=_blank 분기', () => {
  it('(d) 새 탭 링크 클릭은 흐름에 아무 단계도 남기지 않는다', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(
      path.resolve(__dirname, '../../inject-scripts/recorder.js'),
      'utf-8',
    );
    const branch = source.slice(
      source.indexOf("tgt.toLowerCase() === '_blank'"),
      source.indexOf('const target = SelectorEngine.buildTarget(el);'),
    );
    // 이 분기에서 단계를 만들면 안 된다. 새 탭은 배경의 joinTab 이 실제 주소로만 남긴다.
    expect(branch).not.toContain('_pushStep');
    expect(branch).not.toContain('openTab');
    // 옛 짝짓기 흔적(임시 표식·기대)이 남아 있으면 안 된다.
    expect(source).not.toContain('blank_link');
    expect(source).not.toContain('opensTab');
  });
});
