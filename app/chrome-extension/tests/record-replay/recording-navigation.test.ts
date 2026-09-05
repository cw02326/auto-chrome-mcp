/**
 * 페이지 이동 녹화 (2026-09-05 사이드패널 1단계 B + Codex 교차 리뷰 1·2·4).
 *
 * 이 파일이 못박는 것:
 *   (a) 사용자가 직접 일으킨 이동(주소창 입력·뒤로가기)은 `navigate` 단계로 남는다.
 *       SPA 이동(pushState/해시)도 클릭과 무관하면 단계로 남는다.
 *   (b) 클릭·폼 제출 직후의 이동은 그 클릭의 결과이므로 별도 `navigate` 단계를 만들지 않고,
 *       클릭 단계에 이동을 기다리라는 힌트만 남긴다.
 *   (f) 녹화 세션에 속하지 않는 탭의 이동은 아예 보지 않고, 다른 세션 탭의 이동이 이 탭의
 *       클릭에 합쳐지지 않는다 (판정 상태는 탭별).
 *   (g) 새로고침·뒤로가기는 같은 주소가 짧은 간격으로 다시 와도 중복으로 지우지 않는다.
 *   (h) 이동이 클릭보다 먼저 도착하면(클릭 단계는 지연·pagehide 전송이라 실제로 일어난다)
 *       이미 만든 navigate 단계를 지우고 뒤늦게 온 클릭에 힌트를 옮긴다.
 *   (i) 한 클릭이 만든 리다이렉트·SPA 후속 이동은 같은 사슬로 흡수한다.
 *
 * 이동 이벤트는 `chrome.webNavigation` 에서 온다. 전체 문서 이동은 content script 를 죽이고
 * SPA 의 pushState 는 페이지 세계에서 일어나므로, recorder.js 는 둘 다 끝까지 볼 수 없다.
 * 그래서 판정은 배경(browser-event-listener + session-manager)에 있고, 이 테스트도 거기에
 * 이벤트를 넣어 결과 흐름을 본다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initBrowserEventListeners } from '@/entrypoints/background/record-replay/recording/browser-event-listener';
import {
  NAV_MERGE_WINDOW_MS,
  RecordingSessionManager,
} from '@/entrypoints/background/record-replay/recording/session-manager';
import type { Flow, NodeBase, Step } from '@/entrypoints/background/record-replay/types';

const TAB_ID = 42;
/** 같은 녹화 세션의 두 번째 탭. */
const OTHER_SESSION_TAB = 43;
/** 녹화와 무관한 사용자 탭. */
const FOREIGN_TAB = 77;
const START_URL = 'https://example.com/start';

interface NavDetails {
  tabId: number;
  frameId: number;
  url: string;
  transitionType?: string;
  transitionQualifiers?: string[];
  documentLifecycle?: string;
}

type NavListener = (details: NavDetails) => void | Promise<void>;

interface NavEmitters {
  committed: NavListener[];
  history: NavListener[];
  fragment: NavListener[];
}

let emitters: NavEmitters;
/** 스텁 탭 상태. tabs.get 이 여기서 답한다. */
let tabs: Map<number, { id: number; url: string; windowId: number; openerTabId?: number }>;

