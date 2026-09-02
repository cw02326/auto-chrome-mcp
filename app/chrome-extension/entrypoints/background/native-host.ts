import { NativeMessageType } from 'auto-chrome-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { NATIVE_HOST, STORAGE_KEYS, ERROR_MESSAGES, SUCCESS_MESSAGES } from '@/common/constants';
import { handleCallTool } from './tools';
import { listPublished, getFlow } from './record-replay/flow-store';
import { acquireKeepalive } from './keepalive-manager';
import { HeartbeatWatchdog, type HeartbeatPhase } from './native-heartbeat';

const LOG_PREFIX = '[NativeHost]';

let nativePort: chrome.runtime.Port | null = null;
export const HOST_NAME = NATIVE_HOST.NAME;

// ==================== Reconnect Configuration ====================

// v1.0.18: base delay 늘림 (500ms → 3s). Chrome NM 의 자동 reconnect 사이클 이
// 좀비 race 의 원인. 짧은 delay 로 끊임없이 connectNative 호출하면 매번 새 spawn →
// EADDRINUSE → self-exit → disconnect → 또 reconnect → ... 무한 사이클.
// fast attempts 도 8 → 3 으로 줄여서 더 빠르게 cooldown 진입.
const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_FAST_ATTEMPTS = 3;
const RECONNECT_COOLDOWN_DELAY_MS = 60_000;

// ==================== Heartbeat Configuration ====================
// auto-chrome-mcp fork: onDisconnect 가 안 뜨는 "silent-dead" 연결(HTTP hang, sleep/wake
// 좀비, half-open socket)을 능동 ping 으로 감지해 자동 복구. 건강하면 no-op.
const HEARTBEAT_INTERVAL_MS = 15_000; // 15s 주기 ping
const HEARTBEAT_TIMEOUT_MS = 3_000; // 각 ping 3s 안에 응답 없으면 miss
const HEARTBEAT_MAX_MISSES = 3; // 연속 3회(~45s) miss → silent-dead 판정

// ==================== Auto-connect State ====================

let keepaliveRelease: (() => void) | null = null;
let autoConnectEnabled = true;
let autoConnectLoaded = false;
let ensurePromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;

/**
 * Server status management interface
 */
interface ServerStatus {
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
}

let currentServerStatus: ServerStatus = {
  isRunning: false,
  lastUpdated: Date.now(),
};

/**
 * Save server status to chrome.storage
 */
async function saveServerStatus(status: ServerStatus): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_STATUS]: status });
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_SAVE_FAILED, error);
  }
}

/**
 * Load server status from chrome.storage
 */
async function loadServerStatus(): Promise<ServerStatus> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.SERVER_STATUS]);
    if (result[STORAGE_KEYS.SERVER_STATUS]) {
      return result[STORAGE_KEYS.SERVER_STATUS];
    }
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
  }
  return {
    isRunning: false,
    lastUpdated: Date.now(),
  };
}

/**
 * Broadcast server status change to all listeners.
 * v1.0.20: payload 에 nativeConnected 도 함께 — popup 이 polling 기다리지 않고
 * 즉시 nativeConnectionStatus 반영. PORT_CONFLICT 전후 "connected + !isRunning"
 * 노란색 race window 차단 용.
 */
function broadcastServerStatusChange(status: ServerStatus): void {
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED,
      payload: { ...status, nativeConnected: nativePort !== null },
    })
    .catch(() => {
      // Ignore errors if no listeners are present
    });
}

// ==================== Port Normalization ====================

/**
 * Normalize a port value to a valid port number or null.
 */
function normalizePort(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (port <= 0 || port > 65535) return null;
  return port;
}

// ==================== Reconnect Utilities ====================

/**
 * Add jitter to a delay value to avoid thundering herd.
 */
function withJitter(ms: number): number {
  const ratio = 0.7 + Math.random() * 0.6;
  return Math.max(0, Math.round(ms * ratio));
}

/**
 * Calculate reconnect delay based on attempt number.
 * Uses exponential backoff with jitter, then switches to cooldown interval.
 */
function getReconnectDelayMs(attempt: number): number {
  if (attempt >= RECONNECT_MAX_FAST_ATTEMPTS) {
    return withJitter(RECONNECT_COOLDOWN_DELAY_MS);
  }
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  return withJitter(delay);
}

/**
 * Clear the reconnect timer if active.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Reset reconnect state after successful connection.
 */
function resetReconnectState(): void {
  reconnectAttempts = 0;
  clearReconnectTimer();
}

// ==================== Keepalive Management ====================

