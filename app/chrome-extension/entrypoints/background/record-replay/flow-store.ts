import type { Flow, RunRecord, NodeBase, Edge } from './types';
import { stepsToDAG, type RRNode, type RREdge } from 'auto-chrome-mcp-shared';
import { NODE_TYPES } from '@/common/node-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { IndexedDbStorage, ensureMigratedFromLocal } from './storage/indexeddb-manager';

// Design note: IndexedDB-backed store for flows and run records.
// Includes lazy migration from chrome.storage.local for backwards compatibility.

// Validate if a type string is a valid NodeType
const VALID_NODE_TYPES = new Set<string>(Object.values(NODE_TYPES));
function isValidNodeType(type: string): boolean {
  return VALID_NODE_TYPES.has(type);
}

// Convert RRNode to NodeBase (ui coordinates are optional, not added here)
function toNodeBase(node: RRNode): NodeBase {
  return {
    id: node.id,
    type: isValidNodeType(node.type) ? (node.type as NodeBase['type']) : NODE_TYPES.SCRIPT,
    config: node.config,
  };
}

// Convert RREdge to Edge
function toEdge(edge: RREdge): Edge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label,
  };
}

/**
 * Filter edges to only keep those whose from/to both exist in nodeIds.
 * Prevents topoOrder crash when edges reference non-existent nodes.
 */
function filterValidEdges(edges: Edge[], nodeIds: Set<string>): Edge[] {
  return edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
}

// =============================================================================
// UI Notification
// =============================================================================

/**
 * Timer handle for coalescing flow change notifications.
 * Prevents multiple rapid changes (e.g., during import) from flooding UI.
 */
let flowsChangedTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Notify UI that flows have changed.
 * Uses a short debounce (50ms) to coalesce rapid changes.
 */
function notifyFlowsChanged(): void {
  // If timer is already scheduled, skip (will be handled by pending timer)
  if (flowsChangedTimer !== undefined) return;

  flowsChangedTimer = setTimeout(() => {
    flowsChangedTimer = undefined;
    try {
      // Send message to all extension contexts (popup, sidepanel, etc.)
      // Use void cast to avoid unhandled promise rejection
      void chrome.runtime
        .sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.RR_FLOWS_CHANGED,
        })
        .catch(() => {
          // Ignore errors - no listeners is expected when UI is closed
        });
    } catch {
      // Ignore errors (e.g., if chrome.runtime is not available)
    }
  }, 50);
}

/**
 * Strip deprecated steps field before persisting to IndexedDB.
 * This ensures new saves only contain the DAG model (nodes/edges).
 *
 * @param flow - Flow with or without steps
 * @returns Flow without steps field (omit entirely, not set to empty array)
 */
function stripStepsForSave(flow: Flow): Flow {
  if (!('steps' in flow)) {
    return flow;
  }

  const { steps: _steps, ...rest } = flow;
  return rest as Flow;
}

/**
 * Normalize flow before saving: ensure nodes/edges exist for scheduler compatibility.
 * Only generates DAG from steps if nodes are missing or empty.
 * Preserves existing nodes/edges to avoid overwriting user edits.
 *
 * Also validates edges: removes edges referencing non-existent nodes to prevent
 * runtime errors in scheduler's topoOrder calculation.
 */
