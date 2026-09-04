/**
 * @fileoverview Vitest Global Setup
 * @description Provides global configuration and polyfills for test environment
 */

import { vi } from 'vitest';

// Provide IndexedDB globals (jsdom doesn't include them)
import 'fake-indexeddb/auto';

// Mock chrome API (basic placeholder)
if (typeof globalThis.chrome === 'undefined') {
  (globalThis as unknown as { chrome: object }).chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      connect: vi.fn().mockReturnValue({
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      }),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      // auto-chrome-mcp fork: work-tab-manager / mcp-window-manager persist to storage.session
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,'),
      // auto-chrome-mcp fork: MCP 작업 탭 그룹 편입 (utils/mcp-tab-group.ts)
      group: vi.fn().mockResolvedValue(100),
      ungroup: vi.fn().mockResolvedValue(undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // auto-chrome-mcp fork: 탭 그룹 "MCP" 조회·제목/색 지정 (utils/mcp-tab-group.ts)
    tabGroups: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 100, title: 'MCP', color: 'green', windowId: 1 }),
      update: vi.fn().mockResolvedValue({ id: 100, title: 'MCP', color: 'green', windowId: 1 }),
      move: vi.fn().mockResolvedValue(undefined),
      TAB_GROUP_ID_NONE: -1,
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // auto-chrome-mcp fork: work-tab badge ("MCP") lives on chrome.action
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      setIcon: vi.fn().mockResolvedValue(undefined),
    },
    // auto-chrome-mcp fork: dedicated MCP work window (mcp-window-manager)
    windows: {
      get: vi.fn().mockResolvedValue({ id: 1 }),
      getAll: vi.fn().mockResolvedValue([]),
      getCurrent: vi.fn().mockResolvedValue({ id: 1 }),
      getLastFocused: vi.fn().mockResolvedValue({ id: 1 }),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({ id: 1 }),
      remove: vi.fn().mockResolvedValue(undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    debugger: {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
    },
    commands: {
      onCommand: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      remove: vi.fn(),
      onClicked: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}
