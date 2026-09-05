/**
 * 매일 작업(예약) 데이터 계층 (2026-09-05 사이드패널 2단계 E).
 *
 * 예약의 진실은 백그라운드에 있다. 화면은
 *   - 처음 한 번 읽고,
 *   - 백그라운드가 `daily_changed` 를 방송하면 다시 읽고,
 *   - 패널이 보이는 동안에만 낮은 주기로 다시 읽는다.
 * 예약은 알람으로 도는 것이라 사이드패널이 열려 있지 않을 때도 바뀐다. 그래서 방송만
 * 믿지 않고 폴링을 함께 둔다. 패널이 가려져 있으면 멈추므로 서비스 워커를 계속 깨우지 않는다.
 *
 * 백그라운드 메시지 이름과 타입은 `utils/daily-messages.ts` 한 곳에서만 온다.
 */

import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue';

import * as daily from '../utils/daily-messages';
import type { PutScheduleInput, ScheduleView } from '../utils/daily-messages';

/** 예약 목록 다시 읽기 주기. 패널이 보이는 동안에만 돈다. */
const SCHEDULES_POLL_MS = 15000;

export interface UseDailySchedulesOptions {
  /** 폴링 주기(ms). 0 이면 끈다. */
  pollMs?: number;
  /**
   * 지금 이 화면을 보고 있는가. 거짓이면 폴링을 건너뛴다(방송 구독은 그대로 둔다).
   *
   * 탭 전환이 `v-show` 라서 다른 탭을 보고 있어도 문서는 계속 visible 이다. 그 상태로
   * 15초마다 조회하면 서비스 워커를 쓸데없이 깨운다 (2026-09-05 Codex 리뷰 5항).
   */
  active?: Ref<boolean> | ComputedRef<boolean>;
}

export interface UseDailySchedulesReturn {
  schedules: Ref<ScheduleView[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /**
   * 예약·이력이 바뀔 때마다 오르는 번호. 펼쳐 둔 실행 이력이 이것을 보고 다시 읽는다
   * (방송은 목록에만 오므로 이력 컴포넌트에 전달할 손잡이가 필요하다).
   */
  changeSeq: Ref<number>;
  /** 예약이 걸린 흐름 id 집합. 카드 배지와 필터가 쓴다. */
  scheduledFlowIds: ComputedRef<Set<string>>;
  refresh: () => Promise<void>;
  scheduleForFlow: (flowId: string) => ScheduleView | undefined;
  save: (input: PutScheduleInput) => Promise<ScheduleView>;
  remove: (scheduleId: string) => Promise<void>;
  setEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
  runNow: (scheduleId: string) => Promise<RunNowResult>;
}

/** "지금 실행" 결과. `queued:false` 는 같은 예약이 이미 줄을 서 있다는 뜻이다. */
export interface RunNowResult {
  runId: string;
  queued?: boolean;
}

export function useDailySchedules(options: UseDailySchedulesOptions = {}): UseDailySchedulesReturn {
  const { pollMs = SCHEDULES_POLL_MS, active } = options;

  const schedules = ref<ScheduleView[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const changeSeq = ref(0);

  let timer: ReturnType<typeof setInterval> | null = null;
  /** 변경 방송 구독을 끊는 함수. 백그라운드 감싸개가 돌려준다. */
  let stopListening: (() => void) | null = null;

  const scheduledFlowIds = computed(() => {
    const set = new Set<string>();
    for (const s of schedules.value) {
      if (s.target?.kind === 'flow' && s.target.flowId) set.add(s.target.flowId);
    }
    return set;
  });

  function scheduleForFlow(flowId: string): ScheduleView | undefined {
    return schedules.value.find((s) => s.target?.kind === 'flow' && s.target.flowId === flowId);
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      schedules.value = await daily.listSchedules();
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function save(input: PutScheduleInput): Promise<ScheduleView> {
    const saved = await daily.putSchedule(input);
    await refresh();
    return saved;
  }

  async function remove(scheduleId: string): Promise<void> {
    await daily.removeSchedule(scheduleId);
    await refresh();
  }

  async function setEnabled(scheduleId: string, enabled: boolean): Promise<void> {
    await daily.setScheduleEnabled(scheduleId, enabled);
    await refresh();
  }

  async function runNow(scheduleId: string): Promise<RunNowResult> {
    // `queued:false` 는 같은 예약이 이미 줄을 서 있다는 뜻이다. 실패가 아니므로 그대로 전한다.
    const result = await daily.runScheduleNow(scheduleId);
    changeSeq.value += 1;
    await refresh();
    return { runId: result.runId, queued: result.queued };
  }

  function poll(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // 다른 탭을 보고 있으면 조회하지 않는다. 방송은 계속 듣는다.
    if (active && active.value === false) return;
    void refresh();
  }

  onMounted(async () => {
    await refresh();
    try {
      stopListening = daily.onDailyChanged(() => {
        // 목록만이 아니라 펼쳐 둔 이력도 다시 읽어야 한다.
        changeSeq.value += 1;
        void refresh();
      });
    } catch {
      // 방송을 못 들어도 아래 폴링과 새로 고침 버튼이 남는다.
    }
    if (pollMs > 0) timer = setInterval(poll, pollMs);
  });

  onUnmounted(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      stopListening?.();
    } catch {
      // 이미 정리됐다.
    }
    stopListening = null;
  });

  return {
    schedules,
    loading,
    error,
    changeSeq,
    scheduledFlowIds,
    refresh,
    scheduleForFlow,
    save,
    remove,
    setEnabled,
    runNow,
  };
}
