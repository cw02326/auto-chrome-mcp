/**
 * Tab Management Action Handlers
 *
 * Handles browser tab operations:
 * - openTab: Open a new tab or window
 * - switchTab: Switch to a different tab
 * - closeTab: Close tab(s)
 * - handleDownload: Monitor and capture download information
 */

import { failed, invalid, ok, tryResolveString } from '../registry';
import type {
  ActionExecutionContext,
  ActionHandler,
  DownloadInfo,
  DownloadState,
  VariableStore,
} from '../types';
import { actionOwnedTabIds, isActionOwnedTab, markActionOwnedTab } from './common';
// v1.9.0: 창 생성은 mcp-window-manager 를 거친다 (배치·비포커스·복귀 규칙 적용).
import { createManagedWindow } from '@/utils/mcp-window-manager';

/**
 * 2026-09-05 Codex 검토 항목 1·5: 이 핸들러들도 legacy 노드와 같은 격리 규칙을 따른다.
 *   - 새 탭은 run 창에 백그라운드로 만들고 run 소유로 등록한다.
 *   - switchTab / closeTab 은 run 소유 탭만 대상으로 한다. url·title 전역 검색은 없다.
 *   - 탭을 앞으로 끌어내지 않는다 (활성화·창 포커스 없음).
 */

/** run 소유 밖의 탭을 건드리려 할 때의 공통 메시지. */
function scopeMessage(ctx: ActionExecutionContext, what: string): string {
  return `${what} This run may only touch the tab it was given and tabs it opened itself (${[
    ...actionOwnedTabIds(ctx),
  ].join(', ')}).`;
}

/** Default timeout for tab operations */
const DEFAULT_TAB_TIMEOUT_MS = 10000;

/** Default timeout for download operations */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;

// ================================
// openTab Handler
// ================================