function normalizeFlowForSave(flow: Flow): Flow {
  const hasNodes = Array.isArray(flow.nodes) && flow.nodes.length > 0;
  if (hasNodes) {
    // Validate edges even when nodes exist (e.g., imported flows may have invalid edges)
    const nodeIds = new Set(flow.nodes!.map((n) => n.id));
    if (Array.isArray(flow.edges) && flow.edges.length > 0) {
      const validEdges = filterValidEdges(flow.edges, nodeIds);
      if (validEdges.length !== flow.edges.length) {
        // Some edges were invalid, return cleaned flow
        return { ...flow, edges: validEdges };
      }
    }
    return flow;
  }

  // No nodes - generate from steps
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    return flow;
  }

  const dag = stepsToDAG(flow.steps);
  if (dag.nodes.length === 0) {
    return flow;
  }

  const nodes: NodeBase[] = dag.nodes.map(toNodeBase);
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Validate existing edges: only keep if from/to both exist in new nodes
  // Otherwise fall back to generated chain edges
  let edges: Edge[];
  if (Array.isArray(flow.edges) && flow.edges.length > 0) {
    const validEdges = filterValidEdges(flow.edges, nodeIds);
    edges = validEdges.length > 0 ? validEdges : dag.edges.map(toEdge);
  } else {
    edges = dag.edges.map(toEdge);
  }

  return {
    ...flow,
    nodes,
    edges,
  };
}

export interface PublishedFlowInfo {
  id: string;
  slug: string; // for tool name `flow.<slug>`
  version: number;
  name: string;
  description?: string;
}

/**
 * 발행 목록에 대한 모든 쓰기(발행/발행 해제/마이그레이션)를 직렬화하는 모듈 단일 락
 * (2026-09-05 Codex 발행 차단 지적 대응).
 *
 * 예전에는 시작 시 마이그레이션이 `list()` 로 발행 목록을 통째로 읽은 뒤, 그 스냅샷을
 * 기준으로 레코드 전체를 다시 저장했다. 그 사이(읽기~쓰기) 사용자가 재발행하거나 발행을
 * 해제하면, 마이그레이션의 뒤늦은 쓰기가 그 변경을 덮어써 되돌리거나(재발행 무효화) 삭제된
 * 레코드를 되살렸다(발행 해제 무효화).
 *
 * 이제 발행/발행 해제/마이그레이션의 각 쓰기 연산은 이 락을 통해 **완전히 순서대로**
 * 실행된다 - 앞선 연산의 async 본문이 끝나야 다음 연산이 시작된다. 또한 마이그레이션은
 * 레코드별로 락 안에서 "현재 값을 다시 읽고 → sensitive 기본값이 남아 있을 때만 그 레코드만
 * 갱신" 하므로, 자기 차례가 왔을 때 이미 발행 해제됐거나 재발행된 레코드는 건드리지 않는다.
 */
let publishedLock: Promise<void> = Promise.resolve();

