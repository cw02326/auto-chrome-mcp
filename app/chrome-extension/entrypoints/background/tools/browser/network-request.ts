import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { redactedArgsForLog, redactUrlForLog } from '@/utils/log-redact';

const DEFAULT_NETWORK_REQUEST_TIMEOUT = 30000; // For sending a single request via content script

interface NetworkRequestToolParams {
  url: string; // URL is always required
  tabId?: number; // Explicit tab to send the request from. Falls back to the active tab.
  method?: string; // Defaults to GET
  headers?: Record<string, string>; // User-provided headers
  body?: any; // User-provided body
  timeout?: number; // Timeout for the network request itself
  // Optional multipart/form-data descriptor. When provided, overrides body and lets the helper build FormData.
  // Shape: { fields?: Record<string, string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }
  // Or a compact array: [ [name, fileSpec, filename?], ... ] where fileSpec can be 'url:...', 'file:/abs/path', 'base64:...'
  formData?: any;
}

/**
 * NetworkRequestTool - Sends network requests based on provided parameters.
 */
class NetworkRequestTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_REQUEST;

  async execute(args: NetworkRequestToolParams): Promise<ToolResult> {
    const {
      url,
      tabId: requestedTabId,
      method = 'GET',
      headers = {},
      body,
      timeout = DEFAULT_NETWORK_REQUEST_TIMEOUT,
    } = args;

    console.log(`NetworkRequestTool: Executing with options:`, redactedArgsForLog(args));

    if (!url) {
      return createErrorResponse('URL parameter is required.');
    }

    try {
      const tab = (await this.tryGetTab(requestedTabId)) || (await this.getActiveTabInWindow());
      if (!tab?.id) {
        return createErrorResponse('No active tab found or tab has no ID.');
      }
      const activeTabId = tab.id;

      // Ensure content script is available in the target tab
      await this.injectContentScript(activeTabId, ['inject-scripts/network-helper.js']);

      // 2026-09-05 Codex 재확인 1: URL 원문이 그대로 찍혔다. 헤더는 예전부터 이름만 남긴다.
      console.log(
        `NetworkRequestTool: Sending to content script: URL=${redactUrlForLog(url)}, Method=${method}, Headers=${Object.keys(headers).join(',')}, BodyType=${typeof body}`,
      );

      const resultFromContentScript = await this.sendMessageToTab(activeTabId, {
        action: TOOL_MESSAGE_TYPES.NETWORK_SEND_REQUEST,
        url: url,
        method: method,
        headers: headers,
        body: body,
        formData: args.formData || null,
        timeout: timeout,
      });

      // 응답 본문에는 토큰·개인정보가 흔하므로 형태만 남긴다 (2026-09-05 Codex 재확인 1).
      console.log(
        `NetworkRequestTool: Response from content script: success=${resultFromContentScript?.success}, status=${resultFromContentScript?.status}`,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultFromContentScript),
          },
        ],
        isError: !resultFromContentScript?.success,
      };
    } catch (error: any) {
      console.error('NetworkRequestTool: Error sending network request:', error);
      return createErrorResponse(
        `Error sending network request: ${error.message || String(error)}`,
      );
    }
  }
}

export const networkRequestTool = new NetworkRequestTool();
