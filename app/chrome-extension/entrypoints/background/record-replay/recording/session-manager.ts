import type { Edge, Flow, NodeBase, Step, VariableDef } from '../types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { NODE_TYPES } from '@/common/node-types';
import { STEP_TYPES } from '@/common/step-types';
import { mapStepToNodeConfig, stepsToDAG, EDGE_LABELS } from 'auto-chrome-mcp-shared';

/**
 * 클릭 유발 이동 판정 (2026-09-05 사이드패널 1단계 B).
 *
 * 클릭·엔터 단계가 기록된 뒤 이 시간 안에 커밋된 이동은 **그 단계의 결과**로 본다.
 * 별도 navigate 단계를 만들지 않고, 그 단계에 이동을 예상한다는 힌트만 남긴다.
 * 3초로 잡은 이유: 링크 클릭 후 커밋까지는 보통 1초 안쪽이지만 느린 서버·리다이렉트 체인은
 * 2초를 넘긴다. 반대로 이 값을 더 키우면 "클릭하고 한참 뒤에 사용자가 스스로 이동한 것"
 * 까지 삼켜 재생이 그 페이지에 도달하지 못한다.
 */
export const NAV_MERGE_WINDOW_MS = 3000;

/**
 * 같은 이동이 두 경로로 들어왔을 때의 중복 제거 창.
 *
 * 한 번의 이동에 `webNavigation.onCommitted` 와 `onHistoryStateUpdated` 가 모두 뜨는
 * 경우가 있어(프레임워크 라우터가 커밋 직후 replaceState 를 부른다) 같은 URL 이 연달아
 * 들어온다. 이 창 안의 같은 탭·같은 URL 은 한 번만 기록한다.
 *
 * **사용자 조작 이동은 이 창을 타지 않는다** (2026-09-05 Codex 교차 리뷰 2). 같은 페이지를
 * 1.5초 안에 새로고침하거나 뒤로가기로 되돌아오는 것은 진짜 조작이고, 그것을 중복으로 보고
 * 버리면 재생이 그 동작을 잃는다.
 */
export const NAV_DEDUPE_WINDOW_MS = 1500;

/**
 * 이동이 클릭보다 **먼저** 도착했을 때 되돌려 합치는 창 (Codex 교차 리뷰 4).
 *
 * 클릭 단계는 더블클릭 판정 300ms + 배치 100ms 를 거치고, 문서 이동 때는 pagehide 에서
 * best-effort 로 전송된다. 그래서 배경에는 이동이 먼저 도착하는 경우가 실제로 있다.
 * 그때는 이미 만든 navigate 단계를 지우고, 뒤늦게 도착한 클릭 단계에 힌트를 옮긴다.
 * 창을 짧게 잡는 이유: 길면 "이동과 무관한 다음 클릭" 이 방금의 정당한 navigate 단계를
 * 지워 버린다.
 */
export const NAV_REVERSE_MERGE_WINDOW_MS = 1200;

/**
 * 한 번의 클릭이 만든 **이동 사슬**을 묶는 창 (Codex 교차 리뷰 4).
 *
 * 클릭 → 커밋 → 서버/클라이언트 리다이렉트, 또는 클릭 → 커밋 → 라우터의 replaceState 는
 * 전부 그 클릭 하나의 결과다. 첫 이동을 합친 뒤 기준점을 비우면 뒤따르는 리다이렉트가
 * 별도 navigate 단계가 되어, 재생 때 같은 페이지로 두 번 가게 된다. 그래서 리다이렉트·
 * SPA 후속 이동만 이 창 안에서 같은 사슬로 흡수한다. 평범한 링크 이동은 흡수하지 않는다
 * (그것은 다음 조작의 결과다).
 */
export const NAV_CHAIN_WINDOW_MS = 2000;

/** 이동을 일으킬 수 있는 사용자 조작 단계 (클릭 유발 이동 판정의 기준점). */
export const INTERACTION_STEP_TYPES: ReadonlySet<string> = new Set<string>([
  STEP_TYPES.CLICK,
  STEP_TYPES.DBLCLICK,
  STEP_TYPES.KEY,
]);

