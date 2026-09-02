import { describe, expect, test, beforeAll } from '@jest/globals';
import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * auto-chrome-mcp fork — 회귀 케이스 #3·#4·#7 을 **실제 프로세스**로 검증한다.
 *
 * #3 Cursor 연결 / #4 Claude Desktop 연결
 *   두 클라이언트가 하는 일은 결국 같다 — stdio 로 프로세스를 띄우고 `initialize` 뒤
 *   `tools/list` 를 부른다. 그 왕복을 직접 흉내 내 프로토콜 계약을 고정한다.
 *   (특정 앱의 UI 동작까지 보증하지는 않는다. 앱별 확인은 여전히 Self-Test 몫이다.)
 *   브라우저가 없어도 성립한다 — tools/list 는 stdio 프록시가 로컬에서 답한다.
 *
 * #7 STDIO 모드에서 부모가 죽으면 bridge 도 따라 죽는다 (orphan 0)
 *   두 갈래를 본다: 클라이언트가 stdin 을 정상적으로 닫는 경로와, 부모가 SIGKILL 로
 *   갑자기 사라지는 경로(파이프 끊김 → 안 되면 부모 PID 워치독이 백업).
 *
 * dist 가 있어야 한다(`pnpm build`). CI 는 빌드 뒤 테스트를 돌린다.
 */

const DIST_ENTRY = path.resolve(__dirname, '../../dist/mcp/mcp-server-stdio.js');
/** 살아있는 bridge 가 없어야 결정론적이다 — 아무도 안 쓰는 포트를 준다. */
const DEAD_PORT = '59999';

interface JsonRpcMessage {
  id?: number | string;
  result?: any;
  error?: any;
  method?: string;
}

/** stdout 으로 흘러오는 줄 단위 JSON-RPC 를 모아 id 로 기다린다. */
class StdioClient {
  private buffer = '';
  private readonly messages: JsonRpcMessage[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          this.messages.push(JSON.parse(line));
        } catch {
          // 로그가 stdout 으로 새면 무시한다 (정상 로그는 stderr 로 간다).
        }
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async waitFor(id: number, timeoutMs = 15000): Promise<JsonRpcMessage> {
    const startedAt = Date.now();
    for (;;) {
      const hit = this.messages.find((m) => m.id === id);
      if (hit) return hit;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`id=${id} 응답을 ${timeoutMs}ms 안에 못 받았습니다`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const spawnStdioServer = (): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, [DIST_ENTRY], {
    env: { ...process.env, CHROME_PORT: DEAD_PORT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('mcp-server-stdio — 실제 프로세스 계약 (회귀 #3·#4·#7)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(`빌드 산출물이 없습니다: ${DIST_ENTRY} — 먼저 \`pnpm build\` 를 돌리세요`);
    }
  });

  test('#3·#4 — initialize 후 tools/list 가 도구 목록을 돌려준다', async () => {
    const child = spawnStdioServer();
    const client = new StdioClient(child);
    try {
      client.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'regression-test-client', version: '0.0.0' },
        },
      });
      const initialized = await client.waitFor(1);
      expect(initialized.error).toBeUndefined();
      expect(initialized.result?.serverInfo?.name).toBeTruthy();

      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

      const listed = await client.waitFor(2);
      expect(listed.error).toBeUndefined();
      const names: string[] = (listed.result?.tools ?? []).map((t: any) => t.name);

      // 확장 도구와 stdio 로컬 도구가 함께 광고돼야 한다.
      expect(names).toContain('chrome_navigate');
      expect(names).toContain('chrome_scroll_collect');
      expect(names).toContain('chrome_list_browsers');
      expect(names).toContain('chrome_use_browser');
      expect(names.length).toBeGreaterThan(30);
    } finally {
      child.kill();
    }
  }, 30000);

  test('#7 — stdin 이 닫히면 스스로 종료한다', async () => {
    const child = spawnStdioServer();
    // 프로세스가 자리를 잡을 시간을 준다.
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull();

    child.stdin.end();

    const exited = await waitForExit(child, 10000);
    if (!exited) child.kill('SIGKILL');
    expect(exited).toBe(true);
  }, 30000);

  test('#7 — 부모(클라이언트)가 갑자기 죽으면 고아를 남기지 않는다', async () => {
    // Claude Code 가 SIGKILL 로 사라지는 상황을 흉내 낸다. 자식에게는 부모의 파이프를
    // 물려준다 — 이게 실제 배치다(stdin 을 'ignore' 로 주면 즉시 EOF 라 시작하자마자 죽는다).
    const wrapperSource = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [${JSON.stringify(DIST_ENTRY)}], {
        env: { ...process.env, CHROME_PORT: '${DEAD_PORT}' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      process.stdout.write(String(child.pid));
      // 부모가 살아 있는 동안 stdin 을 열어 둔다.
      setInterval(() => {}, 1000);
    `;
    const wrapper = spawn(process.execPath, ['-e', wrapperSource], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const orphanPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('자식 pid 를 못 받았습니다')), 10000);
      wrapper.stdout.setEncoding('utf8');
      wrapper.stdout.on('data', (chunk: string) => {
        clearTimeout(timer);
        resolve(Number(chunk.trim()));
      });
    });

    expect(Number.isInteger(orphanPid)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    // 부모가 살아 있는 동안에는 자식도 살아 있어야 한다 — 아니면 이 테스트는 아무것도 증명 못 한다.
    expect(isAlive(orphanPid)).toBe(true);

    const wrapperExited = waitForExit(wrapper, 10000);
    wrapper.kill('SIGKILL');
    await wrapperExited; // 핸들을 남기지 않는다 (jest 가 못 끝난다)

    // 파이프가 끊기면 즉시, 그게 안 되면 부모 PID 워치독(10초 간격)이 정리한다.
    const deadline = Date.now() + 40000;
    let stillAlive = true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (!isAlive(orphanPid)) {
        stillAlive = false;
        break;
      }
    }

    if (stillAlive) {
      try {
        process.kill(orphanPid, 'SIGKILL');
      } catch {
        /* 이미 죽었으면 무시 */
      }
    }
    expect(stillAlive).toBe(false);
  }, 60000);
});
