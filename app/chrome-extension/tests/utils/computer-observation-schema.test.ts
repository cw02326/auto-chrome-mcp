import { describe, expect, it } from 'vitest';
// 발행 전 dist 대신 수정한 원본 스키마를 검증한다. 브리지 재발행은 사람이 별도로 한다.
import { TOOL_NAMES, TOOL_SCHEMAS } from '../../../../packages/shared/src/tools';

describe('computer 관찰 ID 스키마', () => {
  it('기존 호출을 유지하면서 관찰 ID를 선택적으로 받는다', () => {
    const schema = TOOL_SCHEMAS.find(
      (tool) => tool.name === TOOL_NAMES.BROWSER.COMPUTER,
    )!.inputSchema;
    expect(schema.properties?.observationId).toMatchObject({ type: 'string' });
    expect(schema.required).not.toContain('observationId');
    expect(schema.required).toContain('action');
  });
});