/**
 * Sync keepalive hold based on autoConnectEnabled state.
 * When auto-connect is enabled, we hold a keepalive reference to keep SW alive.
 */
function syncKeepaliveHold(): void {
  if (autoConnectEnabled) {
    if (!keepaliveRelease) {
      keepaliveRelease = acquireKeepalive('native-host');
      console.debug(`${LOG_PREFIX} Acquired keepalive`);
    }
    return;
  }
  if (keepaliveRelease) {
    try {
      keepaliveRelease();
      console.debug(`${LOG_PREFIX} Released keepalive`);
    } catch {
      // Ignore
    }
    keepaliveRelease = null;
  }
}

// ==================== Auto-connect Settings ====================

/**
 * Load the nativeAutoConnectEnabled setting from storage.
 */
async function loadNativeAutoConnectEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]);
    const raw = result[STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED];
    if (typeof raw === 'boolean') return raw;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load nativeAutoConnectEnabled`, error);
  }
  return true; // Default to enabled
}

/**
 * Set the nativeAutoConnectEnabled setting and persist to storage.
 */
async function setNativeAutoConnectEnabled(enabled: boolean): Promise<void> {
  autoConnectEnabled = enabled;
  autoConnectLoaded = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]: enabled });
    console.debug(`${LOG_PREFIX} Set nativeAutoConnectEnabled=${enabled}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to persist nativeAutoConnectEnabled`, error);
  }
  syncKeepaliveHold();
}

// ==================== Port Preference ====================

/**
 * Get the preferred port for connecting to native server.
 * Priority: explicit override > user preference > last known port > default
 */
async function getPreferredPort(override?: unknown): Promise<number> {
  const explicit = normalizePort(override);
  if (explicit) return explicit;

  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.NATIVE_SERVER_PORT,
      STORAGE_KEYS.SERVER_STATUS,
    ]);

    const userPort = normalizePort(result[STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (userPort) return userPort;

    const status = result[STORAGE_KEYS.SERVER_STATUS] as Partial<ServerStatus> | undefined;
    const statusPort = normalizePort(status?.port);
    if (statusPort) return statusPort;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read preferred port`, error);
  }

  const inMemoryPort = normalizePort(currentServerStatus.port);
  if (inMemoryPort) return inMemoryPort;

  return NATIVE_HOST.DEFAULT_PORT;
}