export const openTabHandler: ActionHandler<'openTab'> = {
  type: 'openTab',

  validate: () => ok(),

  describe: (action) => {
    const url = typeof action.params.url === 'string' ? action.params.url : undefined;
    const displayUrl = url ? (url.length > 30 ? url.slice(0, 30) + '...' : url) : 'blank';
    return action.params.newWindow ? `Open window: ${displayUrl}` : `Open tab: ${displayUrl}`;
  },

  run: async (ctx, action) => {
    const params = action.params;

    // Resolve URL if provided
    let url: string | undefined;
    if (params.url !== undefined) {
      const urlResult = tryResolveString(params.url, ctx.vars);
      if (!urlResult.ok) {
        return failed('VALIDATION_ERROR', `Failed to resolve URL: ${urlResult.error}`);
      }
      url = urlResult.value.trim() || undefined;
    }

    try {
      let tabId: number;

      if (params.newWindow) {
        // 창 생성은 mcp-window-manager 한곳에서만 (배치·비포커스·복귀 규칙). 재생 중에는
        // 포커스를 가져가지 않으므로 focused 는 항상 false 다.
        const window = await createManagedWindow({ url: url || 'about:blank', focused: false });

        const tab = window?.tabs?.[0];
        if (!tab?.id) {
          return failed('TAB_NOT_FOUND', 'Failed to create new window');
        }
        tabId = tab.id;
      } else {
        // tab-create-ok: run 이 자기 작업 탭을 연다. run 창에 백그라운드로 만들고 run
        // 소유로 등록하므로 사용자가 쓰는 탭에는 닿지 않는다.
        const tab = await chrome.tabs.create({
          url: url || 'about:blank',
          active: false,
          ...(typeof ctx.windowId === 'number' ? { windowId: ctx.windowId } : {}),
        });

        if (!tab.id) {
          return failed('TAB_NOT_FOUND', 'Failed to create new tab');
        }
        tabId = tab.id;
      }

      markActionOwnedTab(ctx, tabId);

      // Wait for tab to be ready if URL was specified
      if (url) {
        await waitForTabComplete(tabId, DEFAULT_TAB_TIMEOUT_MS);
      }

      // Return newTabId for ctx.tabId sync (adapter 가 setRunTab 으로 재고정한다)
      return { status: 'success', newTabId: tabId };
    } catch (e) {
      return failed('UNKNOWN', `Failed to open tab: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ================================
// switchTab Handler
// ================================

export const switchTabHandler: ActionHandler<'switchTab'> = {
  type: 'switchTab',

  validate: (action) => {
    const params = action.params;
    const hasTabId = params.tabId !== undefined;
    const hasUrlContains = params.urlContains !== undefined;
    const hasTitleContains = params.titleContains !== undefined;

    if (!hasTabId && !hasUrlContains && !hasTitleContains) {
      return invalid('switchTab requires tabId, urlContains, or titleContains');
    }

    return ok();
  },

  describe: (action) => {
    if (action.params.tabId !== undefined) {
      return `Switch to tab #${action.params.tabId}`;
    }
    if (action.params.urlContains !== undefined) {
      return `Switch tab (URL contains)`;
    }
    if (action.params.titleContains !== undefined) {
      return `Switch tab (title contains)`;
    }
    return 'Switch tab';
  },

  run: async (ctx, action) => {
    const params = action.params;

    try {
      if (params.tabId === undefined) {
        // url·title 로 브라우저 전체를 뒤지는 경로는 제거했다 (검토 항목 5): 사용자의
        // 탭이 걸리면 그 탭을 조작하게 된다. run 이 연 탭은 id 를 알고 있다.
        return failed(
          'TAB_NOT_FOUND',
          scopeMessage(
            ctx,
            'tab_scope_violation: switchTab needs the id of a tab this run opened; matching by urlContains/titleContains would search the whole browser.',
          ),
        );
      }

      const targetTabId = params.tabId;
      if (!isActionOwnedTab(ctx, targetTabId)) {
        return failed(
          'TAB_NOT_FOUND',
          scopeMessage(ctx, `tab_scope_violation: switchTab refused tab ${targetTabId}.`),
        );
      }

      // 탭이 살아 있는지만 확인한다. 활성화·창 포커스는 하지 않는다 — 재생이 사용자의
      // 화면을 빼앗지 않는다. ctx 의 작업 탭 포인터(newTabId)만 바뀐다.
      await chrome.tabs.get(targetTabId);

      // Return newTabId for ctx.tabId sync
      return { status: 'success', newTabId: targetTabId };
    } catch (e) {
      return failed(
        'UNKNOWN',
        `Failed to switch tab: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

// ================================
// closeTab Handler
// ================================

export const closeTabHandler: ActionHandler<'closeTab'> = {
  type: 'closeTab',

  validate: () => ok(),

  describe: (action) => {
    if (action.params.tabIds && action.params.tabIds.length > 0) {
      return `Close ${action.params.tabIds.length} tab(s)`;
    }
    if (action.params.url !== undefined) {
      return 'Close tab (by URL)';
    }
    return 'Close current tab';
  },

  run: async (ctx, action) => {
    const params = action.params;

    try {
      let tabIds: number[] = [];
      const owned = actionOwnedTabIds(ctx);

      if (params.tabIds && params.tabIds.length > 0) {
        // Close specific tabs — run 소유 밖은 거절한다 (검토 항목 1).
        tabIds = [...params.tabIds];
        const outside = tabIds.filter((id) => !owned.has(id));
        if (outside.length) {
          return failed(
            'VALIDATION_ERROR',
            scopeMessage(
              ctx,
              `close_scope_violation: closeTab refused tab(s) ${outside.join(', ')}.`,
            ),
          );
        }
      } else if (params.url !== undefined) {
        // Find and close tabs by URL
        const urlResult = tryResolveString(params.url, ctx.vars);
        if (!urlResult.ok) {
          return failed('VALIDATION_ERROR', `Failed to resolve URL: ${urlResult.error}`);
        }
        const urlPattern = urlResult.value.trim().toLowerCase();

        // Empty pattern is invalid
        if (!urlPattern) {
          return failed('VALIDATION_ERROR', 'URL pattern cannot be empty');
        }

        // 후보는 run 소유 탭뿐이다. 전체 탭을 훑지 않는다.
        for (const id of owned) {
          try {
            const tab = await chrome.tabs.get(id);
            if ((tab?.url || '').toLowerCase().includes(urlPattern)) tabIds.push(id);
          } catch {
            // 이미 닫힌 탭은 후보가 아니다.
          }
        }
        if (tabIds.length === 0) {
          return failed(
            'VALIDATION_ERROR',
            scopeMessage(
              ctx,
              `close_scope_violation: closeTab found no run-owned tab whose url contains "${urlPattern}".`,
            ),
          );
        }
      } else {
        // Close current tab
        if (typeof ctx.tabId === 'number') {
          tabIds = [ctx.tabId];
        }
      }

      if (tabIds.length === 0) {
        return failed('TAB_NOT_FOUND', 'No tabs to close');
      }

      await chrome.tabs.remove(tabIds);
      return { status: 'success' };
    } catch (e) {
      return failed(
        'UNKNOWN',
        `Failed to close tab: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

// ================================
// handleDownload Handler
// ================================

export const handleDownloadHandler: ActionHandler<'handleDownload'> = {
  type: 'handleDownload',

  validate: () => ok(),

  describe: (action) => {
    if (action.params.filenameContains !== undefined) {
      return 'Handle download (by filename)';
    }
    return 'Handle download';
  },

  run: async (ctx, action) => {
    const params = action.params;
    const timeoutMs = action.policy?.timeout?.ms ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const waitForComplete = params.waitForComplete !== false;

    // Resolve filename pattern if provided
    let filenamePattern: string | undefined;
    if (params.filenameContains !== undefined) {
      const result = tryResolveString(params.filenameContains, ctx.vars);
      if (!result.ok) {
        return failed('VALIDATION_ERROR', `Failed to resolve filenameContains: ${result.error}`);
      }
      filenamePattern = result.value.toLowerCase();
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      let downloadId: number | undefined;
      let downloadInfo: DownloadInfo | undefined;
      let resolved = false;

      const cleanup = () => {
        chrome.downloads.onCreated.removeListener(onCreated);
        chrome.downloads.onChanged.removeListener(onChanged);
      };

      const finish = (result: Awaited<ReturnType<ActionHandler<'handleDownload'>['run']>>) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(result);
        }
      };

      const onCreated = (item: chrome.downloads.DownloadItem) => {
        // Check if this download matches our criteria
        if (filenamePattern) {
          const filename = item.filename.toLowerCase();
          if (!filename.includes(filenamePattern)) return;
        }

        downloadId = item.id;
        downloadInfo = {
          id: String(item.id),
          filename: item.filename,
          url: item.url,
          state: item.state as DownloadState,
          size: item.totalBytes > 0 ? item.totalBytes : undefined,
        };

        if (!waitForComplete || item.state === 'complete') {
          storeAndFinish();
        }
      };

      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;

        if (delta.state) {
          if (downloadInfo) {
            downloadInfo.state = delta.state.current as DownloadState;
          }

          if (delta.state.current === 'complete') {
            storeAndFinish();
          } else if (delta.state.current === 'interrupted') {
            finish(failed('DOWNLOAD_FAILED', 'Download was interrupted'));
          }
        }

        if (delta.filename && downloadInfo) {
          downloadInfo.filename = delta.filename.current || downloadInfo.filename;
        }

        if (delta.totalBytes && downloadInfo && delta.totalBytes.current) {
          downloadInfo.size = delta.totalBytes.current;
        }
      };

      const storeAndFinish = () => {
        if (params.saveAs && downloadInfo) {
          ctx.vars[params.saveAs] = downloadInfo as unknown as VariableStore[string];
        }
        finish({
          status: 'success',
          output: downloadInfo ? { download: downloadInfo } : undefined,
        });
      };

      // Set up listeners
      chrome.downloads.onCreated.addListener(onCreated);
      chrome.downloads.onChanged.addListener(onChanged);

      // Set up timeout
      const checkTimeout = () => {
        if (resolved) return;
        if (Date.now() - startTime > timeoutMs) {
          finish(failed('TIMEOUT', `Download timeout after ${timeoutMs}ms`));
        } else {
          setTimeout(checkTimeout, 500);
        }
      };
      setTimeout(checkTimeout, 500);
    });
  },
};

// ================================
// Helper Functions
// ================================

/**
 * Wait for a tab to complete loading
 */
async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const checkStatus = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);

        if (tab.status === 'complete') {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Tab load timeout after ${timeoutMs}ms`));
          return;
        }

        setTimeout(checkStatus, 100);
      } catch (e) {
        reject(e);
      }
    };

    checkStatus();
  });
}
