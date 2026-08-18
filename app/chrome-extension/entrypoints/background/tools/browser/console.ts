import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { focusWindowIfAllowed } from '@/utils/focus-policy';
import {
  consoleBuffer,
  BufferedConsoleMessage,
  BufferedConsoleException,
  // auto-chrome-mcp fork (upstream #215): 얕은 preview로 인한 중첩 객체 손실을 보정하는 공용 직렬화 유틸
  buildSerializedConsoleArgs,
  createRunBudget,
} from './console-buffer';

const DEFAULT_MAX_MESSAGES = 100;

type ConsoleMode = 'snapshot' | 'buffer';

interface ConsoleToolParams {
  url?: string;
  tabId?: number;
  background?: boolean;
  windowId?: number;
  includeExceptions?: boolean;
  maxMessages?: number;
  // 新增参数
  mode?: ConsoleMode;
  buffer?: boolean; // mode="buffer" 的别名
  clear?: boolean; // 读取前清空
  clearAfterRead?: boolean; // 读取后清空（mcp-tools.js 风格）
  pattern?: string;
  onlyErrors?: boolean;
  limit?: number;
  // auto-chrome-mcp fork: 페이지네이션 — 필터링 이후 결과 배열을 자르는 offset, 개수만 반환하는 countOnly
  offset?: number;
  countOnly?: boolean;
}

interface ConsoleMessage {
  timestamp: number;
  level: string;
  text: string;
  args?: any[];
  argsSerialized?: unknown[];
  // auto-chrome-mcp fork: 이 메시지에서 깊은 직렬화로 복원한 인자 수
  argsDeepSerializedCount?: number;
  source?: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: any;
}

interface ConsoleException {
  timestamp: number;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: any;
}

interface ConsoleResult {
  success: boolean;
  message: string;
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  captureStartTime: number;
  captureEndTime: number;
  totalDurationMs: number;
  messages: ConsoleMessage[];
  exceptions: ConsoleException[];
  messageCount: number;
  exceptionCount: number;
  messageLimitReached: boolean;
  droppedMessageCount: number;
  droppedExceptionCount: number;
  // auto-chrome-mcp fork: 예산 상한 때문에 깊은 직렬화를 건너뛴 인자 수(0이면 손실 없음)
  deepSerializationSkipped?: number;
}

// 辅助函数

function normalizeLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, n);
}

