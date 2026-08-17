import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';

/**
 * scalemaker fork: chrome_extract — "필요한 값만 뽑는다" 토큰 절약 읽기 도구.
 *
 * 전체 페이지를 읽어서 모델이 그 안에서 값을 찾는 대신, 필드명 → CSS 셀렉터 매핑을 받아
 * 해당 값만 골라서 돌려준다. 가격/재고/제목/링크 확인처럼 "무엇을 볼지 이미 아는" 상황에서
 * read_page / get_web_content 대비 출력이 수십분의 일로 줄어든다.
 *
 * 설계 원칙
 *  - 값이 없는 필드는 실패가 아니라 정보다 → missing 배열로 돌려주고 success:true 유지.
 *    (모델이 셀렉터를 고칠지, 대기할지, 전체 읽기로 넘어갈지 스스로 판단하게 하기 위함)
 *  - 잘못된 셀렉터는 도구 전체를 실패시키지 않고 invalidSelectors 로 따로 보고한다.
 *  - 출력 상한(필드 20개 / 필드당 100개 / 값당 2000자 / 전체 50000자)을 항상 강제해
 *    셀렉터를 넓게 잡았을 때도 컨텍스트가 폭발하지 않게 한다.
 *
 * TOOL_NAMES 상수에는 orchestrator 가 별도로 추가하므로 여기서는 이름을 문자열로 고정한다.
 */

interface ExtractFieldSpec {
  selector: string;
  /** 지정 시 innerText 대신 이 속성값을 반환. href/src 는 절대 URL 로 해석 */
  attr?: string;
  /** true 면 모든 매치를 배열로 반환 (기본: 첫 매치만) */
  all?: boolean;
}

interface ExtractParams {
  tabId?: number;
  fields?: Record<string, string | ExtractFieldSpec>;
  frameId?: number;
}

/** executeScript 로 주입할 정규화된 필드 스펙 (직렬화 가능한 평면 구조) */
interface NormalizedField {
  name: string;
  selector: string;
  attr: string | null;
  all: boolean;
}

interface InPageResult {
  url: string;
  title: string;
  values: Record<string, string | string[] | null>;
  missing: string[];
  invalidSelectors: string[];
}

const MAX_FIELDS = 20;
const MAX_MATCHES_PER_FIELD = 100;
const MAX_VALUE_CHARS = 2000;
const MAX_TOTAL_CHARS = 50000;
const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * 스크립트 주입이 불가능한 페이지 (wait-for.ts 의 가드와 동일한 목록).
 */
function isRestrictedUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://microsoftedge.microsoft.com/')
  );
}

/**
 * 페이지 컨텍스트에서 실행되는 필드 추출 함수.
 * 주의: 외부 스코프를 참조하면 안 된다 (executeScript 가 직렬화해 주입하므로).
 */
function extractFieldsInPage(
  specs: NormalizedField[],
  maxMatches: number,
  maxValueChars: number,
  truncationSuffix: string,
): InPageResult {
  const values: Record<string, string | string[] | null> = {};
  const missing: string[] = [];
  const invalidSelectors: string[] = [];

  const cut = (text: string): string =>
    text.length > maxValueChars
      ? text.slice(0, Math.max(0, maxValueChars - truncationSuffix.length)) + truncationSuffix
      : text;

  const readValue = (el: Element, attr: string | null): string | null => {
    if (attr) {
      // href/src 는 DOM 프로퍼티가 절대 URL 을 돌려주므로 우선 사용한다.
      if (attr === 'href' || attr === 'src') {
        const resolved = (el as any)[attr];
        if (typeof resolved === 'string' && resolved) return cut(resolved);
      }
      const raw = el.getAttribute(attr);
      return raw === null ? null : cut(raw);
    }
    const text =
      typeof (el as HTMLElement).innerText === 'string'
        ? (el as HTMLElement).innerText
        : el.textContent || '';
    return cut(text.trim());
  };

  for (const spec of specs) {
    let matches: Element[];
    try {
      matches = spec.all
        ? Array.prototype.slice.call(document.querySelectorAll(spec.selector), 0, maxMatches)
        : (() => {
            const one = document.querySelector(spec.selector);
            return one ? [one] : [];
          })();
    } catch {
      invalidSelectors.push(spec.name);
      values[spec.name] = null;
      missing.push(spec.name);
      continue;
    }

    if (matches.length === 0) {
      values[spec.name] = spec.all ? [] : null;
      missing.push(spec.name);
      continue;
    }

    if (spec.all) {
      const list: string[] = [];
      for (const el of matches) {
        const v = readValue(el, spec.attr);
        if (v !== null) list.push(v);
      }
      values[spec.name] = list;
      if (list.length === 0) missing.push(spec.name);
    } else {
      const v = readValue(matches[0], spec.attr);
      values[spec.name] = v;
      if (v === null) missing.push(spec.name);
    }
  }

  return {
    url: location.href,
    title: document.title,
    values,
    missing,
    invalidSelectors,
  };
}

/** 문자열 값 하나를 가리키는 핸들 (전체 상한 초과 시 균등 절단용) */
interface ValueSlot {
  read: () => string;
  write: (v: string) => void;
}

