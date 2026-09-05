/**
 * 저장 마법사(SaveFlowWizard)의 순수 로직 (2026-09-05 사이드패널 1단계 A).
 *
 * 크롬 API 를 부르지 않는다. 흐름 객체를 받아 흐름 객체를 돌려주기만 하므로 단위 테스트에서
 * 그대로 부를 수 있다. 화면(.vue)은 이 함수들의 결과를 그리기만 한다.
 *
 * ## 치환 문법
 * 재생 엔진이 실제로 쓰는 문법은 **중괄호 하나**다.
 *   - 액션 경로: `interpolateBraces()` (`actions/handlers/common.ts`) 가 `/\{([^}]+)\}/g` 로 바꾼다.
 *   - 레거시 노드 경로: `nodes/fill.ts` 와 `rr-utils.ts` 의 `expandTemplatesDeep()` 도 같은 정규식이다.
 *   - 녹화기(`inject-scripts/recorder.js`) 도 비밀번호 칸을 이미 `{key}` 로 바꿔 기록한다.
 * 그래서 설계 문서의 `{{변수명}}` 이 아니라 `{변수명}` 을 쓴다. 두 겹으로 쓰면 엔진이 안쪽
 * `{변수명}` 만 치환하고 바깥 중괄호가 값에 그대로 남는다.
 */

/** 흐름 변수 선언 (record-replay V2 `VariableDef` 중 이 화면이 쓰는 부분). */
export interface WizardVariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  default?: unknown;
  type?: string;
  rules?: { required?: boolean; pattern?: string; enum?: string[] };
}