/** recordNavigation 이 실제로 한 일. 테스트와 진단 로그가 읽는다. */
export type NavigationOutcome = 'appended' | 'merged' | 'duplicate' | 'ignored';

/** 배경 리스너가 넘기는 이동 한 건. */
export interface RecordedNavigation {
  /** 이동해 간 주소. */
  url: string;
  /**
   * 이동이 일어난 탭.
   *
   * 판정 상태(직전 조작·중복 제거·이동 사슬)는 **탭마다** 따로 둔다. 하나로 두면 녹화 중
   * 다른 탭에서 일어난 이동이 이 탭의 클릭에 합쳐진다 (2026-09-05 Codex 교차 리뷰 1).
   */
  tabId: number;
  /**
   * 사용자 조작만으로 일어난 이동인가.
   *
   * 주소창 입력·북마크·뒤로가기·새로고침처럼 페이지 안의 클릭과 무관한 이동이면 true 다.
   * 이런 이동은 앞선 클릭과 시간이 가까워도 합치지 않는다 - 합치면 재생이 그 주소로
   * 갈 방법을 잃는다.
   */
  userDriven: boolean;
  /** SPA 이동(pushState/replaceState/hashchange)인가. 이동 사슬 판정에 쓴다. */
  spa?: boolean;
  /** 리다이렉트로 도달한 이동인가 (client_redirect · server_redirect 자격자). */
  redirect?: boolean;
  /** 이동 시각(ms). 생략하면 Date.now(). */
  at?: number;
}

/** 탭 하나의 이동 판정 상태. */
interface TabNavState {
  /** 마지막으로 기록된 사용자 조작 단계. 이동을 합칠 기준점이다. */
  lastInteraction: { stepId: string; at: number } | null;
  /** 마지막으로 기록·합침 처리한 이동 (같은 이동의 중복 이벤트 제거용). */
  lastNavigation: { url: string; at: number } | null;
  /**
   * 방금 만든 navigate 단계. 뒤늦게 도착한 클릭 단계와 되돌려 합칠 후보다.
   * 이동 뒤에 어떤 단계든 하나 들어오면(합치든 아니든) 비운다.
   */
  pendingNav: { stepId: string; at: number } | null;
  /** 클릭에 합쳐진 이동 사슬. 리다이렉트·SPA 후속 이동을 여기로 흡수한다. */
  chain: { stepId: string; at: number } | null;
}

/**
 * Recording status state machine:
 * - idle: No active recording
 * - recording: Actively capturing user interactions
 * - paused: Temporarily paused (UI can resume)
 * - stopping: Draining final steps from content scripts before save
 */
export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopping';

export interface RecordingSessionState {
  sessionId: string;
  status: RecordingStatus;
  originTabId: number | null;
  /** 녹화를 시작한 페이지 주소. 흐름에도 같은 값이 `flow.startUrl` 로 들어간다. */
  startUrl?: string;
  flow: Flow | null;
  // Track tabs that have participated in this recording session
  activeTabs: Set<number>;
  // Track which tabs have acknowledged stop command
  stoppedTabs: Set<number>;
}

// Valid node types for type checking
const VALID_NODE_TYPES = new Set<string>(Object.values(NODE_TYPES));

export class RecordingSessionManager {
  private state: RecordingSessionState = {
    sessionId: '',
    status: 'idle',
    originTabId: null,
    startUrl: undefined,
    flow: null,
    activeTabs: new Set<number>(),
    stoppedTabs: new Set<number>(),
  };

  // Session-level cache for incremental DAG sync (cleared on session start/stop)
  // Note: stepIndexMap removed - we no longer write to flow.steps
  private nodeIndexMap: Map<string, number> = new Map();
  // Monotonic counter for edge id generation (avoids collision on delete/reorder)
  private edgeSeq: number = 0;

