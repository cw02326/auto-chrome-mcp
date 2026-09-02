import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

/**
 * auto-chrome-mcp fork(B1): chrome_storage — 쿠키 / localStorage / sessionStorage 조회·조작.
 *
 * 없어서 못 하던 것들을 가능하게 한다:
 *  - 로그인 세션 저장·복원 (쿠키 export → 나중에 import)
 *  - 로그아웃 상태 테스트 (특정 도메인 쿠키만 비우기)
 *  - 동의 배너 건너뛰기 (사이트가 보는 동의 쿠키를 미리 심기)
 *  - 프론트엔드 상태 디버깅 (localStorage 값 확인·주입)
 *
 * 보안: 쿠키·스토리지 값에는 세션 토큰이 들어 있다. 기본은 값을 가리고
 * (`includeValues:false`) 이름·도메인·만료 같은 메타데이터만 돌려준다.
 * 실제 값이 필요할 때만 호출부가 명시적으로 includeValues:true 를 준다.
 */

type StorageKind = 'cookies' | 'local' | 'session';
type StorageAction = 'get' | 'set' | 'remove' | 'clear';

interface StorageParams {
  kind?: StorageKind;
  action?: StorageAction;
  /** 쿠키: 대상 URL (set 에는 필수). storage: 무시 */
  url?: string;
  /** 쿠키: 도메인으로 필터 (get/clear) */
  domain?: string;
  /** 쿠키 이름 / storage 키 */
  name?: string;
  key?: string;
  /** set 할 값 */
  value?: string;
  /** 쿠키 set 세부 옵션 */
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
  /** 유닉스 초 단위 만료. 생략하면 세션 쿠키 */
  expirationDate?: number;
  /** 실제 값을 그대로 반환할지 (기본 false — 마스킹) */
  includeValues?: boolean;
  tabId?: number;
  windowId?: number;
}

const MAX_ITEMS = 200;

function maskValue(value: string | undefined | null): string {
  const len = typeof value === 'string' ? value.length : 0;
  return `<hidden:${len}chars>`;
}

function isRestrictedUrl(url?: string): boolean {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://')
  );
}

/**
 * 페이지 컨텍스트에서 실행 — 외부 스코프를 참조하면 안 된다(직렬화 주입).
 */