/** 리스너가 async 라서 이벤트를 넣은 뒤 마이크로태스크를 몇 번 흘려보낸다. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeNavEvent(bucket: NavListener[]) {
  return {
    addListener: (fn: NavListener) => bucket.push(fn),
    removeListener: (fn: NavListener) => {
      const idx = bucket.indexOf(fn);
      if (idx >= 0) bucket.splice(idx, 1);
    },
  };
}

function installChrome(): void {
  emitters = { committed: [], history: [], fragment: [] };
  tabs = new Map([
    [TAB_ID, { id: TAB_ID, url: START_URL, windowId: 1 }],
    [OTHER_SESSION_TAB, { id: OTHER_SESSION_TAB, url: 'https://example.com/other', windowId: 1 }],
    [FOREIGN_TAB, { id: FOREIGN_TAB, url: 'https://private.test/inbox', windowId: 2 }],
  ]);
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension-id', lastError: undefined },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { ...tab, status: 'complete' };
      }),
      sendMessage: vi.fn(async () => undefined),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
    webNavigation: {
      onCommitted: makeNavEvent(emitters.committed),
      onHistoryStateUpdated: makeNavEvent(emitters.history),
      onReferenceFragmentUpdated: makeNavEvent(emitters.fragment),
      getAllFrames: vi.fn(async () => [{ frameId: 0 }]),
    },
  });
}

function makeFlow(): Flow {
  return {
    id: 'nav-flow',
    name: 'nav flow',
    version: 1,
    nodes: [],
    edges: [],
    variables: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

function clickStep(id: string): Step {
  return {
    id,
    type: 'click',
    target: { candidates: [{ type: 'css', value: '#go' }] },
  } as unknown as Step;
}

function nodesOf(session: RecordingSessionManager): NodeBase[] {
  return session.getFlow()?.nodes ?? [];
}

function navigateUrls(session: RecordingSessionManager): string[] {
  return nodesOf(session)
    .filter((n) => n.type === 'navigate')
    .map((n) => String((n.config as { url?: string })?.url ?? ''));
}

function nodeById(session: RecordingSessionManager, id: string): NodeBase | undefined {
  return nodesOf(session).find((n) => n.id === id);
}

async function emitCommitted(details: Partial<NavDetails> & { url: string }): Promise<void> {
  const payload: NavDetails = {
    tabId: TAB_ID,
    frameId: 0,
    transitionType: 'link',
    transitionQualifiers: [],
    documentLifecycle: 'active',
    ...details,
  };
  const tab = tabs.get(payload.tabId);
  if (tab) tab.url = payload.url;
  for (const fn of [...emitters.committed]) await fn(payload);
  await settle();
}

async function emitHistoryState(details: Partial<NavDetails> & { url: string }): Promise<void> {
  const payload: NavDetails = {
    tabId: TAB_ID,
    frameId: 0,
    transitionType: 'link',
    transitionQualifiers: [],
    documentLifecycle: 'active',
    ...details,
  };
  for (const fn of [...emitters.history]) await fn(payload);
  await settle();
}

describe('페이지 이동 녹화 (설계 B 2항)', () => {
  let session: RecordingSessionManager;

  beforeEach(async () => {
    installChrome();
    session = new RecordingSessionManager();
    initBrowserEventListeners(session);
    await session.startSession(makeFlow(), TAB_ID, START_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) 사용자 조작으로만 일어난 이동은 navigate 단계로 기록된다', async () => {
    // 시작 URL 은 흐름에 남는다 (설계 B 1항).
    expect(session.getFlow()?.startUrl).toBe(START_URL);
    expect(session.getStartUrl()).toBe(START_URL);

    // 주소창 직접 입력
    await emitCommitted({ url: 'https://example.com/typed', transitionType: 'typed' });
    // 뒤로가기 (transitionType 은 원래 이동의 것이 그대로 오고 qualifier 로 구분된다)
    await emitCommitted({
      url: START_URL,
      transitionType: 'link',
      transitionQualifiers: ['forward_back'],
    });
    // 클릭 없이 일어난 SPA 이동도 재생하려면 주소가 필요하다
    await emitHistoryState({ url: 'https://example.com/spa' });

    expect(navigateUrls(session)).toEqual([
      'https://example.com/typed',
      START_URL,
      'https://example.com/spa',
    ]);

    // 같은 이동에 커밋 이벤트와 SPA 이벤트가 함께 뜨는 경우는 한 번만 기록한다.
    await emitHistoryState({ url: 'https://example.com/spa' });
    expect(navigateUrls(session)).toHaveLength(3);

    // prerender 문서의 이동은 사용자가 실제로 간 곳이 아니다.
    await emitCommitted({
      url: 'https://example.com/prerendered',
      transitionType: 'typed',
      documentLifecycle: 'prerender',
    });
    expect(navigateUrls(session)).toHaveLength(3);
  });

  it('(b) 클릭이 일으킨 이동은 navigate 단계를 만들지 않고 클릭 단계에 힌트를 남긴다', async () => {
    session.appendSteps([clickStep('click_1')], { tabId: TAB_ID });
    await emitCommitted({ url: 'https://example.com/after-click', transitionType: 'link' });

    // navigate 단계는 생기지 않았다.
    expect(navigateUrls(session)).toEqual([]);
    // 대신 그 클릭이 이동을 부른다는 사실이 단계에 남았다.
    const clickNode = nodeById(session, 'click_1')!;
    expect(clickNode.config.expectsNavigation).toBe(true);
    expect(clickNode.config.after).toEqual({ waitForNavigation: true });

    // 폼 제출로 일어난 이동도 같다 (엔터 → key 단계 → form_submit 커밋).
    session.appendSteps([{ id: 'key_1', type: 'key', keys: 'Enter' } as unknown as Step], {
      tabId: TAB_ID,
    });
    await emitCommitted({ url: 'https://example.com/search', transitionType: 'form_submit' });
    expect(navigateUrls(session)).toEqual([]);
    expect(nodeById(session, 'key_1')!.config.after).toEqual({ waitForNavigation: true });

    // 클릭 하나가 그 뒤의 (사슬 밖) 모든 이동을 삼키지는 않는다.
    await emitCommitted({ url: 'https://example.com/later', transitionType: 'link' });
    expect(navigateUrls(session)).toEqual(['https://example.com/later']);

    // 합치기 창을 벗어난 이동은 단계로 남는다. (앞선 이동과 얽히지 않도록 다른 세션 탭에서
    // 확인한다 - 같은 탭에서는 방금 만든 navigate 단계가 되돌려 합치기 후보라 (h)의 규칙이
    // 먼저 적용된다.)
    session.addActiveTab(OTHER_SESSION_TAB);
    session.appendSteps([clickStep('click_2')], { tabId: OTHER_SESSION_TAB });
    const stale = Date.now() + NAV_MERGE_WINDOW_MS + 1000;
    expect(
      session.recordNavigation({
        url: 'https://example.com/slow',
        tabId: OTHER_SESSION_TAB,
        userDriven: false,
        at: stale,
      }),
    ).toBe('appended');
    expect(nodeById(session, 'click_2')!.config.expectsNavigation).toBe(undefined);
  });

  it('(f) 다른 탭의 이동은 이 탭의 클릭에 합쳐지지 않고, 세션 밖 탭은 아예 보지 않는다', async () => {
    // 세션 밖 탭의 이동: 단계도 만들지 않고 녹화기도 주입하지 않는다.
    await emitCommitted({
      tabId: FOREIGN_TAB,
      url: 'https://private.test/refreshed',
      transitionType: 'reload',
    });
    expect(navigateUrls(session)).toEqual([]);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls).toEqual([]);

    // 같은 세션의 다른 탭: 이동은 기록하되, 이 탭의 클릭에 합치지 않는다.
    session.addActiveTab(OTHER_SESSION_TAB);
    session.appendSteps([clickStep('click_tab42')], { tabId: TAB_ID });
    await emitCommitted({
      tabId: OTHER_SESSION_TAB,
      url: 'https://example.com/other-page',
      transitionType: 'link',
    });

    expect(navigateUrls(session)).toEqual(['https://example.com/other-page']);
    expect(nodeById(session, 'click_tab42')!.config.expectsNavigation).toBe(undefined);

    // 그 클릭의 진짜 이동은 여전히 합쳐진다.
    await emitCommitted({ url: 'https://example.com/from-click', transitionType: 'link' });
    expect(navigateUrls(session)).toEqual(['https://example.com/other-page']);
    expect(nodeById(session, 'click_tab42')!.config.after).toEqual({ waitForNavigation: true });
  });

  it('(g) 1500ms 안의 새로고침·뒤로가기는 중복으로 보고 지우지 않는다', async () => {
    const at = Date.now();
    // 시작 주소와 같은 주소로 곧바로 새로고침. 중복 창(1500ms) 안이지만 진짜 조작이다.
    expect(session.recordNavigation({ url: START_URL, tabId: TAB_ID, userDriven: true, at })).toBe(
      'appended',
    );
    // 곧바로 한 번 더 새로고침해도 지우지 않는다.
    expect(
      session.recordNavigation({ url: START_URL, tabId: TAB_ID, userDriven: true, at: at + 200 }),
    ).toBe('appended');
    expect(navigateUrls(session)).toEqual([START_URL, START_URL]);

    // 자동으로 따라온 같은 주소 이벤트는 여전히 중복으로 지운다.
    expect(
      session.recordNavigation({ url: START_URL, tabId: TAB_ID, userDriven: false, at: at + 400 }),
    ).toBe('duplicate');
    expect(navigateUrls(session)).toHaveLength(2);
  });

  it('(h) 이동이 클릭보다 먼저 도착하면 navigate 단계를 지우고 클릭에 힌트를 옮긴다', async () => {
    // 클릭 단계는 더블클릭 판정·배치·pagehide 전송을 거치므로 이동이 먼저 도착할 수 있다.
    await emitCommitted({ url: 'https://example.com/late-click', transitionType: 'link' });
    expect(navigateUrls(session)).toEqual(['https://example.com/late-click']);

    session.appendSteps([clickStep('click_late')], { tabId: TAB_ID });

    // 되돌려 합쳤다: navigate 단계는 사라지고 클릭만 남는다.
    expect(navigateUrls(session)).toEqual([]);
    expect(nodesOf(session).map((n) => n.id)).toEqual(['click_late']);
    expect(nodeById(session, 'click_late')!.config.after).toEqual({ waitForNavigation: true });
    // 간선도 다시 이어졌다 (선형 불변식 유지).
    expect(session.getFlow()?.edges).toEqual([]);

    // 사용자 조작 이동은 되돌려 합치지 않는다.
    await emitCommitted({ url: 'https://example.com/typed2', transitionType: 'typed' });
    session.appendSteps([clickStep('click_after_typed')], { tabId: TAB_ID });
    expect(navigateUrls(session)).toEqual(['https://example.com/typed2']);
    expect(nodeById(session, 'click_after_typed')!.config.expectsNavigation).toBe(undefined);
  });

  it('(i) 한 클릭이 만든 리다이렉트·SPA 후속 이동은 같은 사슬로 흡수한다', async () => {
    session.appendSteps([clickStep('click_chain')], { tabId: TAB_ID });
    await emitCommitted({ url: 'https://example.com/hop1', transitionType: 'link' });
    expect(navigateUrls(session)).toEqual([]);

    // 서버 리다이렉트로 이어진 두 번째 커밋: 같은 클릭의 결과다.
    await emitCommitted({
      url: 'https://example.com/hop2',
      transitionType: 'link',
      transitionQualifiers: ['server_redirect'],
    });
    // 라우터가 뒤이어 부르는 replaceState 도 마찬가지다.
    await emitHistoryState({ url: 'https://example.com/hop2?ready=1' });

    expect(navigateUrls(session)).toEqual([]);
    expect(nodesOf(session).map((n) => n.id)).toEqual(['click_chain']);
  });
});
