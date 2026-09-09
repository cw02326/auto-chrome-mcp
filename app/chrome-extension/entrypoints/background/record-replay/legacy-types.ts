/**
 * Legacy Step Types for Record & Replay
 *
 * This file contains the legacy Step type system that is being phased out
 * in favor of the DAG-based execution model (nodes/edges).
 *
 * These types are kept for:
 * 1. Backward compatibility with existing flows that use steps array
 * 2. Recording pipeline that still produces Step[] output
 * 3. Legacy node handlers in nodes/ directory
 *
 * New code should use the Action type system from ./actions/types.ts instead.
 *
 * Migration status: P4 phase 1 - types extracted, re-exported from types.ts
 */

import { STEP_TYPES } from '@/common/step-types';

// =============================================================================
// Legacy Selector Types
// =============================================================================

export type SelectorType = 'css' | 'xpath' | 'attr' | 'aria' | 'text';

export interface SelectorCandidate {
  type: SelectorType;
  value: string; // literal selector or text/aria expression
  weight?: number; // user-adjustable priority; higher first
}

export interface TargetLocator {
  ref?: string; // ephemeral ref from read_page
  candidates: SelectorCandidate[]; // ordered by priority
}

// =============================================================================
// Legacy Step Types
// =============================================================================

export type StepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];

export interface StepBase {
  id: string;
  type: StepType;
  timeoutMs?: number; // default 10000
  retry?: { count: number; intervalMs: number; backoff?: 'none' | 'exp' };
  screenshotOnFail?: boolean; // default true
}

export interface StepClick extends StepBase {
  type: 'click' | 'dblclick';
  target: TargetLocator;
  before?: { scrollIntoView?: boolean; waitForSelector?: boolean };
  after?: { waitForNavigation?: boolean; waitForNetworkIdle?: boolean };
}

export interface StepFill extends StepBase {
  type: 'fill';
  target: TargetLocator;
  value: string; // may contain {var}
}

export interface StepTriggerEvent extends StepBase {
  type: 'triggerEvent';
  target: TargetLocator;
  event: string; // e.g. 'input', 'change', 'mouseover'
  bubbles?: boolean;
  cancelable?: boolean;
}

export interface StepSetAttribute extends StepBase {
  type: 'setAttribute';
  target: TargetLocator;
  name: string;
  value?: string; // when omitted and remove=true, remove attribute
  remove?: boolean;
}

export interface StepScreenshot extends StepBase {
  type: 'screenshot';
  selector?: string;
  fullPage?: boolean;
  saveAs?: string; // variable name to store base64
}

export interface StepSwitchFrame extends StepBase {
  type: 'switchFrame';
  frame?: { index?: number; urlContains?: string };
}

export interface StepLoopElements extends StepBase {
  type: 'loopElements';
  selector: string;
  saveAs?: string; // list var name
  itemVar?: string; // default 'item'
  subflowId: string;
}

export interface StepKey extends StepBase {
  type: 'key';
  keys: string; // e.g. "Backspace Enter" or "cmd+a"
  target?: TargetLocator; // optional focus target
  /**
   * Post-key waits (2026-09-05 Codex cross review, item 5).
   *
   * Enter on a form submits it, so a recorded key step can carry the same
   * navigation hint a click does. The recorder sets `waitForNavigation` only
   * when it actually observed a navigation right after the key press.
   */
  after?: { waitForNavigation?: boolean; waitForNetworkIdle?: boolean };
}

export interface StepScroll extends StepBase {
  type: 'scroll';
  mode: 'element' | 'offset' | 'container';
  target?: TargetLocator; // when mode = element / container
  offset?: { x?: number; y?: number };
}

export interface StepDrag extends StepBase {
  type: 'drag';
  start: TargetLocator;
  end: TargetLocator;
  path?: Array<{ x: number; y: number }>; // sampled trajectory
}

export interface StepWait extends StepBase {
  type: 'wait';
  condition:
    | { selector: string; visible?: boolean }
    | { text: string; appear?: boolean }
    | { navigation: true }
    | { networkIdle: true }
    | { sleep: number };
}