  /**
   * 탭별 이동 판정 상태 (2026-09-05 Codex 교차 리뷰 1).
   *
   * 예전에는 세션 전체에 하나였다. 그래서 녹화 중 다른 탭에서 일어난 이동이 이 탭의 클릭에
   * 합쳐지고, 중복 제거도 탭을 가리지 않았다.
   */
  private navStates: Map<number, TabNavState> = new Map();

  /** 탭 id 를 모르는 경로(예전 호출부)의 몫. 실제 탭 id 와 절대 겹치지 않는 값이다. */
  private static readonly UNKNOWN_TAB = -1;

  private navState(tabId?: number): TabNavState {
    const key =
      typeof tabId === 'number' && Number.isFinite(tabId)
        ? tabId
        : RecordingSessionManager.UNKNOWN_TAB;
    let st = this.navStates.get(key);
    if (!st) {
      st = { lastInteraction: null, lastNavigation: null, pendingNav: null, chain: null };
      this.navStates.set(key, st);
    }
    return st;
  }

  getStatus(): RecordingStatus {
    return this.state.status;
  }

  getSession(): Readonly<RecordingSessionState> {
    return this.state;
  }

  getFlow(): Flow | null {
    return this.state.flow;
  }

  getOriginTabId(): number | null {
    return this.state.originTabId;
  }

  /**
   * 지금 세션의 id. 배경 리스너가 await 앞뒤로 세션이 바뀌지 않았는지 확인할 때 쓴다
   * (2026-09-05 Codex 교차 리뷰 3).
   */
  getSessionId(): string {
    return this.state.sessionId;
  }

  /**
   * 이 탭이 지금 녹화 세션에 속하는가 (2026-09-05 Codex 교차 리뷰 1).
   *
   * 녹화 중이라고 해서 브라우저의 모든 탭이 녹화 대상인 것은 아니다. 이 확인이 없으면
   * 사용자가 열어 둔 다른 탭의 자동 새로고침까지 흐름에 단계로 들어간다.
   */
  hasTab(tabId: number | undefined): boolean {
    if (typeof tabId !== 'number') return false;
    return this.state.activeTabs.has(tabId) || this.state.originTabId === tabId;
  }

  /** 녹화를 시작한 페이지 주소. 아직 시작하지 않았거나 알 수 없으면 undefined. */
  getStartUrl(): string | undefined {
    return this.state.startUrl;
  }

  addActiveTab(tabId: number): void {
    if (typeof tabId === 'number') this.state.activeTabs.add(tabId);
  }

  removeActiveTab(tabId: number): void {
    this.state.activeTabs.delete(tabId);
  }

  getActiveTabs(): number[] {
    return Array.from(this.state.activeTabs);
  }

  /**
   * @param startUrl 녹화를 시작한 시점의 활성 탭 주소. 흐름에 `startUrl` 로 남는다
   *                 (2026-09-05 사이드패널 1단계 B).
   */
  async startSession(flow: Flow, originTabId: number, startUrl?: string): Promise<void> {
    // Clear cache for fresh session
    this.nodeIndexMap.clear();
    this.edgeSeq = 0;
    this.navStates.clear();

    const normalizedStartUrl =
      typeof startUrl === 'string' && startUrl.trim() ? startUrl.trim() : undefined;
    // 흐름 자체에 남겨야 저장·발행 스냅샷·내보내기까지 따라간다.
    if (normalizedStartUrl && !flow.startUrl) flow.startUrl = normalizedStartUrl;

    // 시작 주소는 그 탭에서 "방금 기록한 이동" 으로 친다. 녹화 시작 직후 같은 주소로 커밋
    // 이벤트가 한 번 더 오는 경우(재주입·리다이렉트)에 중복 navigate 단계가 생기는 것을 막는다.
    if (normalizedStartUrl) {
      this.navState(originTabId).lastNavigation = { url: normalizedStartUrl, at: Date.now() };
    }

    this.state = {
      sessionId: `sess_${Date.now()}`,
      status: 'recording',
      originTabId,
      startUrl: normalizedStartUrl,
      flow,
      activeTabs: new Set<number>([originTabId]),
      stoppedTabs: new Set<number>(),
    };

    // Initialize caches from existing flow data (supports resume scenarios)
    this.rebuildCaches();
  }