/** 흐름 노드 (V2 `NodeBase` 중 이 화면이 쓰는 부분). */
export interface WizardNode {
  id: string;
  type: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

/** 흐름 간선. */
export interface WizardEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/** 마법사가 읽고 쓰는 흐름 (V2 `Flow` 의 부분집합). */
export interface WizardFlow {
  id: string;
  name: string;
  description?: string;
  version: number;
  startUrl?: string;
  meta?: {
    createdAt?: string;
    updatedAt?: string;
    /** 녹화를 시작한 탭의 문서 제목. 이름 기본값의 첫 재료다. */
    startTitle?: string;
    domain?: string;
    [key: string]: unknown;
  };
  variables?: WizardVariableDef[];
  nodes?: WizardNode[];
  edges?: WizardEdge[];
  [key: string]: unknown;
}

/** 발행 목록 한 건 (`RR_LIST_PUBLISHED` 응답 항목). */
export interface PublishedInfoLite {
  id: string;
  slug: string;
  version: number;
  name?: string;
  description?: string;
  /** 발행 시각. 지금 저장 형식에는 없지만, 생기면 그때부터 이 값도 함께 본다. */
  publishedAt?: string;
}

/** 마법사 변수 목록의 한 줄. */
export interface WizardVariable {
  /** 흐름 변수로 쓸 이름. 사용자가 고칠 수 있다. */
  key: string;
  /** 흐름에 이미 선언돼 있던 이름 (없으면 새 후보다). */
  originalKey?: string;
  /** 흐름 변수로 선언할지. */
  selected: boolean;
  /** 값을 흐름에 저장하지 않을지 (비밀번호·토큰). */
  sensitive: boolean;
  /** 녹화된 값. 민감 항목은 빈 문자열이다 (녹화기가 값을 남기지 않는다). */
  value: string;
  /**
   * 이 변수(또는 후보 값)를 값으로 쓰는 단계 **전부**.
   *
   * 같은 변수를 여러 칸이 참조할 수 있다(같은 비밀번호를 두 번 넣는 로그인 화면 등).
   * 하나만 기억하면 이름을 바꿀 때 나머지가 사라진 `{옛이름}` 을 가리키게 된다.
   * 비어 있으면 단계와 무관한 선언이다.
   */
  nodeIds: string[];
  /** 화면에 보여줄 설명 (입력칸 이름·선택자). */
  label?: string;
  /** 이미 흐름 변수로 선언돼 있었는가. */
  declared: boolean;
}

/** 마법사에서 사용자가 고친 내용. */
export interface WizardEdits {
  name: string;
  startUrl: string;
  variables: WizardVariable[];
  /** 지우기로 표시한 단계 id. */
  removedNodeIds: string[];
}

/** `applyWizardEdits` 결과. */
export interface WizardApplyResult {
  flow: WizardFlow;
  /** 흐름 내용이 실제로 바뀌었는가 (바뀌었을 때만 version 을 올린다). */
  changed: boolean;
}

/** 변수 참조 하나만으로 이뤄진 값인지 (`{키}`). */
export const VARIABLE_REFERENCE_PATTERN = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** 변수 이름 규칙. 엔진의 치환 정규식이 `}` 앞까지를 키로 보므로 중괄호는 쓸 수 없다. */
export const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 값이 들어가는 단계 유형. 지금 녹화기는 fill 하나만 값을 남긴다. */
const VALUE_STEP_TYPES: ReadonlySet<string> = new Set(['fill']);

/** 변수 참조 문자열을 만든다. 엔진 문법은 중괄호 하나다. */
export function variableReference(key: string): string {
  return `{${key}}`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 단계에서 사람이 알아볼 만한 이름을 뽑는다 (입력칸 name → id → 선택자 순). */
export function describeNode(node: WizardNode): string {
  const config = (node.config || {}) as Record<string, unknown>;
  const target = config.target as Record<string, unknown> | undefined;
  const candidates = Array.isArray(target?.candidates)
    ? (target?.candidates as Array<Record<string, unknown>>)
    : [];
  const named = candidates.find((c) => c?.type === 'name' || c?.type === 'attr');
  if (named && typeof named.value === 'string' && named.value) return named.value;
  if (typeof target?.selector === 'string' && target.selector) return target.selector;
  const first = candidates[0];
  if (first && typeof first.value === 'string' && first.value) return first.value;
  if (typeof config.url === 'string' && config.url) return config.url;
  return node.name || node.id;
}

/** 후보 변수의 기본 이름을 짓는다. 이미 쓰인 이름은 뒤에 숫자를 붙여 피한다. */
export function suggestVariableKey(node: WizardNode, used: Set<string>): string {
  const config = (node.config || {}) as Record<string, unknown>;
  const target = config.target as Record<string, unknown> | undefined;
  const candidates = Array.isArray(target?.candidates)
    ? (target?.candidates as Array<Record<string, unknown>>)
    : [];
  let base = '';
  for (const candidate of candidates) {
    const raw = typeof candidate?.value === 'string' ? candidate.value : '';
    const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (cleaned && VARIABLE_KEY_PATTERN.test(cleaned)) {
      base = cleaned.slice(0, 32);
      break;
    }
  }
  if (!base) base = 'var';
  let key = base;
  let n = 2;
  while (used.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  return key;
}

/**
 * 마법사에 띄울 변수 목록을 만든다.
 *
 * 순서대로 두 곳을 본다.
 *   1. 녹화 세션이 이미 모아 둔 `flow.variables` (비밀번호·파일 선택 칸). 이미 선언된
 *      변수이므로 체크된 상태로 보여준다. 그 변수를 값으로 쓰는 단계는 **전부** 모은다.
 *   2. 그러고도 남은 fill 단계의 **문자열 값**. 이건 아직 변수가 아닌 후보라 체크가 꺼져 있다.
 *
 * 선언에 없는 `{무엇}` 은 변수가 아니라 사용자가 실제로 친 글자로 본다. 녹화기는 변수를
 * 만들 때 반드시 선언도 함께 남기므로(`_addVariable`), 선언에 없는 중괄호는 값의 일부다.
 * 이것을 참조로 오해하면 그런 값이 편집 후보에서 통째로 빠진다.
 */
export function detectVariables(flow: WizardFlow): WizardVariable[] {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const declared = Array.isArray(flow.variables) ? flow.variables : [];
  const out: WizardVariable[] = [];
  const used = new Set<string>();
  const claimedNodes = new Set<string>();
  const declaredKeys = new Set(
    declared.filter((d) => d && typeof d.key === 'string' && d.key).map((d) => d.key),
  );

  for (const def of declared) {
    if (!def || typeof def.key !== 'string' || !def.key) continue;
    if (used.has(def.key)) continue; // 같은 키가 두 번 선언돼 있으면 앞의 것만 쓴다
    const reference = variableReference(def.key);
    const owners = nodes.filter(
      (n) => VALUE_STEP_TYPES.has(n.type) && asString(n.config?.value) === reference,
    );
    for (const owner of owners) claimedNodes.add(owner.id);
    used.add(def.key);
    out.push({
      key: def.key,
      originalKey: def.key,
      selected: true,
      sensitive: def.sensitive === true,
      value: def.sensitive === true ? '' : asString(def.default as unknown),
      nodeIds: owners.map((o) => o.id),
      label: owners[0] ? describeNode(owners[0]) : def.label,
      declared: true,
    });
  }

  for (const node of nodes) {
    if (!VALUE_STEP_TYPES.has(node.type)) continue;
    if (claimedNodes.has(node.id)) continue;
    const raw = node.config?.value;
    if (typeof raw !== 'string') continue; // 체크박스·라디오는 boolean 이라 변수로 뽑지 않는다
    if (!raw.trim()) continue;
    const asReference = VARIABLE_REFERENCE_PATTERN.exec(raw);
    // 선언된 변수를 가리키는 값만 건너뛴다. 선언에 없는 중괄호는 리터럴이다.
    if (asReference && declaredKeys.has(asReference[1])) continue;
    const key = suggestVariableKey(node, used);
    used.add(key);
    out.push({
      key,
      selected: false,
      sensitive: false,
      value: raw,
      nodeIds: [node.id],
      label: describeNode(node),
      declared: false,
    });
  }

  return out;
}

/** 변수 목록의 형식 오류를 찾는다. 오류 문구는 화면이 붙인다. */
export function validateVariables(
  variables: WizardVariable[],
): { ok: true } | { ok: false; reason: 'invalid_key' | 'duplicate_key'; key: string } {
  const seen = new Set<string>();
  for (const v of variables) {
    if (!v.selected) continue;
    if (!VARIABLE_KEY_PATTERN.test(v.key)) return { ok: false, reason: 'invalid_key', key: v.key };
    if (seen.has(v.key)) return { ok: false, reason: 'duplicate_key', key: v.key };
    seen.add(v.key);
  }
  return { ok: true };
}

/**
 * 단계 하나를 지우고 앞뒤를 잇는다.
 *
 * 녹화된 흐름은 한 줄로 이어진 사슬이지만, 가져온 흐름은 갈래가 있을 수 있다. 그래서
 * "지운 노드로 들어오던 간선"과 "나가던 간선"을 곱해 다시 이어 준다. 들어오는 간선의
 * 라벨을 유지하므로 조건 분기의 어느 갈래였는지가 보존된다.
 */
function removeNodes(flow: WizardFlow, removedIds: Set<string>): void {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  let edges = Array.isArray(flow.edges) ? flow.edges : [];

  for (const removedId of removedIds) {
    const incoming = edges.filter((e) => e.to === removedId);
    const outgoing = edges.filter((e) => e.from === removedId);
    const bridged: WizardEdge[] = [];
    for (const inEdge of incoming) {
      for (const outEdge of outgoing) {
        if (inEdge.from === outEdge.to) continue;
        bridged.push({
          id: `e_bridge_${inEdge.from}_${outEdge.to}`,
          from: inEdge.from,
          to: outEdge.to,
          label: inEdge.label ?? 'default',
        });
      }
    }
    edges = edges.filter((e) => e.from !== removedId && e.to !== removedId).concat(bridged);
  }

  // 같은 두 노드를 잇는 간선이 겹치면 하나만 남긴다.
  const seen = new Set<string>();
  flow.edges = edges.filter((e) => {
    const sig = `${e.from}->${e.to}:${e.label ?? 'default'}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  flow.nodes = nodes.filter((n) => !removedIds.has(n.id));
}

/**
 * 마법사에서 고친 내용을 흐름에 반영한다.
 *
 * - 체크한 변수는 흐름 변수로 선언되고, 그 값이 나온 단계의 값은 `{이름}` 참조로 바뀐다.
 * - **민감 변수의 실제 값은 흐름에 남지 않는다.** `default` 를 아예 넣지 않으므로 저장본에도,
 *   발행 스냅샷에도, 내보내기 JSON 에도 값이 없다. 실행할 때 입력받는다.
 * - 체크를 푼 변수는 선언이 사라지고 단계 값이 원래 문자열로 돌아간다 (민감 항목은 값이
 *   애초에 없으므로 빈 문자열이 된다).
 * - 내용이 실제로 바뀐 경우에만 `version` 을 올리고 `meta.updatedAt` 을 갱신한다. 그래야
 *   마법사를 열었다 그냥 닫은 흐름이 "재발행 필요" 로 잘못 표시되지 않는다.
 */
/**
 * 내용 비교용 표준형.
 *
 * 변수 선언은 저장 때 한 번 정리된다 (빈 기본값을 빼고, 민감 변수는 기본값 자체를 없앤다).
 * 그 정리만으로 "바뀌었다" 고 보면 마법사를 열었다 그냥 저장한 흐름까지 재발행 대상이
 * 되므로, 비교할 때는 두 쪽 모두 같은 규칙으로 접어 놓고 본다.
 */
function canonicalize(flow: {
  name?: string;
  startUrl?: string;
  variables?: WizardVariableDef[];
  nodes?: WizardNode[];
  edges?: WizardEdge[];
}): string {
  const variables = (flow.variables ?? []).map((v) => ({
    key: v.key,
    sensitive: v.sensitive === true,
    default: v.default === '' || v.default === undefined ? undefined : v.default,
  }));
  return JSON.stringify({
    name: flow.name ?? '',
    startUrl: flow.startUrl ?? '',
    variables,
    nodes: flow.nodes ?? [],
    edges: flow.edges ?? [],
  });
}

/**
 * 이름이 바뀐 변수의 참조를 단계 설정 전체에서 한 번에 바꾼다.
 *
 * 값 칸만 고치면 부족하다. 참조는 문자열 안에 섞여 있을 수도 있고(`"주문 {order}"`),
 * 선택자에도 들어갈 수 있다(엔진의 `interpolateBraces` 가 선택자도 치환한다). 또 여러
 * 이름을 **동시에** 바꿔야 한다 - 하나씩 순서대로 바꾸면 `a → b`, `b → c` 가 연달아
 * 적용돼 원래 a 였던 것까지 c 가 된다. 그래서 한 번의 정규식 순회로 한꺼번에 바꾼다.
 */
function renameVariableReferences(nodes: WizardNode[], renames: Map<string, string>): void {
  if (renames.size === 0) return;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
        const next = renames.get(key);
        return next ? variableReference(next) : match;
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  for (const node of nodes) {
    if (node.config) node.config = walk(node.config) as Record<string, unknown>;
  }
}

export function applyWizardEdits(
  source: WizardFlow,
  edits: WizardEdits,
  now: Date = new Date(),
): WizardApplyResult {
  const before = canonicalize(source);

  const flow = deepClone(source);
  const removed = new Set(edits.removedNodeIds.filter(Boolean));
  if (removed.size > 0) removeNodes(flow, removed);

  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // 이름 변경을 먼저 한 번에 처리한다. 그래야 값 칸에 없는(문자열에 섞인) 참조도 따라온다.
  const renames = new Map<string, string>();
  for (const variable of edits.variables) {
    if (!variable.selected) continue;
    if (variable.originalKey && variable.originalKey !== variable.key) {
      renames.set(variable.originalKey, variable.key);
    }
  }
  renameVariableReferences(nodes, renames);

  const variables: WizardVariableDef[] = [];
  for (const variable of edits.variables) {
    const ownedNodeIds = variable.nodeIds ?? [];
    const liveNodes = ownedNodeIds
      .map((id) => nodeById.get(id))
      .filter((n): n is WizardNode => !!n);
    // 값이 나온 단계가 모두 지워졌으면 변수도 함께 사라진다.
    if (ownedNodeIds.length > 0 && liveNodes.length === 0) continue;

    if (!variable.selected) {
      // 아직 변수가 아니었던 후보는 손대지 않는다. 단계에는 이미 그 값이 그대로 있고,
      // 여기서 다시 쓰면 **다른 변수의 이름 변경까지 되돌린다** (그 값 안에 참조가 섞여
      // 있을 수 있다).
      if (!variable.declared) continue;
      for (const node of liveNodes) {
        // 선언을 풀면 값이 그대로 단계에 남는다. 민감 항목은 값이 없으므로 빈 문자열이다.
        if (node.config) node.config.value = variable.value;
      }
      continue;
    }

    for (const node of liveNodes) {
      if (node.config) node.config.value = variableReference(variable.key);
    }

    const def: WizardVariableDef = { key: variable.key };
    if (variable.sensitive) {
      def.sensitive = true;
      // default 를 넣지 않는다 - 이것이 "민감값은 저장하지 않는다" 의 실제 구현이다.
      // 기본값이 없으면 엔진이 실행 시작 때 값을 물어보므로 별도 required 표시도 필요 없다
      // (engine/scheduler.ts 의 변수 수집 조건이 `(v.default ?? '') === ''` 다).
    } else {
      def.default = variable.value;
    }
    variables.push(def);
  }

  flow.name = edits.name.trim() || flow.name;
  const startUrl = edits.startUrl.trim();
  if (startUrl) flow.startUrl = startUrl;
  else delete flow.startUrl;
  flow.variables = variables;

  const changed = before !== canonicalize(flow);

  if (changed) {
    flow.version = Number(flow.version || 0) + 1;
    const stamp = now.toISOString();
    if (!flow.meta) flow.meta = { createdAt: stamp, updatedAt: stamp };
    else flow.meta.updatedAt = stamp;
  }

  return { flow, changed };
}

/**
 * 발행된 내용과 지금 흐름이 달라졌는가 (카드의 "수정 후 재발행 필요" 배지).
 *
 * 발행 레코드에는 발행 시각이 없고 `version` 만 있다. 마법사 저장이 내용이 바뀔 때마다
 * version 을 올리므로, 두 값이 다르면 발행된 스냅샷이 옛것이라는 뜻이다. 나중에 발행
 * 레코드에 시각이 생기면 `meta.updatedAt` 비교도 함께 본다.
 */
export function needsRepublish(flow: WizardFlow, published?: PublishedInfoLite | null): boolean {
  if (!published) return false;
  if (Number(flow.version) !== Number(published.version)) return true;
  const publishedAt = published.publishedAt ? Date.parse(published.publishedAt) : NaN;
  const updatedAt = flow.meta?.updatedAt ? Date.parse(String(flow.meta.updatedAt)) : NaN;
  if (Number.isFinite(publishedAt) && Number.isFinite(updatedAt)) return updatedAt > publishedAt;
  return false;
}

/** 실행하기 전에 사용자에게 값을 받아야 하는 변수. */
export function requiredRunVariables(flow: WizardFlow): WizardVariableDef[] {
  const variables = Array.isArray(flow.variables) ? flow.variables : [];
  return variables.filter((v) => {
    if (!v || typeof v.key !== 'string' || !v.key) return false;
    if (v.sensitive === true) return true;
    const fallback = v.default;
    return fallback === undefined || fallback === null || fallback === '';
  });
}

/**
 * 흐름 이름의 기본값. 사이트 제목이 있으면 제목, 없으면 도메인에 날짜를 붙인다.
 *
 * 날짜 구분에 점을 쓴다. 대시류 문자를 사용자에게 보이는 문구에 넣지 않기로 한 규칙 때문이다.
 */
export function defaultFlowName(input: { title?: string; url?: string; at?: Date }): string {
  const at = input.at ?? new Date();
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  const stamp = `${y}.${m}.${d}`;
  const title = (input.title || '').trim();
  if (title) return `${title.slice(0, 60)} ${stamp}`;
  let host = '';
  try {
    host = input.url ? new URL(input.url).hostname : '';
  } catch {
    host = '';
  }
  if (host) return `${host} ${stamp}`;
  return stamp;
}

/** 녹화 직후 자동으로 붙는 이름인가 (마법사가 기본 이름을 채워 줄지 판단). */
export function isPlaceholderFlowName(name: string | undefined): boolean {
  const trimmed = (name || '').trim();
  return trimmed === '' || trimmed === 'new_workflow';
}

/**
 * 저장 화면이 채워 넣을 이름의 기본값 (2026-09-05 시연 지적 2항).
 *
 * 재료는 **흐름 자신이 들고 있는 것만** 쓴다. 녹화 시작 시점의 탭 제목(`meta.startTitle`)이
 * 있으면 그것, 없으면 시작 주소의 도메인이다. 예전에는 "지금 활성 탭" 의 제목을 썼는데,
 * 녹화가 끝난 뒤 사용자가 다른 페이지로 옮겨 가 있으면 전혀 상관없는 이름이 채워졌다.
 */
export function defaultFlowNameForFlow(flow: WizardFlow, at: Date = new Date()): string {
  return defaultFlowName({ title: flow.meta?.startTitle, url: flow.startUrl, at });
}
