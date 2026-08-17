import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { listMarkersForUrl } from '@/entrypoints/background/element-marker/element-marker-storage';
// scalemaker fork: iframe 안의 콘텐츠까지 읽기 위한 프레임 열거 유틸
import { FRAME_COLLECT_MAX_FRAMES, listChildFrames } from './frame-resolver';
// scalemaker fork(T2): 직전 호출과 내용이 같으면 본문을 다시 보내지 않기 위한 diff 캐시
import { diffCheck } from '@/utils/content-cache';

interface ReadPageStats {
  processed: number;
  included: number;
  durationMs: number;
}

interface ReadPageParams {
  filter?: 'interactive'; // when omitted, return all visible elements
  depth?: number; // maximum DOM depth to traverse (0 = root only)
  refId?: string; // focus on subtree rooted at this refId
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  // scalemaker fork: true 면 top frame 외에 iframe 들의 결과도 함께 수집해 병합한다.
  // 기본값 false → 기존 단일 프레임 동작 그대로.
  allFrames?: boolean;
  // scalemaker fork(T2): 기본 true. 직전 호출과 본문이 동일하면 본문 없이 unchanged 마커만 반환.
  diff?: boolean;
  // scalemaker fork(T4): 기본 true. 무손실 압축 포맷. false 면 종전 포맷을 그대로 재현.
  compact?: boolean;
}

/** scalemaker fork: allFrames 병합 결과에서 프레임 하나에 대한 요약 */
interface ReadPageFrameSummary {
  frameId: number;
  frameUrl: string;
  included: boolean;
  lines: number;
  refMapCount: number;
  chars: number;
  reason?: string;
}

/** scalemaker fork: 프레임에서 수집한 접근성 트리 결과 */
interface ReadPageFrameResult {
  frameId: number;
  frameUrl: string;
  pageContent: string;
  refMapCount: number;
  /** scalemaker fork(T4): 압축 전 문자 수(압축 안 했으면 null) */
  rawChars: number | null;
}

/**
 * scalemaker fork: allFrames 병합 시 pageContent 총량 상한(문자 수).
 * top frame 은 항상 통째로 포함하고, 남은 예산 안에서 큰 프레임부터 채운다.
 */
const MERGED_PAGE_CONTENT_MAX_CHARS = 80000;

/** scalemaker fork: allFrames 폴백(interactive elements) 시 프레임당 / 전체 요소 상한 */
const FRAME_FALLBACK_ELEMENTS_PER_FRAME = 50;
const FRAME_FALLBACK_ELEMENTS_TOTAL = 250;

class ReadPageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.READ_PAGE;

  /**
   * scalemaker fork: 하위 iframe 들에서 접근성 트리를 수집한다(allFrames=true 일 때만 호출).
   * 프레임마다 개별적으로 helper 주입을 보장한 뒤 메시지를 보낸다.
   * 실패하거나 내용이 비어 있는 프레임은 조용히 제외한다.
   */
  private async collectFrameTrees(
    tabId: number,
    message: { filter: 'interactive' | null; depth?: number; compact: boolean },
  ): Promise<ReadPageFrameResult[]> {
    const frames = await listChildFrames(tabId, Math.max(0, FRAME_COLLECT_MAX_FRAMES - 1));
    if (frames.length === 0) return [];

    const settled = await Promise.allSettled(
      frames.map(async (frame): Promise<ReadPageFrameResult | null> => {
        try {
          // 상위에서 allFrames:true 로 이미 주입되지만, 늦게 생성된 프레임을 위해 한 번 더 보장한다.
          await this.injectContentScript(
            tabId,
            ['inject-scripts/accessibility-tree-helper.js'],
            false,
            'ISOLATED',
            false,
            [frame.frameId],
          );
        } catch {
          return null;
        }

        const resp = await this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.GENERATE_ACCESSIBILITY_TREE,
            filter: message.filter,
            depth: message.depth,
            // scalemaker fork(T4): 프레임 트리도 동일하게 압축한다.
            compact: message.compact,
          },
          frame.frameId,
        );

        const content =
          resp && resp.success === true && typeof resp.pageContent === 'string'
            ? resp.pageContent
            : '';
        if (!content.trim()) return null;

        return {
          frameId: frame.frameId,
          frameUrl: frame.frameUrl,
          pageContent: content,
          refMapCount: Array.isArray(resp?.refMap) ? resp.refMap.length : 0,
          rawChars: typeof resp?.rawChars === 'number' ? resp.rawChars : null,
        };
      }),
    );

    const out: ReadPageFrameResult[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) out.push(s.value);
    }
    out.sort((a, b) => a.frameId - b.frameId);
    return out;
  }

  /**
   * scalemaker fork: 하위 iframe 들에서 interactive elements 를 수집한다(allFrames 폴백 경로).
   */
  private async collectFrameInteractiveElements(tabId: number): Promise<any[]> {
    const frames = await listChildFrames(tabId, Math.max(0, FRAME_COLLECT_MAX_FRAMES - 1));
    if (frames.length === 0) return [];

    const settled = await Promise.allSettled(
      frames.map(async (frame): Promise<any[]> => {
        try {
          await this.injectContentScript(
            tabId,
            ['inject-scripts/interactive-elements-helper.js'],
            false,
            'ISOLATED',
            false,
            [frame.frameId],
          );
        } catch {
          return [];
        }
        const resp = await this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
            includeCoordinates: true,
          },
          frame.frameId,
        );
        if (!resp || resp.success !== true || !Array.isArray(resp.elements)) return [];
        return resp.elements
          .slice(0, FRAME_FALLBACK_ELEMENTS_PER_FRAME)
          .map((el: any) => ({ ...el, frameId: frame.frameId, frameUrl: frame.frameUrl }));
      }),
    );

    const out: any[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) out.push(...s.value);
    }
    return out;
  }

  /**
   * scalemaker fork: top frame 콘텐츠 + 프레임 콘텐츠를 크기 상한 안에서 병합한다.
   * top frame 은 항상 전부 포함하고, 남은 예산 안에서 큰 프레임부터 채운다.
   */
  private mergeFrameContent(
    topContent: string,
    frames: ReadPageFrameResult[],
  ): { pageContent: string; summaries: ReadPageFrameSummary[] } {
    const countLines = (s: string) => s.split('\n').filter((l) => l.trim().length > 0).length;

    const summaries: ReadPageFrameSummary[] = [];
    let budget = MERGED_PAGE_CONTENT_MAX_CHARS - topContent.length;

    const bySize = [...frames].sort((a, b) => b.pageContent.length - a.pageContent.length);
    const includedIds = new Set<number>();
    for (const f of bySize) {
      const header = `\n\n=== frame ${f.frameId} | ${f.frameUrl} ===\n`;
      const cost = header.length + f.pageContent.length;
      if (cost <= budget) {
        budget -= cost;
        includedIds.add(f.frameId);
      }
    }

    const parts: string[] = [topContent];
    for (const f of frames) {
      const included = includedIds.has(f.frameId);
      summaries.push({
        frameId: f.frameId,
        frameUrl: f.frameUrl,
        included,
        lines: countLines(f.pageContent),
        refMapCount: f.refMapCount,
        chars: f.pageContent.length,
        ...(included ? {} : { reason: 'size_cap' }),
      });
      if (included) {
        parts.push(`\n\n=== frame ${f.frameId} | ${f.frameUrl} ===\n${f.pageContent}`);
      }
    }

    return { pageContent: parts.join(''), summaries };
  }

  // Execute read page
  async execute(args: ReadPageParams): Promise<ToolResult> {
    const { filter, depth, refId } = args || {};
    // scalemaker fork: allFrames 옵션 (기본 false → 기존 동작 유지)
    const allFrames = args?.allFrames === true;
    // scalemaker fork(T4): compact 기본 true. compact:false 는 종전 포맷 그대로의 탈출구.
    const compact = args?.compact !== false;
    // scalemaker fork(T2): diff 기본 true. diff:false 면 항상 본문을 다시 보낸다.
    const useDiff = args?.diff !== false;

    // Validate refId parameter
    const focusRefId = typeof refId === 'string' ? refId.trim() : '';
    if (refId !== undefined && !focusRefId) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: refId must be a non-empty string`,
      );
    }

    // Validate depth parameter
    const requestedDepth = depth === undefined ? undefined : Number(depth);
    if (requestedDepth !== undefined && (!Number.isInteger(requestedDepth) || requestedDepth < 0)) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: depth must be a non-negative integer`,
      );
    }

    // Track if user explicitly controlled the output (skip sparse heuristics)
    const userControlled = requestedDepth !== undefined || !!focusRefId;

    try {
      // Tip text returned to callers to guide next action
      const standardTips =
        "If the specific element you need is missing from the returned data, use the 'screenshot' tool to capture the current viewport and confirm the element's on-screen coordinates. Also note: 'markedElements' are user-marked elements and have the highest priority when choosing targets.";

      const explicit = await this.tryGetTab(args?.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id)
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');

      // Load any user-marked elements for this URL (priority hints)
      const currentUrl = String(tab.url || '');
      const userMarkers = currentUrl ? await listMarkersForUrl(currentUrl) : [];

      // Inject helper in ISOLATED world to enable chrome.runtime messaging
      // Inject into all frames to support same-origin iframe operations
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/accessibility-tree-helper.js'],
        false,
        'ISOLATED',
        true,
      );

      // Ask content script to generate accessibility tree
      const treeMessage = {
        action: TOOL_MESSAGE_TYPES.GENERATE_ACCESSIBILITY_TREE,
        filter: filter || null,
        depth: requestedDepth,
        refId: focusRefId || undefined,
        // scalemaker fork(T4): helper 는 compact:true 일 때만 압축 패스를 태운다(기본 false).
        compact,
      };

      // scalemaker fork: allFrames 에서는 top frame 실패가 iframe 수집까지 막지 않도록 오류를 흡수한다.
      // allFrames=false 면 기존과 동일하게 그대로 throw 된다.
      let resp: any;
      let topFrameError: string | null = null;
      if (allFrames) {
        try {
          resp = await this.sendMessageToTab(tab.id, treeMessage);
        } catch (topErr) {
          resp = null;
          topFrameError = topErr instanceof Error ? topErr.message : String(topErr);
        }
      } else {
        resp = await this.sendMessageToTab(tab.id, treeMessage);
      }

      // Evaluate tree result and decide whether to fallback
      const treeOk = resp && resp.success === true;
      const pageContent: string =
        resp && typeof resp.pageContent === 'string' ? resp.pageContent : '';

      // Extract stats from response
      const stats: ReadPageStats | null =
        treeOk && resp?.stats
          ? {
              processed: resp.stats.processed ?? 0,
              included: resp.stats.included ?? 0,
              durationMs: resp.stats.durationMs ?? 0,
            }
          : null;

      const lines = pageContent
        ? pageContent.split('\n').filter((l: string) => l.trim().length > 0).length
        : 0;
      const refCount = Array.isArray(resp?.refMap) ? resp.refMap.length : 0;

      // Skip sparse heuristics when user explicitly controls output
      const isSparse = !userControlled && lines < 10 && refCount < 3;

      // scalemaker fork(T4): 압축으로 아낀 문자 수(실제로 응답에 실린 콘텐츠 기준으로만 합산)
      let compactSavedChars =
        compact && typeof resp?.rawChars === 'number'
          ? Math.max(0, resp.rawChars - pageContent.length)
          : 0;

      // scalemaker fork: allFrames=true 일 때만 하위 iframe 들의 트리를 추가 수집해 병합한다.
      // refId 는 프레임 로컬이므로 refId 지정 시에는 수집하지 않는다.
      let mergedPageContent = pageContent;
      let frameSummaries: ReadPageFrameSummary[] | null = null;
      let hasFrameContent = false;
      if (allFrames && !focusRefId) {
        try {
          const frameResults = await this.collectFrameTrees(tab.id, {
            filter: filter || null,
            depth: requestedDepth,
            compact,
          });
          const merged = this.mergeFrameContent(pageContent, frameResults);
          mergedPageContent = merged.pageContent;
          frameSummaries = merged.summaries;
          hasFrameContent = merged.summaries.some((f) => f.included);
          if (compact) {
            const includedIds = new Set(
              merged.summaries.filter((f) => f.included).map((f) => f.frameId),
            );
            for (const f of frameResults) {
              if (includedIds.has(f.frameId) && typeof f.rawChars === 'number') {
                compactSavedChars += Math.max(0, f.rawChars - f.pageContent.length);
              }
            }
          }
        } catch (frameErr) {
          console.warn('read_page allFrames collection failed:', frameErr);
          frameSummaries = [];
        }
      }

      // scalemaker fork: iframe 에서 내용을 찾았다면 top frame 이 비어 있어도 sparse 폴백을 타지 않는다.
      const effectiveSparse = isSparse && !hasFrameContent;

      // Build user-marked elements for inclusion
      const markedElements = userMarkers.map((m) => ({
        name: m.name,
        selector: m.selector,
        selectorType: m.selectorType || 'css',
        urlMatch: { type: m.matchType, origin: m.origin, path: m.path },
        source: 'marker',
        priority: 'highest',
      }));

      // Helper to convert elements array to pageContent format
      const formatElementsAsPageContent = (elements: any[]): string => {
        const out: string[] = [];
        for (const e of elements || []) {
          const type = typeof e?.type === 'string' && e.type ? e.type : 'element';
          const rawText = typeof e?.text === 'string' ? e.text.trim() : '';
          const text =
            rawText.length > 0
              ? ` "${rawText.replace(/\s+/g, ' ').slice(0, 100).replace(/"/g, '\\"')}"`
              : '';
          const selector =
            typeof e?.selector === 'string' && e.selector ? ` selector="${e.selector}"` : '';
          const coords =
            e?.coordinates && Number.isFinite(e.coordinates.x) && Number.isFinite(e.coordinates.y)
              ? ` (x=${Math.round(e.coordinates.x)},y=${Math.round(e.coordinates.y)})`
              : '';
          out.push(`- ${type}${text}${selector}${coords}`);
          if (out.length >= 150) break;
        }
        return out.join('\n');
      };

      // Unified base payload structure - consistent keys for stable contract
      const basePayload: Record<string, any> = {
        success: true,
        filter: filter || 'all',
        pageContent: mergedPageContent,
        tips: standardTips,
        viewport: treeOk ? resp.viewport : { width: null, height: null, dpr: null },
        stats: stats || { processed: 0, included: 0, durationMs: 0 },
        refMapCount: refCount,
        sparse: treeOk ? effectiveSparse : false,
        depth: requestedDepth ?? null,
        focus: focusRefId ? { refId: focusRefId, found: treeOk } : null,
        markedElements,
        elements: [],
        count: 0,
        fallbackUsed: false,
        fallbackSource: null,
        reason: null,
      };

      // scalemaker fork: allFrames 를 켠 경우에만 프레임 메타데이터/안내를 덧붙인다.
      // (기본 경로의 응답 형식은 그대로 유지)
      if (allFrames) {
        basePayload.allFrames = true;
        basePayload.frames = frameSummaries ?? [];
        basePayload.tips =
          standardTips +
          " Frame sections are marked with '=== frame <frameId> | <url> ==='. refs and selectors inside a frame section are frame-local: pass that frameId to chrome_click_element / chrome_fill_or_select when acting on them.";
      }

      // Normal path: return tree
      // scalemaker fork: top frame 트리가 실패해도 iframe 에서 내용을 얻었다면 그대로 반환한다.
      // (allFrames=false 면 hasFrameContent 는 항상 false → 기존 조건과 동일)
      if ((treeOk || hasFrameContent) && !effectiveSparse) {
        // scalemaker fork(T4): 압축 포맷 안내 + 절감량 보고 (트리 본문을 실제로 돌려주는 경로에서만)
        if (compact) {
          basePayload.compact = true;
          basePayload.compactSavedChars = compactSavedChars;
          basePayload.tips =
            basePayload.tips +
            ' Compact format (lossless): indentation is 1 space per tree level; the bare token ref_N is the element ref (pass it as refId/ref); @x,y is the element center. Unnamed empty wrapper nodes are collapsed. Pass compact:false for the verbose format.';
        }

        // scalemaker fork(T2): 직전 호출과 본문이 완전히 같으면 본문을 다시 보내지 않는다.
        //
        // ref 수명 확인 결과(핵심): ref 는 매 호출마다 새로 발급되지 않는다.
        // helper 의 window.__claudeElementMap 은 페이지 수명 동안 유지되고, traverse 는 요소마다
        // 먼저 기존 map 에서 같은 요소를 찾아 같은 ref_N 을 재사용한다(없을 때만 새 번호 발급).
        // 호출 끝의 스윕도 GC 된(=DOM 에서 사라진) 요소의 ref 만 지운다.
        // 게다가 이 unchanged 판정은 "helper 를 실제로 실행해 트리를 받아온 뒤"에 이루어지므로,
        // 본문을 생략하더라도 페이지 안의 ref map 은 이번 호출로 이미 갱신·검증된 상태다.
        // → 이전 응답에 있던 ref_N 은 그대로 클릭/입력에 쓸 수 있다(추가 재주입 불필요).
        //
        // 키에는 결과에 영향을 주는 인자를 모두 넣는다. markedElements 는 본문(pageContent)에
        // 들어가지 않으므로, 마커가 바뀌었는데 unchanged 로 가려지지 않도록 키에 함께 섞는다.
        const markerSig = markedElements.map((m) => m.name).join('|');
        const diffKey = `read_page:${tab.id}:${filter ?? ''}:${allFrames ? 1 : 0}:${refId ?? ''}:${markerSig}`;
        if (mergedPageContent) {
          const { unchanged, hash } = diffCheck(diffKey, mergedPageContent);
          if (useDiff && unchanged) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    unchanged: true,
                    hash,
                    chars: mergedPageContent.length,
                    message:
                      'Page content identical to your previous read — reuse it. Pass diff:false to force full re-send.',
                  }),
                },
              ],
              isError: false,
            };
          }
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(basePayload) }],
          isError: false,
        };
      }

      // When refId is explicitly provided, do not fallback (refs are frame-local and may expire)
      if (focusRefId) {
        return createErrorResponse(
          resp?.error || topFrameError || `refId "${focusRefId}" not found or expired`,
        );
      }

      // When user explicitly controls depth, do not override with fallback heuristics
      if (requestedDepth !== undefined) {
        return createErrorResponse(
          resp?.error || topFrameError || 'Failed to generate accessibility tree',
        );
      }

      // Fallback path: try get_interactive_elements once
      try {
        await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);
        const fallback = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
          includeCoordinates: true,
        });

        if (fallback && fallback.success && Array.isArray(fallback.elements)) {
          const limited = fallback.elements.slice(0, 150);
          // Merge user markers at the front, de-duplicated by selector
          const markerEls = userMarkers.map((m) => ({
            type: 'marker',
            selector: m.selector,
            text: m.name,
            selectorType: m.selectorType || 'css',
            isInteractive: true,
            source: 'marker',
            priority: 'highest',
          }));
          const seen = new Set(markerEls.map((e) => e.selector));
          let merged = [...markerEls, ...limited.filter((e: any) => !seen.has(e.selector))];

          // scalemaker fork: allFrames 폴백 — iframe 들의 interactive elements 도 덧붙인다.
          if (allFrames) {
            try {
              const frameEls = await this.collectFrameInteractiveElements(tab.id);
              if (frameEls.length > 0) {
                merged = [...merged, ...frameEls].slice(0, FRAME_FALLBACK_ELEMENTS_TOTAL);
              }
            } catch (frameFallbackErr) {
              console.warn('read_page allFrames fallback failed:', frameFallbackErr);
            }
          }

          basePayload.fallbackUsed = true;
          basePayload.fallbackSource = 'get_interactive_elements';
          basePayload.reason = treeOk
            ? 'sparse_tree'
            : resp?.error || topFrameError || 'tree_failed';
          basePayload.elements = merged;
          basePayload.count = fallback.elements.length;
          if (!basePayload.pageContent) {
            basePayload.pageContent = formatElementsAsPageContent(merged);
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(basePayload) }],
            isError: false,
          };
        }
      } catch (fallbackErr) {
        console.warn('read_page fallback failed:', fallbackErr);
      }

      // If we reach here, both tree (usable) and fallback failed
      return createErrorResponse(
        treeOk
          ? 'Accessibility tree is too sparse and fallback failed'
          : resp?.error ||
              topFrameError ||
              'Failed to generate accessibility tree and fallback failed',
      );
    } catch (error) {
      console.error('Error in read page tool:', error);
      return createErrorResponse(
        `Error generating accessibility tree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const readPageTool = new ReadPageTool();
