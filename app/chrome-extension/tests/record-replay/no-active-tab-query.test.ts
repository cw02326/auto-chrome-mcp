/**
 * no-active-tab-query.test.ts
 *
 * Source guard for the record-replay (V2) execution engine.
 *
 * Invariant:
 *   The engine must only ever touch the tab that the run context designates
 *   (RunTabContext.tabId). It must never look up "whatever tab the user is
 *   currently looking at". A flow launched without a work tab therefore cannot
 *   reach into the user's browsing session.
 *
 * What is scanned:
 *   Every .ts file under entrypoints/background/record-replay/. The V3 kernel
 *   used to live in a sibling directory, record-replay-v3/; it was deleted on
 *   2026-09-06 (stage 3 dead-code removal). The guard below keeps the scan
 *   anchored to this one tree so a future sibling cannot slip in unscanned.
 *
 * What counts as a violation:
 *   1. chrome.tabs.query(...) whose argument mentions active / currentWindow /
 *      lastFocusedWindow. That is an active-tab lookup.
 *   2. chrome.tabs.query(...) of any other shape (a full tab scan) that is not
 *      annotated with a `tab-scan-ok:` marker comment stating why enumerating
 *      every tab is legitimate there.
 *   3. A call to a helper literally named getActiveTab().
 *   4. chrome.tabs.create(...) without a `tab-create-ok:` marker comment. Opening
 *      a tab is how the engine gets a work surface of its own instead of
 *      borrowing the user's; each site has to say so in writing, so a stray
 *      "just open a tab here" cannot slip in unreviewed
 *      (2026-09-05 Codex review, item 2).
 *
 * The single allowed exception is the entry-point module engine/tab-context.ts:
 *   that is where a user-initiated launch (side panel Run button, context menu,
 *   keyboard command) resolves the tab exactly once, before the engine starts.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// vitest runs with the extension package root as cwd (see vitest.config.ts).
const EXT_ROOT = process.cwd();
const ENGINE_ROOT = join(EXT_ROOT, 'entrypoints', 'background', 'record-replay');

/** The one module allowed to resolve a tab from the user's window. */
const ENTRY_POINT_ALLOWLIST = ['engine/tab-context.ts'];

/** Markers that make a chrome.tabs.query an active-tab lookup. */
const ACTIVE_TAB_MARKERS = ['active', 'currentWindow', 'lastFocusedWindow'];

/** Comment marker that documents an intentional full-tab enumeration. */
const SCAN_OK_MARKER = 'tab-scan-ok';

/** Comment marker that documents an intentional chrome.tabs.create. */
const CREATE_OK_MARKER = 'tab-create-ok';

interface Violation {
  file: string;
  line: number;
  kind: 'active-tab-query' | 'unmarked-tab-scan' | 'get-active-tab' | 'unmarked-tab-create';
  snippet: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** Read the balanced argument text of a call starting at the given "(" index. */
function readCallArgs(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex + 1);
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

function hasMarker(lines: string[], lineNumber: number, marker: string): boolean {
  const from = Math.max(0, lineNumber - 4);
  return lines.slice(from, lineNumber).some((l) => l.includes(marker));
}

function scanFile(absPath: string): Violation[] {
  const rel = relative(ENGINE_ROOT, absPath).split(sep).join('/');
  if (ENTRY_POINT_ALLOWLIST.includes(rel)) return [];

  const source = readFileSync(absPath, 'utf8');
  const lines = source.split('\n');
  const violations: Violation[] = [];

  const queryPattern = /chrome\s*\.\s*tabs\s*\.\s*query\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = queryPattern.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const args = readCallArgs(source, openParen);
    const line = lineNumberAt(source, m.index);
    const snippet = args.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (ACTIVE_TAB_MARKERS.some((marker) => args.includes(marker))) {
      violations.push({
        file: rel,
        line,
        kind: 'active-tab-query',
        snippet: `chrome.tabs.query(${snippet})`,
      });
    } else if (!hasMarker(lines, line, SCAN_OK_MARKER)) {
      violations.push({
        file: rel,
        line,
        kind: 'unmarked-tab-scan',
        snippet: `chrome.tabs.query(${snippet})`,
      });
    }
  }

  // Opening a tab is allowed, but only where the file says why: the run needs a
  // surface of its own instead of borrowing the user's (2026-09-05 review, item 2).
  const createPattern = /chrome\s*\.\s*tabs\s*\.\s*create\s*\(/g;
  while ((m = createPattern.exec(source)) !== null) {
    const line = lineNumberAt(source, m.index);
    if (hasMarker(lines, line, CREATE_OK_MARKER)) continue;
    violations.push({
      file: rel,
      line,
      kind: 'unmarked-tab-create',
      snippet: 'chrome.tabs.create(',
    });
  }

  const getActivePattern = /\bgetActiveTab\s*\(/g;
  while ((m = getActivePattern.exec(source)) !== null) {
    violations.push({
      file: rel,
      line: lineNumberAt(source, m.index),
      kind: 'get-active-tab',
      snippet: 'getActiveTab(',
    });
  }

  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.snippet}`).join('\n');
}

describe('record-replay engine never queries the user active tab', () => {
  const files = listTsFiles(ENGINE_ROOT);

  it('scans the whole V2 engine tree', () => {
    expect(files.length).toBeGreaterThan(50);
    // 삭제됨(2026-09-06, 3단계): record-replay-v3 는 이제 없다. 되살아나더라도 이 스캔에
    // 섞이면 안 되므로 확인은 남긴다.
    expect(files.some((f) => f.includes(`record-replay-v3${sep}`))).toBe(false);
  });

  it('has zero active-tab lookups outside the single entry point', () => {
    const violations = files.flatMap(scanFile);
    const message =
      violations.length === 0
        ? ''
        : `Found ${violations.length} forbidden tab lookup(s) in record-replay/:\n${formatViolations(
            violations,
          )}\n\nUse the run tab from RunTabContext (resolveRunTab(ctx)) instead. ` +
          `Only engine/tab-context.ts may resolve a tab from the user's window, ` +
          `and only at a user-initiated entry point. A deliberate chrome.tabs.create ` +
          `needs a "${CREATE_OK_MARKER}:" comment saying why the run opens its own tab.`;
    expect(violations, message).toEqual([]);
  });

  it('keeps the entry-point allowlist down to one module', () => {
    expect(ENTRY_POINT_ALLOWLIST).toEqual(['engine/tab-context.ts']);
  });
});
