<script setup lang="ts">
import { ref, computed } from 'vue';
import { forceReconnect, type StageResult, type StageStep } from '@/utils/force-reconnect';

const props = defineProps<{
  port: number;
}>();

// 5단계 모두 성공 → 부모(popup) 가 connection status 를 다시 polling 하도록 알림.
// fail 인 경우에도 상태가 바뀌었을 수 있으니 같이 emit (parent 가 결정).
const emit = defineEmits<{
  (e: 'reconnected', payload: { ok: boolean; finalBridgePid?: number }): void;
}>();

// v1.0.13: 카드 접기/펼치기 — 기본 접힘. inFlight 중엔 강제 표시.
const expanded = ref(false);

const stages = ref<Record<StageStep, StageResult | undefined>>({
  process_kill: undefined,
  port_free: undefined,
  spawn: undefined,
  handshake: undefined,
  connect: undefined,
  mcp_ping: undefined,
});

const logs = ref<string[]>([]);
const inFlight = ref(false);
const lastResult = ref<{
  ok?: boolean;
  failedAt?: StageStep;
  finalBridgePid?: number;
  finalSessionId?: string;
}>({});

const stageLabel: Record<StageStep, string> = {
  process_kill: '① 프로세스 종료',
  port_free: '② 포트 해제 확인',
  spawn: '③ 브릿지 재시작',
  handshake: '④ 네이티브 핸드셰이크',
  connect: '⑤ 연결 (⚡ 연결 버튼 효과)',
  mcp_ping: '⑥ MCP 초기화 핑',
};

const statusIcon = (s?: StageResult): string => {
  if (!s) return '⚪';
  switch (s.status) {
    case 'running':
      return '🔄';
    case 'success':
      return '✅';
    case 'fail':
      return '❌';
    case 'skipped':
      return '⏭️';
    default:
      return '⚪';
  }
};

const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });

const append = (line: string) => {
  logs.value.push(`${ts()}  ${line}`);
  if (logs.value.length > 50) logs.value.shift();
};

const handleClick = async () => {
  if (inFlight.value) return;
  inFlight.value = true;
  lastResult.value = {};
  // Reset stages
  for (const k of Object.keys(stages.value) as StageStep[]) {
    stages.value[k] = undefined;
  }
  logs.value = [];
  append(`강제 재연결 시작 (port ${props.port})`);

  const result = await forceReconnect({
    port: props.port,
    onProgress: (s) => {
      stages.value[s.step] = s;
      const dur = s.durationMs ? ` (${s.durationMs}ms)` : '';
      append(`${stageLabel[s.step]}: ${s.status}${dur}${s.message ? ' — ' + s.message : ''}`);
    },
  });

  lastResult.value = {
    ok: result.ok,
    failedAt: result.failedAt,
    finalBridgePid: result.finalBridgePid,
    finalSessionId: result.finalSessionId,
  };

  if (result.ok) {
    append(
      `✅ 연결됨 (pid ${result.finalBridgePid ?? '?'}, 세션 ${result.finalSessionId?.slice(0, 8) ?? '?'}…)`,
    );
  } else {
    append(`❌ ${result.failedAt} 단계 실패`);
  }
  inFlight.value = false;

  // popup 에게 알림 — 자체 connection status polling 을 다시 돌게.
  emit('reconnected', { ok: result.ok, finalBridgePid: result.finalBridgePid });
};

const summaryText = computed(() => {
  if (inFlight.value) return '진행 중…';
  if (lastResult.value.ok === true) return `연결됨 (pid ${lastResult.value.finalBridgePid ?? '?'})`;
  if (lastResult.value.ok === false) return `${lastResult.value.failedAt} 단계에서 실패`;
  return '대기 중 — 클릭하면 강제 재연결';
});
</script>

<template>
  <div class="force-reconnect-card">
    <!-- v1.0.13: 헤더 클릭으로 토글. inFlight 시엔 진행 보이게 강제 expanded. -->
    <div class="fr-header fr-header--toggle" @click="expanded = !expanded">
      <h3 class="fr-title">
        <span class="fr-chevron" :class="{ 'fr-chevron--open': expanded || inFlight }">▶</span>
        ⚡ 강제 재연결
        <span class="fr-port-hint">(포트 {{ props.port }})</span>
      </h3>
      <p class="fr-summary">{{ summaryText }}</p>
    </div>

    <div v-if="expanded || inFlight">
      <button class="fr-button" :disabled="inFlight" @click.stop="handleClick">
        <span v-if="inFlight">재연결 중…</span>
        <span v-else>⚡ 강제 재연결</span>
      </button>

      <div class="fr-stages">
        <div
          v-for="(label, key) in stageLabel"
          :key="key"
          :class="['fr-stage', `fr-stage--${stages[key as StageStep]?.status ?? 'idle'}`]"
        >
          <span class="fr-stage-icon">{{ statusIcon(stages[key as StageStep]) }}</span>
          <span class="fr-stage-label">{{ label }}</span>
          <span v-if="stages[key as StageStep]?.durationMs" class="fr-stage-time">
            {{ stages[key as StageStep]?.durationMs }}ms
          </span>
        </div>
      </div>

      <details v-if="logs.length > 0" class="fr-logs">
        <summary>로그 ({{ logs.length }})</summary>
        <pre class="fr-logs-pre">{{ logs.join('\n') }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
.force-reconnect-card {
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
.fr-header--toggle {
  cursor: pointer;
  user-select: none;
}
.fr-chevron {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.15s ease;
  color: #94a3b8;
  margin-right: 4px;
}
.fr-chevron--open {
  transform: rotate(90deg);
}
.fr-port-hint {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 400;
  margin-left: 4px;
}

.fr-header {
  margin-bottom: 8px;
}

.fr-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 2px 0;
  color: #1f2937;
}

.fr-summary {
  font-size: 12px;
  color: #6b7280;
  margin: 0;
}

.fr-button {
  width: 100%;
  padding: 8px 12px;
  background: #cc785c;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: 12px;
  transition: background 0.15s;
}

.fr-button:hover:not(:disabled) {
  background: #a9583e;
}

.fr-button:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}

.fr-stages {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.fr-stage {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  background: #f9fafb;
}

.fr-stage--running {
  background: #fef3c7;
}

.fr-stage--success {
  background: #d1fae5;
  color: #065f46;
}

.fr-stage--fail {
  background: #fee2e2;
  color: #991b1b;
}

.fr-stage--skipped {
  background: #f3f4f6;
  color: #6b7280;
}

.fr-stage-icon {
  font-size: 14px;
}

.fr-stage-label {
  flex: 1;
}

.fr-stage-time {
  font-size: 10px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.fr-logs {
  margin-top: 8px;
  font-size: 11px;
  color: #4b5563;
}

.fr-logs summary {
  cursor: pointer;
  user-select: none;
  font-weight: 500;
}

.fr-logs-pre {
  background: #1f2937;
  color: #f3f4f6;
  padding: 8px;
  border-radius: 4px;
  margin-top: 4px;
  font-size: 10px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Monaco', 'Cascadia Code', monospace;
}
</style>
