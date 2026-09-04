import { describe, expect, test, beforeAll, afterAll, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * auto-chrome-mcp fork — 업로드 임시 파일 경로 회귀 테스트 (Codex 지적 F5 + 독립 검증 4).
 *
 * ① 예전에는 `path.join(this.tempDir, fileName)` 을 검증 없이 썼다. 그래서 fileName 이
 *    `../../pwned.txt` 면 temp 디렉터리 밖 아무 곳에나 파일을 썼다. cleanupFile 의
 *    `startsWith(tempDir)` 검사도 `chrome-mcp-uploads-evil` 같은 형제 경로를 통과시켰다.
 * ② 그 뒤에도 업로드 디렉터리가 공유 tmp 의 고정 이름(`/tmp/chrome-mcp-uploads`)이었다.
 *    같은 머신의 다른 사용자가 그 경로를 먼저 만들어 파일명을 symlink 로 심어 두면,
 *    `writeFileSync` 가 링크를 따라가 링크 대상(예: 남의 홈, 시스템 파일)을 덮어썼다.
 *    이제 디렉터리는 사용자 전용 상태 디렉터리 아래이고, 파일은 `openSync(..., 'wx')` 로만
 *    만들며 symlink 는 쓰기 전에 거부한다.
 */
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-upload-test-'));

let FileHandlerClass: typeof import('./file-handler').FileHandler;
let handler: import('./file-handler').FileHandler;
let tempDir: string;
let escapeTarget: string;
let siblingDir: string;

const base64 = Buffer.from('payload').toString('base64');

const cleanup = (target: string) => {
  try {
    if (fs.lstatSync(target)) fs.unlinkSync(target);
  } catch {
    /* 없으면 정리할 것도 없다 */
  }
};

beforeAll(async () => {
  process.env.AUTO_CHROME_MCP_HOME = path.join(stateRoot, '.auto-chrome-mcp');
  FileHandlerClass = (await import('./file-handler')).FileHandler;
  handler = new FileHandlerClass();

  // 첫 저장으로 디렉터리를 실제로 만들게 하고 그 경로를 기준으로 삼는다.
  const probe = await handler.handleFileRequest({
    action: 'prepareFile',
    base64Data: base64,
    fileName: 'acm-probe.txt',
  });
  expect(probe.success).toBe(true);
  tempDir = handler.tempDirectory;
  fs.unlinkSync(probe.filePath);

  escapeTarget = path.resolve(tempDir, '..', '..', 'acm-f5-escape-probe.txt');
  siblingDir = `${tempDir}-evil`;
});

afterAll(() => {
  delete process.env.AUTO_CHROME_MCP_HOME;
  try {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
});

afterEach(() => {
  cleanup(escapeTarget);
});

describe('FileHandler 임시 경로 경계', () => {
  test('업로드 디렉터리는 공유 tmp 의 고정 이름이 아니다', () => {
    expect(tempDir).not.toBe(path.join(os.tmpdir(), 'chrome-mcp-uploads'));
    expect(path.resolve(tempDir).startsWith(path.resolve(stateRoot))).toBe(true);
  });

  test('상위 디렉터리로 탈출하는 fileName 은 거부되고 파일도 안 생긴다', async () => {
    const escaping = path.join('..', '..', 'acm-f5-escape-probe.txt');

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64,
      fileName: escaping,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/fileName/i);
    expect(fs.existsSync(escapeTarget)).toBe(false);
  });

  test('경로 구분자·점 이름·빈 이름은 모두 거부된다', async () => {
    const nullByteName = `a${String.fromCharCode(0)}b.txt`;
    for (const fileName of ['sub/dir.txt', '..', '.', '   ', nullByteName]) {
      const result = await handler.handleFileRequest({
        action: 'prepareFile',
        base64Data: base64,
        fileName,
      });
      expect(result.success).toBe(false);
    }
  });

  test('절대 경로 fileName 도 거부된다', async () => {
    const absolute = path.join(os.tmpdir(), 'acm-f5-absolute-probe.txt');

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64,
      fileName: absolute,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(absolute)).toBe(false);
  });

  test('평범한 파일명은 이름 그대로 업로드 디렉터리 안에 저장된다', async () => {
    const fileName = `acm-f5-ok-${Date.now()}.txt`;

    const saved = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64,
      fileName,
    });

    expect(saved.success).toBe(true);
    // 슬롯 디렉터리 한 겹이 생기지만 파일명은 그대로다 (업로드 폼에 보이는 이름).
    expect(path.basename(saved.filePath)).toBe(fileName);
    expect(saved.fileName).toBe(fileName);
    expect(path.dirname(path.dirname(saved.filePath))).toBe(path.resolve(tempDir));
    expect(fs.readFileSync(saved.filePath, 'utf8')).toBe('payload');

    const cleaned = await handler.handleFileRequest({
      action: 'cleanupFile',
      filePath: saved.filePath,
    });
    expect(cleaned.success).toBe(true);
    expect(fs.existsSync(saved.filePath)).toBe(false);
  });

  test('미리 심어 둔 symlink 는 건드리지 않는다', () => {
    const fileName = 'acm-symlink-probe.txt';
    const linkPath = path.join(tempDir, fileName);
    const linkTarget = path.join(stateRoot, 'acm-symlink-victim.txt');
    fs.writeFileSync(linkTarget, 'victim');

    let created = false;
    try {
      fs.symlinkSync(linkTarget, linkPath, 'file');
      created = true;
    } catch {
      // 윈도우에서 symlink 생성은 개발자 모드/관리자 권한이 필요하다. 못 만들면 이 검사는 생략.
    }
    if (!created) {
      return;
    }

    return handler
      .handleFileRequest({ action: 'prepareFile', base64Data: base64, fileName })
      .then((result: any) => {
        // 새 슬롯 디렉터리에 쓰므로 심어 둔 링크는 아예 경로에 걸리지 않는다.
        expect(result.success).toBe(true);
        expect(path.resolve(result.filePath)).not.toBe(path.resolve(linkPath));
        // 링크 대상은 손대지 않았다.
        expect(fs.readFileSync(linkTarget, 'utf8')).toBe('victim');
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      })
      .finally(() => {
        cleanup(linkPath);
        cleanup(linkTarget);
      });
  });

  test('같은 이름의 디렉터리가 자리에 있어도 지우지 않는다', async () => {
    const fileName = 'acm-notafile-probe.txt';
    const target = path.join(tempDir, fileName);
    fs.mkdirSync(target);

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64,
      fileName,
    });

    expect(result.success).toBe(true);
    expect(path.resolve(result.filePath)).not.toBe(path.resolve(target));
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    fs.rmdirSync(target);
  });

  test('같은 이름의 기존 파일을 덮어쓰지 않고 새 슬롯에 만든다', async () => {
    const fileName = 'acm-existing-probe.txt';
    const stale = path.join(tempDir, fileName);
    fs.writeFileSync(stale, 'stale');

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64,
      fileName,
    });

    expect(result.success).toBe(true);
    expect(path.resolve(result.filePath)).not.toBe(path.resolve(stale));
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('payload');
    expect(fs.readFileSync(stale, 'utf8')).toBe('stale');
    cleanup(stale);
  });

  // ============================================================
  // 같은 파일명 병렬 업로드 (Codex 2차 지적 3)
  //
  // 네이티브 호스트는 들어온 메시지를 await 하지 않고 처리한다. 그래서 같은 fileName 으로
  // 두 건이 겹치면 다운로드·디코딩의 await 지점에서 서로 끼어들었고, 먼저 끝난 쪽이
  // 돌려받은 경로에는 나중 쪽의 내용이 들어 있었다 (확장의 기본 fileName 은
  // 'uploaded-file' 고정이라 실제로 잘 겹친다).
  // ============================================================

  test('같은 이름으로 동시에 들어온 2건이 서로의 파일을 덮어쓰지 않는다', async () => {
    const first = Buffer.from('AAAA-first').toString('base64');
    const second = Buffer.from('BBBB-second').toString('base64');

    const [a, b] = await Promise.all([
      handler.handleFileRequest({
        action: 'prepareFile',
        base64Data: first,
        fileName: 'uploaded-file',
      }),
      handler.handleFileRequest({
        action: 'prepareFile',
        base64Data: second,
        fileName: 'uploaded-file',
      }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.filePath).not.toBe(b.filePath);
    // 각 호출이 받은 경로에는 자기 데이터가 있다.
    expect(fs.readFileSync(a.filePath, 'utf8')).toBe('AAAA-first');
    expect(fs.readFileSync(b.filePath, 'utf8')).toBe('BBBB-second');
    // 페이지에 보이는 파일명은 그대로 유지된다.
    expect(path.basename(a.filePath)).toBe('uploaded-file');
    expect(path.basename(b.filePath)).toBe('uploaded-file');

    for (const result of [a, b]) {
      const cleaned = await handler.handleFileRequest({
        action: 'cleanupFile',
        filePath: result.filePath,
      });
      expect(cleaned.success).toBe(true);
      expect(fs.existsSync(result.filePath)).toBe(false);
      // 빈 슬롯 디렉터리도 같이 치운다.
      expect(fs.existsSync(path.dirname(result.filePath))).toBe(false);
    }
  });

  test('cleanupFile 은 업로드 디렉터리 이름을 접두어로 공유하는 형제 경로를 거부한다', async () => {
    const sibling = path.join(siblingDir, 'victim.txt');

    // 예전 구현: startsWith(tempDir) 가 true 라서 통과했다.
    expect(sibling.startsWith(tempDir)).toBe(true);

    const result = await handler.handleFileRequest({
      action: 'cleanupFile',
      filePath: sibling,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/temp directory/i);
  });

  test('cleanupFile 은 업로드 디렉터리 밖 절대 경로를 거부한다', async () => {
    const result = await handler.handleFileRequest({
      action: 'cleanupFile',
      filePath: path.join(tempDir, '..', '..', 'etc-passwd-probe'),
    });
    expect(result.success).toBe(false);
  });
});
