/**
 * 모달 다이얼로그 접근성 (2026-09-06 디자인/접근성 리뷰 대응).
 *
 * 사이드패널의 모달들(예약 폼, 흐름 가져오기, 실행 변수, 저장 마법사, App.vue 의 요소
 * 지정 모달)이 전부 같은 뼈대(`.ac-dim` 위에 `.ac-dialog`)를 쓰면서도 role/aria, 포커스
 * 이동, Tab 가두기, Esc 닫기가 하나도 없었다. 그 다섯 곳이 공유할 로직을 여기 하나로 모은다.
 *
 * 이 컴포저블은 스스로 다이얼로그를 닫지 않는다. Esc 를 누르면 호출자가 넘긴 `onClose`
 * 를 부르기만 하고, 실제로 화면에서 지우는 것(v-if 를 끄는 것 등)은 호출자 몫이다.
 */
import { onUnmounted, watch, type Ref } from 'vue';

/** 포커스를 옮길 수 있는 요소를 고르는 기준. 순수 함수라 jsdom 만으로 테스트한다. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** container 안에서 포커스를 받을 수 있는 요소를 문서 순서대로 돌려준다. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Esc 로 닫으라는 키인지 본다 (일부 브라우저는 `Esc` 를 쓴다). */
export function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === 'Escape' || event.key === 'Esc';
}

/**
 * Tab / Shift+Tab 이 container 밖으로 나가지 않도록 가둔다.
 * 마지막 요소에서 Tab 을 누르면 첫 요소로, 첫 요소에서 Shift+Tab 을 누르면 마지막
 * 요소로 돌아간다. 그 사이(중간) 요소에서는 아무것도 하지 않고 브라우저 기본 동작에
 * 맡긴다.
 */
export function handleFocusTrapKeydown(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const activeIndex = active ? focusable.indexOf(active) : -1;

  if (event.shiftKey) {
    // 첫 요소(또는 다이얼로그 밖/컨테이너 자체에 포커스가 있을 때)에서 뒤로 가면 마지막으로.
    if (activeIndex <= 0) {
      event.preventDefault();
      last.focus();
    }
  } else {
    // 마지막 요소(또는 포커스를 알 수 없을 때)에서 앞으로 가면 처음으로.
    if (activeIndex === -1 || activeIndex === focusable.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }
}

/**
 * 다이얼로그 하나에 role=dialog 접근성을 붙인다.
 *
 * 호출자는 템플릿에서 다이얼로그 요소에 다음을 직접 바인딩해야 한다.
 *   role="dialog" aria-modal="true" :aria-labelledby="titleId" ref="dialogRef" tabindex="-1"
 * 그리고 제목 요소에 :id="titleId" 를 붙인다.
 *
 * `dialogRef` 는 `onMounted` 가 아니라 `watch` 로 지켜본다. 예약 폼처럼 `v-if` 가 컴포넌트
 * 전체를 마운트·언마운트하는 경우뿐 아니라, App.vue 의 요소 지정 모달처럼 이미 떠 있는
 * 컴포넌트 안에서 `v-if` 하나만 켜고 끄는 경우(엘리먼트만 null ↔ 실제 노드로 바뀐다)도
 * 똑같이 다뤄야 하기 때문이다.
 *
 * @param dialogRef 다이얼로그 루트(`.ac-dialog`) 엘리먼트를 담을 ref.
 * @param titleId   그 다이얼로그의 제목 요소에 붙일 고유 id (컴포넌트마다 다른 문자열).
 * @param onClose   Esc 를 눌렀을 때 부를 콜백. 실제 닫기는 호출자가 한다.
 */
export function useDialogA11y(
  dialogRef: Ref<HTMLElement | null>,
  titleId: string,
  onClose: () => void,
): { titleId: string } {
  let previouslyFocused: HTMLElement | null = null;
  let active = false;

  function handleKeydown(event: KeyboardEvent): void {
    if (isEscapeKey(event)) {
      onClose();
      return;
    }
    const container = dialogRef.value;
    if (container) handleFocusTrapKeydown(event, container);
  }

  function activate(container: HTMLElement): void {
    if (active) return;
    active = true;
    // 다이얼로그를 연 순간 화면에 있던 포커스를 기억해 뒀다가 닫히면 되돌려준다.
    previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = getFocusableElements(container);
    // 안에 포커스 받을 요소가 없으면 컨테이너 자체(tabindex="-1")로 이동한다.
    (focusable[0] ?? container).focus();
    document.addEventListener('keydown', handleKeydown);
  }

  function deactivate(): void {
    if (!active) return;
    active = false;
    document.removeEventListener('keydown', handleKeydown);
    previouslyFocused?.focus?.();
    previouslyFocused = null;
  }

  watch(
    dialogRef,
    (el) => {
      if (el) activate(el);
      else deactivate();
    },
    { immediate: true },
  );

  onUnmounted(() => {
    deactivate();
  });

  return { titleId };
}
