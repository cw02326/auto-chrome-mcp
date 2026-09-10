import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS } from '../../../../packages/shared/src/tools';

function computerSchema() {
  return TOOL_SCHEMAS.find((tool) => tool.name === TOOL_NAMES.BROWSER.COMPUTER)!.inputSchema as {
    properties: Record<string, any>;
  };
}

describe('computer 입력 루프 스키마', () => {
  it('관찰 후 옵션은 기본적으로 꺼져 있고 이미지를 별도로 선택한다', () => {
    const { properties } = computerSchema();

    expect(properties.observeAfter).toMatchObject({ type: 'boolean', default: false });
    expect(properties.includeImage).toMatchObject({ type: 'boolean', default: false });
    expect(properties.includeImage.description).toContain('observeAfter=true');
  });

  it('분리 입력, 경로 드래그, IME 입력을 표현한다', () => {
    const { properties } = computerSchema();
    const actionDescription = properties.action.description as string;

    for (const action of [
      'mouse_down',
      'mouse_up',
      'key_down',
      'key_up',
      'drag_path',
      'ime_type',
    ]) {
      expect(actionDescription).toContain(action);
    }
    expect(properties.button).toMatchObject({
      type: 'string',
      enum: ['left', 'right', 'middle'],
      default: 'left',
    });
    expect(properties.key).toMatchObject({ type: 'string' });
    expect(properties.path).toMatchObject({ type: 'array', minItems: 2, maxItems: 1000 });
    expect(properties.path.items).toMatchObject({
      type: 'object',
      required: ['x', 'y'],
    });
    expect(properties.path.items.properties.x).toMatchObject({ type: 'number' });
    expect(properties.path.items.properties.y).toMatchObject({ type: 'number' });
  });

  it('기존 action 필수 계약과 type의 insertText 동작 설명을 보존한다', () => {
    const schema = TOOL_SCHEMAS.find(
      (tool) => tool.name === TOOL_NAMES.BROWSER.COMPUTER,
    )!.inputSchema;
    const { properties } = computerSchema();

    expect(schema.required).toContain('action');
    expect(properties.text.description).toContain('type remains insertText');
    expect(properties.observeAfter.description).toContain('observationId');
  });
});
