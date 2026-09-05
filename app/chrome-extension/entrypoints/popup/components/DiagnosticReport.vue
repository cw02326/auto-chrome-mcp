<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { getMessage } from '@/utils/i18n';
import {
  BRIDGE_AUTH_MISMATCH_MESSAGE,
  getBridgeAuthHeaders,
  isBridgeAuthFailure,
} from '@/utils/bridge-auth';

const props = defineProps<{
  port: number;
  /** 팝업의 "진단 리포트" 보조 버튼이 켜고 끄는 값. */
  open?: boolean;
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
    { name: getMessage('popup_diag_test_initialize_first'), status: 'pending' },
    { name: getMessage('popup_diag_test_initialize_second'), status: 'pending' },
    { name: getMessage('popup_diag_test_health_pid'), status: 'pending' },
    { name: getMessage('popup_diag_test_pagehide'), status: 'pending' },
    { name: getMessage('popup_diag_test_env'), status: 'pending' },
  ];

  // #1
  const r1 = await initializeOnce();
  selfTestResults.value[0] = {
    name: getMessage('popup_diag_test_initialize_first'),
    status: r1.ok ? 'pass' : 'fail',
    ms: r1.ms,
    detail: r1.ok ? getMessage('popup_diag_detail_session', [r1.sid?.slice(0, 8) ?? '?']) : r1.err,
  };

  // #2 (다른 세션)
  const r2 = await initializeOnce();
  const distinct = r1.ok && r2.ok && r1.sid !== r2.sid;
  selfTestResults.value[1] = {
    name: getMessage('popup_diag_test_initialize_second'),
    status: distinct ? 'pass' : 'fail',
    ms: r2.ms,
    detail: r2.ok
      ? distinct
        ? getMessage('popup_diag_detail_session_distinct', [r2.sid?.slice(0, 8) ?? '?'])
        : getMessage('popup_diag_detail_session_same')
      : r2.err,
  };

  // #3 /health
  await probeHealth();
  selfTestResults.value[2] = {
    name: getMessage('popup_diag_test_health_pid'),
    status: health.value?.bridge?.pid ? 'pass' : 'fail',
    detail: health.value?.bridge?.pid
      ? getMessage('popup_diag_detail_pid', [String(health.value.bridge.pid)])
      : (healthError.value ?? getMessage('popup_diag_detail_no_pid')),
  };

  // #5 pagehide: 런타임으로 확인할 수 없어 코드에 박제된 사실만 표시한다.
  selfTestResults.value[3] = {
    name: getMessage('popup_diag_test_pagehide'),
    status: 'skip',
    detail: getMessage('popup_diag_detail_pagehide'),
  };

  // #8 env (정보)
  selfTestResults.value[4] = {
    name: getMessage('popup_diag_test_env'),
    status: 'skip',
    detail: getMessage('popup_diag_detail_env'),
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
    .then(() => alert(getMessage('popup_diag_copied')))
    .catch((e) => alert(getMessage('popup_diag_copy_failed', [String(e)])));
};

/** 자가 진단 한 줄의 결과를 색 있는 글자로 보여 준다 (색만으로 구분하지 않는다). */
const testToneClass = (status: string): string => {
  switch (status) {
    case 'pass':
      return 'ac-text-success';
    case 'fail':
      return 'ac-text-danger';
    case 'skip':
      return 'ac-text-tertiary';
    default:
      return 'ac-text-secondary';
  }
};

const testStateText = (status: string): string => {
  switch (status) {
    case 'pass':
      return getMessage('popup_fr_state_success');
    case 'fail':
      return getMessage('popup_fr_state_fail');
    case 'skip':
      return getMessage('popup_fr_state_skipped');
    default:
      return getMessage('popup_fr_state_idle');
  }
};

onMounted(async () => {
  detectEnv();
  await probeHealth();
});
</script>