function parseRegexPattern(pattern?: string): RegExp | undefined {
  if (typeof pattern !== 'string') return undefined;
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  // 支持 /pattern/flags 语法
  const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    return match ? new RegExp(match[1], match[2]) : new RegExp(trimmed);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid regex pattern: ${msg}`);
  }
}

function matchesPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function isErrorLevel(level?: string): boolean {
  const normalized = (level || '').toLowerCase();
  return normalized === 'error' || normalized === 'assert';
}

function applyResultFilters(
  result: ConsoleResult,
  options: { pattern?: RegExp; onlyErrors?: boolean; includeExceptions: boolean },
): ConsoleResult {
  const { pattern, onlyErrors = false, includeExceptions } = options;

  let messages = result.messages;
  if (onlyErrors) {
    messages = messages.filter((m) => isErrorLevel(m.level));
  }
  if (pattern) {
    messages = messages.filter((m) => matchesPattern(pattern, m.text || ''));
  }

  let exceptions = includeExceptions ? result.exceptions : [];
  if (includeExceptions && pattern) {
    exceptions = exceptions.filter((e) => matchesPattern(pattern, e.text || ''));
  }

  return {
    ...result,
    messages,
    exceptions,
    messageCount: messages.length,
    exceptionCount: exceptions.length,
  };
}

// auto-chrome-mcp fork: countOnly/limit/offset 페이지네이션 — messages 배열에만 적용(필터링 이후), exceptions는 그대로 유지
interface PaginationResult {
  messages?: ConsoleMessage[];
  totalCount: number;
  returnedCount: number;
  offset: number;
  hasMore: boolean;
}

function paginateMessages(
  messages: ConsoleMessage[],
  options: { limit: number; offset: number; countOnly: boolean },
): PaginationResult {
  const { limit, offset, countOnly } = options;
  const totalCount = messages.length;
  if (countOnly) {
    return { totalCount, returnedCount: 0, offset, hasMore: offset < totalCount };
  }
  const sliced = messages.slice(offset, offset + limit);
  return {
    messages: sliced,
    totalCount,
    returnedCount: sliced.length,
    offset,
    hasMore: offset + sliced.length < totalCount,
  };
}

function isDebuggerConflictError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('debugger is already attached') || msg.includes('another client');
}

function formatDebuggerConflictMessage(tabId: number, originalMessage: string): string {
  return (
    `Failed to attach Chrome Debugger to tab ${tabId}: another debugger client is already attached ` +
    `(likely DevTools or another extension). Close DevTools for this tab or disable the conflicting extension, ` +
    `then retry. Original error: ${originalMessage}`
  );
}

/**
 * Tool for capturing console output from browser tabs
 */
class ConsoleTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CONSOLE;

  async execute(args: ConsoleToolParams): Promise<ToolResult> {
    const {
      url,
      tabId,
      windowId,
      background = false,
      includeExceptions = true,
      maxMessages = DEFAULT_MAX_MESSAGES,
      mode = 'snapshot',
      buffer,
      clear = false,
      clearAfterRead = false,
      pattern,
      onlyErrors = false,
      limit,
      offset,
      countOnly,
    } = args;

    let targetTab: chrome.tabs.Tab;
    let targetTabId: number | undefined;

    // 解析正则表达式
    let compiledPattern: RegExp | undefined;
    try {
      compiledPattern = parseRegexPattern(pattern);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return createErrorResponse(msg);
    }

    try {
      if (typeof tabId === 'number') {
        // Use explicit tab
        const t = await chrome.tabs.get(tabId);
        if (!t?.id) return createErrorResponse('Failed to identify target tab.');
        targetTab = t;
      } else if (url) {
        // Navigate to the specified URL
        targetTab = await this.navigateToUrl(url, background === true, windowId);
      } else {
        // Use current active tab
        const [activeTab] =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) {
          return createErrorResponse('No active tab found and no URL provided.');
        }
        targetTab = activeTab;
      }

      if (!targetTab?.id) {
        return createErrorResponse('Failed to identify target tab.');
      }

      targetTabId = targetTab.id;

      // 确定模式：buffer 参数是 mode="buffer" 的别名
      const resolvedMode: ConsoleMode =
        mode === 'buffer' || buffer === true ? 'buffer' : 'snapshot';

      // 计算有效的消息限制
      const normalizedMaxMessages = normalizeLimit(maxMessages, DEFAULT_MAX_MESSAGES);
      // auto-chrome-mcp fork: limit은 상한(normalizedMaxMessages)을 더 작게만 줄일 수 있다 — 늘리는 용도로는 쓰지 않는다
      const effectiveLimit =
        typeof limit === 'number'
          ? Math.min(normalizeLimit(limit, normalizedMaxMessages), normalizedMaxMessages)
          : normalizedMaxMessages;
      // auto-chrome-mcp fork: 필터링 이후 결과 배열을 자르는 offset (기본 0)
      const normalizedOffset = normalizeLimit(offset, 0);
      const isCountOnly = countOnly === true;

      // Buffer 模式
      if (resolvedMode === 'buffer') {
        try {
          await consoleBuffer.ensureStarted(targetTabId);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          if (isDebuggerConflictError(error)) {
            return createErrorResponse(formatDebuggerConflictMessage(targetTabId, msg));
          }
          throw error;
        }

        // 处理读取前清空请求
        let clearedBefore: { clearedMessages: number; clearedExceptions: number } | null = null;
        if (clear === true) {
          clearedBefore = consoleBuffer.clear(targetTabId, 'manual');
        }

        // 读取缓冲区
        const read = consoleBuffer.read(targetTabId, {
          pattern: compiledPattern,
          onlyErrors,
          limit: effectiveLimit,
          includeExceptions,
        });

        if (!read) {
          return createErrorResponse('Console buffer is not available for this tab.');
        }

        // 处理读取后清空请求（mcp-tools.js 风格，避免重复读取）
        let clearedAfter: { clearedMessages: number; clearedExceptions: number } | null = null;
        if (clearAfterRead === true) {
          clearedAfter = consoleBuffer.clear(targetTabId, 'manual');
        }

        // 构建清空摘要
        let clearedSummary = '';
        if (clearedBefore) {
          clearedSummary += ` Cleared ${clearedBefore.clearedMessages} messages and ${clearedBefore.clearedExceptions} exceptions before reading.`;
        }
        if (clearedAfter) {
          clearedSummary += ` Cleared ${clearedAfter.clearedMessages} messages and ${clearedAfter.clearedExceptions} exceptions after reading.`;
        }

        // auto-chrome-mcp fork: countOnly/limit/offset — buffer 모드에서도 읽어온 messages 배열에 동일하게 페이지네이션 적용
        const bufferPagination = paginateMessages(read.messages as ConsoleMessage[], {
          limit: effectiveLimit,
          offset: normalizedOffset,
          countOnly: isCountOnly,
        });

        const result = {
          success: true,
          message:
            `Console buffer read for tab ${targetTabId}.` +
            clearedSummary +
            ` Returned ${bufferPagination.returnedCount} messages and ${read.exceptionCount} exceptions.`,
          tabId: targetTabId,
          tabUrl: read.tabUrl || '',
          tabTitle: read.tabTitle || '',
          captureStartTime: read.captureStartTime,
          captureEndTime: read.captureEndTime,
          totalDurationMs: read.totalDurationMs,
          ...(isCountOnly ? {} : { messages: bufferPagination.messages }),
          exceptions: read.exceptions as ConsoleException[],
          messageCount: read.messageCount,
          exceptionCount: read.exceptionCount,
          messageLimitReached: read.messageLimitReached,
          droppedMessageCount: read.droppedMessageCount,
          droppedExceptionCount: read.droppedExceptionCount,
          deepSerializationSkipped: read.deepSerializationSkipped,
          totalCount: bufferPagination.totalCount,
          returnedCount: bufferPagination.returnedCount,
          offset: bufferPagination.offset,
          hasMore: bufferPagination.hasMore,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        };
      }

      // Snapshot 模式（一次性捕获）
      const result = await this.captureConsoleMessages(targetTabId, {
        includeExceptions,
        maxMessages: effectiveLimit,
      });

      // 应用过滤器
      const filtered = applyResultFilters(result, {
        pattern: compiledPattern,
        onlyErrors,
        includeExceptions,
      });

      // auto-chrome-mcp fork: countOnly/limit/offset — 필터링 이후 messages 배열에 페이지네이션 적용
      const { messages: filteredMessages, ...filteredRest } = filtered;
      const snapshotPagination = paginateMessages(filteredMessages, {
        limit: effectiveLimit,
        offset: normalizedOffset,
        countOnly: isCountOnly,
      });
      const paginatedResult = {
        ...filteredRest,
        ...(isCountOnly ? {} : { messages: snapshotPagination.messages }),
        totalCount: snapshotPagination.totalCount,
        returnedCount: snapshotPagination.returnedCount,
        offset: snapshotPagination.offset,
        hasMore: snapshotPagination.hasMore,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(paginatedResult) }],
        isError: false,
      };
    } catch (error: unknown) {
      console.error('ConsoleTool: Critical error during execute:', error);
      const msg = error instanceof Error ? error.message : String(error);
      if (typeof targetTabId === 'number' && isDebuggerConflictError(error)) {
        return createErrorResponse(formatDebuggerConflictMessage(targetTabId, msg));
      }
      return createErrorResponse(`Error in ConsoleTool: ${msg}`);
    }
  }

  private async navigateToUrl(
    url: string,
    background = false,
    windowId?: number,
  ): Promise<chrome.tabs.Tab> {
    // Check if URL is already open
    const existingTabs = await chrome.tabs.query({ url });

    if (existingTabs.length > 0 && existingTabs[0]?.id) {
      const tab = existingTabs[0];
      if (!background) {
        // auto-chrome-mcp fork: 콘솔 수집은 CDP Runtime/Log 도메인으로 동작하므로 탭 활성화는 불필요 — 정책 게이트를 통과한 경우에만 윈도우 포커스.
        await focusWindowIfAllowed(tab.windowId);
      }
      return tab;
    } else {
      // Create new tab with the URL
      const createInfo: chrome.tabs.CreateProperties = { url, active: background ? false : true };
      if (typeof windowId === 'number') createInfo.windowId = windowId;
      const newTab = await chrome.tabs.create(createInfo);
      // Wait for tab to be ready
      await this.waitForTabReady(newTab.id!);
      return newTab;
    }
  }

  private async waitForTabReady(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      const checkTab = async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') {
            resolve();
          } else {
            setTimeout(checkTab, 100);
          }
        } catch (error) {
          // Tab might be closed, resolve anyway
          resolve();
        }
      };
      checkTab();
    });
  }

  private formatConsoleArgs(args: any[]): string {
    if (!args || args.length === 0) return '';

    return args
      .map((arg) => {
        if (arg.type === 'string') {
          return arg.value || '';
        } else if (arg.type === 'number') {
          return String(arg.value || '');
        } else if (arg.type === 'boolean') {
          return String(arg.value || '');
        } else if (arg.type === 'object') {
          return arg.description || '[Object]';
        } else if (arg.type === 'undefined') {
          return 'undefined';
        } else if (arg.type === 'function') {
          return arg.description || '[Function]';
        } else {
          return arg.description || arg.value || String(arg);
        }
      })
      .join(' ');
  }

  private async captureConsoleMessages(
    tabId: number,
    options: {
      includeExceptions: boolean;
      maxMessages: number;
    },
  ): Promise<ConsoleResult> {
    const { includeExceptions, maxMessages } = options;
    const startTime = Date.now();
    const messages: ConsoleMessage[] = [];
    const exceptions: ConsoleException[] = [];
    let limitReached = false;
    // auto-chrome-mcp fork: 예산 상한으로 깊은 직렬화를 건너뛴 인자 수(관측용)
    let deepSerializationSkipped = 0;

    try {
      // Get tab information
      const tab = await chrome.tabs.get(tabId);

      // Attach via shared manager
      await cdpSessionManager.attach(tabId, 'console');

      // Set up event listener to collect messages
      const collectedMessages: any[] = [];
      const collectedExceptions: any[] = [];

      const eventListener = (source: chrome.debugger.Debuggee, method: string, params?: any) => {
        if (source.tabId !== tabId) return;

        if (method === 'Log.entryAdded' && params?.entry) {
          collectedMessages.push(params.entry);
        } else if (method === 'Runtime.consoleAPICalled' && params) {
          // Convert Runtime.consoleAPICalled to Log.entryAdded format
          const logEntry = {
            timestamp: params.timestamp,
            level: params.type || 'log',
            text: this.formatConsoleArgs(params.args || []),
            source: 'console-api',
            url: params.stackTrace?.callFrames?.[0]?.url,
            lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
            stackTrace: params.stackTrace,
            args: params.args,
          };
          collectedMessages.push(logEntry);
        } else if (
          method === 'Runtime.exceptionThrown' &&
          includeExceptions &&
          params?.exceptionDetails
        ) {
          collectedExceptions.push(params.exceptionDetails);
        }
      };

      chrome.debugger.onEvent.addListener(eventListener);

      try {
        // Enable Runtime domain first to capture console API calls and exceptions
        await cdpSessionManager.sendCommand(tabId, 'Runtime.enable');

        // Also enable Log domain to capture other log entries
        await cdpSessionManager.sendCommand(tabId, 'Log.enable');

        // Wait for all messages to be flushed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Process collected messages
        // auto-chrome-mcp fork (upstream #215): 예전에는 objectId가 있는 모든 인자를 매번
        // Runtime.callFunctionOn 으로 직렬화해 CDP 왕복이 폭주했고, 문자 수 상한도 없었다.
        // 이제는 preview가 실제로 손실된 인자만 깊이 직렬화하며(그 외는 preview 복원 fast path),
        // 이 캡처 1회당 총 호출 수와 벽시계 데드라인으로 상한을 건다.
        const deepBudget = createRunBudget();

        for (const entry of collectedMessages) {
          if (messages.length >= maxMessages) {
            limitReached = true;
            break;
          }

          const message: ConsoleMessage = {
            timestamp: entry.timestamp,
            level: entry.level || 'log',
            text: entry.text || '',
            source: entry.source,
            url: entry.url,
            lineNumber: entry.lineNumber,
          };

          if (entry.stackTrace) {
            message.stackTrace = entry.stackTrace;
          }

          if (entry.args && Array.isArray(entry.args)) {
            message.args = entry.args;
            // auto-chrome-mcp fork: shallow 결과를 먼저 채우고, 손실된 인자만 깊은 직렬화로 덮어쓴다.
            // 어떤 실패도 던지지 않으므로 툴 호출 자체는 절대 실패하지 않는다.
            const { args: serialized, deepCount } = await buildSerializedConsoleArgs(
              tabId,
              entry.args,
              deepBudget,
            );
            message.argsSerialized = serialized;
            if (deepCount > 0) message.argsDeepSerializedCount = deepCount;
          }

          messages.push(message);
        }
        deepSerializationSkipped = deepBudget.skipped;

        // Process collected exceptions
        for (const exceptionDetails of collectedExceptions) {
          const exception: ConsoleException = {
            timestamp: Date.now(),
            text:
              exceptionDetails.text ||
              exceptionDetails.exception?.description ||
              'Unknown exception',
            url: exceptionDetails.url,
            lineNumber: exceptionDetails.lineNumber,
            columnNumber: exceptionDetails.columnNumber,
          };

          if (exceptionDetails.stackTrace) {
            exception.stackTrace = exceptionDetails.stackTrace;
          }

          exceptions.push(exception);
        }
      } finally {
        // Clean up
        chrome.debugger.onEvent.removeListener(eventListener);

        // 如果 buffer 模式正在使用这个 tab，不要关闭 Runtime/Log 域
        const keepDomainsEnabled = consoleBuffer.isCapturing(tabId);
        if (!keepDomainsEnabled) {
          try {
            await cdpSessionManager.sendCommand(tabId, 'Runtime.disable');
          } catch (e) {
            console.warn(`ConsoleTool: Error disabling Runtime for tab ${tabId}:`, e);
          }

          try {
            await cdpSessionManager.sendCommand(tabId, 'Log.disable');
          } catch (e) {
            console.warn(`ConsoleTool: Error disabling Log for tab ${tabId}:`, e);
          }
        }

        try {
          await cdpSessionManager.detach(tabId, 'console');
        } catch (e) {
          console.warn(`ConsoleTool: Error detaching debugger for tab ${tabId}:`, e);
        }
      }

      const endTime = Date.now();

      // Sort messages by timestamp
      messages.sort((a, b) => a.timestamp - b.timestamp);
      exceptions.sort((a, b) => a.timestamp - b.timestamp);

      return {
        success: true,
        message: `Console capture completed for tab ${tabId}. ${messages.length} messages, ${exceptions.length} exceptions captured.`,
        tabId,
        tabUrl: tab.url || '',
        tabTitle: tab.title || '',
        captureStartTime: startTime,
        captureEndTime: endTime,
        totalDurationMs: endTime - startTime,
        messages,
        exceptions,
        messageCount: messages.length,
        exceptionCount: exceptions.length,
        messageLimitReached: limitReached,
        droppedMessageCount: 0,
        droppedExceptionCount: 0,
        deepSerializationSkipped,
      };
    } catch (error: any) {
      console.error(`ConsoleTool: Error capturing console messages for tab ${tabId}:`, error);
      throw error;
    }
  }
}

export const consoleTool = new ConsoleTool();