function withPublishedLock<T>(task: () => Promise<T>): Promise<T> {
  const result = publishedLock.then(task, task);
  // 실패해도 체인이 막히지 않도록, 다음 연산은 항상 이어서 돈다.
  publishedLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 발행 저장소에 실제로 들어가는 레코드 (2026-09-05 Codex 재확인 항목 4).
 *
 * 발행은 "이 흐름을 도구 표면에 연다" 는 승인이다. 그런데 예전에는 메타데이터만 저장하고
 * 실행 시점에 **그때의 draft** 를 다시 읽었다. 발행한 뒤 draft 를 고치면(편집은 version 을
 * 올리지 않는다) 승인받지 않은 내용이 그대로 돌았다. 그래서 발행 시점의 흐름 전문을
 * 스냅샷으로 함께 저장하고, 실행은 그 스냅샷으로 한다.
 *
 * `listPublished()` 는 스냅샷을 떼고 돌려준다 — 목록은 MCP 응답으로 나가므로 흐름 본문이
 * 실리면 안 된다.
 */
interface PublishedRecord extends PublishedFlowInfo {
  snapshot?: Flow;
}

/** 저장 레코드에서 목록·응답용 메타데이터만 뽑는다. */
function toPublishedInfo(record: PublishedRecord): PublishedFlowInfo {
  return {
    id: record.id,
    slug: record.slug,
    version: record.version,
    name: record.name,
    ...(record.description !== undefined ? { description: record.description } : {}),
  };
}

/**
 * Check if a flow needs normalization (missing nodes when steps exist).
 */
function needsNormalization(flow: Flow): boolean {
  const hasSteps = Array.isArray(flow.steps) && flow.steps.length > 0;
  const hasNodes = Array.isArray(flow.nodes) && flow.nodes.length > 0;
  return hasSteps && !hasNodes;
}

/**
 * Lazy normalize a flow if needed, and persist the normalized version.
 * This handles legacy flows that only have steps but no nodes.
 * After normalization, steps field is stripped before persist AND return.
 */
async function lazyNormalize(flow: Flow): Promise<Flow> {
  if (!needsNormalization(flow)) {
    return stripStepsForSave(flow);
  }
  // Normalize and save back to storage (strip steps before persist)
  const normalized = normalizeFlowForSave(flow);
  const cleanFlow = stripStepsForSave(normalized);
  try {
    await IndexedDbStorage.flows.save(cleanFlow);
  } catch (e) {
    console.warn('lazyNormalize: failed to save normalized flow', e);
  }
  // Return DAG-only flow (do not leak deprecated steps to callers)
  return cleanFlow;
}

export async function listFlows(): Promise<Flow[]> {
  await ensureMigratedFromLocal();
  const flows = await IndexedDbStorage.flows.list();
  // Check if any flows need normalization
  const needsNorm = flows.some(needsNormalization);
  if (!needsNorm) {
    // Strip steps from all flows before returning
    return flows.map(stripStepsForSave);
  }
  // Normalize flows that need it (in parallel)
  // lazyNormalize already returns DAG-only flow
  const normalized = await Promise.all(
    flows.map(async (flow) => {
      if (needsNormalization(flow)) {
        return lazyNormalize(flow);
      }
      return stripStepsForSave(flow);
    }),
  );
  return normalized;
}

export async function getFlow(flowId: string): Promise<Flow | undefined> {
  await ensureMigratedFromLocal();
  const flow = await IndexedDbStorage.flows.get(flowId);
  if (!flow) return undefined;
  // Lazy normalize if needed (lazyNormalize returns DAG-only)
  if (needsNormalization(flow)) {
    return lazyNormalize(flow);
  }
  // Strip steps before returning
  return stripStepsForSave(flow);
}

export async function saveFlow(flow: Flow, options?: { notify?: boolean }): Promise<void> {
  await ensureMigratedFromLocal();
  // 1. Normalize: generate nodes/edges from steps if missing
  // 2. Strip: remove deprecated steps field before persist
  const normalizedFlow = normalizeFlowForSave(flow);
  const cleanFlow = stripStepsForSave(normalizedFlow);
  await IndexedDbStorage.flows.save(cleanFlow);
  // Notify UI by default, can be disabled for batch operations
  if (options?.notify !== false) {
    notifyFlowsChanged();
  }
}

export async function deleteFlow(flowId: string): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.flows.delete(flowId);
  notifyFlowsChanged();
}

export async function listRuns(): Promise<RunRecord[]> {
  await ensureMigratedFromLocal();
  return await IndexedDbStorage.runs.list();
}

export async function appendRun(record: RunRecord): Promise<void> {
  await ensureMigratedFromLocal();
  const runs = await IndexedDbStorage.runs.list();
  runs.push(record);
  // Trim to keep last 10 runs per flowId to avoid unbounded growth
  try {
    const byFlow = new Map<string, RunRecord[]>();
    for (const r of runs) {
      const list = byFlow.get(r.flowId) || [];
      list.push(r);
      byFlow.set(r.flowId, list);
    }
    const merged: RunRecord[] = [];
    for (const [, arr] of byFlow.entries()) {
      arr.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
      const last = arr.slice(Math.max(0, arr.length - 10));
      merged.push(...last);
    }
    await IndexedDbStorage.runs.replaceAll(merged);
  } catch (e) {
    console.warn('appendRun: trim failed, saving all', e);
    await IndexedDbStorage.runs.replaceAll(runs);
  }
}

