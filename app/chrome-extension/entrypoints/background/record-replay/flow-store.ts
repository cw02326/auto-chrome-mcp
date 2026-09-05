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

export async function publishFlow(flow: Flow, slug?: string): Promise<PublishedFlowInfo> {
  await ensureMigratedFromLocal();
  const info: PublishedFlowInfo = {
    id: flow.id,
    slug: slug || toSlug(flow.name) || flow.id,
    version: flow.version,
    name: flow.name,
    description: flow.description,
  };
  // 발행 시점의 흐름 전문을 함께 저장한다. 저장 형식은 saveFlow 와 같게 맞춘다
  // (steps → nodes 정규화 후 deprecated steps 제거), 여기에 sensitive 변수의 기본값을
  // 뺀다 (2026-09-05 발행 전 검토 6).
  const snapshot = stripSensitiveDefaults(stripStepsForSave(normalizeFlowForSave(flow)));
  await IndexedDbStorage.published.save({ ...info, snapshot } as PublishedFlowInfo);
  return info;
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
  await IndexedDbStorage.published.delete(flowId);
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
export async function importFlowFromJson(json: string): Promise<Flow[]> {
  await ensureMigratedFromLocal();
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

  // Save all flows (normalize on save)
  // Disable individual notifications to avoid flooding UI during batch import
  for (const f of flowsToImport) {
    await saveFlow(f, { notify: false });
  }

  // Send single notification after all flows are imported
  notifyFlowsChanged();

  return flowsToImport;
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
