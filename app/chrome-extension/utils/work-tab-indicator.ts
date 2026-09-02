/**
 * auto-chrome-mcp fork: 작업 탭 표시기.
 *
 * MCP 가 조작 중인 탭임을 페이지 위에 눈에 보이게 알린다. 기존 chrome.action 뱃지('MCP')는
 * 툴바 아이콘에만 뜨고 그 탭을 보고 있을 때만 보여서, 사용자가 "지금 이 탭을 AI 가 쓰는 중"임을
 * 알아채기 어려웠다.
 *
 * 표시는 페이지 동작을 절대 방해하면 안 된다:
 *   - shadow DOM 안에 그려 사이트 CSS 와 섞이지 않게 한다
 *   - pointer-events:none — 클릭을 가로채지 않는다 (우리 자동화의 클릭도 포함)
 *   - DOM 은 host 요소 하나뿐이고, 제거 시 흔적을 남기지 않는다
 *   - innerText/textContent 수집(read_page·scroll_collect)에 섞이지 않도록 shadow root 를 쓴다
 */

const HOST_ID = '__auto_chrome_mcp_work_tab_badge__';
const STORAGE_KEY = 'workTabIndicatorEnabled';

/** 스크립트 주입이 불가능한 페이지 (screenshot.ts 가드와 동일 목록). */
function isRestrictedUrl(url?: string): boolean {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('about:') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://microsoftedge.microsoft.com/')
  );
}

/** 사용자가 팝업에서 끌 수 있다. 기본값은 켜짐. */
export async function isIndicatorEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setIndicatorEnabled(enabled: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  } catch {
    // 저장 실패해도 표시 자체는 다음 호출에서 기본값으로 동작한다
  }
}

/** 페이지 컨텍스트에서 실행 — 외부 스코프를 참조하면 안 된다. */
function mountBadge(hostId: string, label: string): void {
  const existing = document.getElementById(hostId);
  if (existing) {
    const prev = existing.shadowRoot?.querySelector('.acm-label');
    if (prev) prev.textContent = label;
    return;
  }
  if (!document.body) return;

  const host = document.createElement('div');
  host.id = hostId;
  // 페이지 레이아웃에 영향을 주지 않도록 host 자체는 크기 0
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = [
    ':host { pointer-events: none; }',
    '.acm-frame {',
    '  position: fixed; inset: 0; pointer-events: none;',
    '  border: 2px solid rgba(109, 40, 217, 0.55);',
    '  box-shadow: inset 0 0 0 1px rgba(109, 40, 217, 0.25);',
    '}',
    '.acm-pill {',
    '  position: fixed; top: 10px; right: 10px; pointer-events: none;',
    '  display: flex; align-items: center; gap: 6px;',
    '  padding: 6px 11px; border-radius: 999px;',
    '  background: rgba(24, 24, 27, 0.88); color: #f4f4f5;',
    '  font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;',
    '  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);',
    '}',
    '.acm-dot {',
    '  width: 7px; height: 7px; border-radius: 50%; background: #a78bfa;',
    '  animation: acm-pulse 1.6s ease-in-out infinite;',
    '}',
    '@keyframes acm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
    '@media (prefers-reduced-motion: reduce) { .acm-dot { animation: none; } }',
  ].join('\n');

  const frame = document.createElement('div');
  frame.className = 'acm-frame';

  const pill = document.createElement('div');
  pill.className = 'acm-pill';
  const dot = document.createElement('span');
  dot.className = 'acm-dot';
  const text = document.createElement('span');
  text.className = 'acm-label';
  text.textContent = label;
  pill.appendChild(dot);
  pill.appendChild(text);

  root.appendChild(style);
  root.appendChild(frame);
  root.appendChild(pill);
  document.documentElement.appendChild(host);
}

/** 페이지 컨텍스트에서 실행 — 표시 제거. */
function unmountBadge(hostId: string): void {
  document.getElementById(hostId)?.remove();
}

async function canInject(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !isRestrictedUrl(tab.url);
  } catch {
    return false;
  }
}

/**
 * 대상 탭에 "Claude 작업 중" 표시를 띄운다. 이미 떠 있으면 문구만 갱신한다.
 * 실패(제한 페이지·탭 종료 등)는 조용히 무시한다 — 표시는 부가 기능이라 도구를 실패시키면 안 된다.
 */
export async function showWorkTabIndicator(tabId: number, label = 'Claude 작업 중'): Promise<void> {
  if (!(await isIndicatorEnabled())) return;
  if (!(await canInject(tabId))) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: mountBadge,
      args: [HOST_ID, label],
    });
  } catch {
    // 주입 불가 페이지 — 무시
  }
}

export async function hideWorkTabIndicator(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: unmountBadge,
      args: [HOST_ID],
    });
  } catch {
    // 탭이 이미 닫혔거나 주입 불가 — 무시
  }
}