export async function listPublished(): Promise<PublishedFlowInfo[]> {
  await ensureMigratedFromLocal();
  const records = (await IndexedDbStorage.published.list()) as PublishedRecord[];
  return records.map(toPublishedInfo);
}

/**
 * 발행 스냅샷에서 `sensitive` 변수의 `default` 를 뺀다 (2026-09-05 발행 전 검토 6).
 *
 * 발행 스냅샷은 **도구 표면이 실제로 실행하는 내용**이고, 사이드패널 편집과 무관하게
 * 그대로 남는다. 여기에 비밀번호·토큰의 기본값이 실리면 그 값이 IndexedDB 에 평문으로
 * 영속되고, 흐름을 내보내거나 스냅샷을 읽는 모든 경로로 함께 나간다. 실행에 필요한 값은
 * 호출자가 `args` 로 주는 것 하나뿐이어야 한다 - 스냅샷은 "어떤 비밀이 필요한지" 만 안다.
 *
 * `sensitive` 표시가 없는 변수의 기본값은 그대로 둔다. 그것이 흐름의 설정값이다.
 */
export function stripSensitiveDefaults(flow: Flow): Flow {
  const variables = flow.variables;
  if (!Array.isArray(variables) || variables.length === 0) return flow;
  if (!variables.some((v) => v?.sensitive === true && v?.default !== undefined)) return flow;
  return {
    ...flow,
    variables: variables.map((v) => {
      if (v?.sensitive !== true || v?.default === undefined) return v;
      const { default: _dropped, ...rest } = v;
      return rest;
    }),
  };
}

/**
 * 이미 저장된 발행 스냅샷에서 `sensitive` 변수의 기본값을 지운다 (한 번만).
 *
 * `stripSensitiveDefaults` 는 **앞으로 발행하는** 스냅샷만 막는다. 그 전에 발행된 레코드는
 * IndexedDB 에 비밀번호·토큰 기본값을 평문으로 그대로 들고 있고, 사용자가 그 흐름을 다시
 * 발행할 이유가 없으므로 영영 남는다. 워커가 뜰 때 한 번 걷어 낸다
 * (2026-09-05 Codex 최종 확인 5).
 *
 * 되돌릴 수 없는 변경이지만 지우는 값이 "저장돼 있으면 안 되는 값" 이라 그대로 진행한다.
 * 흐름 자체(draft)의 기본값은 건드리지 않는다 - 사이드패널에서 사용자가 편집하는 값이고,
 * 실행되는 것은 스냅샷 쪽이다.
 *
 * @returns 실제로 고친 레코드 수.
 */
export async function migratePublishedSensitiveDefaults(): Promise<number> {
  await ensureMigratedFromLocal();
  // 대상 후보만 고르기 위한 훑기 - 이 목록은 곧바로 낡을 수 있으므로 쓰기에는 쓰지 않는다.
  const candidates = (await IndexedDbStorage.published.list()) as PublishedRecord[];
  let fixed = 0;
  for (const candidate of candidates) {
    if (!candidate.snapshot) continue;
    // 레코드 하나당 락 한 차례. 다른 발행/발행 해제와 순서대로 줄을 서므로, 내 차례가
    // 왔을 때 "현재" 값을 다시 읽어 판단한다 - 훑을 때 본 stale 값으로 쓰지 않는다.
    const didFix = await withPublishedLock(async () => {
      const latest = ((await IndexedDbStorage.published.list()) as PublishedRecord[]).find(
        (r) => r.id === candidate.id,
      );
      // 그 사이 발행 해제됐거나(레코드 없음) 스냅샷이 없어졌으면 손댈 것이 없다.
      if (!latest?.snapshot) return false;
      const cleaned = stripSensitiveDefaults(latest.snapshot);
      // 참조가 같으면 지울 것이 없었다는 뜻이다 (재발행으로 이미 깨끗해졌을 수도 있다).
      if (cleaned === latest.snapshot) return false;
      await IndexedDbStorage.published.save({ ...latest, snapshot: cleaned } as PublishedFlowInfo);
      return true;
    });
    if (didFix) fixed += 1;
  }
  return fixed;
}

