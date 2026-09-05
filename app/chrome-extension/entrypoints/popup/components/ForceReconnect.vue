<script setup lang="ts">
import { ref, computed } from 'vue';
import { getMessage } from '@/utils/i18n';
import { forceReconnect, type StageResult, type StageStep } from '@/utils/force-reconnect';

const props = defineProps<{
  port: number;
  /**
   * 팝업의 "강제 재연결" 보조 버튼이 켜고 끄는 값. 진행 중일 때는 이 값과 상관없이
   * 패널을 펼쳐 둔다. 사용자가 접어 놓고 결과를 놓치는 일이 없게 하려는 것이다.
   */
  open?: boolean;
}>();

// 5단계 모두 성공하면 부모(popup) 가 connection status 를 다시 polling 하도록 알린다.
// fail 인 경우에도 상태가 바뀌었을 수 있으니 같이 emit 하고 판단은 부모가 한다.
const emit = defineEmits<{
  (e: 'reconnected', payload: { ok: boolean; finalBridgePid?: number }): void;
}>();

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

const visible = computed(() => props.open === true || inFlight.value);

const stageLabel = computed<Record<StageStep, string>>(() => ({
  process_kill: getMessage('popup_fr_stage_process_kill'),
  port_free: getMessage('popup_fr_stage_port_free'),
  spawn: getMessage('popup_fr_stage_spawn'),
  handshake: getMessage('popup_fr_stage_handshake'),
  connect: getMessage('popup_fr_stage_connect'),
  mcp_ping: getMessage('popup_fr_stage_mcp_ping'),
}));

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
  append(getMessage('popup_fr_log_start', [String(props.port)]));

  const result = await forceReconnect({
    port: props.port,
    onProgress: (s) => {
      stages.value[s.step] = s;
      const dur = s.durationMs ? ` (${s.durationMs}ms)` : '';
      append(`${stageLabel.value[s.step]}: ${s.status}${dur}${s.message ? ': ' + s.message : ''}`);
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
      getMessage('popup_fr_log_ok', [
        String(result.finalBridgePid ?? '?'),
        result.finalSessionId?.slice(0, 8) ?? '?',
      ]),
    );
  } else {
    append(getMessage('popup_fr_log_fail', [String(result.failedAt ?? '?')]));
  }
  inFlight.value = false;

  // popup 에게 알린다. 자체 connection status polling 을 다시 돌게 하려는 것이다.
  emit('reconnected', { ok: result.ok, finalBridgePid: result.finalBridgePid });
};

const summaryText = computed(() => {
  if (inFlight.value) return getMessage('popup_fr_progress');
  if (lastResult.value.ok === true) {
    return getMessage('popup_fr_ok', [String(lastResult.value.finalBridgePid ?? '?')]);
  }
  if (lastResult.value.ok === false) {
    return getMessage('popup_fr_fail', [String(lastResult.value.failedAt ?? '?')]);
  }
  return getMessage('popup_fr_idle');
});

/** 단계 하나의 상태를 색 있는 글자로 함께 보여 준다 (색만으로 구분하지 않는다). */
const stageToneClass = (s?: StageResult): string => {
  switch (s?.status) {
    case 'success':
      return 'ac-text-success';
    case 'fail':
      return 'ac-text-danger';
    case 'running':
      return 'ac-text-accent';
    default:
      return 'ac-text-tertiary';
  }
};

const stageStateText = (s?: StageResult): string => {
  switch (s?.status) {
    case 'running':
      return getMessage('popup_fr_state_running');
    case 'success':
      return getMessage('popup_fr_state_success');
    case 'fail':
      return getMessage('popup_fr_state_fail');
    case 'skipped':
      return getMessage('popup_fr_state_skipped');
    default:
      return getMessage('popup_fr_state_idle');
  }
};
</script>

<template>
  <div v-if="visible" class="fr-panel">
    <div class="fr-head">
      <p class="ac-sub fr-clip">{{ summaryText }}</p>
      <p class="ac-caption ac-num">{{ getMessage('popup_fr_port_hint', [String(props.port)]) }}</p>
    </div>

    <button
      type="button"
      class="ac-button ac-button--primary fr-run"
      :disabled="inFlight"
      @click="handleClick"
    >
      {{ inFlight ? getMessage('popup_fr_running') : getMessage('popup_fr_run') }}
    </button>

    <div class="fr-stages">
      <div v-for="(label, key) in stageLabel" :key="key" class="fr-stage">
        <span class="ac-sub fr-clip">{{ label }}</span>
        <span class="ac-caption fr-state" :class="stageToneClass(stages[key as StageStep])">{{
          stageStateText(stages[key as StageStep])
        }}</span>
        <span v-if="stages[key as StageStep]?.durationMs" class="ac-caption ac-num">
          {{ stages[key as StageStep]?.durationMs }}ms
        </span>
      </div>
    </div>

    <details v-if="logs.length > 0" class="fr-logs">
      <summary class="ac-sub fr-summary">
        {{ getMessage('popup_fr_logs', [String(logs.length)]) }}
      </summary>
      <pre class="fr-logs-pre">{{ logs.join('\n') }}</pre>
    </details>
  </div>
</template>

<style scoped>
/* 레이아웃만. 색·글꼴·버튼 모양은 ui/theme.css 의 .ac-* 가 그린다. */
.fr-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.fr-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.fr-clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.fr-run {
  width: 100%;
}

.fr-stages {
  display: flex;
  flex-direction: column;
}

.fr-stage {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}

.fr-stage + .fr-stage {
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.fr-stage .ac-sub {
  flex: 1;
}

.fr-state {
  flex-shrink: 0;
}

.fr-summary {
  cursor: pointer;
  padding: 6px 0;
}

.fr-logs-pre {
  max-height: 160px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
  color: var(--ac-text-secondary);
  font-family: var(--ac-font-mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
