/**
 * action-path-run-context.test.ts
 *
 * 2026-09-05 Codex 최종 확인 2: **액션 경로가 실행 컨텍스트를 잃었다.**
 *
 * 흐름 실행이 노드에서 브라우저 도구를 부르는 길은 두 갈래다. 레거시 경로는
 * `runToolArgs`(engine/tab-context.ts)를 지나며 실행 컨텍스트 모드(`_effectiveBackgroundMode`)
 * 와 마감(`_deadlineAt`)을 인자에 싣는다. 액션 경로는 `actionToolArgs` 를 지나는데 그 둘을
 * 싣지 않았다. 같은 흐름의 같은 스텝이라도 어느 경로로 실행되느냐에 따라
 *
 *   - 무간섭 판정이 전역 토글로 떨어져 사용자 탭을 활성화할 수 있었고,
 *   - 도구 하나가 실행 마감을 넘겨 매달려도 아무도 끊지 않았다.
 *
 * 여기서는 두 계약을 고정한다: 어댑터가 실행 컨텍스트에서 두 값을 옮겨 주고,
 * `actionToolArgs` 가 그 값을 도구 호출 인자에 싣는다.
 */

import { describe, expect, it, vi } from 'vitest';
import { execCtxToActionCtx } from '@/entrypoints/background/record-replay/actions/adapter';
import { actionToolArgs } from '@/entrypoints/background/record-replay/actions/handlers/common';
import { EFFECTIVE_BACKGROUND_MODE_ARG } from '@/utils/background-mode';
import { FLOW_DEADLINE_ARG } from '@/utils/tool-watchdog';
import { LEASE_TOKEN_ARG } from '@/utils/tab-lock';
import { createMockActionCtx, createMockExecCtx } from './_test-helpers';

const DEADLINE_AT = 1_800_000_000_000;

describe('액션 경로도 실행 컨텍스트 모드와 마감을 도구 호출에 싣는다 (최종 확인 2)', () => {
  it('actionToolArgs 가 _effectiveBackgroundMode 와 _deadlineAt 을 함께 보낸다', () => {
    const ctx = createMockActionCtx({
      tabId: 42,
      mcpSessionId: 'sess-a',
      lane: 'lane-1',
      leaseToken: 'lease-1',
      effectiveBackgroundMode: true,
      deadlineAt: DEADLINE_AT,
    });

    const args = actionToolArgs(ctx, { selector: '#go' });

    expect(args.tabId).toBe(42);
    expect(args._mcpSessionId).toBe('sess-a');
    expect(args.lane).toBe('lane-1');
    expect((args as Record<string, unknown>)[LEASE_TOKEN_ARG]).toBe('lease-1');
    // 이 두 줄이 회귀의 전부다: 예전에는 둘 다 빠져 있었다.
    expect((args as Record<string, unknown>)[EFFECTIVE_BACKGROUND_MODE_ARG]).toBe(true);
    expect((args as Record<string, unknown>)[FLOW_DEADLINE_ARG]).toBe(DEADLINE_AT);
  });

  it('실행 컨텍스트에 값이 없으면 키 자체를 만들지 않는다', () => {
    const args = actionToolArgs(createMockActionCtx({ tabId: 7 }), {});

    expect(EFFECTIVE_BACKGROUND_MODE_ARG in args).toBe(false);
    expect(FLOW_DEADLINE_ARG in args).toBe(false);
  });

  it('어댑터가 run 컨텍스트의 모드·마감을 핸들러 컨텍스트로 옮긴다', () => {
    const runCtx = createMockExecCtx({
      tabId: 42,
      logger: vi.fn(),
      effectiveBackgroundMode: true,
      deadlineAt: DEADLINE_AT,
    });

    const actionCtx = execCtxToActionCtx(runCtx, 42);

    expect(actionCtx.effectiveBackgroundMode).toBe(true);
    expect(actionCtx.deadlineAt).toBe(DEADLINE_AT);
    // 옮겨 준 값이 그대로 도구 호출 인자까지 간다.
    const args = actionToolArgs(actionCtx, {});
    expect((args as Record<string, unknown>)[EFFECTIVE_BACKGROUND_MODE_ARG]).toBe(true);
    expect((args as Record<string, unknown>)[FLOW_DEADLINE_ARG]).toBe(DEADLINE_AT);
  });
});
