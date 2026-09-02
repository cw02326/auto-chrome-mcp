/**
 * auto-chrome-mcp fork — chrome_scroll_collect 의 스냅샷 합치기 규칙.
 *
 * 2026-08-23 실측: 푸터나 "Loading" 스피너가 끝에 붙어 있는 페이지(=대부분의 무한 스크롤)는
 * 새 항목이 **가운데**로 들어와서 접두/접미 겹침이 둘 다 빗나갔고, 패스마다 페이지 전체가
 * `---` 와 함께 통째로 다시 붙었다. 토큰을 아끼자고 만든 도구가 되레 낭비하고 있었다.
 */
import { describe, expect, it } from 'vitest';
import { appendWithOverlap } from '@/entrypoints/background/tools/browser/scroll-collect';

const HEADER = 'Quotes to Scrape\nLogin\n';
const FOOTER = '\nQuotes by: GoodReads.com\nMade with love by Zyte';
const PAGE1 = Array.from(
  { length: 10 },
  (_, i) => `quote ${i + 1} — a fairly long line of text`,
).join('\n');
const PAGE2 = Array.from(
  { length: 10 },
  (_, i) => `quote ${i + 11} — a fairly long line of text`,
).join('\n');

describe('appendWithOverlap', () => {
  it('append-only 페이지는 뒤에 붙은 부분만 더한다', () => {
    const acc = HEADER + PAGE1;
    expect(appendWithOverlap(acc, acc + '\n' + PAGE2)).toBe(acc + '\n' + PAGE2);
  });

  it('푸터가 끝에 고정된 페이지도 중복 없이 합친다', () => {
    const pass1 = HEADER + PAGE1 + FOOTER;
    const pass2 = HEADER + PAGE1 + '\n' + PAGE2 + FOOTER;

    const merged = appendWithOverlap(pass1, pass2);

    expect(merged).toBe(pass2);
    expect(merged).not.toContain('\n---\n');
    // 헤더가 두 번 들어가면 중복 누적이다.
    expect(merged.split(HEADER).length - 1).toBe(1);
  });

  it('스피너가 사라져도 항목은 남기고 중복 없이 합친다', () => {
    const pass1 = HEADER + PAGE1 + '\nLoading...' + FOOTER;
    const pass2 = HEADER + PAGE1 + '\n' + PAGE2 + FOOTER; // 로딩이 끝나 스피너가 사라진 스냅샷

    const merged = appendWithOverlap(pass1, pass2);

    expect(merged).toContain('quote 1 —');
    expect(merged).toContain('quote 20 —');
    expect(merged.split('quote 1 —').length - 1).toBe(1);
    expect(merged.split('quote 10 —').length - 1).toBe(1);
    expect(merged).not.toContain('\n---\n');
  });

  it('맨 윗줄이 매번 바뀌어도(검색결과 카운터) 패스마다 통째로 다시 붙지 않는다', () => {
    // Codex 리뷰 지적: 첫 줄이 중간에서 갈리면 공통 접두사가 줄 시작으로 스냅되며 0 이 되어,
    // 푸터만으로 splice 조건을 통과한 뒤 이전·새 스냅샷이 모두 보존돼 8패스에 4배로 불었다.
    const snapshotFor = (pages: number) => {
      const items = Array.from(
        { length: pages * 5 },
        (_, i) => `quote ${i + 1} — a fairly long line of text`,
      ).join('\n');
      return `검색결과 ${pages * 5}건\n` + items + FOOTER;
    };

    let accumulated = '';
    for (let pages = 1; pages <= 8; pages++) {
      accumulated = appendWithOverlap(accumulated, snapshotFor(pages));
    }

    expect(accumulated).toContain('quote 40 —');
    expect(accumulated.split('quote 1 —').length - 1).toBe(1);
    expect(accumulated.split('quote 5 —').length - 1).toBe(1);
    expect(accumulated.length).toBeLessThan(snapshotFor(8).length * 1.2);
  });

  it('겹침이 탐색 창(2000자)보다 커도 중복시키지 않는다', () => {
    const line = (i: number) => `상품 ${i} — 넉넉히 긴 설명이 붙은 목록 줄입니다. 재고 있음.`;
    const older = Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n');
    const shared = Array.from({ length: 60 }, (_, i) => line(i + 41)).join('\n'); // 2000자 초과
    const fresh = Array.from({ length: 20 }, (_, i) => line(i + 101)).join('\n');

    expect(shared.length).toBeGreaterThan(2000);

    const merged = appendWithOverlap(older + '\n' + shared, shared + '\n' + fresh);

    expect(merged.split(line(41)).length - 1).toBe(1);
    expect(merged.split(line(100)).length - 1).toBe(1);
    expect(merged).toContain(line(120));
    expect(merged).not.toContain('\n---\n');
  });

  it('짧은 실제 본문을 "스피너처럼 보인다"는 이유로 지우지 않는다', () => {
    // Codex 리뷰 지적: 긴 헤더/푸터 + 4배 크기 차이는 일시적 UI 의 증거가 못 된다.
    const longHeader = 'Shop\nSign in\nCart is empty\nFree shipping over 50,000 KRW\n';
    const longFooter = '\nAbout us | Careers | Privacy | Terms\nCopyright 2026 Example Inc.';
    const shortReal = '재고 3개 남음 — 오늘 출발';
    const longNew = Array.from({ length: 8 }, (_, i) => `상품 ${i + 1} — 넉넉히 긴 설명 줄`).join(
      '\n',
    );

    const merged = appendWithOverlap(
      longHeader + shortReal + longFooter,
      longHeader + longNew + longFooter,
    );

    expect(merged).toContain(shortReal);
    expect(merged).toContain('상품 8 —');
  });

  it('패스를 거듭해도 누적본이 최종 스냅샷 크기를 넘지 않는다 (중복 누적 회귀)', () => {
    const snapshotFor = (pages: number) => {
      const items = Array.from(
        { length: pages * 10 },
        (_, i) => `quote ${i + 1} — a fairly long line of text`,
      ).join('\n');
      return HEADER + items + '\nLoading...' + FOOTER;
    };

    let accumulated = '';
    for (let pages = 1; pages <= 10; pages++) {
      accumulated = appendWithOverlap(accumulated, snapshotFor(pages));
    }

    expect(accumulated.length).toBeLessThanOrEqual(snapshotFor(10).length);
    expect(accumulated).toContain('quote 100 —');
    expect(accumulated.split('quote 1 —').length - 1).toBe(1);
    expect(accumulated.split(HEADER).length - 1).toBe(1);
  });

  it('짧은 본문이 비슷한 길이의 본문으로 교체돼도 잃지 않는다', () => {
    // Codex 리뷰 지적: 길이만으로 판정하면 80자짜리 실제 항목이 스피너로 오인돼 사라진다.
    const itemA = '상품 A — 재고 3개 남았습니다. 오늘 출발 예정.';
    const itemB = '상품 B — 재고 7개 남았습니다. 내일 출발 예정.';
    const merged = appendWithOverlap(HEADER + itemA + FOOTER, HEADER + itemB + FOOTER);

    expect(merged).toContain('상품 A');
    expect(merged).toContain('상품 B');
  });

  it('사라진 조각이 길면(진짜 내용) 버리지 않는다', () => {
    const dropped = Array.from(
      { length: 4 },
      (_, i) => `사라진 항목 ${i + 1} — 실제 본문이라 보존해야 하는 충분히 긴 줄입니다`,
    ).join('\n');
    const pass1 = HEADER + PAGE1 + '\n' + dropped + FOOTER;
    const pass2 = HEADER + PAGE1 + '\n' + PAGE2 + FOOTER;

    const merged = appendWithOverlap(pass1, pass2);

    expect(merged).toContain('사라진 항목 1');
    expect(merged).toContain('quote 20 —');
  });

  it('가상 스크롤로 앞부분이 사라지면 겹치는 지점부터 이어 붙인다', () => {
    const acc = HEADER + PAGE1;
    const snapshot = PAGE1.slice(-200) + '\n' + PAGE2;

    const merged = appendWithOverlap(acc, snapshot);

    expect(merged.startsWith(acc)).toBe(true);
    expect(merged).toContain('quote 20 —');
    expect(merged).not.toContain('\n---\n');
  });

  it('가상 스크롤 + 고정 헤더/푸터에서 아직 살아 있는 항목을 중복시키지 않는다', () => {
    // 헤더·푸터가 있어 2)의 접미-접두 겹침은 빗나가고 3)으로 넘어오는 모양.
    const older = Array.from(
      { length: 10 },
      (_, i) => `quote ${i + 1} — a fairly long line of text`,
    ).join('\n');
    const shared = Array.from(
      { length: 10 },
      (_, i) => `quote ${i + 11} — a fairly long line of text`,
    ).join('\n');
    const fresh = Array.from(
      { length: 10 },
      (_, i) => `quote ${i + 21} — a fairly long line of text`,
    ).join('\n');

    const pass1 = HEADER + older + '\n' + shared + FOOTER;
    const pass2 = HEADER + shared + '\n' + fresh + FOOTER; // 앞 10개가 언로드된 스냅샷

    const merged = appendWithOverlap(pass1, pass2);

    expect(merged).toContain('quote 1 —');
    expect(merged).toContain('quote 30 —');
    expect(merged.split('quote 11 —').length - 1).toBe(1);
    expect(merged.split(HEADER).length - 1).toBe(1);
  });

  it('전혀 겹치지 않으면 구분자와 함께 통째로 붙인다 (내용 손실 금지)', () => {
    const merged = appendWithOverlap('완전히 다른 이전 내용입니다', '전혀 관계없는 새 내용');
    expect(merged).toContain('\n---\n');
    expect(merged).toContain('완전히 다른 이전 내용입니다');
    expect(merged).toContain('전혀 관계없는 새 내용');
  });

  it('같은 스냅샷이 반복되면 그대로 둔다', () => {
    const acc = HEADER + PAGE1 + FOOTER;
    expect(appendWithOverlap(acc, acc)).toBe(acc);
  });
});
