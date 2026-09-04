<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import {
  BRIDGE_AUTH_MISMATCH_MESSAGE,
  getBridgeAuthHeaders,
  isBridgeAuthFailure,
} from '@/utils/bridge-auth';

const props = defineProps<{
  port: number;
}>();

interface HealthResponse {
  status?: string;
  fork?: string;
  version?: string;
  bridge?: { pid?: number; uptime_ms?: number; node?: string; memory_mb?: number };
  transports?: { active_count?: number };
}

const env = ref<{
  ua: string;
  chrome: string;
  extensionVersion: string;
  manifestVersion: number;
}>({
  ua: '',
  chrome: '',
  extensionVersion: '',
  manifestVersion: 3,
});

const health = ref<HealthResponse | null>(null);
const healthError = ref<string | null>(null);
const selfTestRunning = ref(false);

// v1.0.13: 진단 리포트 토글 — 기본 접힘. 사용자가 헤더 클릭으로 펼침.
const expanded = ref(false);
const selfTestResults = ref<
  Array<{
    name: string;
    status: 'pending' | 'pass' | 'fail' | 'skip';
    ms?: number;
    detail?: string;
  }>
>([]);

const base = computed(() => `http://127.0.0.1:${props.port}`);

const detectEnv = () => {
  const manifest = chrome.runtime.getManifest();
  env.value = {
    ua: navigator.userAgent,
    chrome: navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? 'unknown',
    extensionVersion: manifest.version ?? 'unknown',
    manifestVersion: manifest.manifest_version ?? 3,
  };
};

const probeHealth = async () => {
  healthError.value = null;
  try {
    const res = await fetch(`${base.value}/health`, {
      method: 'GET',
      headers: await getBridgeAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      // 브리지가 토큰을 요구하는데 확장이 못 보내면(또는 그 반대면) 401/403 이 온다.
      healthError.value = isBridgeAuthFailure(res.status)
        ? BRIDGE_AUTH_MISMATCH_MESSAGE
        : `HTTP ${res.status}`;
      health.value = null;
      return;
    }
    health.value = await res.json();
  } catch (e: any) {
    healthError.value = e?.message || String(e);
    health.value = null;
  }
};

const fmtUptime = (ms?: number): string => {
  if (!ms) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const initializeOnce = async (): Promise<{
  ok: boolean;
  sid?: string;
  ms: number;
  err?: string;
}> => {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base.value}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(await getBridgeAuthHeaders()),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `selftest-${t0}-${Math.random().toString(36).slice(2, 8)}`,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'auto-chrome-mcp-selftest', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const ms = Date.now() - t0;
    const sid = res.headers.get('mcp-session-id') ?? undefined;
    if (isBridgeAuthFailure(res.status)) {
      return { ok: false, ms, err: BRIDGE_AUTH_MISMATCH_MESSAGE };
    }
    return { ok: res.ok && !!sid, sid, ms };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, err: e?.message || String(e) };
  }
};