  /**
   * Transition to stopping state. Content scripts can still send final steps.
   * Returns the sessionId for barrier verification.
   */
  beginStopping(): string {
    if (this.state.status === 'idle') return '';
    this.state.status = 'stopping';
    this.state.stoppedTabs.clear();
    return this.state.sessionId;
  }

  /**
   * Mark a tab as having acknowledged the stop command.
   * Returns true if all active tabs have stopped.
   */
  markTabStopped(tabId: number): boolean {
    this.state.stoppedTabs.add(tabId);
    // Check if all active tabs have acknowledged
    for (const activeTabId of this.state.activeTabs) {
      if (!this.state.stoppedTabs.has(activeTabId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if we're in stopping state (still accepting final steps).
   */
  isStopping(): boolean {
    return this.state.status === 'stopping';
  }

  /**
   * Check if we can accept steps (recording or stopping).
   */
  canAcceptSteps(): boolean {
    return this.state.status === 'recording' || this.state.status === 'stopping';
  }

  /**
   * Transition to paused state.
   */
  pause(): void {
    if (this.state.status === 'recording') {
      this.state.status = 'paused';
    }
  }

  /**
   * Resume from paused state.
   */
  resume(): void {
    if (this.state.status === 'paused') {
      this.state.status = 'recording';
    }
  }

  /**
   * Finalize stop and clear session state.
   */
  async stopSession(): Promise<Flow | null> {
    const flow = this.state.flow;
    // 시작 주소를 흐름에 굳힌다. 세션 상태는 곧 비워지므로 여기가 마지막 기회다.
    if (flow && !flow.startUrl && this.state.startUrl) flow.startUrl = this.state.startUrl;
    this.state.status = 'idle';
    this.state.flow = null;
    this.state.originTabId = null;
    this.state.startUrl = undefined;
    this.state.activeTabs.clear();
    this.state.stoppedTabs.clear();
    // Clear cache
    this.nodeIndexMap.clear();
    this.edgeSeq = 0;
    this.navStates.clear();
    return flow;
  }

  updateFlow(mutator: (f: Flow) => void): void {
    const f = this.state.flow;
    if (!f) return;
    mutator(f);
    try {
      (f.meta as any).updatedAt = new Date().toISOString();
    } catch (e) {
      // ignore meta update errors
    }
  }

  /**
   * Append or upsert steps to the flow with incremental DAG sync.
   * Uses upsert semantics: if a step with the same id exists, update it in place.
   * This ensures fill steps get their final value even after initial flush.
   *
   * DAG sync: maintains flow.nodes/edges during recording.
   * - New step → create node + edge from previous node
   * - Upsert step → update node.config and node.type
   * - Invariant violation → fallback to linear DAG rebuild
   *
   * Note: flow.steps is no longer written. Nodes are the source of truth.
   *
   * @param options.tabId 이 단계들이 온 탭. 이동 판정 상태를 탭별로 두기 위해 받는다
   *   (2026-09-05 Codex 교차 리뷰 1). content script 메시지는 sender.tab.id 가 실어 준다.
   */
  appendSteps(steps: Step[], options?: { tabId?: number }): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(steps) || steps.length === 0) return;
    const nav = this.navState(options?.tabId);

    // Initialize arrays if missing
    if (!Array.isArray(f.nodes)) f.nodes = [];
    if (!Array.isArray(f.edges)) f.edges = [];

    // Legacy compatibility: if flow only has steps, initialize DAG from them once
    if (f.nodes.length === 0 && Array.isArray(f.steps) && f.steps.length > 0) {
      this.rebuildDagFromSteps();
    }

    const nodes = f.nodes;
    const edges = f.edges;

    // Check invariants: edges must match linear chain
    // If violated (e.g., imported flow, manual edit), rebuild linear chain
    if (!this.checkDagInvariant(nodes, edges)) {
      this.rechainEdges();
    }

    // Process each incoming step with upsert semantics + incremental DAG sync
    let needsRebuild = false;
    /** 이번 호출에서 **새로** 붙은 단계 id 들. 이동 판정은 이 목록만 본다. */
    const appendedIds: string[] = [];
    for (const step of steps) {
      // Ensure step has an id
      if (!step.id) {
        step.id = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      }

      const nodeIdx = this.nodeIndexMap.get(step.id);
      if (nodeIdx !== undefined) {
        // Upsert: update existing node in place
        if (!nodes[nodeIdx]) {
          needsRebuild = true;
          continue;
        }
        nodes[nodeIdx] = {
          ...nodes[nodeIdx],
          type: this.toNodeType(step.type),
          config: mapStepToNodeConfig(step),
        };
      } else {
        // Append: new node
        const prevNodeId = nodes.length > 0 ? nodes[nodes.length - 1]?.id : undefined;

        // Create corresponding node
        const newNode: NodeBase = {
          id: step.id,
          type: this.toNodeType(step.type),
          config: mapStepToNodeConfig(step),
        };
        nodes.push(newNode);
        this.nodeIndexMap.set(step.id, nodes.length - 1);
        appendedIds.push(step.id);

        // Create edge from previous node (if exists)
        if (prevNodeId) {
          if (!this.nodeIndexMap.has(prevNodeId)) {
            needsRebuild = true;
            continue;
          }
          const edgeId = `e_${this.edgeSeq++}_${prevNodeId}_${step.id}`;
          edges.push({
            id: edgeId,
            from: prevNodeId,
            to: step.id,
            label: EDGE_LABELS.DEFAULT,
          });
        }
      }
    }

    // Final invariant check: if any inconsistency detected, rebuild edges
    if (needsRebuild || !this.checkDagInvariant(nodes, edges)) {
      this.rechainEdges();
    }

    // 이동 판정 상태 갱신 (2026-09-05 B + Codex 교차 리뷰 1·4).
    this.trackAppendedSteps(nav, appendedIds);

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }

    this.broadcastTimelineUpdate();
  }

  /**
   * 새로 붙은 단계들을 이동 판정 상태에 반영한다.
   *
   *   - 사용자 조작 단계는 "직전 조작" 기준점이 된다.
   *   - 그 조작이 **방금 만든 navigate 단계보다 늦게 도착한 것**이면(클릭 지연·pagehide
   *     전송 때문에 실제로 일어난다) 그 navigate 단계를 지우고 힌트를 이 단계로 옮긴다
   *     (Codex 교차 리뷰 4).
   *   - 이동 뒤에 어떤 단계든 하나 들어오면 되돌려 합칠 기회는 끝난다.
   */
  private trackAppendedSteps(nav: TabNavState, appendedIds: string[]): void {
    if (appendedIds.length === 0) return;
    const f = this.state.flow;
    if (!f || !Array.isArray(f.nodes)) return;

    for (const stepId of appendedIds) {
      const idx = this.nodeIndexMap.get(stepId);
      const node = idx === undefined ? undefined : f.nodes[idx];
      const type = node?.type as string | undefined;
      if (!type) continue;
      // navigate 단계는 recordNavigation 이 스스로 관리한다.
      if (type === STEP_TYPES.NAVIGATE) continue;

      if (INTERACTION_STEP_TYPES.has(type)) {
        const pending = nav.pendingNav;
        const now = Date.now();
        if (pending && now - pending.at <= NAV_REVERSE_MERGE_WINDOW_MS) {
          // 이동이 먼저 도착했던 경우: 그 navigate 단계를 지우고 이 조작에 힌트를 남긴다.
          if (this.removeNodeById(pending.stepId)) {
            this.markStepExpectsNavigation(stepId);
            nav.chain = { stepId, at: pending.at };
            nav.lastInteraction = null;
            nav.pendingNav = null;
            continue;
          }
        }
        nav.lastInteraction = { stepId, at: now };
      }
      // 조작이든 아니든, 이동 뒤에 단계가 들어왔으면 되돌려 합칠 기회는 끝났다.
      nav.pendingNav = null;
    }
  }

  /**
   * 노드 하나를 흐름에서 지운다 (되돌려 합치기 전용).
   *
   * 녹화 중의 DAG 는 항상 선형이므로 지운 뒤 다시 이어 주면 된다. rechainEdges 가 캐시도
   * 함께 다시 만든다.
   */
  private removeNodeById(nodeId: string): boolean {
    const f = this.state.flow;
    if (!f || !Array.isArray(f.nodes)) return false;
    const idx = this.nodeIndexMap.get(nodeId);
    if (idx === undefined || !f.nodes[idx]) return false;
    f.nodes.splice(idx, 1);
    if (Array.isArray(f.edges)) {
      f.edges = f.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
    }
    this.rechainEdges();
    return true;
  }

  /**
   * Convert step type to valid NodeType with fallback to SCRIPT.
   * Logs a warning for unknown types to help detect upstream type drift.
   */
  private toNodeType(stepType: string): NodeBase['type'] {
    if (VALID_NODE_TYPES.has(stepType)) {
      return stepType as NodeBase['type'];
    }
    console.warn(`[RecordingSession] Unknown step type "${stepType}", falling back to "script"`);
    return NODE_TYPES.SCRIPT;
  }

  /**
   * Check DAG invariant for linear recording:
   * - edges.length === max(0, nodes.length - 1)
   * - Last edge (if exists) points to the last node
   */
  private checkDagInvariant(nodes: NodeBase[], edges: Edge[]): boolean {
    const nodeCount = nodes.length;
    const expectedEdgeCount = Math.max(0, nodeCount - 1);

    // Check edge count matches expected linear chain
    if (edges.length !== expectedEdgeCount) {
      return false;
    }

    // Check last edge points to last node (if edges exist)
    if (edges.length > 0 && nodes.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const lastNodeId = nodes[nodes.length - 1]?.id;
      if (lastEdge.to !== lastNodeId) {
        return false;
      }
    }

    return true;
  }

  /**
   * Rebuild caches from current flow state.
   * Called on session start and after DAG rebuild.
   */
  private rebuildCaches(): void {
    const f = this.state.flow;
    if (!f) return;

    this.nodeIndexMap.clear();

    if (Array.isArray(f.nodes)) {
      for (let i = 0; i < f.nodes.length; i++) {
        const id = f.nodes[i]?.id;
        if (id) this.nodeIndexMap.set(id, i);
      }
    }

    // Sync edgeSeq to continue from current edge count (avoids id collision)
    this.edgeSeq = Array.isArray(f.edges) ? f.edges.length : 0;
  }

  /**
   * Full DAG rebuild from legacy steps.
   * Used when flow only has steps[] but no nodes[].
   */
  private rebuildDagFromSteps(): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(f.steps) || f.steps.length === 0) return;

