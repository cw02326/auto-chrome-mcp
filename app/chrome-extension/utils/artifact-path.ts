/**
 * auto-chrome-mcp fork: 확장이 저장하는 모든 산출물의 경로를 여기 한 곳에서 만든다.
 *
 * 왜 필요한가:
 *   스크린샷·GIF·PDF·트레이스가 저마다 다른 규칙으로 파일명을 만들어 사용자 다운로드 폴더
 *   **루트** 에 그대로 쌓였다(2026-09-02 기준 250여 개). 사용자가 받은 파일과 도구가 만든
 *   파일이 한 곳에 섞여 구분도 정리도 안 됐다.
 *
 * 규칙(2026-09-02 사용자 지시):
 *   `mcp-screenshots/YYYY-MM-DD/<kind>_<name>_<HHmmss>.<ext>`
 *   - 날짜·시각은 **로컬 시간**. 브리지의 자동 정리도 같은 로컬 날짜로 판정한다.
 *   - 크롬 다운로드 API 는 다운로드 폴더 기준 상대 경로에 하위 폴더를 허용한다.
 *   - `conflictAction: 'uniquify'` — 같은 초에 두 번 저장돼도 덮어쓰지 않는다.
 *
 * 경계:
 *   사용자가 `name` 에 경로 구분자를 넣어도 마지막 조각(basename)만 쓴다. `..` 도 한 조각일
 *   뿐이라 밖으로 나갈 수 없고, 허용 문자 밖은 밑줄로 바뀐다. 즉 어떤 입력이 와도 결과는
 *   항상 `mcp-screenshots/<날짜>/` 안이다.
 */

/** 산출물 루트 폴더 (다운로드 폴더 기준 상대 경로). 브리지의 정리 대상과 같은 이름이어야 한다. */
export const ARTIFACT_ROOT = 'mcp-screenshots';

/** 파일명 한 조각의 최대 길이 — 긴 페이지 제목이 그대로 들어오는 것을 막는다. */
export const ARTIFACT_NAME_MAX_LENGTH = 60;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 로컬 날짜 폴더명 `YYYY-MM-DD` */
export function artifactDateFolder(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 로컬 시각 접미사 `HHmmss` */
export function artifactTimeSuffix(now: Date = new Date()): string {
  return `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

/**
 * 파일명 한 조각을 안전하게 만든다.
 * 경로 구분자가 있으면 마지막 조각만 남기므로 상위 폴더로 나갈 수 없다.
 */
function sanitizeSegment(raw: string): string {
  const basename = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  return basename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/_{2,}/g, '_')
    .slice(0, ARTIFACT_NAME_MAX_LENGTH)
    .replace(/[._-]+$/, '');
}

function sanitizeExt(raw: string): string {
  const cleaned = raw
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  return cleaned || 'bin';
}

/**
 * 산출물 저장 경로를 만든다 — `mcp-screenshots/YYYY-MM-DD/<kind>_<name>_<HHmmss>.<ext>`
 *
 * @param kind  도구 종류 (screenshot, gif, pdf, trace ...)
 * @param name  사용자가 준 이름 (선택). 경로 구분자가 있어도 basename 만 쓴다.
 * @param ext   확장자 (점은 있어도 없어도 된다)
 * @param now   테스트용 시각 주입
 */
export function artifactFilename(
  kind: string,
  name?: string,
  ext = 'png',
  now: Date = new Date(),
): string {
  const safeKind = sanitizeSegment(kind) || 'artifact';
  const safeExt = sanitizeExt(ext);

  let safeName = sanitizeSegment(typeof name === 'string' ? name : '');
  // 이름에 확장자가 이미 붙어 있으면 떼어낸다 (`shot.gif` → `shot`)
  safeName = safeName.replace(new RegExp(`\\.${safeExt}$`, 'i'), '');
  // kind 와 같은 이름이면 두 번 쓰지 않는다 (`screenshot_screenshot_...` 방지)
  if (safeName.toLowerCase() === safeKind.toLowerCase()) safeName = '';

  const stem = [safeKind, safeName, artifactTimeSuffix(now)].filter(Boolean).join('_');
  return `${ARTIFACT_ROOT}/${artifactDateFolder(now)}/${stem}.${safeExt}`;
}

export interface ArtifactSaveResult {
  downloadId: number;
  /** 다운로드 폴더 기준 상대 경로 (요청한 값) */
  filename: string;
  /** 크롬이 실제로 쓴 절대 경로. 조회에 실패하면 없다. */
  fullPath?: string;
}

export interface ArtifactSaveOptions {
  /** data: 또는 blob: URL */
  url: string;
  kind: string;
  name?: string;
  ext: string;
  /** 절대 경로 조회 전 대기 시간(ms). 0 이면 조회하지 않는다. */
  resolvePathDelayMs?: number;
}

/**
 * 산출물을 다운로드 폴더의 날짜 폴더 아래에 저장한다.
 *
 * 확장 안에서 `chrome.downloads.download` 를 직접 부르는 곳은 여기 하나뿐이어야 한다
 * (tests/utils/artifact-download-paths.test.ts 가 그물로 막는다).
 * 실패는 그대로 던진다 — 저장 실패를 도구가 어떻게 다룰지는 호출부가 정한다.
 */
export async function saveArtifactToDownloads(
  options: ArtifactSaveOptions,
): Promise<ArtifactSaveResult> {
  const filename = artifactFilename(options.kind, options.name, options.ext);
  const downloadId = await chrome.downloads.download({
    url: options.url,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  } as chrome.downloads.DownloadOptions);

  const delay = options.resolvePathDelayMs ?? 100;
  if (delay <= 0) return { downloadId, filename };

  try {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.filename) return { downloadId, filename, fullPath: item.filename };
  } catch {
    // 절대 경로 조회 실패는 저장 실패가 아니다 — 상대 경로만 돌려준다.
  }
  return { downloadId, filename };
}
