/**
 * auto-chrome-mcp fork — appendWithOverlap 수렴성 퍼즈 테스트.
 *
 * 단발 케이스 테스트만으로는 "패스를 거듭할수록 조금씩 어긋나 결국 폭발" 하는 유형을 못 잡는다.
 * (실제로 그 유형이었다: 최종 16.8KB 페이지가 패스마다 통째로 다시 붙어 120KB 가 됐다.)
 * 그래서 무한 스크롤 페이지의 대표적인 모양 4가지를 시드 고정 난수로 시뮬레이션해,
 * 매 패스마다 ① 지금까지 등장한 항목이 하나도 사라지지 않고 ② 중복이 쌓이지 않는지 본다.
 */
import { describe, expect, it } from 'vitest';
import { appendWithOverlap } from '@/entrypoints/background/tools/browser/scroll-collect';

/** 시드 고정 LCG — 실패를 재현할 수 있어야 한다. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const HEADER = 'Shop\nSign in\nCart is empty\n';
const FOOTER = '\nAbout us | Careers | Privacy\nCopyright 2026 Example Inc.';

interface PageShape {
  name: string;
  /** 가상 스크롤: 화면에 유지되는 항목 수 (무한이면 전체 유지) */
  windowSize: number;
  header: boolean;
  footer: boolean;
  spinner: boolean;
}

const SHAPES: PageShape[] = [
  { name: 'append-only', windowSize: Infinity, header: false, footer: false, spinner: false },
  { name: '헤더+푸터', windowSize: Infinity, header: true, footer: true, spinner: false },
  { name: '헤더+푸터+스피너', windowSize: Infinity, header: true, footer: true, spinner: true },
  { name: '가상 스크롤', windowSize: 25, header: true, footer: true, spinner: true },
];

function itemLine(index: number, random: () => number): string {
  const words = ['가벼운', '튼튼한', '방수', '무선', '휴대용', '접이식'];
  const word = words[Math.floor(random() * words.length)];
  return `상품 ${index} — ${word} 모델, 재고 ${Math.floor(random() * 90) + 1}개, 무료배송`;
}

const SEEDS = [1, 20260823, 987654321];
const PAGE_SIZES = [7, 12];

describe('appendWithOverlap — 여러 패스 수렴성', () => {
  for (const shape of SHAPES) {
    for (const seed of SEEDS) {
      for (const pageSize of PAGE_SIZES) {
        runShape(shape, seed, pageSize);
      }
    }
  }

  function runShape(shape: PageShape, seed: number, pageSize: number): void {
    it(`${shape.name} (seed ${seed}, ${pageSize}개씩): 내용을 잃지 않고 크기가 폭발하지 않는다`, () => {
      const random = makeRandom(seed);
      const items = Array.from({ length: 120 }, (_, i) => itemLine(i + 1, random));

      let accumulated = '';
      for (let pass = 1; pass * pageSize <= items.length; pass++) {
        const end = pass * pageSize;
        const start = Number.isFinite(shape.windowSize) ? Math.max(0, end - shape.windowSize) : 0;
        const visible = items.slice(start, end);
        const snapshot =
          (shape.header ? HEADER : '') +
          visible.join('\n') +
          (shape.spinner && end < items.length ? '\nLoading more…' : '') +
          (shape.footer ? FOOTER : '');

        accumulated = appendWithOverlap(accumulated, snapshot);

        // ① 지금까지 등장한 항목은 전부 남아 있어야 한다.
        for (const item of items.slice(0, end)) {
          expect(accumulated, `pass ${pass}: 항목이 사라졌다 — ${item}`).toContain(item);
        }
        // ② 같은 항목이 두 번 이상 쌓이면 안 된다.
        for (const item of items.slice(0, end)) {
          const occurrences = accumulated.split(item).length - 1;
          expect(occurrences, `pass ${pass}: 항목이 ${occurrences}번 중복 — ${item}`).toBe(1);
        }
      }

      // 최종 크기는 "모든 항목 + 고정 UI" 근처여야 한다 (패스마다 통째로 붙으면 몇 배가 된다).
      const contentSize =
        items.join('\n').length +
        (shape.header ? HEADER.length : 0) +
        (shape.footer ? FOOTER.length : 0);
      expect(accumulated.length).toBeLessThan(contentSize * 1.2);
    });
  }
});
