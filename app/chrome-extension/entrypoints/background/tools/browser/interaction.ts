import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
// auto-chrome-mcp fork: iframe 안의 요소를 찾기 위한 프레임 탐색 공용 모듈
import {
  isElementNotFoundError,
  probeActionFor,
  resolveFrameInfo,
  searchFramesForTarget,
  type FrameProbeHit,
} from './frame-resolver';

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  // auto-chrome-mcp fork: frameId 를 주면 프레임 탐색 없이 해당 프레임에서 바로 실행한다.
  // 생략하면 top frame 을 먼저 시도하고, 요소를 못 찾은 경우에만 iframe 들을 탐색한다.
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * auto-chrome-mcp fork: top frame 에서 요소를 못 찾았을 때 하위 iframe 들을 탐색한다.
   * probe 는 조회 전용 메시지라 부수효과가 없다.
   */
  private async findTargetFrame(
    tabId: number,
    target: { selector?: string; ref?: string; isXPath?: boolean },
  ): Promise<FrameProbeHit | null> {
    return searchFramesForTarget({
      tabId,
      probeFile: 'inject-scripts/click-helper.js',
      probeAction: probeActionFor(this.name),
      selector: target.selector,
      ref: target.ref,
      isXPath: target.isXPath,
      inject: (id, files, frameIds) =>
        this.injectContentScript(id, files, false, 'ISOLATED', false, frameIds),
      send: (id, message, frameId) => this.sendMessageToTab(id, message, frameId),
    });
  }

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = args.ref;
      let finalSelector = selector;

      // auto-chrome-mcp fork: frameId 를 명시하면 그 프레임만 대상으로 하고 탐색을 건너뛴다.
      const explicitFrameId = typeof frameId === 'number' ? frameId : undefined;
      let targetFrameId: number | undefined = explicitFrameId;
      let resolvedFrame: FrameProbeHit | null = null;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
        );

        let resolved: any = null;
        let resolveError: string | null = null;
        try {
          resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            targetFrameId,
          );
        } catch (error) {
          resolveError = error instanceof Error ? error.message : String(error);
        }

        // auto-chrome-mcp fork: top frame 에서 XPath 를 못 찾으면 iframe 들을 탐색해 다시 시도한다.
        if (!(resolved && resolved.success && resolved.ref) && explicitFrameId === undefined) {
          const hit = await this.findTargetFrame(tab.id, { selector, isXPath: true });
          if (hit) {
            try {
              await this.injectContentScript(
                tab.id,
                ['inject-scripts/accessibility-tree-helper.js'],
                false,
                'ISOLATED',
                false,
                [hit.frameId],
              );
              const retried = await this.sendMessageToTab(
                tab.id,
                {
                  action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                  selector,
                  isXPath: true,
                },
                hit.frameId,
              );
              if (retried && retried.success && retried.ref) {
                resolved = retried;
                resolveError = null;
                targetFrameId = hit.frameId;
                resolvedFrame = hit;
              }
            } catch {
              // 프레임 재시도 실패는 무시하고 아래에서 원래 오류를 반환한다.
            }
          }
        }

        if (resolved && resolved.success && resolved.ref) {
          finalRef = resolved.ref;
          finalSelector = undefined; // Use ref instead of selector
        } else if (resolveError !== null) {
          return createErrorResponse(`Error resolving XPath: ${resolveError}`);
        } else {
          return createErrorResponse(
            `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
          );
        }
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/click-helper.js'],
        false,
        'ISOLATED',
        false,
        typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
      );

      const clickMessage = {
        action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
        selector: finalSelector,
        coordinates,
        ref: finalRef,
        waitForNavigation,
        timeout,
        double: args.double === true,
        button,
        bubbles,
        cancelable,
        modifiers,
      };

      // Send click message to content script
      let result: any;
      try {
        result = await this.sendMessageToTab(tab.id, clickMessage, targetFrameId);
      } catch (error) {
        // auto-chrome-mcp fork: top frame 에서 "요소 없음"이면 iframe 들을 탐색해 재시도한다.
        // 좌표 클릭, 명시적 frameId, 연결 오류 등은 기존과 동일하게 그대로 실패시킨다.
        const message = error instanceof Error ? error.message : String(error);
        const canSearchFrames =
          explicitFrameId === undefined &&
          !coordinates &&
          (!!finalSelector || !!finalRef) &&
          isElementNotFoundError(message);
        if (!canSearchFrames) throw error;

        const hit = await this.findTargetFrame(tab.id, {
          selector: finalSelector,
          ref: finalRef,
        });
        if (!hit) throw error; // 못 찾으면 원래 오류를 그대로 전달(하위 호환)

        resolvedFrame = hit;
        targetFrameId = hit.frameId;
        result = await this.sendMessageToTab(tab.id, clickMessage, hit.frameId);
      }

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      const payload: Record<string, any> = {
        success: true,
        message: result.message || 'Click operation successful',
        elementInfo: result.elementInfo,
        navigationOccurred: result.navigationOccurred,
        clickMethod,
      };

      // auto-chrome-mcp fork: top frame 이 아닌 프레임에서 실행된 경우에만 프레임 정보를 덧붙인다.
      // (top frame 기본 경로의 응답 형식은 그대로 유지)
      if (typeof targetFrameId === 'number' && targetFrameId !== 0) {
        payload.frameId = targetFrameId;
        const info = resolvedFrame ?? (await resolveFrameInfo(tab.id, targetFrameId));
        payload.frameUrl = info?.frameUrl ?? null;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  // auto-chrome-mcp fork: frameId 를 주면 프레임 탐색 없이 해당 프레임에서 바로 실행한다.
  // 생략하면 top frame 을 먼저 시도하고, 요소를 못 찾은 경우에만 iframe 들을 탐색한다.
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * auto-chrome-mcp fork: top frame 에서 요소를 못 찾았을 때 하위 iframe 들을 탐색한다.
   * probe 는 조회 전용 메시지라 부수효과가 없다.
   */
  private async findTargetFrame(
    tabId: number,
    target: { selector?: string; ref?: string; isXPath?: boolean },
  ): Promise<FrameProbeHit | null> {
    return searchFramesForTarget({
      tabId,
      probeFile: 'inject-scripts/fill-helper.js',
      probeAction: probeActionFor(this.name),
      selector: target.selector,
      ref: target.ref,
      isXPath: target.isXPath,
      inject: (id, files, frameIds) =>
        this.injectContentScript(id, files, false, 'ISOLATED', false, frameIds),
      send: (id, message, frameId) => this.sendMessageToTab(id, message, frameId),
    });
  }

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !ref) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector');
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = ref;
      let finalSelector = selector;

      // auto-chrome-mcp fork: frameId 를 명시하면 그 프레임만 대상으로 하고 탐색을 건너뛴다.
      const explicitFrameId = typeof frameId === 'number' ? frameId : undefined;
      let targetFrameId: number | undefined = explicitFrameId;
      let resolvedFrame: FrameProbeHit | null = null;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
        );

        let resolved: any = null;
        let resolveError: string | null = null;
        try {
          resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            targetFrameId,
          );
        } catch (error) {
          resolveError = error instanceof Error ? error.message : String(error);
        }

        // auto-chrome-mcp fork: top frame 에서 XPath 를 못 찾으면 iframe 들을 탐색해 다시 시도한다.
        if (!(resolved && resolved.success && resolved.ref) && explicitFrameId === undefined) {
          const hit = await this.findTargetFrame(tab.id, { selector, isXPath: true });
          if (hit) {
            try {
              await this.injectContentScript(
                tab.id,
                ['inject-scripts/accessibility-tree-helper.js'],
                false,
                'ISOLATED',
                false,
                [hit.frameId],
              );
              const retried = await this.sendMessageToTab(
                tab.id,
                {
                  action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                  selector,
                  isXPath: true,
                },
                hit.frameId,
              );
              if (retried && retried.success && retried.ref) {
                resolved = retried;
                resolveError = null;
                targetFrameId = hit.frameId;
                resolvedFrame = hit;
              }
            } catch {
              // 프레임 재시도 실패는 무시하고 아래에서 원래 오류를 반환한다.
            }
          }
        }

        if (resolved && resolved.success && resolved.ref) {
          finalRef = resolved.ref;
          finalSelector = undefined; // Use ref instead of selector
        } else if (resolveError !== null) {
          return createErrorResponse(`Error resolving XPath: ${resolveError}`);
        } else {
          return createErrorResponse(
            `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
          );
        }
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/fill-helper.js'],
        false,
        'ISOLATED',
        false,
        typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
      );

      const fillMessage = {
        action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
        selector: finalSelector,
        ref: finalRef,
        value,
      };

      // Send fill message to content script
      let result: any;
      try {
        result = await this.sendMessageToTab(tab.id, fillMessage, targetFrameId);
      } catch (error) {
        // auto-chrome-mcp fork: top frame 에서 "요소 없음"이면 iframe 들을 탐색해 재시도한다.
        const message = error instanceof Error ? error.message : String(error);
        const canSearchFrames =
          explicitFrameId === undefined &&
          (!!finalSelector || !!finalRef) &&
          isElementNotFoundError(message);
        if (!canSearchFrames) throw error;

        const hit = await this.findTargetFrame(tab.id, {
          selector: finalSelector,
          ref: finalRef,
        });
        if (!hit) throw error; // 못 찾으면 원래 오류를 그대로 전달(하위 호환)

        resolvedFrame = hit;
        targetFrameId = hit.frameId;
        result = await this.sendMessageToTab(tab.id, fillMessage, hit.frameId);
      }

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      const payload: Record<string, any> = {
        success: true,
        message: result.message || 'Fill operation successful',
        elementInfo: result.elementInfo,
      };

      // auto-chrome-mcp fork: top frame 이 아닌 프레임에서 실행된 경우에만 프레임 정보를 덧붙인다.
      if (typeof targetFrameId === 'number' && targetFrameId !== 0) {
        payload.frameId = targetFrameId;
        const info = resolvedFrame ?? (await resolveFrameInfo(tab.id, targetFrameId));
        payload.frameUrl = info?.frameUrl ?? null;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