<template>
  <div v-if="props.open" class="diag-panel">
    <div class="diag-actions">
      <button type="button" class="ac-button ac-button--ghost ac-button--sm" @click="copyAsJson">
        {{ getMessage('popup_diag_copy_json') }}
      </button>
      <button
        type="button"
        class="ac-button ac-button--primary ac-button--sm"
        :disabled="selfTestRunning"
        @click="runSelfTest"
      >
        {{ selfTestRunning ? getMessage('popup_diag_running') : getMessage('popup_diag_run') }}
      </button>
    </div>

    <section class="diag-section">
      <h3 class="diag-section-title">{{ getMessage('popup_diag_section_env') }}</h3>
      <div class="diag-rows">
        <div class="diag-row">
          <span class="ac-sub">Chrome</span>
          <span class="ac-sub ac-num diag-val">{{ env.chrome }}</span>
        </div>
        <div class="diag-row">
          <span class="ac-sub">{{ getMessage('popup_diag_key_extension') }}</span>
          <span class="ac-sub ac-num diag-val"
            >v{{ env.extensionVersion }} (MV{{ env.manifestVersion }})</span
          >
        </div>
      </div>
    </section>

    <section class="diag-section">
      <h3 class="diag-section-title">{{ getMessage('popup_diag_section_bridge') }}</h3>
      <div v-if="health" class="diag-rows">
        <div class="diag-row">
          <span class="ac-sub">Fork</span>
          <span class="ac-sub diag-val diag-clip">{{ health.fork }}@{{ health.version }}</span>
        </div>
        <div class="diag-row">
          <span class="ac-sub">PID</span>
          <span class="ac-sub ac-num diag-val">{{ health.bridge?.pid }}</span>
        </div>
        <div class="diag-row">
          <span class="ac-sub">{{ getMessage('popup_diag_key_uptime') }}</span>
          <span class="ac-sub ac-num diag-val">{{ fmtUptime(health.bridge?.uptime_ms) }}</span>
        </div>
        <div class="diag-row">
          <span class="ac-sub">{{ getMessage('popup_diag_key_memory') }}</span>
          <span class="ac-sub ac-num diag-val">{{ health.bridge?.memory_mb }} MB</span>
        </div>
        <div class="diag-row">
          <span class="ac-sub">Node</span>
          <span class="ac-sub ac-num diag-val">{{ health.bridge?.node }}</span>
        </div>
        <div class="diag-row">
          <span class="ac-sub">{{ getMessage('popup_diag_key_transports') }}</span>
          <span class="ac-sub ac-num diag-val">{{ health.transports?.active_count ?? 0 }}</span>
        </div>
      </div>
      <p v-else-if="healthError" class="ac-caption ac-text-danger">
        {{ getMessage('popup_diag_health_error', [healthError, base]) }}
      </p>
      <p v-else class="ac-caption">{{ getMessage('popup_diag_health_loading') }}</p>
    </section>

    <section v-if="selfTestResults.length > 0" class="diag-section">
      <h3 class="diag-section-title">{{ getMessage('popup_diag_section_selftest') }}</h3>
      <div class="diag-rows">
        <div v-for="(r, i) in selfTestResults" :key="i" class="diag-test">
          <div class="diag-test-head">
            <span class="ac-sub diag-clip">{{ r.name }}</span>
            <span class="ac-caption" :class="testToneClass(r.status)">{{
              testStateText(r.status)
            }}</span>
            <span v-if="r.ms" class="ac-caption ac-num">{{ r.ms }}ms</span>
          </div>
          <p v-if="r.detail" class="ac-caption diag-detail">{{ r.detail }}</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 레이아웃만. 색·글꼴·버튼 모양은 ui/theme.css 의 .ac-* 가 그린다. */
.diag-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.diag-actions {
  display: flex;
  gap: 8px;
}

.diag-actions > * {
  flex: 1;
  min-width: 0;
}

.diag-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 섹션 라벨 */
.diag-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  color: var(--ac-text-secondary);
}

.diag-rows {
  display: flex;
  flex-direction: column;
}

.diag-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
}

.diag-row + .diag-row {
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.diag-val {
  color: var(--ac-text);
  text-align: right;
}

.diag-clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.diag-test {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
}

.diag-test + .diag-test {
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.diag-test-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.diag-test-head .ac-sub {
  flex: 1;
}

.diag-detail {
  margin: 0;
  word-break: break-word;
}
</style>