// ==================== Reconnect Scheduling ====================

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function scheduleReconnect(reason: string): void {
  if (nativePort) return;
  if (manualDisconnect) return;
  if (!autoConnectEnabled) return;
  if (reconnectTimer) return;

  const delay = getReconnectDelayMs(reconnectAttempts);
  console.debug(
    `${LOG_PREFIX} Reconnect scheduled in ${delay}ms (attempt=${reconnectAttempts}, reason=${reason})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (nativePort) return;
    if (manualDisconnect || !autoConnectEnabled) return;

    reconnectAttempts += 1;
    void ensureNativeConnected(`reconnect:${reason}`).catch(() => {});
  }, delay);
}

// ==================== Server Status Update ====================

/**
 * Mark server as stopped and broadcast the change.
 */
async function markServerStopped(reason: string): Promise<void> {
  currentServerStatus = {
    isRunning: false,
    port: currentServerStatus.port,
    lastUpdated: Date.now(),
  };
  try {
    await saveServerStatus(currentServerStatus);
  } catch {
    // Ignore
  }
  broadcastServerStatusChange(currentServerStatus);
  console.debug(`${LOG_PREFIX} Server marked stopped (${reason})`);
}

// ==================== Heartbeat Watchdog ====================

/**
 * Broadcast heartbeat phase to UI listeners (popup badge: healthy=green,
 * suspect=yellow, dead→recovering). Reuses SERVER_STATUS_CHANGED so existing
 * listeners keep working; adds an extra `heartbeatPhase` field they may ignore.
 */
function broadcastHeartbeatPhase(phase: HeartbeatPhase): void {
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED,
      payload: {
        ...currentServerStatus,
        nativeConnected: nativePort !== null,
        heartbeatPhase: phase,
      },
    })
    .catch(() => {
      // Ignore if no listeners are present
    });
}

/**
 * Active liveness watchdog. Only runs while a session is confirmed live
 * (started on SERVER_STARTED, stopped on any disconnect). If the bridge stops
 * answering /ping for HEARTBEAT_MAX_MISSES consecutive checks, treat the port
 * as silently dead and drive a clean reconnect through the existing machinery.
 */
const heartbeat = new HeartbeatWatchdog({
  intervalMs: HEARTBEAT_INTERVAL_MS,
  maxMisses: HEARTBEAT_MAX_MISSES,
  ping: async () => {
    // Not our concern when there is no port — the onDisconnect/reconnect path owns that.
    if (!nativePort) return true;
    const port = normalizePort(currentServerStatus.port) ?? NATIVE_HOST.DEFAULT_PORT;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  onPhase: (phase) => {
    if (phase !== 'healthy') {
      console.warn(`${LOG_PREFIX} Heartbeat phase: ${phase}`);
    }
    broadcastHeartbeatPhase(phase);
  },
  onDead: () => {
    console.warn(`${LOG_PREFIX} Heartbeat: connection silently dead → forcing reconnect`);
    // Tear down the stale port. Note: calling port.disconnect() ourselves does NOT
    // fire our own onDisconnect listener, so we must drive recovery explicitly.
    const stale = nativePort;
    nativePort = null;
    try {
      stale?.disconnect();
    } catch {
      // Ignore
    }
    void markServerStopped('heartbeat_silent_dead');
    // Reset backoff so recovery is immediate rather than waiting out a cooldown.
    reconnectAttempts = 0;
    clearReconnectTimer();
    if (autoConnectEnabled && !manualDisconnect) {
      void ensureNativeConnected('heartbeat_recovery').catch(() => {});
    }
  },
});

// ==================== Core Ensure Function ====================

/**
 * Ensure native connection is established.
 * This is the main entry point for auto-connect logic.
 *
 * @param trigger - Description of what triggered this call (for logging)
 * @param portOverride - Optional explicit port to use
 * @returns Whether the connection is now established
 */
async function ensureNativeConnected(trigger: string, portOverride?: unknown): Promise<boolean> {
  // Concurrency protection: only one ensure flow at a time
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    // Load auto-connect setting if not yet loaded
    if (!autoConnectLoaded) {
      autoConnectEnabled = await loadNativeAutoConnectEnabled();
      autoConnectLoaded = true;
      syncKeepaliveHold();
    }

    // If auto-connect is disabled, do nothing
    if (!autoConnectEnabled) {
      console.debug(`${LOG_PREFIX} Auto-connect disabled, skipping ensure (trigger=${trigger})`);
      return false;
    }

    // Sync keepalive hold
    syncKeepaliveHold();

    // Already connected
    if (nativePort) {
      console.debug(`${LOG_PREFIX} Already connected (trigger=${trigger})`);
      return true;
    }

    // Get the port to use
    const port = await getPreferredPort(portOverride);
    console.debug(`${LOG_PREFIX} Attempting connection on port ${port} (trigger=${trigger})`);

    // Attempt connection
    const ok = connectNativeHost(port);
    if (!ok) {
      console.warn(`${LOG_PREFIX} Connection failed (trigger=${trigger})`);
      scheduleReconnect(`connect_failed:${trigger}`);
      return false;
    }

    console.debug(`${LOG_PREFIX} Connection initiated successfully (trigger=${trigger})`);
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

/**
 * Connect to the native messaging host
 * @returns Whether the connection was initiated successfully
 */
export function connectNativeHost(port: number = NATIVE_HOST.DEFAULT_PORT): boolean {
  if (nativePort) {
    return true;
  }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener(async (message) => {
      if (message.type === NativeMessageType.PROCESS_DATA && message.requestId) {
        const requestId = message.requestId;
        const requestPayload = message.payload;

        nativePort?.postMessage({
          responseToRequestId: requestId,
          payload: {
            status: 'success',
            message: SUCCESS_MESSAGES.TOOL_EXECUTED,
            data: requestPayload,
          },
        });
      } else if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
        const requestId = message.requestId;
        try {
          const result = await handleCallTool(message.payload);
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'success',
              message: SUCCESS_MESSAGES.TOOL_EXECUTED,
              data: result,
            },
          });
        } catch (error) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'error',
              message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else if (message.type === 'rr_list_published_flows' && message.requestId) {
        const requestId = message.requestId;
        try {
          const published = await listPublished();
          const items = [] as any[];
          for (const p of published) {
            const flow = await getFlow(p.id);
            if (!flow) continue;
            items.push({
              id: p.id,
              slug: p.slug,
              version: p.version,
              name: p.name,
              description: p.description || flow.description || '',
              variables: flow.variables || [],
              meta: flow.meta || {},
            });
          }
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: { status: 'success', items },
          });
        } catch (error: any) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: { status: 'error', error: error?.message || String(error) },
          });
        }
      } else if (message.type === NativeMessageType.SERVER_STARTED) {
        const port = message.payload?.port;
        currentServerStatus = {
          isRunning: true,
          port: port,
          lastUpdated: Date.now(),
        };
        await saveServerStatus(currentServerStatus);
        broadcastServerStatusChange(currentServerStatus);
        // Server is confirmed running - now we can reset reconnect state
        resetReconnectState();
        // auto-chrome-mcp fork: start active liveness watchdog for this live session.
        heartbeat.start();
        console.log(`${SUCCESS_MESSAGES.SERVER_STARTED} on port ${port}`);
      } else if (message.type === NativeMessageType.SERVER_STOPPED) {
        currentServerStatus = {
          isRunning: false,
          port: currentServerStatus.port, // Keep last known port for reconnection
          lastUpdated: Date.now(),
        };
        await saveServerStatus(currentServerStatus);
        broadcastServerStatusChange(currentServerStatus);
        console.log(SUCCESS_MESSAGES.SERVER_STOPPED);
      } else if (message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST) {
        console.error('Error from native host:', message.payload?.message || 'Unknown error');
      } else if (message.type === NativeMessageType.PORT_CONFLICT) {
        // v1.0.19: bridge 가 EADDRINUSE / takeover 로 죽기 직전 신호.
        // 자동 reconnect 영구 OFF. popup 은 disconnected 로 고정되며, 사용자가
        // ⚡ 연결 명시적으로 누르면 testNativeConnection 의 CONNECT_NATIVE 흐름이
        // setNativeAutoConnectEnabled(true) 로 다시 켬.
        const port = message.payload?.port;
        const reason = message.payload?.reason || 'unknown';
        console.warn(
          `${LOG_PREFIX} PORT_CONFLICT received (port ${port}, reason ${reason}) — disabling auto-reconnect`,
        );
        try {
          await setNativeAutoConnectEnabled(false);
        } catch {
          autoConnectEnabled = false;
        }
        // manualDisconnect 플래그 — onDisconnect 에서 reconnect 스케줄 안 잡게
        manualDisconnect = true;
        // v1.0.20: nativePort 즉시 disconnect — bridge 의 exit 까지 기다리는 race window
        // 차단. 이 window 동안 popup 이 "connected && !isRunning" 으로 노란색 깜빡임 발생함.
        // 강제로 끊긴 거니까 즉시 빨간색 'disconnected' 로.
        if (nativePort) {
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }
        // auto-chrome-mcp fork: conflict tears down the session — stop the watchdog.
        heartbeat.stop();
        void markServerStopped(`port_conflict:${reason}`);
      } else if (message.type === 'file_operation_response') {
        // Forward file operation response back to the requesting tool
        chrome.runtime.sendMessage(message).catch(() => {
          // Ignore if no listeners
        });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn(ERROR_MESSAGES.NATIVE_DISCONNECTED, chrome.runtime.lastError);
      nativePort = null;
      // auto-chrome-mcp fork: session ended — stop the liveness watchdog.
      heartbeat.stop();

      // Mark server as stopped since native host disconnection means server is down
      void markServerStopped('native_port_disconnected');

      // Handle reconnection based on disconnect reason
      if (manualDisconnect) {
        manualDisconnect = false;
        return;
      }
      if (!autoConnectEnabled) return;
      scheduleReconnect('native_port_disconnected');
    });

    nativePort.postMessage({ type: NativeMessageType.START, payload: { port } });
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  } catch (error) {
    console.warn(ERROR_MESSAGES.NATIVE_CONNECTION_FAILED, error);
    nativePort = null;
    return false;
  }
}

/**
 * Initialize native host listeners and load initial state
 */
export const initNativeHostListener = () => {
  // Initialize server status from storage
  loadServerStatus()
    .then((status) => {
      currentServerStatus = status;
    })
    .catch((error) => {
      console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
    });

  // Auto-connect on SW activation (covers SW restart after idle termination)
  void ensureNativeConnected('sw_startup').catch(() => {});

  // Auto-connect on Chrome browser startup
  chrome.runtime.onStartup.addListener(() => {
    void ensureNativeConnected('onStartup').catch(() => {});
  });

  // Auto-connect on extension install/update
  chrome.runtime.onInstalled.addListener(() => {
    void ensureNativeConnected('onInstalled').catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Allow UI to call tools directly
    if (message && message.type === 'call_tool' && message.name) {
      handleCallTool({ name: message.name, args: message.args })
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) =>
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    const msgType = typeof message === 'string' ? message : message?.type;

    // ENSURE_NATIVE: Trigger ensure without changing autoConnectEnabled
    if (msgType === NativeMessageType.ENSURE_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      ensureNativeConnected('ui_ensure', portOverride)
        .then((connected) => {
          sendResponse({ success: true, connected, autoConnectEnabled });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    // CONNECT_NATIVE: Explicit user connect, re-enables auto-connect
    if (msgType === NativeMessageType.CONNECT_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      const normalized = normalizePort(portOverride);

      (async () => {
        // Explicit user connect: re-enable auto-connect
        await setNativeAutoConnectEnabled(true);
        // v1.0.19: PORT_CONFLICT 로 인한 manualDisconnect 도 같이 해제 — 사용자가
        // ⚡ 연결 명시적으로 누른 시점부터 자동 reconnect 다시 활성.
        manualDisconnect = false;

        if (normalized) {
          // Best-effort: persist preferred port
          try {
            await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: normalized });
          } catch {
            // Ignore
          }
        }

        return ensureNativeConnected('ui_connect', normalized ?? undefined);
      })()
        .then((connected) => {
          sendResponse({ success: true, connected });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    if (msgType === NativeMessageType.PING_NATIVE) {
      const connected = nativePort !== null;
      sendResponse({ connected, autoConnectEnabled });
      return true;
    }

    // auto-chrome-mcp fork: Force Reconnect Stage A step ③ — supervisor 가 popup 에서
    // 호출. background 가 chrome.runtime.connectNative 트리거해서 Chrome 의 자동
    // respawn 을 발동. 기존 nativePort 가 있어도 force 모드로 끊고 다시 연결.
    if (msgType === 'force-reconnect-respawn') {
      (async () => {
        // Stop any pending reconnect timer first
        clearReconnectTimer();
        reconnectAttempts = 0;

        // v1.0.19: PORT_CONFLICT 등으로 autoConnect OFF + manualDisconnect=true 였어도
        // 강제 재연결은 명시적 사용자 의도이므로 둘 다 풀고 진행. (이전엔 ensureNativeConnected
        // 가 autoConnect off 가드에 걸려 spawn 안 되고 handshake 무한 fail 했음.)
        try {
          await setNativeAutoConnectEnabled(true);
        } catch {
          autoConnectEnabled = true;
        }
        manualDisconnect = false;

        // Explicit force: disconnect existing port (without persisting manual-disconnect flag,
        // since the user wants to reconnect immediately).
        if (nativePort) {
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }

        // v1.0.17: wait 줄임 (1500 → 200ms). 다른 브라우저 background 가 onDisconnect
        // 후 자동 reconnect 하기 전에 우리가 먼저 connectNative 호출 → 우리 process 가
        // winner. 200ms 는 bridge drain 의 setImmediate exit + OS file desc close 시간.
        await new Promise((r) => setTimeout(r, 200));

        return ensureNativeConnected('force_reconnect');
      })()
        .then((connected) => {
          sendResponse({ ok: true, connected });
        })
        .catch((e) => {
          sendResponse({ ok: false, error: String(e) });
        });
      return true;
    }

    // DISCONNECT_NATIVE: Explicit user disconnect, disables auto-connect
    if (msgType === NativeMessageType.DISCONNECT_NATIVE) {
      (async () => {
        // Explicit user disconnect: disable auto-connect and stop reconnect loop
        await setNativeAutoConnectEnabled(false);
        clearReconnectTimer();
        reconnectAttempts = 0;
        syncKeepaliveHold();

        if (nativePort) {
          // Only set manualDisconnect if we actually have a port to disconnect.
          // This prevents the flag from persisting when there's no active connection.
          manualDisconnect = true;
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }
        // auto-chrome-mcp fork: user disconnected — stop the watchdog.
        heartbeat.stop();
        await markServerStopped('manual_disconnect');
      })()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((e) => {
          sendResponse({ success: false, error: String(e) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS) {
      sendResponse({
        success: true,
        serverStatus: currentServerStatus,
        connected: nativePort !== null,
      });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS) {
      loadServerStatus()
        .then((storedStatus) => {
          currentServerStatus = storedStatus;
          sendResponse({
            success: true,
            serverStatus: currentServerStatus,
            connected: nativePort !== null,
          });
        })
        .catch((error) => {
          console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
          sendResponse({
            success: false,
            error: ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED,
            serverStatus: currentServerStatus,
            connected: nativePort !== null,
          });
        });
      return true;
    }

    // Forward file operation messages to native host
    if (message.type === 'forward_to_native' && message.message) {
      if (nativePort) {
        nativePort.postMessage(message.message);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Native host not connected' });
      }
      return true;
    }
  });
};
