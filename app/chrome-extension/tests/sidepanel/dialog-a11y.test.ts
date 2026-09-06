/**
 * 다이얼로그 접근성 순수 함수 (2026-09-06 디자인/접근성 리뷰 대응).
 *
 * 확인하려는 것.
 *   1. getFocusableElements 는 버튼·입력·링크를 찾고, disabled 와 tabindex="-1" 은 뺀다.
 *   2. handleFocusTrapKeydown 은 마지막 요소에서 Tab 을 누르면 첫 요소로 되돌린다.
 *   3. handleFocusTrapKeydown 은 첫 요소에서 Shift+Tab 을 누르면 마지막 요소로 되돌린다.
 *   4. 가운데 요소에서 Tab 을 누르면 아무 일도 하지 않는다(preventDefault 를 부르지 않는다).
 *   5. isEscapeKey 는 Escape 키만 골라낸다.
 */

import { describe, expect, it, vi } from 'vitest';
import { getFocusableElements, handleFocusTrapKeydown, isEscapeKey } from '@/ui/useDialogA11y';

/** container 안에 버튼 몇 개(+비활성/포커스 제외)를 넣은 뒤 컨테이너를 돌려준다. */
function buildContainer(): {
  container: HTMLElement;
  first: HTMLButtonElement;
  middle: HTMLButtonElement;
  last: HTMLInputElement;
} {
  const container = document.createElement('div');

  const first = document.createElement('button');
  first.textContent = '첫 버튼';
  container.appendChild(first);

  const disabled = document.createElement('button');
  disabled.disabled = true;
  disabled.textContent = '비활성 버튼';
  container.appendChild(disabled);

  const noFocus = document.createElement('div');
  noFocus.setAttribute('tabindex', '-1');
  container.appendChild(noFocus);

  const middle = document.createElement('button');
  middle.textContent = '가운데 버튼';
  container.appendChild(middle);

  const link = document.createElement('a');
  link.textContent = '링크 없음(href 없음)';
  container.appendChild(link);

  const last = document.createElement('input');
  last.type = 'text';
  container.appendChild(last);

  document.body.appendChild(container);
  return { container, first, middle, last };
}

function keydown(options: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
}

describe('getFocusableElements', () => {
  it('버튼·입력을 찾고 비활성 버튼과 tabindex=-1 요소는 뺀다', () => {
    const { container, first, middle, last } = buildContainer();
    const focusable = getFocusableElements(container);

    // href 없는 <a> 와 disabled 버튼, tabindex="-1" div 는 목록에 없어야 한다.
    expect(focusable).toEqual([first, middle, last]);
  });

  it('a[href] 는 포함한다', () => {
    const container = document.createElement('div');
    const link = document.createElement('a');
    link.href = 'https://example.com';
    container.appendChild(link);

    expect(getFocusableElements(container)).toEqual([link]);
  });
});

describe('handleFocusTrapKeydown', () => {
  it('마지막 요소에서 Tab 을 누르면 첫 요소로 되돌아간다', () => {
    const { container, first, last } = buildContainer();
    last.focus();
    expect(document.activeElement).toBe(last);

    const event = keydown({ key: 'Tab' });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    handleFocusTrapKeydown(event, container);

    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it('첫 요소에서 Shift+Tab 을 누르면 마지막 요소로 되돌아간다', () => {
    const { container, first, last } = buildContainer();
    first.focus();
    expect(document.activeElement).toBe(first);

    const event = keydown({ key: 'Tab', shiftKey: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    handleFocusTrapKeydown(event, container);

    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(last);
  });

  it('가운데 요소에서 Tab 을 누르면 아무 일도 하지 않는다', () => {
    const { container, middle } = buildContainer();
    middle.focus();
    expect(document.activeElement).toBe(middle);

    const event = keydown({ key: 'Tab' });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    handleFocusTrapKeydown(event, container);

    expect(preventDefault).not.toHaveBeenCalled();
    // 포커스도 그대로다 (브라우저 기본 동작에 맡긴다).
    expect(document.activeElement).toBe(middle);
  });

  it('가운데 요소에서 Shift+Tab 을 눌러도 아무 일도 하지 않는다', () => {
    const { container, middle } = buildContainer();
    middle.focus();

    const event = keydown({ key: 'Tab', shiftKey: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    handleFocusTrapKeydown(event, container);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('Tab 이 아닌 키는 무시한다', () => {
    const { container, last } = buildContainer();
    last.focus();

    const event = keydown({ key: 'Enter' });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    handleFocusTrapKeydown(event, container);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(last);
  });
});

describe('isEscapeKey', () => {
  it('Escape 키는 true 다', () => {
    expect(isEscapeKey(keydown({ key: 'Escape' }))).toBe(true);
  });

  it('구형 브라우저의 Esc 표기도 true 다', () => {
    expect(isEscapeKey(keydown({ key: 'Esc' }))).toBe(true);
  });

  it('그 외 키는 false 다', () => {
    expect(isEscapeKey(keydown({ key: 'Tab' }))).toBe(false);
    expect(isEscapeKey(keydown({ key: 'Enter' }))).toBe(false);
  });
});
