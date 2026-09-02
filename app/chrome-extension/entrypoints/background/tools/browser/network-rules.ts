import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

/**
 * auto-chrome-mcp fork(B4): chrome_network_rules — 요청 차단 규칙.
 *
 * declarativeNetRequest 권한은 이미 선언되어 있었지만 실제로 쓰이지 않고 있었다.
 * 광고·추적 스크립트나 무거운 이미지/영상을 막으면:
 *   - 페이지가 눈에 띄게 빨리 뜨고 (자동화 대기 시간 감소)
 *   - read_page / get_web_content 가 읽어들이는 잡동사니가 줄어 토큰이 절약된다.
 *
 * 세션 규칙(updateSessionRules)만 쓴다 — 브라우저를 껐다 켜면 사라지고,
 * 특정 탭에만 적용할 수 있어서 사용자의 일반 브라우징에 영향을 남기지 않는다.
 */

type NetworkRuleAction = 'block' | 'unblock' | 'list' | 'clear';
type RulePreset = 'ads' | 'trackers' | 'images' | 'media' | 'fonts';

interface NetworkRulesParams {
  action?: NetworkRuleAction;
  /** urlFilter 패턴들 (예: "||doubleclick.net^", "/ads/") */
  patterns?: string[];
  preset?: RulePreset;
  /** 이 탭에만 적용 (생략하면 모든 탭) */
  tabId?: number;
  /** unblock 대상 규칙 id */
  ruleIds?: number[];
}

/** 우리 규칙만 건드리도록 id 범위를 예약한다 (다른 코드가 세션 규칙을 쓸 경우 대비) */
const RULE_ID_MIN = 9000;
const RULE_ID_MAX = 9899;
const MAX_PATTERNS = 100;

const AD_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'ads.linkedin.com',
  'ad.daum.net',
  'adpnut.com',
  'astrid.cafe24.com',
];

const TRACKER_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.tiktok.com',
  'connect.facebook.net',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'clarity.ms',
  'scorecardresearch.com',
  'newrelic.com',
  'braze.com',
  'wcs.naver.net',
];

const RESOURCE_PRESETS: Record<string, string[]> = {
  images: ['image'],
  media: ['media'],
  fonts: ['font'],
};

class NetworkRulesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_RULES;

  async execute(args: NetworkRulesParams): Promise<ToolResult> {
    const params = args || ({} as NetworkRulesParams);
    const action: NetworkRuleAction =
      params.action === 'unblock' || params.action === 'list' || params.action === 'clear'
        ? params.action
        : 'block';

    if (typeof chrome.declarativeNetRequest === 'undefined') {
      return createErrorResponse('chrome.declarativeNetRequest is unavailable in this browser');
    }

    try {
      const existing = await this.getOwnRules();

      if (action === 'list') {
        return this.ok({
          action,
          count: existing.length,
          rules: existing.map((r) => this.describeRule(r)),
        });
      }

      if (action === 'clear') {
        if (existing.length === 0) {
          return this.ok({ action, removed: 0, message: 'No rules were active' });
        }
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: existing.map((r) => r.id),
        });
        return this.ok({ action, removed: existing.length });
      }

      if (action === 'unblock') {
        const ids = Array.isArray(params.ruleIds)
          ? params.ruleIds.filter((id) => typeof id === 'number')
          : [];
        if (ids.length === 0) {
          return createErrorResponse(
            'ruleIds is required for unblock. Call action="list" first, or use action="clear" to remove all rules.',
          );
        }
        const ours = new Set(existing.map((r) => r.id));
        const removable = ids.filter((id) => ours.has(id));
        if (removable.length === 0) {
          return createErrorResponse(
            `None of the given ruleIds belong to chrome_network_rules (active ids: ${[...ours].join(', ') || 'none'})`,
          );
        }
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removable });
        return this.ok({ action, removed: removable.length, removedIds: removable });
      }

      // --- block ---
      const patterns: string[] = [];
      const seen = new Set<string>();
      const pushPattern = (p: string) => {
        const trimmed = p.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        patterns.push(trimmed);
      };

      const preset = params.preset;
      let resourceTypes: string[] | null = null;

      if (preset === 'ads') AD_DOMAINS.forEach((d) => pushPattern(`||${d}^`));
      else if (preset === 'trackers') TRACKER_DOMAINS.forEach((d) => pushPattern(`||${d}^`));
      else if (preset && RESOURCE_PRESETS[preset]) resourceTypes = RESOURCE_PRESETS[preset];
      else if (preset) {
        return createErrorResponse(
          `Unknown preset "${preset}". Available: ads, trackers, images, media, fonts.`,
        );
      }

      if (Array.isArray(params.patterns)) {
        params.patterns.filter((p) => typeof p === 'string').forEach(pushPattern);
      }

      if (patterns.length === 0 && !resourceTypes) {
        return createErrorResponse(
          'Provide patterns (e.g. ["||doubleclick.net^"]) or a preset (ads / trackers / images / media / fonts).',
        );
      }
      if (patterns.length > MAX_PATTERNS) {
        return createErrorResponse(`Too many patterns (${patterns.length}); max ${MAX_PATTERNS}.`);
      }

      const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
      let nextId = this.nextRuleId(existing);
      const addRules: any[] = [];

      const buildCondition = (urlFilter: string | null) => {
        const condition: Record<string, unknown> = {};
        if (urlFilter) condition.urlFilter = urlFilter;
        if (resourceTypes) condition.resourceTypes = resourceTypes;
        if (typeof tabId === 'number') condition.tabIds = [tabId];
        return condition;
      };

      if (resourceTypes && patterns.length === 0) {
        // 리소스 타입 전체 차단 (urlFilter 없이) — DNR 은 urlFilter 를 생략하면 전체 매치
        addRules.push({
          id: nextId++,
          priority: 1,
          action: { type: 'block' },
          condition: buildCondition(null),
        });
      } else {
        for (const urlFilter of patterns) {
          if (nextId > RULE_ID_MAX) break;
          addRules.push({
            id: nextId++,
            priority: 1,
            action: { type: 'block' },
            condition: buildCondition(urlFilter),
          });
        }
      }

      if (addRules.length === 0) {
        return createErrorResponse(
          `Rule id space is full (${RULE_ID_MIN}-${RULE_ID_MAX}). Call action="clear" first.`,
        );
      }

      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: addRules as chrome.declarativeNetRequest.Rule[],
      });

      return this.ok({
        action: 'block',
        added: addRules.length,
        scope: typeof tabId === 'number' ? { tabId } : 'all tabs',
        preset: preset ?? null,
        resourceTypes,
        rules: addRules.map((r) => this.describeRule(r)),
        note: 'Session rules only — they disappear when Chrome restarts. Use action="list" to review and action="clear" to remove them. Blocking can break sites that depend on the blocked hosts (some logins use tracker domains).',
      });
    } catch (error) {
      return createErrorResponse(
        `chrome_network_rules failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 우리 id 범위의 세션 규칙만 반환 */
  private async getOwnRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
    const all = await chrome.declarativeNetRequest.getSessionRules();
    return all.filter((r) => r.id >= RULE_ID_MIN && r.id <= RULE_ID_MAX);
  }

  private nextRuleId(existing: chrome.declarativeNetRequest.Rule[]): number {
    let max = RULE_ID_MIN - 1;
    for (const r of existing) if (r.id > max) max = r.id;
    return Math.max(RULE_ID_MIN, max + 1);
  }

  private describeRule(rule: any): Record<string, unknown> {
    return {
      id: rule.id,
      urlFilter: rule.condition?.urlFilter ?? null,
      resourceTypes: rule.condition?.resourceTypes ?? null,
      tabIds: rule.condition?.tabIds ?? null,
    };
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

export const networkRulesTool = new NetworkRulesTool();
