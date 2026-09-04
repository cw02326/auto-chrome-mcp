export enum NativeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  // Additional message types used in Chrome extension
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
  // v1.0.19: bridge 가 EADDRINUSE 또는 강제 takeover 로 죽을 때 client 에 broadcast.
  // background 가 받으면 autoConnect 영구 OFF — popup 은 disconnected 로 고정,
  // 사용자가 ⚡ 연결 명시적으로 누를 때까지 자동 reconnect 안 함.
  PORT_CONFLICT = 'port_conflict',
}

/**
 * `SERVER_STARTED` payload — 네이티브 호스트가 HTTP 브리지를 띄운 뒤 확장에 보낸다.
 *
 * `authToken` 은 브리지의 로컬 HTTP 인증 토큰이다. 확장은 파일 시스템을 읽을 수 없어
 * `~/.auto-chrome-mcp/auth-token` 을 볼 수 없으므로, 이 메시지가 확장이 토큰을 얻는
 * 유일한 경로다. 확장은 이 값을 `chrome.storage.session`(디스크에 남지 않는다)에만
 * 보관하고 `/admin/*`, `/mcp` 호출에 `Authorization: Bearer <token>` 으로 붙인다.
 *
 * 옛 브리지는 이 필드를 보내지 않는다. 그때는 확장이 토큰 없이 붙고, 브리지도 인증을
 * 요구하지 않으므로 그대로 동작한다.
 */
export interface ServerStartedPayload {
  port: number;
  authToken?: string;
}

export interface NativeMessage<P = any, E = any> {
  type?: NativeMessageType;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}

// ============================================================
// Element Picker Types (chrome_request_element_selection)
// ============================================================

/**
 * A single element selection request from the AI.
 */
export interface ElementPickerRequest {
  /**
   * Optional stable request id. If omitted, the extension will generate one.
   */
  id?: string;
  /**
   * Short label shown to the user (e.g., "Login button").
   */
  name: string;
  /**
   * Optional longer instruction shown to the user.
   */
  description?: string;
}

/**
 * Bounding rectangle of a picked element.
 */
export interface PickedElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Center point of a picked element.
 */
export interface PickedElementPoint {
  x: number;
  y: number;
}

/**
 * A picked element that can be used with other tools (click, fill, etc.).
 */
export interface PickedElement {
  /**
   * Element ref written into window.__claudeElementMap (frame-local).
   * Can be used directly with chrome_click_element, chrome_fill_or_select, etc.
   */
  ref: string;
  /**
   * Best-effort stable CSS selector.
   */
  selector: string;
  /**
   * Selector type (currently CSS only).
   */
  selectorType: 'css';
  /**
   * Bounding rect in the element's frame viewport coordinates.
   */
  rect: PickedElementRect;
  /**
   * Center point in the element's frame viewport coordinates.
   * Can be used as coordinates for chrome_computer.
   */
  center: PickedElementPoint;
  /**
   * Optional text snippet to help verify the selection.
   */
  text?: string;
  /**
   * Lowercased tag name.
   */
  tagName?: string;
  /**
   * Chrome frameId for iframe targeting.
   * Pass this to chrome_click_element/chrome_fill_or_select for cross-frame support.
   */
  frameId: number;
}

/**
 * Result for a single element selection request.
 */
export interface ElementPickerResultItem {
  /**
   * The request id (matches the input request).
   */
  id: string;
  /**
   * The request name (for reference).
   */
  name: string;
  /**
   * The picked element, or null if not selected.
   */
  element: PickedElement | null;
  /**
   * Error message if selection failed for this request.
   */
  error?: string;
}

/**
 * Result of the chrome_request_element_selection tool.
 */
export interface ElementPickerResult {
  /**
   * True if the user confirmed all selections.
   */
  success: boolean;
  /**
   * Session identifier for this picker session.
   */
  sessionId: string;
  /**
   * Timeout value used for this session.
   */
  timeoutMs: number;
  /**
   * True if the user cancelled the selection.
   */
  cancelled?: boolean;
  /**
   * True if the selection timed out.
   */
  timedOut?: boolean;
  /**
   * List of request IDs that were not selected (for debugging).
   */
  missingRequestIds?: string[];
  /**
   * Results for each requested element.
   */
  results: ElementPickerResultItem[];
}
