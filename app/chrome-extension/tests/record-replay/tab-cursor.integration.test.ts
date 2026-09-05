/**
 * Tab Cursor Integration Tests (M3-full batch 2)
 *
 * Purpose:
 *   Test tab management operations (openTab, switchTab) and verify their behavior,
 *   including ctx.tabId cursor updates after tab operations (M3 requirement).
 *
 * Test Strategy:
 *   - Use real HybridStepExecutor + real ActionRegistry + real tab handlers
 *   - Mock only environment boundaries (chrome.* APIs)
 *
 * Coverage:
 *   - Basic tab operations: openTab with newWindow, switchTab by urlContains
 *   - Tab cursor sync: ctx.tabId updated and used by subsequent steps
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mock Setup (using vi.hoisted for proper hoisting)
// =============================================================================

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  locate: vi.fn(),
  tabsQuery: vi.fn(),
  tabsGet: vi.fn(),
  tabsCreate: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsCreate: vi.fn(),
  windowsUpdate: vi.fn(),
}));

// Mock tool bridge
vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

// Mock selector locator
vi.mock('@/shared/selector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selector')>();
  return {
    ...actual,
    createChromeSelectorLocator: () => ({
      locate: mocks.locate,
    }),
  };
});

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { createMockExecCtx } from './_test-helpers';
import { createHybridConfig } from '@/entrypoints/background/record-replay/engine/execution-mode';
import { HybridStepExecutor } from '@/entrypoints/background/record-replay/engine/runners/step-executor';
import { createReplayActionRegistry } from '@/entrypoints/background/record-replay/actions';

// =============================================================================
// Test Constants
// =============================================================================

const TAB_ID = 1;
const NEW_TAB_ID = 101;
const TARGET_TAB_ID = 42;
const TARGET_WINDOW_ID = 999;

// =============================================================================
// Helper Types and Functions
// =============================================================================

interface TestStep {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Create executor with configurable hybrid config
 */
function createExecutor(overrides?: Parameters<typeof createHybridConfig>[0]): HybridStepExecutor {
  const registry = createReplayActionRegistry();
  const config = createHybridConfig(overrides);
  return new HybridStepExecutor(registry, config);
}

/**
 * Setup default mock responses for handleCallTool
 */
function setupDefaultToolMock(): void {
  mocks.handleCallTool.mockImplementation(async () => ({}));
}

// =============================================================================
// Test Suite
// =============================================================================

