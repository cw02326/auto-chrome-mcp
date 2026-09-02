/**
 * auto-chrome-mcp fork: 새로 만든(또는 새 탭을 붙인) 창이 OS 포커스를 훔치는 것을 되돌리는
 * 공용 장치.
 *
 * `chrome.windows.create({focused:false})` 는 "포커스를 주지 말라"는 요청일 뿐이라,
 * 창 초기화 과정이나 그 창에 활성 탭을 만드는 동작이 곧바로 포커스를 잡아가는 경우가
 * 실제로 있다(2026-09-02 실측). 그래서 두 번(300ms · 1200ms) 비포커스를 다시 걸고,
 * 그래도 우리 창이 포커스를 쥐고 있으면 **사용자 창으로 포커스를 되돌린다**.
 *
 * 원래 `utils/spawned-tab-tracker.ts` 안에 있던 완화책(페이지가 연 팝업용)을 꺼내
 * 전용 작업 창 경로와 같은 코드를 쓰게 한 것이다.
 *
 * ⚠️ 복귀(focused:true)는 **사용자 창을 대상으로 할 때만** 허용된다. 이 파일 밖에서
 * MCP 작업 창에 focused:true 를 거는 코드가 생기면 무간섭 모드가 깨진다.
 *
 * 안전장치 (설계 I + 2026-09-02 독립 검토 반영):
 *
 *  1. **감시를 창 생성 *전에* 시작한다.** `beginFocusWatch()` 로 리스너를 먼저 걸고,
 *     창이 만들어진 뒤 `arm(windowId)` 로 예약한다. 창 생성과 리스너 등록 사이에 오는
 *     포커스 이벤트를 놓치면 "사용자가 이미 다른 앱으로 갔다"를 못 보고 복귀해 버린다.
 *  2. **복귀 직전에 다시 확인한다.** `cancelled` 확인 후 `windows.get()` 을 기다리는
 *     동안에도 사용자는 이동할 수 있다. await 를 건널 때마다 `cancelled` 를 다시 보고,
 *     마지막으로 `windows.getLastFocused()` 로 "지금 포커스가 우리 창에 있다"를
 *     재검증한 뒤에만 복귀한다.
 *  3. 사용자 창이 아닌 곳(다른 크롬 창, 또는 WINDOW_ID_NONE = 크롬 밖의 다른 앱)으로
 *     포커스가 한 번이라도 옮겨가면 복귀를 취소한다. 사용자가 메모장을 쓰고 있는데
 *     크롬을 앞으로 끌어내면 안 되기 때문이다.
 */

/** 창 생성 직후 비포커스를 다시 거는 시점(ms). */
export const UNFOCUS_DELAYS_MS = [300, 1200] as const;

/** 마지막 비포커스 뒤 "그래도 우리 창이 포커스를 쥐고 있는지" 확인하는 시점(ms). */
export const FOCUS_RESTORE_DELAY_MS = 1500;

/** 크롬이 포커스를 완전히 잃은 상태(다른 앱). */
export const CHROME_WINDOW_ID_NONE = -1;

export interface FocusWatch {
  /**
   * 대상 창이 확정된 뒤 호출 — 지연 이중 비포커스와 (필요 시) 사용자 창 복귀를 예약한다.
   * 감시 시작 이후 arm 까지 사이에 들어온 포커스 이벤트도 함께 판정한다.
   */
  arm(targetWindowId: number): void;
  /** 예약 없이 감시만 끝낸다(창 생성 실패 등). */
  dispose(): void;
}

/**
 * 포커스 감시를 **지금 즉시** 시작한다. 창을 만들기 전에 부르는 것이 이 함수의 존재 이유다.
 *
 * @param userWindowId 복귀 대상 사용자 창. 없으면(null) 복귀는 시도하지 않고 비포커스만 건다.
 */