/** 워커 하나당 한 번만 돌게 잡아 두는 자리. */
let sensitiveDefaultsMigration: Promise<number> | null = null;

/**
 * 위 마이그레이션을 워커 초기화 시 한 번 돌린다 (`initRecordReplayListeners`).
 * 실패해도 배경 초기화를 막지 않는다 - 다음 워커 평가에서 다시 시도한다.
 */
export function ensurePublishedSensitiveDefaultsMigrated(): Promise<number> {
  if (!sensitiveDefaultsMigration) {
    sensitiveDefaultsMigration = migratePublishedSensitiveDefaults().catch((error) => {
      console.warn('[record-replay] 발행 스냅샷 sensitive 기본값 정리 실패:', error);
      sensitiveDefaultsMigration = null;
      return 0;
    });
  }
  return sensitiveDefaultsMigration;
}

/**
 * 이미 쓰이는 slug 를 피해 유일한 slug 를 고른다 (2026-09-05 Codex 교차 리뷰 3항).
 *
 * slug 는 도구 표면의 이름이고 `resolvePublishedFlow` 는 id 로 못 찾으면 slug 로 찾는다.
 * 이름이 같은 흐름 둘을 발행하면 자동 slug 도 같아지고, 그러면 slug 로 들어온 실행 요청이
 * **어느 흐름인지 알 수 없다**(먼저 저장된 쪽이 잡힌다). 그래서 겹치면 숫자를 붙인다.
 * 호출자가 slug 를 직접 준 경우에도 같다 - 조용히 남의 slug 를 빼앗는 것보다 낫다.
 */
/**
 * 이름에서 자동 slug 를 만든다 (2026-09-05 시연 지적 3항).
 *
 * `toSlug` 는 ascii 가 아닌 글자를 전부 구분자로 바꾼다. 그래서 한글 이름
 * "짬뽕 : 네이버 검색 2026.09.05" 는 날짜 부스러기 "2026-09-05" 만 남았다 - 무엇을 실행하는
 * 흐름인지 알 수 없고, 이름이 다른 두 흐름이 같은 날 만들어졌다는 이유로 같은 slug 가 된다.
 * 그래서 **ascii 글자가 하나도 남지 않으면** 흐름 id 에서 만든 안정적인 이름을 쓴다.
 */