describe('tab cursor integration (M3-full batch 2)', () => {
  beforeEach(() => {
    // Reset all mocks
    Object.values(mocks).forEach((mock) => mock.mockReset());
    setupDefaultToolMock();

    // Default selector locate result
    mocks.locate.mockResolvedValue({ ref: 'ref_default', frameId: 0, resolvedBy: 'css' });

    // Default tabs.query returns current tab
    mocks.tabsQuery.mockResolvedValue([
      {
        id: TAB_ID,
        url: 'https://example.com/',
        title: 'Example',
        windowId: 1,
        status: 'complete',
      },
    ]);

    // Default tabs.get returns tab info
    mocks.tabsGet.mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: 'https://example.com/',
      windowId: TARGET_WINDOW_ID,
      status: 'complete',
    }));

    // Default tab/window creation
    mocks.tabsCreate.mockResolvedValue({ id: NEW_TAB_ID });
    mocks.tabsUpdate.mockResolvedValue({});
    mocks.windowsCreate.mockResolvedValue({ tabs: [{ id: NEW_TAB_ID }] });
    mocks.windowsUpdate.mockResolvedValue({});

    // Stub chrome.* globals
    vi.stubGlobal('chrome', {
      tabs: {
        query: mocks.tabsQuery,
        get: mocks.tabsGet,
        create: mocks.tabsCreate,
        update: mocks.tabsUpdate,
      },
      windows: {
        create: mocks.windowsCreate,
        update: mocks.windowsUpdate,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // ctx.tabId Sync Tests
  // ===========================================================================

  describe('ctx.tabId sync after tab operations', () => {
    it('openTab updates ctx.tabId for subsequent steps', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['openTab', 'click']) });
      const ctx = createMockExecCtx({ tabId: TAB_ID });

      const openStep: TestStep = {
        id: 'openTab_updates_ctx_tabId',
        type: 'openTab',
        newWindow: false,
      };

      await executor.execute(ctx, openStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // ctx.tabId should be updated to the new tab
      expect(ctx.tabId).toBe(NEW_TAB_ID);

      // Verify subsequent step uses the new tabId
      mocks.locate.mockResolvedValueOnce(undefined);

      const clickStep: TestStep = {
        id: 'click_after_openTab',
        type: 'click',
        target: {
          candidates: [{ type: 'css', value: '#btn' }],
        },
      };

      await executor.execute(ctx, clickStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // The click tool should be called with the NEW_TAB_ID
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.objectContaining({ tabId: NEW_TAB_ID }),
        }),
      );
    });

    it('switchTab updates ctx.tabId for subsequent steps', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab', 'click']) });
      // 2026-09-05 검토 항목 5: 대상은 run 이 연 탭(= 소유 탭)이어야 한다.
      const ctx = createMockExecCtx({ tabId: TAB_ID, ownedTabIds: new Set([TARGET_TAB_ID]) });

      const switchStep: TestStep = {
        id: 'switchTab_updates_ctx_tabId',
        type: 'switchTab',
        tabId: TARGET_TAB_ID,
      };

      await executor.execute(ctx, switchStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // ctx.tabId should be updated to the target tab
      expect(ctx.tabId).toBe(TARGET_TAB_ID);

      // Verify subsequent step uses the new tabId
      mocks.locate.mockResolvedValueOnce(undefined);

      const clickStep: TestStep = {
        id: 'click_after_switchTab',
        type: 'click',
        target: {
          candidates: [{ type: 'css', value: '#btn' }],
        },
      };

      await executor.execute(ctx, clickStep as never, { tabId: ctx.tabId ?? TAB_ID });

      // The click tool should be called with the TARGET_TAB_ID
      expect(mocks.handleCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.objectContaining({ tabId: TARGET_TAB_ID }),
        }),
      );
    });
  });

  // ===========================================================================
  // Basic Tab Operations Tests
  // ===========================================================================

  describe('basic tab operations', () => {
    it('openTab success with new window', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['openTab']) });
      const ctx = createMockExecCtx();

      const step: TestStep = {
        id: 'openTab_newWindow_success',
        type: 'openTab',
        newWindow: true,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      // auto-chrome-mcp fork v1.9.0: 창 생성은 mcp-window-manager 를 거친다 —
      // 강제 포커스 기본 OFF 라 focused:false 로 만들고, 기본 배치(minimized)는 만든 뒤
      // windows.update 로 적용한다(create 인자의 state 는 크롬이 무시한다).
      expect(mocks.windowsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'about:blank', focused: false }),
      );
    });

    it('openTab success with new tab in current window', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['openTab']) });
      const ctx = createMockExecCtx();

      const step: TestStep = {
        id: 'openTab_newTab_success',
        type: 'openTab',
        url: 'https://example.com/new-page',
        newWindow: false,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      // auto-chrome-mcp fork v1.9.0: 사용자 창에 만드는 탭은 활성화하지 않는다
      // (activation-guard 가 active:true 를 false 로 강등).
      expect(mocks.tabsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/new-page', active: false }),
      );
    });

    it('switchTab 은 url·title 로 브라우저 전체를 뒤지지 않는다', async () => {
      // 2026-09-05 Codex 검토 항목 5: url/title 검색은 사용자의 탭을 골라 조작하게 만든다.
      // 이제는 run 이 연 탭의 id 로만 옮겨간다.
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx();

      for (const step of [
        { id: 'switchTab_urlContains_refused', type: 'switchTab', urlContains: 'docs.example.com' },
        { id: 'switchTab_titleContains_refused', type: 'switchTab', titleContains: 'Settings' },
      ] as TestStep[]) {
        await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
          /tab_scope_violation/,
        );
      }

      // 전역 탭 조회 자체가 일어나지 않는다.
      expect(mocks.tabsQuery).not.toHaveBeenCalled();
      expect(mocks.tabsUpdate).not.toHaveBeenCalled();
      expect(mocks.windowsUpdate).not.toHaveBeenCalled();
    });

    it('switchTab 은 run 소유가 아닌 탭 id 를 거절한다', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx({ tabId: TAB_ID });

      const step: TestStep = {
        id: 'switchTab_foreign_tab_refused',
        type: 'switchTab',
        tabId: TARGET_TAB_ID,
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        /tab_scope_violation/,
      );
    });

    it('switchTab by explicit tabId', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx({ ownedTabIds: new Set([TARGET_TAB_ID]) });

      mocks.tabsGet.mockResolvedValueOnce({
        id: TARGET_TAB_ID,
        url: 'https://example.com/',
        windowId: TARGET_WINDOW_ID,
        status: 'complete',
      });

      const step: TestStep = {
        id: 'switchTab_byId_success',
        type: 'switchTab',
        tabId: TARGET_TAB_ID,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      // v1.9.0: 백그라운드 작업 모드 기본 ON — 활성화하지 않는다.
      expect(mocks.tabsUpdate).not.toHaveBeenCalled();
      // auto-chrome-mcp fork: window 포커스는 focusWindowIfAllowed 게이트 통과 시에만 — 기본 OFF 라 미호출
      expect(mocks.windowsUpdate).not.toHaveBeenCalled();
    });

    // 2026-09-05 검토 항목 5: 재생은 탭을 앞으로 끌어내지 않는다. foreground:true 도 마찬가지다
    // (예전에는 이 값으로 활성화 게이트를 우회할 수 있었다).
    it('switchTab with foreground:true no longer activates the tab', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx({ ownedTabIds: new Set([TARGET_TAB_ID]) });

      mocks.tabsGet.mockResolvedValue({
        id: TARGET_TAB_ID,
        url: 'https://example.com/',
        windowId: TARGET_WINDOW_ID,
        status: 'complete',
      });

      const step: TestStep = {
        id: 'switchTab_foreground_success',
        type: 'switchTab',
        tabId: TARGET_TAB_ID,
        foreground: true,
      };

      const result = await executor.execute(ctx, step as never, { tabId: TAB_ID });

      expect(result.executor).toBe('actions');
      expect(mocks.tabsUpdate).not.toHaveBeenCalled();
      expect(mocks.windowsUpdate).not.toHaveBeenCalled();
    });

    it('switchTab 은 사정권 밖 요청에 사정권을 알려 준다', async () => {
      const executor = createExecutor({ actionsAllowlist: new Set(['switchTab']) });
      const ctx = createMockExecCtx({ tabId: TAB_ID });

      const step: TestStep = {
        id: 'switchTab_not_found',
        type: 'switchTab',
        urlContains: 'nonexistent.example.com',
      };

      await expect(executor.execute(ctx, step as never, { tabId: TAB_ID })).rejects.toThrow(
        /tabs it opened itself/,
      );
    });
  });
});