const runSelfTest = async () => {
  if (selfTestRunning.value) return;
  selfTestRunning.value = true;
  selfTestResults.value = [
    { name: '#1 initialize 첫 회', status: 'pending' },
    { name: '#2 initialize 두 번째 (다른 세션 살아있음)', status: 'pending' },
    { name: '#3 /health 가 bridge.pid 응답', status: 'pending' },
    { name: '#5 Chrome 144+ pagehide 이벤트 (정보)', status: 'pending' },
    { name: '#8 CHROME_MCP_HOST 환경변수 (정보)', status: 'pending' },
  ];

  // #1
  const r1 = await initializeOnce();
  selfTestResults.value[0] = {
    name: '#1 initialize 첫 회',
    status: r1.ok ? 'pass' : 'fail',
    ms: r1.ms,
    detail: r1.ok ? `세션 ${r1.sid?.slice(0, 8)}…` : r1.err,
  };

  // #2 (다른 세션)
  const r2 = await initializeOnce();
  const distinct = r1.ok && r2.ok && r1.sid !== r2.sid;
  selfTestResults.value[1] = {
    name: '#2 initialize 두 번째 (다른 세션 살아있음)',
    status: distinct ? 'pass' : 'fail',
    ms: r2.ms,
    detail: r2.ok
      ? distinct
        ? `세션 ${r2.sid?.slice(0, 8)}… (≠ #1)`
        : `#1 과 같은 sid — factory 패턴 미적용!`
      : r2.err,
  };

  // #3 /health
  await probeHealth();
  selfTestResults.value[2] = {
    name: '#3 /health 가 bridge.pid 응답',
    status: health.value?.bridge?.pid ? 'pass' : 'fail',
    detail: health.value?.bridge?.pid
      ? `pid ${health.value.bridge.pid}`
      : (healthError.value ?? 'pid 없음'),
  };

  // #5 pagehide (info — runtime 검증 불가, 우리 코드에 박제 확인만)
  selfTestResults.value[3] = {
    name: '#5 Chrome 144+ pagehide 이벤트 (정보)',
    status: 'skip',
    detail: 'static check: PR #329 흡수됨 (UPSTREAM_DIFF.md 참조)',
  };

  // #8 env (info)
  selfTestResults.value[4] = {
    name: '#8 CHROME_MCP_HOST 환경변수 (정보)',
    status: 'skip',
    detail: 'src/constant/index.test.ts 단위 테스트 10개 통과',
  };

  selfTestRunning.value = false;
};

const copyAsJson = () => {
  const payload = {
    fork: 'auto-chrome-mcp',
    extension_version: env.value.extensionVersion,
    env: {
      ua: env.value.ua,
      chrome: env.value.chrome,
      manifest_version: env.value.manifestVersion,
    },
    bridge: health.value?.bridge ?? null,
    bridge_error: healthError.value,
    transports: health.value?.transports ?? null,
    self_test: selfTestResults.value,
    captured_at: new Date().toISOString(),
  };
  navigator.clipboard
    .writeText(JSON.stringify(payload, null, 2))
    .then(() => alert('진단 JSON 이 클립보드에 복사되었습니다'))
    .catch((e) => alert(`복사 실패: ${e}`));
};

onMounted(async () => {
  detectEnv();
  await probeHealth();
});
</script>

