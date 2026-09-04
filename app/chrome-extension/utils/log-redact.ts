/**
 * 도구 인자 로그 마스킹 (auto-chrome-mcp fork).
 *
 * 배경 (2026-09-04 Codex 최종 검토 항목 2): 여러 도구가 진입점에서 `console.log(..., args)` 로
 * 인자를 통째로 찍었다. chrome_shortcut 의 `secret` 파라미터는 응답에서는 가려지지만
 * (`shortcut.ts` maskSecrets), 치환된 값이 하위 도구 인자로 들어가면서 확장 서비스워커
 * 콘솔에는 평문으로 남았다 — `chrome_fill_or_select.value`(비밀번호),
 * `chrome_keyboard.keys`, `chrome_network_request.body/headers`(토큰),
 * `chrome_javascript.code` 가 대표적이다.
 *
 * 규칙: **allowlist 만 남긴다.** 목록에 없는 키는 값 대신 종류·길이만 남긴다.
 * 진단에 필요한 것(어느 탭·어느 선택자·어떤 동작)은 그대로 보이고, 값 자체는 안 남는다.
 */

/**
 * 값을 그대로 로그에 남겨도 되는 키.
 *
 * 판단 기준: 페이지에서 온 식별자·좌표·모드처럼 그 자체로 비밀이 될 수 없는 것만.
 * 사람이 입력하는 값(`value`·`keys`·`text`), 실행 코드(`code`·`script`·`expression`),
 * 네트워크 본문(`body`·`headers`·`data`·`json`), 파일 경로는 절대 넣지 않는다.
 */
const LOGGABLE_ARG_KEYS: ReadonlySet<string> = new Set([
  'action',
  'all',
  'allFrames',
  'background',
  'button',
  'clickCount',
  'coordinate',
  'delay',
  'enabled',
  'frameId',
  'index',
  'kind',
  'lane',
  'maxResults',
  'method',
  'mode',
  'persist',
  'ref',
  'refresh',
  'runAt',
  'selector',
  'tabId',
  'tabIds',
  'timeout',
  'timeoutMs',
  'tool',
  'uid',
  'waitTimeoutMs',
  'windowId',
  'world',
  'xpath',
]);

/** allowlist 이지만 값 안에 비밀이 섞일 수 있어 잘라 쓰는 키. */
const TRIMMED_URL_KEYS: ReadonlySet<string> = new Set(['url']);

/**
 * 쿼리·해시를 떼고 origin + 경로만 남긴다 (토큰이 쿼리로 오는 경우가 흔하다).
 *
 * 2026-09-05 Codex 재확인 1: 진입부 로그만 `redactedArgsForLog` 로 가려 놓고,
 * 그 뒤 "어느 탭을 찾는다 / 새 탭을 만든다" 같은 후속 로그가 같은 URL 을 원문으로
 * 다시 찍고 있었다. 후속 로그는 인자 객체가 아니라 URL 문자열 하나만 들고 있으므로
 * 이 함수를 그대로 부른다.
 */
export function redactUrlForLog(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '[redacted:url]';
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[redacted:url]';
  }
}

function describeRedacted(value: unknown): string {
  if (value === null) return '[redacted:null]';
  if (typeof value === 'string') return `[redacted:string(${value.length})]`;
  if (Array.isArray(value)) return `[redacted:array(${value.length})]`;
  return `[redacted:${typeof value}]`;
}

/**
 * 로그에 남겨도 되는 인자 사본을 만든다. 원본은 건드리지 않는다.
 * 최상위 own 키만 본다 — 중첩 값은 통째로 가린다(중첩 안에 비밀이 있는 경우가 많다).
 */
export function redactedArgsForLog(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args as Record<string, unknown>)) {
    const value = (args as Record<string, unknown>)[key];
    if (TRIMMED_URL_KEYS.has(key)) {
      out[key] = redactUrlForLog(value);
      continue;
    }
    if (!LOGGABLE_ARG_KEYS.has(key)) {
      out[key] = describeRedacted(value);
      continue;
    }
    if (value === null || typeof value !== 'object') {
      out[key] = value;
      continue;
    }
    // allowlist 키라도 객체·배열이면 형태만 남긴다 (tabIds 배열 등).
    out[key] =
      Array.isArray(value) && value.every((item) => typeof item === 'number')
        ? value
        : describeRedacted(value);
  }
  return out;
}