function autoSlugFor(flow: Flow): string {
  const fromName = toSlug(flow.name);
  if (/[a-z]/.test(fromName)) return fromName;
  const tail = String(flow.id || '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase()
    .slice(-6);
  return tail ? `flow-${tail}` : `flow-${Date.now()}`;
}

function uniquePublishedSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function publishFlow(flow: Flow, slug?: string): Promise<PublishedFlowInfo> {
  await ensureMigratedFromLocal();
  // 발행 시점의 흐름 전문을 함께 저장한다. 저장 형식은 saveFlow 와 같게 맞춘다
  // (steps → nodes 정규화 후 deprecated steps 제거), 여기에 sensitive 변수의 기본값을
  // 뺀다 (2026-09-05 발행 전 검토 6).
  const snapshot = stripSensitiveDefaults(stripStepsForSave(normalizeFlowForSave(flow)));
  // 마이그레이션과 같은 락을 거친다 - 마이그레이션이 이 레코드를 처리 중이면 그 뒤에
  // 줄을 서고, 이 발행이 끝난 뒤에는 마이그레이션이 "현재" 값(이 발행 결과)을 다시 읽어
  // 이미 깨끗함을 확인하므로 되돌려지지 않는다.
  //
  // slug 중복 검사도 이 락 **안에서** 한다. 밖에서 읽고 안에서 쓰면 두 발행이 같은 빈
  // slug 를 동시에 보고 둘 다 차지한다.
  return await withPublishedLock(async () => {
    // 목록을 못 읽어도 발행 자체는 막지 않는다 (그 경우 유일성 검사만 건너뛴다).
    const records = ((await IndexedDbStorage.published.list()) ?? []) as PublishedRecord[];
    const existing = Array.isArray(records) ? records : [];
    const taken = new Set(
      existing.filter((r) => r.id !== flow.id).map((r) => String(r.slug || '')),
    );
    const base = slug || autoSlugFor(flow) || flow.id;
    const info: PublishedFlowInfo = {
      id: flow.id,
      slug: uniquePublishedSlug(base, taken),
      version: flow.version,
      name: flow.name,
      description: flow.description,
    };
    await IndexedDbStorage.published.save({ ...info, snapshot } as PublishedFlowInfo);
    // 발행 상태가 바뀌면 열려 있는 사이드패널의 카드 배지도 따라와야 한다.
    notifyFlowsChanged();
    return info;
  });
}

/**
 * 도구 표면으로 실행할 흐름을 발행 목록에서 고른다 (2026-09-05 Codex 재확인 항목 4).
 *
 * 예전 코드는 `getFlow(flowId)` 를 먼저 부르고, 발행 목록은 허가 확인에만 썼다. 그래서
 * 흐름 A 의 slug 가 발행되지 않은 흐름 B 의 id 와 겹치면, A 의 허가로 B 가 실행됐다.
 * 이제 대상은 **발행 레코드**로만 정한다: id 우선, 없으면 slug. 실행할 내용은 그 레코드의
 * 스냅샷이고, 스냅샷이 없는 옛 레코드만 `entry.id` 로 저장소를 읽되 version 이 발행 당시와
 * 같은지 확인한다.
 */
export type PublishedResolution =
  | { ok: true; entry: PublishedFlowInfo; flow: Flow }
  | {
      ok: false;
      reason: 'not_published' | 'missing' | 'version_mismatch';
      entry?: PublishedFlowInfo;
    };

export async function resolvePublishedFlow(flowId: string): Promise<PublishedResolution> {
  await ensureMigratedFromLocal();
  const records = (await IndexedDbStorage.published.list()) as PublishedRecord[];
  const record = records.find((p) => p.id === flowId) ?? records.find((p) => p.slug === flowId);
  if (!record) {
    // 발행되지 않은 것과 아예 없는 것은 호출자에게 다른 이야기다. "저장은 됐으니 발행해라"
    // 와 "그런 흐름이 없다" 를 한 문장으로 뭉치면 어느 쪽을 고쳐야 할지 알 수 없다.
    const draft = await getFlow(flowId);
    return { ok: false, reason: draft ? 'not_published' : 'missing' };
  }

  const entry = toPublishedInfo(record);
  if (record.snapshot) return { ok: true, entry, flow: record.snapshot };

  // 스냅샷 이전에 발행된 레코드. 대상은 언제나 entry.id 이고, 내용이 발행 당시와 같을 때만
  // 실행한다.
  const flow = await getFlow(record.id);
  if (!flow) return { ok: false, reason: 'missing', entry };
  if (Number(flow.version) !== Number(record.version)) {
    return { ok: false, reason: 'version_mismatch', entry };
  }
  return { ok: true, entry, flow };
}

export async function unpublishFlow(flowId: string): Promise<void> {
  await ensureMigratedFromLocal();
  // 같은 락을 거친다 - 마이그레이션이 이 레코드를 막 정리해 저장하려던 참이어도, 삭제는
  // 그 뒤(또는 앞)에 순서대로 실행되고 마이그레이션이 죽은 레코드를 되살리지 않는다.
  await withPublishedLock(async () => {
    await IndexedDbStorage.published.delete(flowId);
  });
  // 발행 해제도 카드 배지에 반영돼야 한다.
  notifyFlowsChanged();
}

export function toSlug(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 64);
}

export async function exportFlow(flowId: string): Promise<string> {
  const flow = await getFlow(flowId);
  if (!flow) throw new Error('flow not found');
  return JSON.stringify(flow, null, 2);
}

