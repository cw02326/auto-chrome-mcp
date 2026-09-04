/**
 * auto-chrome-mcp fork — 고정 대기를 조건 대기로 바꾼 공용 유틸 테스트.
 *
 * 계약: 조건이 충족되면 **상한보다 빨리** 돌아오고, 조건을 관측할 수 없으면 예전 고정 대기와
 * 똑같이 상한까지 기다린다(결과 품질을 지키기 위한 폴백).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FRAME_PAINT_MAX_WAIT_MS,
  FRAME_PAINT_MIN_WAIT_MS,
  HELPER_READY_MAX_WAIT_MS,
  waitForContentSettle,
  waitForFramePaint,
  waitForHelperReady,
  waitUntil,
} from '@/utils/adaptive-wait';

describe('adaptive-wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('waitUntil', () => {
    it('조건이 충족되면 상한을 채우지 않고 즉시 반환한다', async () => {
      let value = 0;
      const pending = waitUntil<number>({
        probe: () => value,
        done: (v) => v >= 2,
        timeoutMs: 5_000,
        pollMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      value = 1;
      await vi.advanceTimersByTimeAsync(50);
      value = 2;
      await vi.advanceTimersByTimeAsync(50);

      const result = await pending;
      expect(result.satisfied).toBe(true);
      expect(result.waitedMs).toBeLessThan(5_000);
    });

    it('조건이 끝내 안 되면 상한까지 기다린다', async () => {
      const pending = waitUntil<number>({
        probe: () => 0,
        done: () => false,
        timeoutMs: 400,
        pollMs: 100,
      });
      await vi.advanceTimersByTimeAsync(400);
      const result = await pending;
      expect(result.satisfied).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(400);
    });

    it('probe 가 던지면 실패가 아니라 "아직 아님"으로 보고 계속 폴링한다', async () => {
      let calls = 0;
      const pending = waitUntil<boolean>({
        probe: () => {
          calls++;
          if (calls < 3) throw new Error('cannot access contents');
          return true;
        },
        done: (v) => v,
        timeoutMs: 1_000,
        pollMs: 100,
      });
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;
      expect(result.satisfied).toBe(true);
      expect(result.waitedMs).toBeLessThan(1_000);
    });
  });

  describe('waitForHelperReady', () => {
    it('pong 이 오면 상한(100ms)을 기다리지 않는다', async () => {
      const ping = vi.fn(async () => ({ status: 'pong' }));
      const pending = waitForHelperReady({ ping });
      await vi.advanceTimersByTimeAsync(0);
      const result = await pending;

      expect(result.ready).toBe(true);
      expect(result.waitedMs).toBeLessThan(HELPER_READY_MAX_WAIT_MS);
      expect(ping).toHaveBeenCalledTimes(1);
    });

    it('응답이 없으면 예전처럼 상한까지 기다린다', async () => {
      const ping = vi.fn(async () => {
        throw new Error('Receiving end does not exist');
      });
      const pending = waitForHelperReady({ ping });
      await vi.advanceTimersByTimeAsync(HELPER_READY_MAX_WAIT_MS + 10);
      const result = await pending;

      expect(result.ready).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(HELPER_READY_MAX_WAIT_MS);
    });
  });

  describe('waitForFramePaint', () => {
    it('rAF 두 번이 끝나도 최소 대기(150ms)는 채운다 (항목 6)', async () => {
      const executeScript = vi.fn(async () => [{ result: true }]);
      let settled = false;
      const pending = waitForFramePaint(7, { executeScript }).then((r) => {
        settled = true;
        return r;
      });

      // rAF 두 번은 "그렸다"는 신호일 뿐 합성이 끝났다는 뜻은 아니다 — 하한을 채워야 한다.
      await vi.advanceTimersByTimeAsync(FRAME_PAINT_MIN_WAIT_MS - 10);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;

      expect(result.painted).toBe(true);
      expect(result.waitedMs).toBeGreaterThanOrEqual(FRAME_PAINT_MIN_WAIT_MS);
      expect(result.waitedMs).toBeLessThan(FRAME_PAINT_MAX_WAIT_MS);
    });

    it('rAF 가 돌지 않는 탭에서는 상한(300ms)까지만 기다린다', async () => {
      const executeScript = vi.fn(() => new Promise<never>(() => {}));
      const pending = waitForFramePaint(7, { executeScript });
      await vi.advanceTimersByTimeAsync(FRAME_PAINT_MAX_WAIT_MS + 1);
      const result = await pending;

      expect(result.painted).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(FRAME_PAINT_MAX_WAIT_MS);
    });

    it('스크립트를 주입할 수 없는 문서에서도 상한까지 기다린다', async () => {
      const executeScript = vi.fn(async () => {
        throw new Error('Cannot access contents of the page');
      });
      const pending = waitForFramePaint(7, { executeScript });
      await vi.advanceTimersByTimeAsync(FRAME_PAINT_MAX_WAIT_MS + 1);
      const result = await pending;

      expect(result.painted).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(FRAME_PAINT_MAX_WAIT_MS);
    });
  });

  describe('waitForContentSettle', () => {
    it('연속 2회 같다고 끝내지 않는다 — 3회 연속 + 네트워크 조용이 필요하다 (항목 4)', async () => {
      const probe = vi.fn(async () => ({ height: 2000, nodes: 400, networkQuiet: true }));
      let settled = false;
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 1_000,
      }).then((r) => {
        settled = true;
        return r;
      });

      // 150ms 두 번(=예전 판정 시점)에는 아직 끝나면 안 된다.
      await vi.advanceTimersByTimeAsync(310);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      const result = await pending;

      expect(result.reason).toBe('settled');
      expect(result.grew).toBe(true);
      expect(result.waitedMs).toBeLessThan(1_000);
    });

    it('네트워크 요청이 진행 중이면 안정으로 보지 않는다 (항목 4)', async () => {
      const probe = vi.fn(async () => ({ height: 2000, nodes: 400, networkQuiet: false }));
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 700,
      });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;

      expect(result.reason).toBe('cap');
      expect(result.grew).toBe(true);
    });

    it('네트워크 신호를 못 얻으면 상한까지 기다린다 (항목 4)', async () => {
      const probe = vi.fn(async () => ({ height: 2000, nodes: 400 }));
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 700,
      });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;

      expect(result.reason).toBe('cap');
    });

    it('자라지 않으면 예전과 똑같이 상한까지 기다린다(지연 로딩 유실 방지)', async () => {
      const probe = vi.fn(async () => ({ height: 1000, nodes: 300, networkQuiet: true }));
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 700,
      });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;

      expect(result.reason).toBe('cap');
      expect(result.grew).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(700);
    });

    it('아직 자라는 중이면 안정될 때까지 기다린다', async () => {
      let height = 1000;
      const probe = vi.fn(async () => {
        height += 200;
        return { height, nodes: 300, networkQuiet: true };
      });
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 700,
      });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;

      expect(result.reason).toBe('cap');
      expect(result.grew).toBe(true);
    });

    it('스피너가 붙었다 사라져 원래 크기로 돌아오면 조기 종료하지 않는다 (항목 4)', async () => {
      // 스크롤 직후 스피너가 붙어 한 번 자랐다가(=1100) 응답 전에 제거돼 baseline(1000)으로
      // 되돌아온 상황. "한 번 자랐다"를 기억해 두고 쓰면 이후 같은 값 3연속 + 네트워크 조용에
      // 걸려 새 콘텐츠가 한 줄도 안 붙었는데 settled 로 끝난다.
      const heights = [1100, 1000, 1000, 1000, 1000, 1000];
      let index = 0;
      const probe = vi.fn(async () => ({
        height: heights[Math.min(index++, heights.length - 1)],
        nodes: 300,
        networkQuiet: true,
      }));
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_050);
      const result = await pending;

      expect(result.reason).toBe('cap');
      expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);
    });

    it('관측이 실패하면(주입 불가) 상한까지 기다린다', async () => {
      const probe = vi.fn(async () => null);
      const pending = waitForContentSettle({
        probe,
        baseline: { height: 1000, nodes: 300 },
        maxWaitMs: 700,
      });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;

      expect(result.reason).toBe('cap');
    });
  });
});
