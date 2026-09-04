import { describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

/**
 * auto-chrome-mcp fork — 네이티브 호스트 래퍼가 argv 를 그대로 넘기는지 고정한다.
 *
 * Chrome 은 native messaging host 를 띄울 때 호출자 origin(`chrome-extension://<id>/`)과
 * `--parent-window=<handle>` 을 인자로 준다. 래퍼가 그 인자를 버리면 브리지의
 * `collectExtensionOriginsFromArgv` 는 늘 빈 목록을 받고, 로그·doctor 에 "어느 확장이
 * 띄웠는지"가 남지 않는다. (인증 판정에는 쓰지 않는다 — 토큰이 유일한 신원이다.)
 */
const scriptsDir = path.join(__dirname);
const read = (name: string) => fs.readFileSync(path.join(scriptsDir, name), 'utf8');

describe('run_host 래퍼 argv 전달', () => {
  test('run_host.bat 은 %* 로 인자를 넘긴다', () => {
    const bat = read('run_host.bat');
    const invocation = bat
      .split(/\r?\n/)
      .filter((line) => /^\s*call\s+"%NODE_EXEC%"\s+"%NODE_SCRIPT%"/.test(line));
    expect(invocation).toHaveLength(1);
    expect(invocation[0]).toContain('%*');
  });

  test('run_host.sh 은 "$@" 로 인자를 넘긴다', () => {
    const sh = read('run_host.sh');
    const invocation = sh
      .split(/\r?\n/)
      .filter((line) => /^\s*exec\s+"\$\{NODE_EXEC\}"/.test(line));
    expect(invocation).toHaveLength(1);
    expect(invocation[0]).toContain('"$@"');
  });
});
