/**
 * 녹화 버튼의 상태 (2026-09-05 사이드패널 1단계 A).
 *
 * 녹화 상태의 진실은 백그라운드(`recording/session-manager.ts`)다. 이 컴포저블은 그 상태를
 * 주기적으로 읽어 화면에 옮길 뿐이라, 사이드패널을 닫았다 다시 열어도 빨간 점·경과 시간·
 * 단계 수가 그대로 복원된다. 화면에 따로 상태를 쌓아 두지 않는 이유가 그것이다.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as rr from '../utils/rr-messages';

/** 녹화 중일 때의 조회 주기. 단계 수와 경과 시간이 이 주기로 갱신된다. */
const POLL_ACTIVE_MS = 1000;

/** 쉬는 중일 때의 조회 주기. 다른 창에서 녹화를 시작한 경우를 늦게라도 잡는다. */
const POLL_IDLE_MS = 5000;

export function useRecorder() {
  const status = ref<rr.RecordingSnapshot['status']>('idle');
  const stepCount = ref(0);
  const startedAtMs = ref<number | null>(null);
  const busy = ref(false);
  const now = ref(Date.now());

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const isRecording = computed(
    () => status.value === 'recording' || status.value === 'paused' || status.value === 'stopping',
  );

  const elapsedMs = computed(() => {
    if (!startedAtMs.value) return 0;
    return Math.max(0, now.value - startedAtMs.value);
  });

  async function refresh(): Promise<void> {
    try {
      const snapshot = await rr.getRecordingSnapshot();
      status.value = snapshot.status;
      stepCount.value = snapshot.stepCount;
      const parsed = snapshot.startedAt ? Date.parse(snapshot.startedAt) : NaN;
      startedAtMs.value = Number.isFinite(parsed) ? parsed : null;
    } catch {
      // 백그라운드가 아직 깨어나지 않았을 수 있다. 다음 주기에 다시 묻는다.
    }
  }

  function scheduleNextPoll(): void {
    if (disposed) return;
    const delay = isRecording.value ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    pollTimer = setTimeout(async () => {
      await refresh();
      scheduleNextPoll();
    }, delay);
  }

  /** 녹화 시작. `tabId` 를 주면 그 탭에서 녹화한다 (팝업이 넘긴 탭). */
  async function start(tabId?: number): Promise<void> {
    busy.value = true;
    try {
      await rr.startRecording(tabId);
      await refresh();
    } finally {
      busy.value = false;
    }
  }

  async function stop(): Promise<{ flowId?: string; warning?: string }> {
    busy.value = true;
    try {
      const result = await rr.stopRecording();
      await refresh();
      return result;
    } finally {
      busy.value = false;
    }
  }

  onMounted(async () => {
    await refresh();
    scheduleNextPoll();
    tickTimer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  });

  onUnmounted(() => {
    disposed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  });

  return { status, stepCount, elapsedMs, isRecording, busy, start, stop, refresh };
}

/** 경과 시간을 "3분 12초" 처럼 만든다. 화면에서 문구 키와 함께 쓴다. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