    const dag = stepsToDAG(f.steps);

    // Clear and repopulate nodes
    if (!Array.isArray(f.nodes)) f.nodes = [];
    f.nodes.length = 0;
    for (const n of dag.nodes) {
      f.nodes.push({
        id: n.id,
        type: this.toNodeType(n.type),
        config: n.config,
      });
    }

    // Clear and repopulate edges
    if (!Array.isArray(f.edges)) f.edges = [];
    f.edges.length = 0;
    for (const e of dag.edges) {
      f.edges.push({
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label,
      });
    }

    // Rebuild caches
    this.rebuildCaches();
  }

  /**
   * Re-chain edges linearly according to current nodes order.
   * Used when edge invariant is violated but nodes exist.
   */
  private rechainEdges(): void {
    const f = this.state.flow;
    if (!f) return;

    if (!Array.isArray(f.nodes)) f.nodes = [];
    if (!Array.isArray(f.edges)) f.edges = [];

    // Clear and re-chain edges
    f.edges.length = 0;
    for (let i = 0; i < f.nodes.length - 1; i++) {
      const from = f.nodes[i].id;
      const to = f.nodes[i + 1].id;
      f.edges.push({
        id: `e_${i}_${from}_${to}`,
        from,
        to,
        label: EDGE_LABELS.DEFAULT,
      });
    }

    // Rebuild caches
    this.rebuildCaches();
  }

  /**
   * 페이지 이동 한 건을 흐름에 반영한다 (2026-09-05 사이드패널 1단계 B).
   *
   * 이동 이벤트는 배경 리스너(`browser-event-listener.ts`)가 `chrome.webNavigation` 에서
   * 받아 여기로 넘긴다. 판정은 세 단계다:
   *
   *   1. **중복 제거** - 같은 URL 이 NAV_DEDUPE_WINDOW_MS 안에 다시 들어오면 버린다.
   *      한 번의 이동에 커밋 이벤트와 SPA 이벤트가 함께 뜨는 경우가 있다.
   *   2. **클릭 유발 이동 합치기** - 사용자 조작만으로 일어난 이동이 아니고(링크·폼 제출·
   *      SPA 라우팅) 직전 NAV_MERGE_WINDOW_MS 안에 클릭·엔터 단계가 있으면, navigate 단계를
   *      만들지 않고 그 단계에 힌트만 남긴다. 재생할 때는 그 클릭이 같은 이동을 다시
   *      일으키므로, navigate 단계를 따로 두면 같은 페이지로 두 번 가게 된다.
   *   3. 나머지는 navigate 단계로 남긴다. 주소창 입력·북마크·뒤로가기·새로고침처럼
   *      사용자 조작으로만 일어난 이동은 재생이 그 주소로 갈 다른 방법이 없다.
   *
   * @returns 실제로 한 일. 테스트가 이 값으로 판정을 고정한다.
   */
  recordNavigation(nav: RecordedNavigation): NavigationOutcome {
    const f = this.state.flow;
    if (!f) return 'ignored';
    // 일시정지 중에는 아무 단계도 잡지 않는다 (다른 단계 수집과 같은 규칙).
    if (!this.canAcceptSteps()) return 'ignored';
    // 녹화 세션에 속하지 않는 탭의 이동은 이 흐름의 일이 아니다 (Codex 교차 리뷰 1).
    if (!this.hasTab(nav?.tabId)) return 'ignored';

    const url = typeof nav?.url === 'string' ? nav.url.trim() : '';
    if (!url) return 'ignored';
    const at = typeof nav.at === 'number' && Number.isFinite(nav.at) ? nav.at : Date.now();
    const st = this.navState(nav.tabId);

    // 중복 제거는 **자동으로 따라온 이동에만** 건다. 같은 페이지를 1.5초 안에 다시
    // 새로고침하거나 뒤로가기로 되돌아오는 것은 진짜 조작이다 (Codex 교차 리뷰 2).
    if (!nav.userDriven) {
      const last = st.lastNavigation;
      if (last && last.url === url && at - last.at <= NAV_DEDUPE_WINDOW_MS) {
        return 'duplicate';
      }
    }

    if (!nav.userDriven) {
      const interaction = st.lastInteraction;
      if (interaction && at - interaction.at <= NAV_MERGE_WINDOW_MS) {
        this.markStepExpectsNavigation(interaction.stepId);
        st.lastNavigation = { url, at };
        // 이 클릭이 만든 이동 사슬을 연다. 뒤따르는 리다이렉트·replaceState 는 여기로 흡수된다.
        st.chain = { stepId: interaction.stepId, at };
        // 클릭 하나가 (사슬 밖의) 여러 이동을 삼키지 않도록 기준점은 비운다.
        st.lastInteraction = null;
        st.pendingNav = null;
        this.broadcastTimelineUpdate();
        return 'merged';
      }

      // 같은 클릭이 만든 이동 사슬의 뒷부분 (리다이렉트 또는 SPA 후속 이동).
      // 평범한 링크 이동은 여기로 들어오지 않는다 - 그것은 다음 조작의 결과다.
      if (
        st.chain &&
        (nav.redirect === true || nav.spa === true) &&
        at - st.chain.at <= NAV_CHAIN_WINDOW_MS
      ) {
        st.chain.at = at;
        st.lastNavigation = { url, at };
        return 'merged';
      }
    }

    st.lastNavigation = { url, at };
    const stepId = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.appendSteps([{ id: stepId, type: STEP_TYPES.NAVIGATE, url } as Step], {
      tabId: nav.tabId,
    });
    // 사용자 조작 이동은 되돌려 합칠 후보가 아니다. 클릭이 뒤늦게 도착해도 그 이동은
    // 주소창·뒤로가기가 만든 것이므로 단계로 남아야 한다.
    st.pendingNav = nav.userDriven ? null : { stepId, at };
    st.chain = null;
    return 'appended';
  }

  /**
   * 이 단계가 이동을 일으킨다는 사실을 단계에 남긴다.
   *
   * `expectsNavigation` 은 사람이 읽는 힌트이고, `after.waitForNavigation` 은 재생 엔진이
   * 실제로 소비하는 값이다(actions/handlers/click.ts · engine/runners/step-runner.ts).
   * 둘 다 남기는 이유: 재생 때 클릭 뒤에 이동이 끝날 때까지 기다려야 다음 단계가 이전
   * 문서에서 대상을 찾다 실패하지 않는다.
   */
  private markStepExpectsNavigation(stepId: string): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(f.nodes)) return;
    const idx = this.nodeIndexMap.get(stepId);
    if (idx === undefined) return;
    const node = f.nodes[idx];
    if (!node) return;
    const config = (node.config && typeof node.config === 'object' ? node.config : {}) as Record<
      string,
      unknown
    >;
    const after = (config.after && typeof config.after === 'object' ? config.after : {}) as Record<
      string,
      unknown
    >;
    node.config = {
      ...config,
      expectsNavigation: true,
      after: { ...after, waitForNavigation: true },
    };
  }

  /**
   * Append variables to the flow. Deduplicates by key.
   */
  appendVariables(variables: VariableDef[]): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(variables) || variables.length === 0) return;

    if (!f.variables) {
      f.variables = [];
    }

    // Deduplicate by key - newer definitions override older ones
    const existingKeys = new Set(f.variables.map((v) => v.key));
    for (const v of variables) {
      if (!v.key) continue;
      if (existingKeys.has(v.key)) {
        // Update existing variable
        const idx = f.variables.findIndex((fv) => fv.key === v.key);
        if (idx >= 0) {
          f.variables[idx] = v;
        }
      } else {
        f.variables.push(v);
        existingKeys.add(v.key);
      }
    }

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }
  }

  /**
   * Derive timeline steps from nodes for UI broadcast.
   * This keeps protocol compatibility with recorder.js without storing steps.
   */
  private getTimelineSteps(): Step[] {
    const f = this.state.flow;
    if (!f) return [];

    // Primary: derive from nodes
    if (Array.isArray(f.nodes) && f.nodes.length > 0) {
      return f.nodes.map((n) => {
        const cfg =
          n && typeof n.config === 'object' && n.config != null
            ? (n.config as Record<string, unknown>)
            : {};
        // Important: id and type must override any values in config
        // (config may contain 'type' for trigger nodes, etc.)
        return { ...cfg, id: n.id, type: n.type } as Step;
      });
    }

    // Legacy fallback: use steps if no nodes (shouldn't happen in normal recording)
    if (Array.isArray(f.steps) && f.steps.length > 0) {
      return f.steps;
    }

    return [];
  }

  // Broadcast timeline updates to relevant tabs (top-frame only)
  broadcastTimelineUpdate(): void {
    try {
      // Derive steps from nodes for UI consumption (protocol unchanged)
      const fullSteps = this.getTimelineSteps();
      if (fullSteps.length === 0) return;

      // Prefer broadcasting to all tabs that participated in this session, so timeline
      // stays consistent when user switches across tabs/windows during a single session.
      const targets = this.getActiveTabs();
      const list =
        targets && targets.length
          ? targets
          : this.state.originTabId != null
            ? [this.state.originTabId]
            : [];
      for (const tabId of list) {
        chrome.tabs.sendMessage(
          tabId,
          { action: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE, steps: fullSteps },
          { frameId: 0 },
        );
      }
    } catch {}
  }
}

// Singleton for wiring convenience
export const recordingSession = new RecordingSessionManager();