export interface StepAssert extends StepBase {
  type: 'assert';
  assert:
    | { exists: string }
    | { visible: string }
    | { textPresent: string }
    | { attribute: { selector: string; name: string; equals?: string; matches?: string } };
  // 실패 정책: stop=실패 즉시 중단(기본), warn=경고만 남기고 계속, retry=재시도
  failStrategy?: 'stop' | 'warn' | 'retry';
}

export interface StepScript extends StepBase {
  type: 'script';
  world?: 'MAIN' | 'ISOLATED';
  code: string; // user script string
  when?: 'before' | 'after';
}

export interface StepIf extends StepBase {
  type: 'if';
  // condition supports: { var: string; equals?: any } | { expression: string }
  condition: any;
}

export interface StepForeach extends StepBase {
  type: 'foreach';
  listVar: string;
  itemVar?: string;
  subflowId: string;
}

export interface StepWhile extends StepBase {
  type: 'while';
  condition: any;
  subflowId: string;
  maxIterations?: number;
}

export interface StepHttp extends StepBase {
  type: 'http';
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  formData?: any;
  saveAs?: string;
  assign?: Record<string, string>;
}

export interface StepExtract extends StepBase {
  type: 'extract';
  selector?: string;
  attr?: string; // 'text'|'textContent' to read text
  js?: string; // custom JS that returns value
  saveAs: string;
}

export interface StepOpenTab extends StepBase {
  type: 'openTab';
  url?: string;
  newWindow?: boolean;
  /**
   * 이 단계가 만든 탭에 붙일 논리 탭 번호 (2026-09-09 여러 탭 설계 2.1).
   *
   * 녹화가 확정한 번호다. 재생은 번호를 추측하지 않는다. 0 은 흐름을 시작한 탭이다.
   */
  tabRef?: number;
  /**
   * 이 `openTab` 단계가 어떻게 생겼는지 (표시·진단용).
   *
   *   - `joined`: 녹화 중 사용자가 그 탭으로 옮겨 가 세션에 합류한 것. 지금 녹화가 만드는
   *     값은 이것 하나뿐이다.
   *   - `blank_link` · `auto`: 1.14.0 개발 중 잠깐 쓰였던 값. 그때 저장된 흐름을 읽기 위해
   *     타입에만 남겨 둔다.
   */
  origin?: 'joined' | 'blank_link' | 'auto';
}

export interface StepSwitchTab extends StepBase {
  type: 'switchTab';
  tabId?: number;
  urlContains?: string;
  titleContains?: string;
  /** 옮겨 갈 논리 탭 번호. 있으면 `tabId` 보다 우선한다 (설계 2.1). */
  tabRef?: number;
}

export interface StepCloseTab extends StepBase {
  type: 'closeTab';
  tabIds?: number[];
  url?: string;
  /**
   * 닫을 논리 탭 번호 (설계 2.4).
   *
   * 이 필드가 있으면 해석 실패 시 현재 run 탭을 닫는 폴백을 타지 않는다. 구버전이 이
   * 필드를 "인자 없음" 으로 오해해 사용자가 보던 탭을 닫는 것이 이 기능의 대표 사고이고,
   * 그래서 구버전은 게이트(`engine/flow-compat.ts`)가 아예 실행을 거절한다.
   */
  tabRef?: number;
}

export interface StepNavigate extends StepBase {
  type: 'navigate';
  url: string;
}

export interface StepHandleDownload extends StepBase {
  type: 'handleDownload';
  filenameContains?: string;
  saveAs?: string;
  waitForComplete?: boolean;
}

export interface StepExecuteFlow extends StepBase {
  type: 'executeFlow';
  flowId: string;
  inline?: boolean;
  args?: Record<string, any>;
}

// =============================================================================
// Step Union Type
// =============================================================================

export type Step =
  | StepClick
  | StepFill
  | StepTriggerEvent
  | StepSetAttribute
  | StepScreenshot
  | StepSwitchFrame
  | StepLoopElements
  | StepKey
  | StepScroll
  | StepDrag
  | StepWait
  | StepAssert
  | StepScript
  | StepIf
  | StepForeach
  | StepWhile
  | StepNavigate
  | StepHttp
  | StepExtract
  | StepOpenTab
  | StepSwitchTab
  | StepCloseTab
  | StepHandleDownload
  | StepExecuteFlow;
