/**
 * 매일 작업 화면 새로고침 방송 (2026-09-05 사이드패널 2단계 D).
 *
 * 예약·이력이 바뀌었다는 사실 하나만 알린다. 내용은 싣지 않는다 - 사이드패널이 어떤
 * 필터·페이지를 보고 있는지는 화면 쪽 사정이고, 방송에 목록을 실으면 열려 있지 않은
 * 패널에도 매번 큰 payload 를 보내게 된다.
 *
 * 예약 러너와 메시지 핸들러 양쪽이 부르므로 별도 모듈에 둔다. 러너가 핸들러를 import 하면
 * 도구 레지스트리의 순환 import 에 끌려들어간다.
 */

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

/** 짧은 시간에 몰린 변경을 한 번으로 묶는다 (흐름 목록 방송과 같은 값). */
const COALESCE_MS = 50;

let timer: ReturnType<typeof setTimeout> | undefined;

export function notifyDailyChanged(): void {
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    try {
      void chrome.runtime
        .sendMessage({ type: BACKGROUND_MESSAGE_TYPES.DAILY_CHANGED })
        .catch(() => {
          // 듣는 화면이 없으면 오류가 난다. 정상이다.
        });
    } catch {
      // chrome.runtime 이 없는 컨텍스트 (테스트 등)
    }
  }, COALESCE_MS);
}

/** 테스트용 - 대기 중인 방송을 취소한다. */
export function resetDailyNotify(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
