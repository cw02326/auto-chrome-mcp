/**
 * Force Reconnect Supervisor — Stage A (popup-side, HTTP-only).
 *
 * v1.0.19: 6단계로 확장. handshake 다음에 connect 단계 추가 — popup 의 ⚡ 연결 버튼
 * 클릭과 동일 효과 (CONNECT_NATIVE 메시지). PORT_CONFLICT 등으로 background 의
 * autoConnect 가 OFF 된 상태에서도 명시적 connect 로 회복.
 *
 *   ① process_kill    POST /admin/drain
 *   ② port_free       /health probe 가 timeout/refused 까지 backoff (= bridge 죽음 확인)
 *   ③ spawn           background 에 'force-reconnect-respawn' message → chrome.runtime.connectNative
 *   ④ handshake       /health probe 가 200 응답 + bridge.pid 새 값 확인 (실패해도 fallthrough)
 *   ⑤ connect         background 'connectNative' 메시지 — ⚡ 연결 버튼과 동일. autoConnect 다시 ON.
 *   ⑥ mcp_ping        POST /mcp { jsonrpc: 'initialize' } → 200 + sessionId
 *
 * Stage A 가 실패하면 호출자 (Vue component) 가 Stage B (manifest re-register) /
 * Stage C (Chrome restart) 다이얼로그 후속.
 */

export type StageStep =
  | 'process_kill'
  | 'port_free'
  | 'spawn'
  | 'handshake'
  | 'connect'
  | 'mcp_ping';

export type StageStatus = 'pending' | 'running' | 'success' | 'fail' | 'skipped';

export interface StageResult {
  step: StageStep;
  status: StageStatus;
  message?: string;
  durationMs?: number;
}

export interface ForceReconnectOptions {
  /** Bridge HTTP port (default 12320 — v1.0.2 부터 fork 전용). */
  port?: number;
  /** Bridge host (default 127.0.0.1). */
  host?: string;
  /** Progress callback — UI 갱신용. */
  onProgress?: (step: StageResult) => void;
  /** Stage 별 timeout (ms). */
  timeouts?: Partial<Record<StageStep, number>>;
}

export interface ForceReconnectResult {
  ok: boolean;
  stages: StageResult[];
  /** 실패 시 마지막 실패 step. */
  failedAt?: StageStep;
  /** 최종 bridge pid (handshake step 에서 받은 값) — 새 process 확인용. */
  finalBridgePid?: number;
  /** 최종 mcp session id (mcp_ping 통과 시). */
  finalSessionId?: string;
}

const DEFAULT_TIMEOUTS: Record<StageStep, number> = {
  process_kill: 5000,
  port_free: 5000,
  spawn: 30000,
  // v1.0.19: handshake 30s → 10s. connect 단계가 회복 책임지므로 짧게.
  handshake: 10000,
  // v1.0.19: connect — background CONNECT_NATIVE 메시지 ack + 짧은 /health 재검증
  connect: 8000,
  mcp_ping: 5000,
};

/**
 * Sleep helper.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * fetch 가 throw 하면 false (서버 죽음), 200 이면 true.
 */
const probeHealth = async (
  url: string,
  controllerTimeoutMs = 1500,
): Promise<{ alive: boolean; pid?: number; payload?: any }> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), controllerTimeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return { alive: false };
    const payload = await res.json().catch(() => undefined);
    return { alive: true, pid: payload?.bridge?.pid, payload };
  } catch {
    return { alive: false };
  } finally {
    clearTimeout(timeoutId);
  }
};

const now = () => Date.now();

const emit = (
  cb: ForceReconnectOptions['onProgress'],
  step: StageStep,
  patch: Partial<StageResult> & { status: StageStatus },
): StageResult => {
  const result: StageResult = { step, ...patch };
  cb?.(result);
  return result;
};

/**
 * Main entrypoint.
 */
