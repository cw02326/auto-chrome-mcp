/**
 * auto-chrome-mcp fork — 회귀 케이스 #5: "Chrome 144+ 에서 unload deprecation 경고 무발생".
 *
 * Chrome 은 `unload` 이벤트를 단계적으로 폐기하고 있고(Permissions-Policy 로 차단 가능),
 * 콘텐츠 스크립트가 `unload` 리스너를 달면 대상 페이지에 경고가 찍힌다. 우리 코드는
 * `pagehide` 로 정리한다.
 *
 * 런타임에서 "경고가 안 떴다" 를 증명하려면 실제 Chrome 144 가 필요하다. 대신 원인을
 * 소스 수준에서 고정한다 — `unload` 리스너가 다시 들어오면 여기서 막힌다.
 * (`beforeunload` 는 폐기 대상이 아니므로 허용한다.)
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['entrypoints', 'utils', 'inject-scripts'];
const EXTENSIONS = new Set(['.ts', '.js', '.vue']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.output') continue;
      collectSourceFiles(full, out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** `unload` 만 잡고 `beforeunload` 는 지나간다. */
const UNLOAD_LISTENER = /addEventListener\(\s*['"`]unload['"`]|\bon(?:unload)\s*=/;

describe('회귀 #5 — Chrome 144+ unload 폐기 대응', () => {
  const files = ROOTS.flatMap((r) => collectSourceFiles(path.resolve(process.cwd(), r)));

  it('스캔 대상 소스가 실제로 존재한다 (스캔이 비어서 통과하는 것을 막는다)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('폐기된 unload 리스너를 달지 않는다', () => {
    const offenders = files
      .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
      .filter(({ text }) => UNLOAD_LISTENER.test(text))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(offenders, `unload 리스너 발견: ${offenders.join(', ')}`).toEqual([]);
  });

  it('페이지에 주입되는 스크립트는 pagehide 로 정리한다', () => {
    const withPagehide = files.filter((file) =>
      fs.readFileSync(file, 'utf8').includes("addEventListener('pagehide'"),
    );
    expect(withPagehide.length).toBeGreaterThan(0);
  });
});
