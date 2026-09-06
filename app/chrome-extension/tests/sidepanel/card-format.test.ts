/**
 * 흐름 카드 정보 목록 문구 (2026-09-06 초보자 가독성 개편).
 *
 * 확인하려는 것.
 *   1. 발행 상태 3종(발행됨/재발행 필요/저장만 됨)이 올바른 문구 키를 고른다.
 *   2. 재발행 필요가 발행됨보다 먼저 본다(둘 다 참이면 재발행 필요가 이긴다).
 *   3. "다음 예약" 줄은 예약이 있을 때만 보인다.
 *   4. "설명" 줄은 설명이 있을 때만 보인다(빈 문자열·공백은 없는 것으로 친다).
 */

import { describe, expect, it } from 'vitest';
import {
  cardStatusKind,
  formatCardStatusText,
  shouldShowDescription,
  shouldShowNextSchedule,
  shouldShowSite,
} from '@/entrypoints/sidepanel/utils/card-format';

function t(key: string): string {
  return key;
}

describe('card-format', () => {
  describe('상태 문구 선택', () => {
    it('발행됨만 참이면 발행됨 키를 고른다', () => {
      expect(cardStatusKind(true, false)).toBe('published');
      expect(formatCardStatusText(true, false, t)).toBe('sidepanel_card_status_published');
    });

    it('아무것도 아니면 초안(저장만 됨) 키를 고른다', () => {
      expect(cardStatusKind(false, false)).toBe('draft');
      expect(formatCardStatusText(false, false, t)).toBe('sidepanel_card_status_draft');
    });

    it('재발행 필요면 발행됨이어도 재발행 필요 키를 고른다', () => {
      expect(cardStatusKind(true, true)).toBe('needs_republish');
      expect(formatCardStatusText(true, true, t)).toBe('sidepanel_card_status_needs_republish');
    });

    it('발행 안 됐는데 재발행 필요만 참이어도 재발행 필요 키다', () => {
      expect(cardStatusKind(false, true)).toBe('needs_republish');
    });
  });

  describe('다음 예약 줄 표시 조건', () => {
    it('예약이 없으면 줄을 숨긴다', () => {
      expect(shouldShowNextSchedule(null)).toBe(false);
      expect(shouldShowNextSchedule(undefined)).toBe(false);
    });

    it('예약이 있으면(꺼져 있어도) 줄을 보여준다', () => {
      expect(shouldShowNextSchedule({ enabled: false, nextAt: null })).toBe(true);
      expect(shouldShowNextSchedule({ enabled: true, nextAt: 123 })).toBe(true);
    });
  });

  describe('설명 줄 표시 조건', () => {
    it('설명이 없거나 공백뿐이면 숨긴다', () => {
      expect(shouldShowDescription(undefined)).toBe(false);
      expect(shouldShowDescription('')).toBe(false);
      expect(shouldShowDescription('   ')).toBe(false);
    });

    it('설명이 있으면 보여준다', () => {
      expect(shouldShowDescription('로그인 후 표를 내려받는다')).toBe(true);
    });
  });

  describe('사이트 줄 표시 조건', () => {
    it('도메인이 없으면 숨긴다', () => {
      expect(shouldShowSite(undefined)).toBe(false);
      expect(shouldShowSite('')).toBe(false);
    });

    it('도메인이 있으면 보여준다', () => {
      expect(shouldShowSite('example.com')).toBe(true);
    });
  });
});