export async function forceReconnect(
  opts: ForceReconnectOptions = {},
): Promise<ForceReconnectResult> {
  const port = opts.port ?? 12320;
  const host = opts.host ?? '127.0.0.1';
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const base = `http://${host}:${port}`;
  const stages: StageResult[] = [];
  const cb = opts.onProgress;

  // ---------- ① process_kill ----------
  // v1.0.6: drain + kill-self 둘 다 fire-and-forget. drain 이 응답 안 해도 kill-self 가
  // immediate process.exit. 좀비 bridge (HTTP server 만 hang) 강제 청산.
  {
    const step: StageStep = 'process_kill';
    const t0 = now();
    emit(cb, step, { status: 'running', message: 'POST /admin/drain + /admin/kill-self' });

    const tryEndpoint = async (path: string): Promise<{ ok: boolean; note: string }> => {
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        });
        return { ok: res.ok, note: `${path}=${res.status}` };
      } catch (e: any) {
        return { ok: false, note: `${path}=err:${e?.name || 'unknown'}` };
      }
    };

    // 병렬로 둘 다 시도. 한 endpoint 만 응답해도 process 죽음.
    const [drainRes, killRes] = await Promise.all([
      tryEndpoint('/admin/drain'),
      tryEndpoint('/admin/kill-self'),
    ]);
    const duration = now() - t0;
    const anyOk = drainRes.ok || killRes.ok;
    const allFailed = !drainRes.ok && !killRes.ok;

    if (anyOk) {
      const r = emit(cb, step, {
        status: 'success',
        message: `kill request accepted (${drainRes.note}, ${killRes.note})`,
        durationMs: duration,
      });
      stages.push(r);
    } else if (allFailed) {
      // 이미 죽어있거나 unreachable — 다음 step 에서 /health probe 로 확인
      const r = emit(cb, step, {
        status: 'skipped',
        message: `bridge unreachable (${drainRes.note}, ${killRes.note}) — verifying via /health`,
        durationMs: duration,
      });
      stages.push(r);
    }
  }

  // ---------- ② port_free ----------
  {
    const step: StageStep = 'port_free';
    const t0 = now();
    emit(cb, step, { status: 'running', message: 'waiting for /health to fail' });
    const deadline = t0 + timeouts[step];
    let confirmedDead = false;
    while (now() < deadline) {
      const probe = await probeHealth(`${base}/health`, 800);
      if (!probe.alive) {
        confirmedDead = true;
        break;
      }
      await sleep(300);
    }
    const duration = now() - t0;
    if (confirmedDead) {
      const r = emit(cb, step, {
        status: 'success',
        message: 'bridge process down (port freed)',
        durationMs: duration,
      });
      stages.push(r);
    } else {
      const r = emit(cb, step, {
        status: 'fail',
        message: `bridge still answering /health after ${timeouts[step]}ms`,
        durationMs: duration,
      });
      stages.push(r);
      return { ok: false, stages, failedAt: step };
    }
  }

  // ---------- ③ spawn ----------
  // background 에 chrome.runtime.connectNative 트리거 요청. background 가 응답하면
  // Chrome 이 native messaging host manifest 보고 bridge process 자동 spawn.
  {
    const step: StageStep = 'spawn';
    const t0 = now();
    emit(cb, step, { status: 'running', message: 'asking background to reconnect native' });
    try {
      const respawnOk = await chrome.runtime.sendMessage({
        type: 'force-reconnect-respawn',
      });
      const duration = now() - t0;
      if (respawnOk && (respawnOk as any).ok) {
        const r = emit(cb, step, {
          status: 'success',
          message: 'background respawn message acknowledged',
          durationMs: duration,
        });
        stages.push(r);
      } else {
        const r = emit(cb, step, {
          status: 'fail',
          message: `background respawn declined: ${JSON.stringify(respawnOk)}`,
          durationMs: duration,
        });
        stages.push(r);
        return { ok: false, stages, failedAt: step };
      }
    } catch (e: any) {
      // sendMessage 실패해도 (no listener) bridge 의 자동 respawn 시도는 다음 polling 으로 확인 가능.
      // → fail 로 표시하지 말고 fallthrough.
      const duration = now() - t0;
      const r = emit(cb, step, {
        status: 'skipped',
        message: `background sendMessage failed: ${e?.message || e} (will probe directly)`,
        durationMs: duration,
      });
      stages.push(r);
    }
  }

  // ---------- ④ handshake ----------
  let finalBridgePid: number | undefined;
  {
    const step: StageStep = 'handshake';
    const t0 = now();
    emit(cb, step, { status: 'running', message: 'waiting for /health to return 200' });
    const deadline = t0 + timeouts[step];
    let alive = false;
    while (now() < deadline) {
      const probe = await probeHealth(`${base}/health`, 1500);
      if (probe.alive) {
        alive = true;
        finalBridgePid = probe.pid;
        break;
      }
      await sleep(500);
    }
    const duration = now() - t0;
    if (alive) {
      const r = emit(cb, step, {
        status: 'success',
        message: `new bridge alive${finalBridgePid ? ` (pid ${finalBridgePid})` : ''}`,
        durationMs: duration,
      });
      stages.push(r);
    } else {
      // v1.0.19: handshake fail 이어도 즉시 return 안 함. 다음 ⑤ connect 단계가
      // ⚡ 연결 버튼과 동일한 효과로 회복 시도. background 의 autoConnect 가 OFF
      // (PORT_CONFLICT 후) 였으면 그것도 함께 풀림.
      const r = emit(cb, step, {
        status: 'fail',
        message: `bridge did not respond within ${timeouts[step]}ms — try connect step`,
        durationMs: duration,
      });
      stages.push(r);
    }
  }

  // ---------- ⑤ connect ----------
  // ⚡ 연결 버튼과 동일 효과 — background CONNECT_NATIVE 메시지. PORT_CONFLICT 등으로
  // autoConnect OFF + manualDisconnect=true 상태도 함께 풀고 새 bridge spawn 트리거.
  {
    const step: StageStep = 'connect';
    const t0 = now();
    emit(cb, step, { status: 'running', message: 'sending connectNative (= ⚡ 연결 버튼 효과)' });
    try {
      const res: any = await chrome.runtime.sendMessage({
        type: 'connectNative',
        port,
      });
      const ackOk = !!(res && res.success);
      const connectedFlag = !!(res && (res.connected === true || res.connected === undefined));

      if (!ackOk) {
        const r = emit(cb, step, {
          status: 'fail',
          message: `connectNative declined: ${JSON.stringify(res)}`,
          durationMs: now() - t0,
        });
        stages.push(r);
        return { ok: false, stages, failedAt: step, finalBridgePid };
      }

      // ack 받았으니 짧게 /health 재검증 — spawn + listen 까지 시간 확보
      const probeDeadline = t0 + timeouts[step];
      let healthOk = false;
      while (now() < probeDeadline) {
        const probe = await probeHealth(`${base}/health`, 1000);
        if (probe.alive) {
          healthOk = true;
          finalBridgePid = probe.pid ?? finalBridgePid;
          break;
        }
        await sleep(400);
      }

      const duration = now() - t0;
      if (healthOk) {
        const r = emit(cb, step, {
          status: 'success',
          message: `connectNative ack + /health 200${finalBridgePid ? ` (pid ${finalBridgePid})` : ''}`,
          durationMs: duration,
        });
        stages.push(r);
      } else {
        const r = emit(cb, step, {
          status: 'fail',
          message: `connectNative ack 했지만 /health 응답 없음 (connected=${connectedFlag})`,
          durationMs: duration,
        });
        stages.push(r);
        return { ok: false, stages, failedAt: step, finalBridgePid };
      }
    } catch (e: any) {
      const r = emit(cb, step, {
        status: 'fail',
        message: `connectNative threw: ${e?.message || e}`,
        durationMs: now() - t0,
      });
      stages.push(r);
      return { ok: false, stages, failedAt: step, finalBridgePid };
    }
  }

  // ---------- ⑥ mcp_ping ----------
  let finalSessionId: string | undefined;
  {
    const step: StageStep = 'mcp_ping';
    const t0 = now();
    emit(cb, step, { status: 'running', message: 'POST /mcp initialize' });
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `force-reconnect-${Date.now()}`,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-chrome-scalemaker-supervisor', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(timeouts[step]),
      });
      const duration = now() - t0;
      finalSessionId = res.headers.get('mcp-session-id') ?? undefined;
      if (res.ok && finalSessionId) {
        const r = emit(cb, step, {
          status: 'success',
          message: `MCP initialize ok (session ${finalSessionId.slice(0, 8)}…)`,
          durationMs: duration,
        });
        stages.push(r);
      } else {
        const r = emit(cb, step, {
          status: 'fail',
          message: `MCP initialize failed (HTTP ${res.status}, sid=${finalSessionId})`,
          durationMs: duration,
        });
        stages.push(r);
        return { ok: false, stages, failedAt: step, finalBridgePid, finalSessionId };
      }
    } catch (e: any) {
      const duration = now() - t0;
      const r = emit(cb, step, {
        status: 'fail',
        message: `MCP initialize threw: ${e?.message || e}`,
        durationMs: duration,
      });
      stages.push(r);
      return { ok: false, stages, failedAt: step, finalBridgePid };
    }
  }

  return { ok: true, stages, finalBridgePid, finalSessionId };
}

/**
 * Test helper — Stage A 의 final pid 가 이전 pid 와 다른지 검증.
 */
export const verifyNewProcessSpawned = (
  resultBefore: { pid?: number },
  resultAfter: ForceReconnectResult,
): boolean => {
  if (!resultAfter.finalBridgePid) return false;
  if (!resultBefore.pid) return true; // 이전 pid 없으면 새 spawn 으로 간주
  return resultBefore.pid !== resultAfter.finalBridgePid;
};
