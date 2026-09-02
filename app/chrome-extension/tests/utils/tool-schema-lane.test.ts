/**
 * auto-chrome-mcp fork(P1) — 도구 스키마의 lane 인자 회귀 테스트.
 *
 * lane 은 packages/shared/src/tools.ts 에서 스키마마다 손으로 넣지 않고 한 번에 주입한다.
 * 도구가 새로 추가돼도 자동으로 따라오는 대신, 주입이 조용히 깨질 수 있어 여기서 못박는다.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS } from 'auto-chrome-mcp-shared';

function schemaOf(name: string) {
  const tool = TOOL_SCHEMAS.find((t) => t.name === name);
  expect(tool, `${name} 스키마가 없다`).toBeDefined();
  return tool!.inputSchema as { properties?: Record<string, any> };
}

describe('도구 스키마 lane 인자 (P1)', () => {
  it('탭을 대상으로 하는 도구에는 lane 이 들어 있다', () => {
    const laneUsers = [
      TOOL_NAMES.BROWSER.NAVIGATE,
      TOOL_NAMES.BROWSER.SET_WORK_TAB,
      TOOL_NAMES.BROWSER.CLICK,
      TOOL_NAMES.BROWSER.FILL,
      TOOL_NAMES.BROWSER.READ_PAGE,
      TOOL_NAMES.BROWSER.SCREENSHOT,
      TOOL_NAMES.BROWSER.BATCH,
      TOOL_NAMES.BROWSER.SHORTCUT,
      TOOL_NAMES.BROWSER.CLOSE_TABS,
    ];

    for (const name of laneUsers) {
      const lane = schemaOf(name).properties?.lane;
      expect(lane, `${name} 에 lane 이 없다`).toBeDefined();
      expect(lane.type).toBe('string');
      expect(lane.description).toMatch(/lane/i);
    }
  });

  it('navigate / set_work_tab 은 병렬 사용법을 자세히 설명한다', () => {
    for (const name of [TOOL_NAMES.BROWSER.NAVIGATE, TOOL_NAMES.BROWSER.SET_WORK_TAB]) {
      expect(schemaOf(name).properties?.lane.description).toMatch(/Sub-agents/);
    }
  });

  it('탭과 무관한 도구에는 lane 을 넣지 않는다 (스키마 군살 방지)', () => {
    const exempt = [
      TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
      TOOL_NAMES.BROWSER.HISTORY,
      TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    ];
    for (const name of exempt) {
      expect(schemaOf(name).properties?.lane, `${name} 에 lane 이 붙었다`).toBeUndefined();
    }
  });

  it('lane 은 어떤 도구에서도 필수가 아니다 (기존 호출 그대로 동작)', () => {
    for (const tool of TOOL_SCHEMAS) {
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      expect(required, `${tool.name} 이 lane 을 필수로 요구한다`).not.toContain('lane');
    }
  });
});
