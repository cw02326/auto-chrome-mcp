import {
  describe,
  expect,
  test,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  jest,
} from '@jest/globals';
import supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getStaleExtensionReport, resetStaleExtensionReport } from './auth-guard';

/**
 * auto-chrome-mcp fork — 로컬 HTTP 브리지 인증 회귀 테스트 (Codex 지적 F1).
 *
 * 예전에는 `/mcp` 와 `/admin/*` 에 인증이 전혀 없었다. CORS 는 응답 읽기만 막고 요청
 * 실행은 못 막으므로, 아무 웹페이지나 다음 한 방으로 남의 브리지를 죽일 수 있었다:
 *   fetch('http://127.0.0.1:12320/admin/kill-self', { method: 'POST' })
 * 게다가 CORS 검사가 startsWith('http://127.0.0.1') 라서
 * `http://127.0.0.1.attacker.example` 같은 원격 origin 도 로컬로 취급됐다.
 *
 * 이제 보호 경로는 예외 없이 토큰 파일과 일치하는 Bearer 토큰을 요구한다. 확장도
 * 브리지가 SERVER_STARTED 로 넘겨준 토큰을 붙여야 한다 (확장 origin 예외는 제거됐다 —
 * 브라우저 밖의 프로세스는 Origin 헤더를 아무 값으로나 붙일 수 있다).
 * Origin 헤더가 있으면 허용 목록(loopback / 확장) 안이어야 하고, Host 는 언제나
 * loopback 이름이어야 한다. /ping, /health 만 토큰 없이 열린다.
 */
const TOKEN = 'a'.repeat(64);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-server-auth-'));
const stateDir = path.join(tempRoot, '.auto-chrome-mcp');

let ServerInstance: any;
let exitSpy: any;

const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(async () => {
  process.env.AUTO_CHROME_MCP_HOME = stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'auth-token'), `${TOKEN}\n`);

  ServerInstance = (await import('./index')).default;
  await ServerInstance.getInstance().ready();
});

afterAll(async () => {
  await ServerInstance.getInstance().close();
  delete process.env.AUTO_CHROME_MCP_HOME;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
});