export async function exportAllFlows(): Promise<string> {
  const flows = await listFlows();
  return JSON.stringify({ flows }, null, 2);
}

/**
 * Import flows from JSON string.
 *
 * Supported formats:
 * 1. Array of flows: [...flows]
 * 2. Object with flows array: { flows: [...] }
 * 3. Single flow with steps: { id, steps: [...] }
 * 4. Single flow with nodes (new format): { id, nodes: [...], edges?: [...] }
 *
 * Flows are normalized on save (steps → nodes if needed).
 */
export function parseImportCandidates(json: string): Flow[] {
  const parsed = JSON.parse(json);

  // Detect candidates from various formats
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.flows)
      ? parsed.flows
      : parsed?.id && (Array.isArray(parsed?.steps) || Array.isArray(parsed?.nodes))
        ? [parsed]
        : [];

  if (!candidates.length) {
    throw new Error('invalid flow json: no flows found');
  }

  const nowIso = new Date().toISOString();
  const flowsToImport: Flow[] = [];

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('invalid flow json: flow must be an object');
    }

    const f = raw as Record<string, unknown>;
    const id = String(f.id || '').trim();
    if (!id) {
      throw new Error('invalid flow json: missing id');
    }

    // Normalize fields with sensible defaults
    const name = typeof f.name === 'string' && f.name.trim() ? f.name : id;
    const version = Number.isFinite(Number(f.version)) ? Number(f.version) : 1;

    // Handle meta with proper timestamps
    const existingMeta =
      f.meta && typeof f.meta === 'object' ? (f.meta as Record<string, unknown>) : {};
    const createdAt = typeof existingMeta.createdAt === 'string' ? existingMeta.createdAt : nowIso;

    // Build flow object - preserve steps only if present (for normalize)
    // saveFlow() will normalize (steps→nodes) then strip steps before persist
    const flow: Flow = {
      ...(f as object),
      id,
      name,
      version,
      meta: {
        ...existingMeta,
        createdAt,
        updatedAt: nowIso,
      },
    } as Flow;

    // Preserve steps for normalization if present in import data
    if (Array.isArray(f.steps) && f.steps.length > 0) {
      flow.steps = f.steps as Flow['steps'];
    }

    flowsToImport.push(flow);
  }

  return flowsToImport;
}

export async function importFlowFromJson(json: string): Promise<Flow[]> {
  await ensureMigratedFromLocal();
  const flowsToImport = parseImportCandidates(json);

  // Save all flows (normalize on save)
  // Disable individual notifications to avoid flooding UI during batch import
  for (const f of flowsToImport) {
    await saveFlow(f, { notify: false });
  }

  // Send single notification after all flows are imported
  notifyFlowsChanged();

  return flowsToImport;
}

/** 흐름 하나의 단계 수 (DAG 가 먼저, 없으면 옛 steps). */
function stepCountOf(flow: Flow): number {
  if (Array.isArray(flow.nodes) && flow.nodes.length > 0) return flow.nodes.length;
  return Array.isArray(flow.steps) ? flow.steps.length : 0;
}

export interface ImportPreviewEntry {
  id: string;
  name: string;
  stepCount: number;
  /** 같은 id 의 흐름이 이미 있다. 덮어쓸지 새 id 로 복사할지 사용자가 고른다. */
  conflict: boolean;
}

/**
 * 가져오기 미리보기 (2026-09-05 사이드패널 2단계 D).
 *
 * 저장은 하지 않는다. JSON 이 무엇을 담고 있는지, 기존 흐름을 덮어쓰게 되는지를 먼저
 * 보여 주기 위한 조회다. 예전 `importFlowFromJson` 은 id 가 겹치면 아무 말 없이 덮어썼다.
 */
