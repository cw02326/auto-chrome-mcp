/**
 * 흐름 카드(WorkflowListItem)의 정보 목록 문구 (2026-09-06 초보자 가독성 개편).
 *
 * 사용자 피드백: 카드 안의 "발행됨", "설명 없음", "example.com" 같은 말이 무슨 뜻인지
 * 몰랐다. 그래서 상태 한 줄에 "왜 중요한지" 까지 적고, 값 없는 줄은 아예 숨긴다.
 *
 * 크롬 API 를 부르지 않는 순수 함수만 둔다.
 */

import { getMessage } from '@/utils/i18n';
import type { Translate } from './daily-format';

/** 발행 상태 3종. `needsRepublish` 가 `published` 보다 먼저 본다 - 발행은 됐지만 바뀐 게 있으면 그게 더 급한 정보다. */
export type CardStatusKind = 'published' | 'needs_republish' | 'draft';

export function cardStatusKind(published: boolean, needsRepublish: boolean): CardStatusKind {
  if (needsRepublish) return 'needs_republish';
  if (published) return 'published';
  return 'draft';
}

const CARD_STATUS_MESSAGE_KEYS: Readonly<Record<CardStatusKind, string>> = {
  published: 'sidepanel_card_status_published',
  needs_republish: 'sidepanel_card_status_needs_republish',
  draft: 'sidepanel_card_status_draft',
};

/** 상태 줄의 문구. "발행됨" 같은 한 단어가 아니라 무엇을 할 수 있는지까지 말한다. */
export function formatCardStatusText(
  published: boolean,
  needsRepublish: boolean,
  t: Translate = getMessage,
): string {
  return t(CARD_STATUS_MESSAGE_KEYS[cardStatusKind(published, needsRepublish)]);
}

/** 예약이 있을 때만 "다음 예약" 줄을 보여준다. 없으면 줄 자체를 숨긴다. */
export function shouldShowNextSchedule(schedule: unknown): boolean {
  return schedule != null;
}

/** 설명이 있을 때만 "설명" 줄을 보여준다. "설명 없음" 이라는 줄은 더 이상 두지 않는다. */
export function shouldShowDescription(description: string | null | undefined): boolean {
  return typeof description === 'string' && description.trim().length > 0;
}

/** 사이트(도메인)가 있을 때만 "사이트" 줄을 보여준다. */
export function shouldShowSite(domain: string | null | undefined): boolean {
  return typeof domain === 'string' && domain.trim().length > 0;
}