function webStorageOp(
  area: 'local' | 'session',
  action: 'get' | 'set' | 'remove' | 'clear',
  key: string | null,
  value: string | null,
  includeValues: boolean,
  maxItems: number,
): { ok: boolean; error?: string; items?: Array<{ key: string; value: string }>; count?: number } {
  try {
    const store = area === 'local' ? window.localStorage : window.sessionStorage;
    if (!store) return { ok: false, error: `${area}Storage is unavailable on this page` };

    if (action === 'clear') {
      const count = store.length;
      store.clear();
      return { ok: true, count };
    }
    if (action === 'remove') {
      if (!key) return { ok: false, error: 'key is required for remove' };
      store.removeItem(key);
      return { ok: true, count: 1 };
    }
    if (action === 'set') {
      if (!key) return { ok: false, error: 'key is required for set' };
      store.setItem(key, value === null ? '' : value);
      return { ok: true, count: 1 };
    }

    // get
    const items: Array<{ key: string; value: string }> = [];
    if (key) {
      const raw = store.getItem(key);
      if (raw !== null) {
        items.push({ key, value: includeValues ? raw : `<hidden:${raw.length}chars>` });
      }
      return { ok: true, items, count: items.length };
    }
    const total = store.length;
    for (let i = 0; i < total && items.length < maxItems; i++) {
      const k = store.key(i);
      if (k === null) continue;
      const raw = store.getItem(k) ?? '';
      items.push({ key: k, value: includeValues ? raw : `<hidden:${raw.length}chars>` });
    }
    return { ok: true, items, count: total };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

class StorageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.STORAGE;

  async execute(args: StorageParams): Promise<ToolResult> {
    const params = args || ({} as StorageParams);
    const kind: StorageKind =
      params.kind === 'local' || params.kind === 'session' ? params.kind : 'cookies';
    const action: StorageAction =
      params.action === 'set' ||
      params.action === 'remove' ||
      params.action === 'clear' ||
      params.action === 'get'
        ? params.action
        : 'get';
    const includeValues = params.includeValues === true;

    try {
      if (kind === 'cookies') {
        return await this.handleCookies(params, action, includeValues);
      }
      return await this.handleWebStorage(params, kind, action, includeValues);
    } catch (error) {
      return createErrorResponse(
        `chrome_storage failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 쿠키 조작에 쓸 URL 을 정한다 — 명시 url > 대상 탭의 url */
  private async resolveUrl(params: StorageParams): Promise<string | null> {
    if (typeof params.url === 'string' && params.url.trim()) return params.url.trim();
    const tab =
      (await this.tryGetTab(params.tabId)) || (await this.getActiveTabInWindow(params.windowId));
    return tab?.url ?? null;
  }

  private async handleCookies(
    params: StorageParams,
    action: StorageAction,
    includeValues: boolean,
  ): Promise<ToolResult> {
    if (typeof chrome.cookies === 'undefined') {
      return createErrorResponse(
        'chrome.cookies is unavailable — the extension needs the "cookies" permission (reload the extension after updating).',
      );
    }

    const name = params.name ?? params.key;
    const url = await this.resolveUrl(params);
    const domain =
      typeof params.domain === 'string' && params.domain.trim() ? params.domain.trim() : undefined;

    if (action === 'get') {
      if (!url && !domain) {
        return createErrorResponse('Provide url or domain (or target a tab) to list cookies');
      }
      const query: chrome.cookies.GetAllDetails = {};
      if (domain) query.domain = domain;
      else if (url) query.url = url;
      if (name) query.name = name;

      const all = await chrome.cookies.getAll(query);
      const cookies = all.slice(0, MAX_ITEMS).map((c) => ({
        name: c.name,
        value: includeValues ? c.value : maskValue(c.value),
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        session: c.session,
        expirationDate: c.expirationDate ?? null,
      }));
      return this.ok({
        kind: 'cookies',
        action,
        scope: domain ? { domain } : { url },
        total: all.length,
        returned: cookies.length,
        truncated: all.length > cookies.length,
        valuesHidden: !includeValues,
        cookies,
        ...(includeValues
          ? {}
          : {
              note: 'Cookie values are hidden. Pass includeValues:true only when you actually need them.',
            }),
      });
    }

    if (action === 'set') {
      if (!url) return createErrorResponse('url is required to set a cookie');
      if (!name) return createErrorResponse('name is required to set a cookie');
      if (typeof params.value !== 'string') {
        return createErrorResponse('value (string) is required to set a cookie');
      }
      const details: chrome.cookies.SetDetails = {
        url,
        name,
        value: params.value,
      };
      if (params.domain) details.domain = params.domain;
      if (params.path) details.path = params.path;
      if (typeof params.secure === 'boolean') details.secure = params.secure;
      if (typeof params.httpOnly === 'boolean') details.httpOnly = params.httpOnly;
      if (params.sameSite) details.sameSite = params.sameSite;
      if (typeof params.expirationDate === 'number') details.expirationDate = params.expirationDate;

      const written = await chrome.cookies.set(details);
      if (!written) {
        return createErrorResponse(
          'chrome.cookies.set returned null — the cookie was rejected (check url/domain/secure combination).',
        );
      }
      return this.ok({
        kind: 'cookies',
        action,
        cookie: {
          name: written.name,
          domain: written.domain,
          path: written.path,
          secure: written.secure,
          session: written.session,
          expirationDate: written.expirationDate ?? null,
        },
      });
    }

    if (action === 'remove') {
      if (!url) return createErrorResponse('url is required to remove a cookie');
      if (!name) return createErrorResponse('name is required to remove a cookie');
      const removed = await chrome.cookies.remove({ url, name });
      return this.ok({ kind: 'cookies', action, removed: removed !== null, name, url });
    }

    // clear — 반드시 url 또는 domain 으로 범위를 좁혀야 한다 (브라우저 전체 삭제 방지)
    if (!url && !domain) {
      return createErrorResponse(
        'Refusing to clear cookies without a scope. Provide url or domain (this guard prevents wiping every cookie in the browser).',
      );
    }
    const query: chrome.cookies.GetAllDetails = {};
    if (domain) query.domain = domain;
    else if (url) query.url = url;
    const targets = await chrome.cookies.getAll(query);

    let removedCount = 0;
    const failures: string[] = [];
    for (const c of targets) {
      // getAll 은 url 을 안 주므로 쿠키 정보로 삭제용 url 을 재구성한다.
      const cookieUrl = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
      try {
        const done = await chrome.cookies.remove({ url: cookieUrl, name: c.name });
        if (done) removedCount++;
        else failures.push(c.name);
      } catch {
        failures.push(c.name);
      }
    }
    return this.ok({
      kind: 'cookies',
      action,
      scope: domain ? { domain } : { url },
      matched: targets.length,
      removed: removedCount,
      failed: failures.slice(0, 20),
    });
  }

  private async handleWebStorage(
    params: StorageParams,
    area: 'local' | 'session',
    action: StorageAction,
    includeValues: boolean,
  ): Promise<ToolResult> {
    const tab =
      (await this.tryGetTab(params.tabId)) ||
      (await this.getActiveTabOrThrowInWindow(params.windowId));
    const tabId = tab.id;
    if (typeof tabId !== 'number') return createErrorResponse('Target tab has no id');
    if (isRestrictedUrl(tab.url)) {
      return createErrorResponse(
        'Cannot access web storage on browser-internal pages. Navigate to a regular http(s) page first.',
      );
    }

    const key = params.key ?? params.name ?? null;
    const value = typeof params.value === 'string' ? params.value : null;

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: webStorageOp,
      args: [area, action, key, value, includeValues, MAX_ITEMS],
    });
    const result = injection?.result as ReturnType<typeof webStorageOp> | undefined;
    if (!result) return createErrorResponse('Failed to read page storage (no result)');
    if (!result.ok) return createErrorResponse(result.error || 'Web storage operation failed');

    return this.ok({
      kind: area,
      action,
      tabId,
      url: tab.url,
      count: result.count ?? null,
      valuesHidden: action === 'get' ? !includeValues : undefined,
      items: result.items,
      truncated: action === 'get' && (result.count ?? 0) > (result.items?.length ?? 0),
    });
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

export const storageTool = new StorageTool();