export async function previewImportFlows(json: string): Promise<ImportPreviewEntry[]> {
  await ensureMigratedFromLocal();
  const candidates = parseImportCandidates(json);
  const existing = new Set((await IndexedDbStorage.flows.list()).map((f) => f.id));
  return candidates.map((flow) => ({
    id: flow.id,
    name: flow.name,
    stepCount: stepCountOf(flow),
    conflict: existing.has(flow.id),
  }));
}

export type ImportMode = 'copy' | 'overwrite';

export interface ImportedFlowInfo {
  oldId: string;
  newId: string;
  name: string;
}

/**
 * 가져오기 실행. `copy` 는 **겹치는 것만** 새 id 로 복사하고 이름 뒤에 " (복사)" 를 붙인다.
 * 겹치지 않는 흐름은 두 모드에서 똑같이 그대로 들어온다.
 */
export async function importFlowsFromJson(
  json: string,
  mode: ImportMode = 'overwrite',
): Promise<ImportedFlowInfo[]> {
  await ensureMigratedFromLocal();
  const candidates = parseImportCandidates(json);
  const taken = new Set((await IndexedDbStorage.flows.list()).map((f) => f.id));

  const imported: ImportedFlowInfo[] = [];
  for (const flow of candidates) {
    let target = flow;
    if (mode === 'copy' && taken.has(flow.id)) {
      const newId = uniqueFlowId(flow.id, taken);
      target = { ...flow, id: newId, name: `${flow.name} (복사)` };
    }
    taken.add(target.id);
    await saveFlow(target, { notify: false });
    imported.push({ oldId: flow.id, newId: target.id, name: target.name });
  }

  notifyFlowsChanged();
  return imported;
}

/**
 * 겹치지 않는 새 흐름 id. 원본 id 를 알아볼 수 있게 뒤에만 붙인다.
 *
 * 2026-09-05 Codex 코드 리뷰 4: 예전에는 후보 1000개가 차면 `Date.now()` 로 만든 id 를
 * **충돌 검사 없이** 돌려줬다. 같은 밀리초에 두 개를 만들면 두 번째가 첫 번째를 덮어쓴다.
 * 이제 어떤 경로로 만들든 `taken` 에 없는 값이 나올 때까지 확인한다.
 */
export function uniqueFlowId(baseId: string, taken: ReadonlySet<string>): string {
  for (let n = 2; n <= 1000; n += 1) {
    const candidate = `${baseId}-copy${n === 2 ? '' : n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 순번이 다 찼다. 무작위 꼬리를 붙이되 겹치지 않는 것을 확인하고 돌려준다.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${baseId}-copy-${randomIdTail()}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 여기까지 오는 것은 사실상 불가능하다(무작위 100회가 전부 겹쳤다). 마지막으로 시각을
  // 덧붙여 한 번 더 확인한다.
  let last = `${baseId}-copy-${randomIdTail()}-${Date.now().toString(36)}`;
  while (taken.has(last)) last = `${last}x`;
  return last;
}

/** 짧은 무작위 꼬리. `crypto.randomUUID` 가 없는 환경도 지난다. */
function randomIdTail(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid.replace(/-/g, '').slice(0, 8);
  } catch {
    // 아래 폴백으로 간다.
  }
  return Math.random().toString(36).slice(2, 10);
}

// Scheduling support
export type ScheduleType = 'once' | 'interval' | 'daily';
export interface FlowSchedule {
  id: string; // schedule id
  flowId: string;
  type: ScheduleType;
  enabled: boolean;
  // when: ISO string for 'once'; HH:mm for 'daily'; minutes for 'interval'
  when: string;
  // optional variables to pass when running
  args?: Record<string, any>;
}

export async function listSchedules(): Promise<FlowSchedule[]> {
  await ensureMigratedFromLocal();
  return await IndexedDbStorage.schedules.list();
}

export async function saveSchedule(s: FlowSchedule): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.schedules.save(s);
}

export async function removeSchedule(scheduleId: string): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.schedules.delete(scheduleId);
}
