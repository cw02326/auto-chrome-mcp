/**
 * 매일 작업 문구 만들기 (2026-09-05 사이드패널 2단계 E).
 *
 * 확인하려는 것.
 *   1. 예약 요약이 표현 세 가지(매일·요일·간격)를 각각 다른 문구 키로 만든다.
 *   2. 요일은 저장 순서와 무관하게 주 순서로 정렬돼 나온다.
 *   3. 다음 실행 시각이 남은 시간에 따라 다른 말이 된다(분 → 오늘 → 내일 → 날짜).
 *   4. 상태 9종이 모두 문구 키를 가진다.
 */

import { describe, expect, it } from 'vitest';
import {
  RUN_STATUS_MESSAGE_KEYS,
  formatCardLastRunLine,
  formatCardRunClock,
  formatDays,
  formatNextRun,
  formatRunStatus,
  formatScheduleEnabledLine,
  formatTimes,
  runStatusColor,
  summarizeSchedule,
} from '@/entrypoints/sidepanel/utils/daily-format';

/** 테스트용 번역기. 키와 인자를 그대로 드러내 무엇을 넘겼는지 확인한다. */
function t(key: string, subs?: string[]): string {
  return subs && subs.length > 0 ? `${key}(${subs.join('|')})` : key;
}

describe('daily-format', () => {
  it('매일 예약은 시각 목록을 오름차순으로 붙인다', () => {
    const text = summarizeSchedule({ daily: ['12:30', '08:00'] }, t);
    expect(text).toBe('sidepanel_daily_summary_daily(08:00, 12:30)');
  });

  it('요일 예약은 요일과 시각을 함께 넘긴다', () => {
    const text = summarizeSchedule({ daily: ['09:30'], days: ['fri', 'mon', 'wed'] }, t);
    expect(text).toBe(
      'sidepanel_daily_summary_days(sidepanel_daily_day_mon sidepanel_daily_day_wed sidepanel_daily_day_fri|09:30)',
    );
  });

  it('요일 7개를 모두 고르면 매일과 같은 문구가 된다', () => {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    expect(summarizeSchedule({ daily: ['07:00'], days }, t)).toBe(
      'sidepanel_daily_summary_daily(07:00)',
    );
  });

  it('간격 예약은 간격별 문구 키를 쓴다', () => {
    expect(summarizeSchedule({ every: '6h' }, t)).toBe('sidepanel_daily_every_6h');
    expect(summarizeSchedule({ every: '15m' }, t)).toBe('sidepanel_daily_every_15m');
  });

  it('모르는 표현은 안내 문구로 떨어진다', () => {
    expect(summarizeSchedule({ every: '3m' }, t)).toBe('sidepanel_daily_summary_unknown');
    expect(summarizeSchedule({}, t)).toBe('sidepanel_daily_summary_unknown');
    expect(summarizeSchedule(null, t)).toBe('sidepanel_daily_summary_unknown');
  });

  it('요일 표기는 저장 순서와 무관하게 월요일부터 늘어놓는다', () => {
    expect(formatDays(['sun', 'tue'], t)).toBe('sidepanel_daily_day_tue sidepanel_daily_day_sun');
  });

  it('시각 목록은 정렬해 붙인다', () => {
    expect(formatTimes(['22:00', '09:05'])).toBe('09:05, 22:00');
  });

  describe('다음 실행 시각', () => {
    // 2026년 9월 5일 토요일 10:00 (로컬 시간)
    const now = new Date(2026, 8, 5, 10, 0, 0).getTime();

    it('예정이 없으면 없다고 말한다', () => {
      expect(formatNextRun(undefined, now, t)).toBe('sidepanel_daily_next_none');
      expect(formatNextRun(0, now, t)).toBe('sidepanel_daily_next_none');
    });

    it('이미 지난 시각은 곧이다', () => {
      expect(formatNextRun(now - 60_000, now, t)).toBe('sidepanel_daily_next_soon');
    });

    it('한 시간 안이면 남은 분을 말한다', () => {
      expect(formatNextRun(now + 12 * 60_000, now, t)).toBe('sidepanel_daily_next_in_minutes(12)');
    });

    it('오늘 남은 시각은 오늘로 말한다', () => {
      const at = new Date(2026, 8, 5, 18, 30, 0).getTime();
      expect(formatNextRun(at, now, t)).toBe('sidepanel_daily_next_today(18:30)');
    });

    it('내일이면 내일로 말한다', () => {
      const at = new Date(2026, 8, 6, 7, 5, 0).getTime();
      expect(formatNextRun(at, now, t)).toBe('sidepanel_daily_next_tomorrow(07:05)');
    });

    it('그보다 멀면 날짜와 시각을 보여 준다 (구분은 점)', () => {
      const at = new Date(2026, 8, 9, 7, 5, 0).getTime();
      expect(formatNextRun(at, now, t)).toBe('09.09 07:05');
    });
  });

  it('상태 9종이 모두 문구 키를 가진다', () => {
    const statuses = [
      'running',
      'success',
      'failed',
      'stopped',
      'timeout',
      'interrupted',
      'skipped_queue',
      'login_required',
      'user_took_over_tab',
    ];
    expect(Object.keys(RUN_STATUS_MESSAGE_KEYS).sort()).toEqual(statuses.slice().sort());
    for (const status of statuses) {
      expect(formatRunStatus(status, t)).toBe(`sidepanel_daily_status_${status}`);
    }
  });

  it('모르는 상태는 감추지 않고 그대로 보여 준다', () => {
    expect(formatRunStatus('weird_state', t)).toBe('weird_state');
  });

  describe('예약 줄의 켜짐 상태 문구 (2026-09-06 실기기 확인: 펼친 줄에서 이 분기가 뒤집힌 적이 있었다)', () => {
    // 2026년 9월 5일 토요일 10:00 (로컬 시간)
    const now = new Date(2026, 8, 5, 10, 0, 0).getTime();

    it('켜져 있고 다음 실행이 미래면 다음 실행 문구다', () => {
      const at = new Date(2026, 8, 6, 9, 0, 0).getTime();
      expect(formatScheduleEnabledLine(true, at, now, t)).toBe(
        'sidepanel_daily_next_run(sidepanel_daily_next_tomorrow(09:00))',
      );
    });

    it('꺼져 있으면 다음 실행이 미래라도 꺼짐이다', () => {
      const at = new Date(2026, 8, 6, 9, 0, 0).getTime();
      expect(formatScheduleEnabledLine(false, at, now, t)).toBe('sidepanel_daily_paused');
    });

    it('꺼져 있으면 다음 실행이 없어도 꺼짐이다', () => {
      expect(formatScheduleEnabledLine(false, null, now, t)).toBe('sidepanel_daily_paused');
    });
  });

  describe('상태별 색은 토큰 이름만 돌려준다 (하드코드 폴백 금지)', () => {
    it('색 문자열에 폴백(쉼표·# 값)이 없다', () => {
      const statuses = [
        'success',
        'running',
        'failed',
        'stopped',
        'timeout',
        'interrupted',
        'skipped_queue',
        'login_required',
        'user_took_over_tab',
        undefined,
      ];
      for (const status of statuses) {
        const color = runStatusColor(status);
        expect(color).toMatch(/^var\(--ac-[a-z-]+\)$/);
        expect(color).not.toContain(',');
        expect(color).not.toContain('#');
      }
    });

    it('성공은 success, 진행 중은 accent, 로그인 필요 등은 warning, 나머지는 danger 토큰이다', () => {
      expect(runStatusColor('success')).toBe('var(--ac-success)');
      expect(runStatusColor('running')).toBe('var(--ac-accent)');
      expect(runStatusColor('login_required')).toBe('var(--ac-warning)');
      expect(runStatusColor('skipped_queue')).toBe('var(--ac-warning)');
      expect(runStatusColor('user_took_over_tab')).toBe('var(--ac-warning)');
      expect(runStatusColor('stopped')).toBe('var(--ac-warning)');
      expect(runStatusColor('failed')).toBe('var(--ac-danger)');
      expect(runStatusColor(undefined)).toBe('var(--ac-danger)');
    });
  });

  describe('흐름 카드의 "마지막 실행" 문구 (2026-09-06 초보자 가독성 개편)', () => {
    // 2026년 9월 6일 일요일 10:00 (로컬 시간)
    const now = new Date(2026, 8, 6, 10, 0, 0).getTime();

    it('오늘이면 "오늘 시각"이다', () => {
      const at = new Date(2026, 8, 6, 0, 12, 0).getTime();
      expect(formatCardRunClock(at, now, t)).toBe('sidepanel_card_day_today(00:12)');
    });

    it('어제면 "어제 시각"이다', () => {
      const at = new Date(2026, 8, 5, 21, 10, 0).getTime();
      expect(formatCardRunClock(at, now, t)).toBe('sidepanel_card_day_yesterday(21:10)');
    });

    it('그제 이전이면 날짜와 시각이다 (구분은 점)', () => {
      const at = new Date(2026, 8, 3, 21, 10, 0).getTime();
      expect(formatCardRunClock(at, now, t)).toBe('09.03 21:10');
    });

    it('시각이 없으면 빈 문자열이다', () => {
      expect(formatCardRunClock(null, now, t)).toBe('');
      expect(formatCardRunClock(undefined, now, t)).toBe('');
    });

    it('성공이면 "성공 · 시각" 문구다', () => {
      const at = new Date(2026, 8, 6, 0, 12, 0).getTime();
      expect(formatCardLastRunLine('success', at, now, t)).toBe(
        'sidepanel_card_last_run_success(sidepanel_card_day_today(00:12))',
      );
    });

    it('실패면 "실패 · 시각" 문구다', () => {
      const at = new Date(2026, 8, 5, 21, 10, 0).getTime();
      expect(formatCardLastRunLine('failure', at, now, t)).toBe(
        'sidepanel_card_last_run_failed(sidepanel_card_day_yesterday(21:10))',
      );
    });

    it('실행 기록이 없으면 안내 문구다', () => {
      expect(formatCardLastRunLine(null, null, now, t)).toBe('sidepanel_card_last_run_none');
      expect(formatCardLastRunLine('success', null, now, t)).toBe('sidepanel_card_last_run_none');
      expect(formatCardLastRunLine(undefined, undefined, now, t)).toBe(
        'sidepanel_card_last_run_none',
      );
    });
  });
});
