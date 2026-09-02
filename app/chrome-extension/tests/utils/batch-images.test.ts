/**
 * auto-chrome-mcp fork — chrome_batch 이미지 보존 회귀 테스트.
 *
 * 재현하려는 실패: 스키마는 `click -> fill -> click -> screenshot` 체인을 권하는데,
 * batch 는 스텝 결과에서 **텍스트만** 이어붙이고 image content 를 통째로 버렸다.
 * 배치로 스크린샷을 찍으면 그림이 영영 안 돌아왔다.
 *
 * 계약: 스텝이 만든 이미지는 요약 JSON 뒤에 순서대로 붙는다. 다만 20 스텝이 전부
 * 스크린샷일 때 컨텍스트가 터지지 않도록 뒤에서부터 상한만큼만 남기고, 버린 개수를 알린다.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { batchTool, setBatchToolInvoker } from '@/entrypoints/background/tools/browser/batch';

const img = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });
const txt = (text: string) => ({ type: 'text', text });

function parseSummary(result: any) {
  return JSON.parse(result.content[0].text);
}

function imagesOf(result: any) {
  return result.content.filter((c: any) => c.type === 'image');
}

describe('chrome_batch 이미지 보존', () => {
  beforeEach(() => {
    setBatchToolInvoker(async () => ({ content: [txt('{}')], isError: false }));
  });

  it('스텝이 돌려준 이미지를 결과에 붙인다 (핵심 회귀)', async () => {
    setBatchToolInvoker(async ({ name }) =>
      name === 'chrome_screenshot'
        ? { content: [txt('{"ok":true}'), img('SHOT')], isError: false }
        : { content: [txt('{"ok":true}')], isError: false },
    );

    const result = await batchTool.execute({
      steps: [{ tool: 'chrome_click_element' }, { tool: 'chrome_screenshot' }],
    });

    const images = imagesOf(result);
    expect(images).toHaveLength(1);
    expect(images[0].data).toBe('SHOT');

    const summary = parseSummary(result);
    expect(summary.success).toBe(true);
    expect(summary.steps[1].images).toBe(1);
    expect(summary.attachedImages).toEqual([{ step: 1, tool: 'chrome_screenshot' }]);
  });

  it('실패 스텝의 이미지(실패 스크린샷)도 살린다', async () => {
    setBatchToolInvoker(async () => ({
      content: [txt('boom'), img('FAILSHOT')],
      isError: true,
    }));

    const result = await batchTool.execute({
      steps: [{ tool: 'chrome_click_element' }],
    });

    expect(imagesOf(result)[0].data).toBe('FAILSHOT');
    expect(parseSummary(result).success).toBe(false);
  });

  it('이미지가 많으면 최신 것부터 상한만큼만 남기고 버린 수를 알린다', async () => {
    let n = 0;
    setBatchToolInvoker(async () => ({
      content: [txt('{}'), img(`SHOT${n++}`)],
      isError: false,
    }));

    const result = await batchTool.execute({
      steps: Array.from({ length: 6 }, () => ({ tool: 'chrome_screenshot' })),
    });

    const images = imagesOf(result);
    expect(images).toHaveLength(4);
    // 체인의 마지막 스크린샷이 보통 가장 중요하다 — 뒤에서부터 남긴다.
    expect(images.map((i: any) => i.data)).toEqual(['SHOT2', 'SHOT3', 'SHOT4', 'SHOT5']);

    const summary = parseSummary(result);
    expect(summary.droppedImages).toBe(2);
    expect(summary.droppedImagesNote).toContain('last 4');
  });

  it('이미지가 없으면 결과 모양은 예전 그대로다 (텍스트 1개)', async () => {
    const result = await batchTool.execute({ steps: [{ tool: 'chrome_click_element' }] });
    expect(result.content).toHaveLength(1);
    expect(parseSummary(result).attachedImages).toBeUndefined();
  });

  it('건너뛴 스텝은 이미지를 만들지 않는다', async () => {
    setBatchToolInvoker(async () => ({ content: [txt('boom'), img('X')], isError: true }));
    const result = await batchTool.execute({
      steps: [{ tool: 'chrome_click_element' }, { tool: 'chrome_screenshot' }],
    });
    const summary = parseSummary(result);
    expect(summary.stoppedAtStep).toBe(0);
    expect(summary.steps[1].images).toBeUndefined();
    expect(imagesOf(result)).toHaveLength(1);
  });
});