<template>
  <div class="diag-card">
    <div class="diag-header diag-header--toggle" @click="expanded = !expanded">
      <h3 class="diag-title">
        <span class="diag-chevron" :class="{ 'diag-chevron--open': expanded }">▶</span>
        🔬 진단 리포트
      </h3>
      <div v-if="expanded" class="diag-actions" @click.stop>
        <button class="diag-btn diag-btn-secondary" @click="copyAsJson">JSON 복사</button>
        <button class="diag-btn" :disabled="selfTestRunning" @click="runSelfTest">
          {{ selfTestRunning ? '실행 중…' : '자가 진단 실행' }}
        </button>
      </div>
    </div>

    <div v-if="expanded">
      <!-- Environment -->
      <section class="diag-section">
        <h4 class="diag-section-title">환경</h4>
        <div class="diag-rows">
          <div class="diag-row">
            <span class="diag-key">Chrome</span><span class="diag-val">{{ env.chrome }}</span>
          </div>
          <div class="diag-row">
            <span class="diag-key">확장</span
            ><span class="diag-val">v{{ env.extensionVersion }} (MV{{ env.manifestVersion }})</span>
          </div>
        </div>
      </section>

      <!-- Bridge process -->
      <section class="diag-section">
        <h4 class="diag-section-title">브릿지 프로세스</h4>
        <div v-if="health" class="diag-rows">
          <div class="diag-row">
            <span class="diag-key">Fork</span>
            <span class="diag-val">{{ health.fork }}@{{ health.version }}</span>
          </div>
          <div class="diag-row">
            <span class="diag-key">PID</span>
            <span class="diag-val">{{ health.bridge?.pid }}</span>
          </div>
          <div class="diag-row">
            <span class="diag-key">가동 시간</span>
            <span class="diag-val">{{ fmtUptime(health.bridge?.uptime_ms) }}</span>
          </div>
          <div class="diag-row">
            <span class="diag-key">메모리</span>
            <span class="diag-val">{{ health.bridge?.memory_mb }} MB</span>
          </div>
          <div class="diag-row">
            <span class="diag-key">Node</span>
            <span class="diag-val">{{ health.bridge?.node }}</span>
          </div>
          <div class="diag-row">
            <span class="diag-key">활성 transport 수</span>
            <span class="diag-val">{{ health.transports?.active_count ?? 0 }}</span>
          </div>
        </div>
        <div v-else-if="healthError" class="diag-error">
          ❌ {{ healthError }} — {{ base }}/health 에 접근 불가
        </div>
        <div v-else class="diag-loading">⏳ /health 응답 대기 중…</div>
      </section>

      <!-- Self-Test results -->
      <section v-if="selfTestResults.length > 0" class="diag-section">
        <h4 class="diag-section-title">자가 진단 (DESIGN.md §3 회귀 케이스)</h4>
        <div class="diag-rows">
          <div
            v-for="(r, i) in selfTestResults"
            :key="i"
            :class="['diag-test-row', `diag-test-row--${r.status}`]"
          >
            <span class="diag-test-icon">
              {{
                r.status === 'pass'
                  ? '✅'
                  : r.status === 'fail'
                    ? '❌'
                    : r.status === 'skip'
                      ? '⏭️'
                      : '⏳'
              }}
            </span>
            <span class="diag-test-name">{{ r.name }}</span>
            <span v-if="r.ms" class="diag-test-ms">{{ r.ms }}ms</span>
            <div v-if="r.detail" class="diag-test-detail">{{ r.detail }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.diag-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
}

/* v1.0.13: 토글 가능 헤더 */
.diag-header--toggle {
  cursor: pointer;
  user-select: none;
}
.diag-chevron {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.15s ease;
  color: #94a3b8;
  margin-right: 4px;
}
.diag-chevron--open {
  transform: rotate(90deg);
}

.diag-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.diag-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: #1f2937;
}

.diag-actions {
  display: flex;
  gap: 6px;
}

.diag-btn {
  font-size: 11px;
  padding: 4px 10px;
  background: #cc785c;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}

.diag-btn:hover:not(:disabled) {
  background: #a9583e;
}

.diag-btn:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}

.diag-btn-secondary {
  background: #6b7280;
}

.diag-btn-secondary:hover {
  background: #4b5563;
}

.diag-section {
  margin-bottom: 12px;
}

.diag-section-title {
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 4px 0;
}

.diag-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.diag-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  padding: 2px 0;
}

.diag-key {
  color: #6b7280;
}

.diag-val {
  color: #1f2937;
  font-variant-numeric: tabular-nums;
  font-family: 'SF Mono', 'Monaco', monospace;
}

.diag-error {
  font-size: 11px;
  color: #991b1b;
  background: #fee2e2;
  padding: 6px 8px;
  border-radius: 4px;
}

.diag-loading {
  font-size: 11px;
  color: #6b7280;
  padding: 6px 8px;
}

.diag-test-row {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 4px;
  background: #f9fafb;
}

.diag-test-row--pass {
  background: #d1fae5;
  color: #065f46;
}

.diag-test-row--fail {
  background: #fee2e2;
  color: #991b1b;
}

.diag-test-row--skip {
  background: #f3f4f6;
  color: #6b7280;
}

.diag-test-icon {
  font-size: 12px;
}

.diag-test-name {
  flex: 1;
  text-align: left;
}

.diag-test-ms {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.diag-test-detail {
  grid-column: 2 / 4;
  font-size: 10px;
  color: #4b5563;
  font-family: 'SF Mono', 'Monaco', monospace;
}
</style>