function collectSlots(values: Record<string, string | string[] | null>): ValueSlot[] {
  const slots: ValueSlot[] = [];
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (typeof value === 'string') {
      slots.push({ read: () => values[key] as string, write: (v) => (values[key] = v) });
    } else if (Array.isArray(value)) {
      const arr = value;
      for (let i = 0; i < arr.length; i++) {
        const idx = i;
        slots.push({ read: () => arr[idx], write: (v) => (arr[idx] = v) });
      }
    }
  }
  return slots;
}

/**
 * 전체 문자 수 상한을 넘으면 값들을 "균등하게" 자른다.
 * 짧은 값부터 예산을 배분해(water-filling), 짧은 값은 온전히 남기고 긴 값만 깎는다.
 */
function truncateEvenly(
  values: Record<string, string | string[] | null>,
  maxTotal: number,
): boolean {
  const slots = collectSlots(values);
  const total = slots.reduce((sum, s) => sum + s.read().length, 0);
  if (total <= maxTotal || slots.length === 0) return false;

  const ordered = [...slots].sort((a, b) => a.read().length - b.read().length);
  let remainingBudget = maxTotal;
  let remainingSlots = ordered.length;
  let truncated = false;

  for (const slot of ordered) {
    const allowance = Math.floor(remainingBudget / remainingSlots);
    const text = slot.read();
    if (text.length <= allowance) {
      remainingBudget -= text.length;
    } else {
      const keep = Math.max(0, allowance - TRUNCATION_SUFFIX.length);
      slot.write(text.slice(0, keep) + TRUNCATION_SUFFIX);
      remainingBudget -= allowance;
      truncated = true;
    }
    remainingSlots--;
  }

  return truncated;
}

/**
 * Extract only the requested fields from a page (token-saving alternative to a full read)
 */
class ExtractTool extends BaseBrowserToolExecutor {
  name = 'chrome_extract';

  async execute(args: ExtractParams): Promise<ToolResult> {
    const params = args || ({} as ExtractParams);
    const fields = params.fields;

    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return createErrorResponse(
        'fields is required: an object mapping field names to CSS selectors, e.g. {"price": ".price", "links": {"selector": "a", "attr": "href", "all": true}}',
      );
    }

    const fieldNames = Object.keys(fields);
    if (fieldNames.length === 0) {
      return createErrorResponse('fields must contain at least one field');
    }
    if (fieldNames.length > MAX_FIELDS) {
      return createErrorResponse(
        `Too many fields: ${fieldNames.length} (max ${MAX_FIELDS}). Split into multiple calls.`,
      );
    }

    const specs: NormalizedField[] = [];
    for (const name of fieldNames) {
      const raw = fields[name];
      if (typeof raw === 'string') {
        if (!raw.trim()) return createErrorResponse(`Field "${name}" has an empty selector`);
        specs.push({ name, selector: raw.trim(), attr: null, all: false });
        continue;
      }
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof raw.selector !== 'string' ||
        !raw.selector.trim()
      ) {
        return createErrorResponse(
          `Field "${name}" must be a CSS selector string or an object with a non-empty "selector"`,
        );
      }
      specs.push({
        name,
        selector: raw.selector.trim(),
        attr: typeof raw.attr === 'string' && raw.attr.trim() ? raw.attr.trim() : null,
        all: raw.all === true,
      });
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = (await this.tryGetTab(params.tabId)) || (await this.getActiveTabOrThrowInWindow());
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
    const tabId = tab.id;
    if (typeof tabId !== 'number') {
      return createErrorResponse('Target tab has no id');
    }

    if (isRestrictedUrl(tab.url)) {
      return createErrorResponse(
        'Cannot extract from special browser pages or web store pages due to security restrictions.',
      );
    }

    const frameId =
      typeof params.frameId === 'number' && Number.isFinite(params.frameId) && params.frameId >= 0
        ? params.frameId
        : undefined;

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof frameId === 'number') target.frameIds = [frameId];

      const [injection] = await chrome.scripting.executeScript({
        target,
        func: extractFieldsInPage,
        args: [specs, MAX_MATCHES_PER_FIELD, MAX_VALUE_CHARS, TRUNCATION_SUFFIX],
      });

      const result = injection?.result as InPageResult | undefined;
      if (!result) {
        return createErrorResponse('chrome_extract: no result returned from the page');
      }

      const truncated = truncateEvenly(result.values, MAX_TOTAL_CHARS);

      const payload: Record<string, unknown> = {
        success: true,
        tabId,
        url: result.url || tab.url,
        values: result.values,
        missing: result.missing,
      };
      if (typeof frameId === 'number') payload.frameId = frameId;
      if (result.invalidSelectors.length > 0) payload.invalidSelectors = result.invalidSelectors;
      if (truncated) {
        payload.truncated = true;
        payload.truncationNote = `Output exceeded ${MAX_TOTAL_CHARS} chars — values were truncated evenly. Narrow the selectors or split the fields.`;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `chrome_extract failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const extractTool = new ExtractTool();
