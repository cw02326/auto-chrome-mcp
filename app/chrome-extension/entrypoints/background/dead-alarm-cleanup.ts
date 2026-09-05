/**
 * @fileoverview 없어진 예약 기능이 남긴 chrome.alarms 정리 (2026-09-06, 3단계 죽은 코드 삭제)
 *
 * 3단계에서 두 갈래의 예약 코드를 지웠다.
 *   - record-replay 자체 예약: `rr_schedule_<scheduleId>` 알람
 *   - record-replay-v3 트리거 엔진: `rr_v3_cron_` / `rr_v3_interval_` / `rr_v3_once_` 알람
 *
 * 코드는 사라졌지만 이미 설치된 브라우저에는 그 알람이 그대로 남아 있다. 등록된 리스너가
 * 없으니 아무 일도 일어나지 않지만, 주기 알람(`periodInMinutes`)은 계속 서비스 워커를 깨워
 * 배터리만 쓴다. 그래서 브라우저가 처음 켜질 때 한 번 훑어 지운다.
 *
 * 지우는 것은 위 네 접두로 시작하는 알람뿐이다. 살아 있는 예약 엔진의 알람
 * (`mcp-shortcut::<scheduleId>`)과 다른 기능의 알람은 이름이 겹치지 않으므로 건드리지 않는다.
 *
 * 한 번만 돌면 되므로 끝나면 `chrome.storage.local` 에 표시를 남긴다. 서비스 워커는 수시로
 * 다시 평가되는데 그때마다 `alarms.getAll()` 을 부를 이유가 없다.
 *
 * 다만 표시는 **전부 지웠을 때만** 남긴다(2026-09-06 Codex 리뷰 1항). 하나라도 지우지 못한 채
 * 완료로 표시해 버리면, 살아남은 주기 알람이 영원히 워커를 깨운다. 실패가 있으면 표시를
 * 남기지 않고 다음 기동에서 다시 시도한다. 다시 시도해 봐야 손해는 `alarms.getAll()` 한 번이다.
 */

/** 지울 알람 이름 접두. 여기 없는 이름은 절대 지우지 않는다. */
export const DEAD_ALARM_PREFIXES = [
  'rr_schedule_',
  'rr_v3_cron_',
  'rr_v3_interval_',
  'rr_v3_once_',
] as const;

/** 정리를 이미 했는지 표시하는 storage 키. */
export const CLEANUP_DONE_KEY = 'rr_dead_alarms_cleaned_2026_09_06';

/** `cleanupDeadAlarmsOnce` 가 무엇을 했는지. 테스트와 로그가 본다. */
export interface DeadAlarmCleanupResult {
  /** 이미 정리가 끝나 있어 아무것도 하지 않았는가. */
  skipped: boolean;
  /** 이번에 실제로 지운 알람 이름들. */
  cleared: string[];
  /** 지우려다 실패한 알람 이름들. 비어 있지 않으면 완료 표시를 남기지 않는다. */
  failed: string[];
  /** 완료 표시를 남겼는가. 남겼으면 다음 기동에서 다시 돌지 않는다. */
  markedDone: boolean;
}

/**
 * 남아 있는 죽은 알람을 지운다. 이미 한 번 성공적으로 돌았으면 아무것도 하지 않는다.
 *
 * 하나라도 지우지 못하면 완료 표시를 남기지 않아 다음 기동에서 다시 시도한다.
 */
export async function cleanupDeadAlarmsOnce(): Promise<DeadAlarmCleanupResult> {
  const idle: DeadAlarmCleanupResult = {
    skipped: true,
    cleared: [],
    failed: [],
    markedDone: false,
  };
  try {
    const flag = await chrome.storage.local.get([CLEANUP_DONE_KEY]);
    if (flag?.[CLEANUP_DONE_KEY]) return idle;

    const alarms = (await chrome.alarms.getAll()) ?? [];
    const dead = alarms
      .map((a) => a?.name)
      .filter((name): name is string =>
        Boolean(name && DEAD_ALARM_PREFIXES.some((p) => name.startsWith(p))),
      );

    const cleared: string[] = [];
    const failed: string[] = [];
    for (const name of dead) {
      try {
        // chrome.alarms.clear 는 "그런 알람이 없다" 를 예외가 아니라 false 로 알린다.
        // 이미 없어진 것은 실패가 아니므로 지운 것으로 친다.
        await chrome.alarms.clear(name);
        cleared.push(name);
      } catch (e) {
        // 하나가 실패해도 나머지는 계속 지운다. 대신 아래에서 완료 표시를 남기지 않는다.
        failed.push(name);
        console.warn('[dead-alarms] clear 실패:', name, e);
      }
    }

    if (failed.length) {
      console.warn(
        `[dead-alarms] ${failed.length}개를 지우지 못해 완료로 표시하지 않는다(다음 기동에서 재시도): ${failed.join(', ')}`,
      );
      return { skipped: false, cleared, failed, markedDone: false };
    }

    await chrome.storage.local.set({ [CLEANUP_DONE_KEY]: true });
    if (cleared.length) {
      console.log(`[dead-alarms] 없어진 예약 알람 ${cleared.length}개 정리: ${cleared.join(', ')}`);
    }
    return { skipped: false, cleared, failed, markedDone: true };
  } catch (e) {
    // 표시를 남기지 않으므로 다음 기동에서 다시 시도한다.
    console.warn('[dead-alarms] 정리 실패:', e);
    return { skipped: false, cleared: [], failed: [], markedDone: false };
  }
}