export function beginFocusWatch(userWindowId?: number | null): FocusWatch {
  const restoreTarget = typeof userWindowId === 'number' ? userWindowId : null;

  let armedWindowId: number | null = null;
  let cancelled = false;
  let disposed = false;
  /** arm 전에 들어온 이벤트 — arm 시점에 대상 창 id 를 알고 나서 판정한다. */
  const pending: number[] = [];
  /** 마지막으로 관측한 포커스 창 id (복귀 직전 재검증에 쓴다). */
  let lastFocusedSeen: number | null = null;

  const judge = (focusedWindowId: number) => {
    // 우리 창이 포커스를 쥔 것은 지금 해제하려는 그 상태이므로 취소 사유가 아니다.
    if (armedWindowId !== null && focusedWindowId === armedWindowId) return;
    // 사용자가 원래 자기 창에 있다면 복귀는 어차피 no-op — 취소할 필요 없다.
    if (restoreTarget !== null && focusedWindowId === restoreTarget) return;
    // 그 밖(다른 크롬 창 / WINDOW_ID_NONE = 크롬 밖의 다른 앱)으로 옮겨갔다 → 복귀 취소.
    cancelled = true;
  };

  const onFocusChanged = (focusedWindowId: number) => {
    lastFocusedSeen = focusedWindowId;
    if (armedWindowId === null) {
      pending.push(focusedWindowId);
      return;
    }
    judge(focusedWindowId);
  };

  try {
    chrome.windows?.onFocusChanged?.addListener?.(onFocusChanged);
  } catch {
    // onFocusChanged 를 못 쓰는 컨텍스트 — 취소 감시 없이 진행한다.
  }

  const removeListener = () => {
    if (disposed) return;
    disposed = true;
    try {
      chrome.windows?.onFocusChanged?.removeListener?.(onFocusChanged);
    } catch {
      // ignore
    }
  };

  return {
    arm(targetWindowId: number) {
      armedWindowId = targetWindowId;
      // 감시 시작 ~ arm 사이에 들어온 이벤트를 이제 판정한다(TOCTOU 방어).
      for (const seen of pending.splice(0, pending.length)) judge(seen);

      for (const delay of UNFOCUS_DELAYS_MS) {
        setTimeout(() => {
          void unfocus(targetWindowId);
        }, delay);
      }

      if (restoreTarget === null || restoreTarget === targetWindowId) {
        setTimeout(removeListener, FOCUS_RESTORE_DELAY_MS);
        return;
      }

      setTimeout(() => {
        void (async () => {
          try {
            if (cancelled) return;
            const win = await chrome.windows.get(targetWindowId);
            // 우리 창이 포커스를 안 쥐고 있으면 되돌릴 것이 없다.
            if (win?.focused !== true) return;
            if (cancelled) return; // await 를 건너는 사이 사용자가 이동했을 수 있다

            // 복귀 직전 재검증 — "지금" 포커스가 우리 창에 있어야만 되돌린다.
            const last = await chrome.windows.getLastFocused({ populate: false });
            if (last?.id !== targetWindowId) return;
            if (cancelled) return;
            if (lastFocusedSeen !== null && lastFocusedSeen !== targetWindowId) return;

            await chrome.windows.update(restoreTarget, { focused: true });
          } catch {
            // 창이 이미 닫혔거나 조회 실패 — best-effort
          } finally {
            removeListener();
          }
        })();
      }, FOCUS_RESTORE_DELAY_MS);
    },
    dispose: removeListener,
  };
}

/**
 * 이미 존재하는 창을 대상으로 감시 시작과 예약을 한 번에 한다.
 * (창 생성 경로는 `beginFocusWatch()` → `arm()` 을 직접 써서 생성 전부터 감시한다.)
 */
export function scheduleDeferredUnfocus(
  targetWindowId: number,
  userWindowId?: number | null,
): void {
  const watch = beginFocusWatch(userWindowId);
  watch.arm(targetWindowId);
}

async function unfocus(windowId: number): Promise<void> {
  try {
    await chrome.windows.update(windowId, { focused: false });
  } catch {
    // 창이 이미 닫혔을 수 있다 — best-effort
  }
}