beforeEach(() => {
  // /admin/* 은 통과하면 다음 tick 에 process.exit(0) 한다. 러너가 죽지 않게 가로챈다.
  exitSpy = jest
    .spyOn(process, 'exit')
    .mockImplementation(((_code?: number) => undefined) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
});

const agent = () => supertest(ServerInstance.getInstance().server);

describe('브리지 HTTP 인증 (auto-chrome-mcp fork)', () => {
  test('GET /ping 은 공개다 (확장 heartbeat)', async () => {
    const res = await agent().get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', message: 'pong' });
  });

  test('GET /health 는 공개지만 인증 없이는 상세를 주지 않는다', async () => {
    const res = await agent().get('/health');

    // 살아 있는지는 여전히 토큰 없이 확인된다 (Force Reconnect 의 probe 가 이걸 쓴다).
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.fork).toBe('auto-chrome-mcp');
    // 예전에는 여기서 pid·node 버전·메모리·transport 수가 그대로 나왔다.
    expect(res.body.bridge).toBeUndefined();
    expect(res.body.transports).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(process.version);
  });

  test('토큰을 붙이면 GET /health 가 상세를 준다 (확장 팝업 진단·강제 재연결)', async () => {
    const res = await agent().get('/health').set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.bridge.pid).toBe(process.pid);
    expect(res.body.bridge.node).toBe(process.version);
    expect(typeof res.body.transports.active_count).toBe('number');
  });

  test('틀린 토큰으로는 /health 상세가 나오지 않는다', async () => {
    const res = await agent()
      .get('/health')
      .set('Authorization', `Bearer ${'b'.repeat(64)}`);

    expect(res.status).toBe(200);
    expect(res.body.bridge).toBeUndefined();
  });

  test('토큰 없이 말을 거는 확장 origin 은 "확장 버전 낮음" 신호로 기록된다', async () => {
    resetStaleExtensionReport();
    expect(getStaleExtensionReport().rejections).toBe(0);

    const extensionOrigin = 'chrome-extension://aogfhfajjknomcnmlkbjmihjbknlhbbi';
    const res = await agent().post('/mcp').set('Origin', extensionOrigin);
    expect(res.status).toBe(401);

    const report = getStaleExtensionReport();
    expect(report.rejections).toBe(1);
    expect(report.lastOrigin).toBe(extensionOrigin);
    expect(report.lastAt).toBeGreaterThan(0);

    // 토큰이 있는 확장 요청은 신호로 세지 않는다.
    await agent()
      .get('/health')
      .set('Origin', extensionOrigin)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(getStaleExtensionReport().rejections).toBe(1);

    // doctor 가 읽어갈 자리에도 같은 값이 실린다.
    const health = await agent().get('/health').set('Authorization', `Bearer ${TOKEN}`);
    expect(health.body.extension_auth.stale_client_rejections).toBe(1);
    resetStaleExtensionReport();
  });

  test('토큰 없는 POST /admin/kill-self 는 401 이고 프로세스를 죽이지 못한다', async () => {
    const res = await agent().post('/admin/kill-self');
    await flushImmediate();

    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('unauthorized');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('토큰 없는 POST /admin/drain 도 401 이다', async () => {
    const res = await agent().post('/admin/drain');
    await flushImmediate();

    expect(res.status).toBe(401);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('loopback prefix 를 흉내낸 원격 origin 은 403 이다 (startsWith 회귀)', async () => {
    const res = await agent()
      .post('/admin/kill-self')
      .set('Origin', 'http://127.0.0.1.attacker.example');
    await flushImmediate();

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('bad_origin');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('원격 웹페이지 origin 은 토큰을 들고 와도 403 이다', async () => {
    const res = await agent()
      .post('/admin/kill-self')
      .set('Origin', 'https://evil.example')
      .set('Authorization', `Bearer ${TOKEN}`);
    await flushImmediate();

    expect(res.status).toBe(403);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('토큰 없는 POST /mcp initialize 는 401 이다 (세션이 생기지 않는다)', async () => {
    const res = await agent()
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'attacker', version: '1.0.0' },
        },
      });

    expect(res.status).toBe(401);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  test('틀린 토큰도 401 이다', async () => {
    const res = await agent()
      .post('/admin/kill-self')
      .set('Authorization', `Bearer ${'b'.repeat(64)}`);
    await flushImmediate();

    expect(res.status).toBe(401);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('GET /ask-extension 도 토큰이 필요하다', async () => {
    const res = await agent().get('/ask-extension');
    expect(res.status).toBe(401);
  });

  test('토큰 파일과 일치하는 Bearer 토큰은 통과한다', async () => {
    const res = await agent().post('/admin/kill-self').set('Authorization', `Bearer ${TOKEN}`);
    await flushImmediate();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('killing');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('확장 origin 이라도 토큰이 없으면 401 이다', async () => {
    const res = await agent()
      .post('/admin/kill-self')
      .set('Origin', 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc');
    await flushImmediate();

    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('unauthorized');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('확장 origin + 토큰은 통과한다 (확장도 브리지가 준 토큰을 붙인다)', async () => {
    const res = await agent()
      .post('/admin/kill-self')
      .set('Origin', 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc')
      .set('Authorization', `Bearer ${TOKEN}`);
    await flushImmediate();

    expect(res.status).toBe(200);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('Host 가 loopback 이 아니면 공개 경로도 403 이다 (DNS rebinding)', async () => {
    const res = await agent().get('/ping').set('Host', 'attacker.example');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('bad_host');
  });

  test('Host 가 loopback 이 아니면 토큰이 있어도 403 이다', async () => {
    const res = await agent()
      .post('/admin/kill-self')
      .set('Host', 'attacker.example')
      .set('Authorization', `Bearer ${TOKEN}`);
    await flushImmediate();

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('bad_host');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('CORS preflight 는 인증 없이 지나간다', async () => {
    const res = await agent()
      .options('/mcp')
      .set('Origin', 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBeLessThan(400);
  });
});
