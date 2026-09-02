// node-specs-builtin.ts — builtin NodeSpecs shared for UI + runtime
import type { NodeSpec } from './node-spec';
import { registerNodeSpec } from './node-spec-registry';
import { STEP_TYPES } from './step-types';

export function registerBuiltinSpecs() {
  const nav: NodeSpec = {
    type: STEP_TYPES.NAVIGATE,
    version: 1,
    display: { label: '이동', iconClass: 'icon-navigate', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'url',
        label: 'URL',
        type: 'string',
        required: true,
        placeholder: 'https://example.com',
        help: '이동할 주소 (변수 템플릿 {var}',
        default: '',
      },
    ],
    defaults: { url: '' },
    validate: (cfg) => {
      const errs: string[] = [];
      if (!cfg || !cfg.url || String(cfg.url).trim() === '') errs.push('URL 필수');
      return errs;
    },
  };
  registerNodeSpec(nav);

  // Click / Dblclick
  registerNodeSpec({
    type: STEP_TYPES.CLICK,
    version: 1,
    display: { label: '클릭', iconClass: 'icon-click', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'target',
        label: '대상',
        type: 'json',
        widget: 'targetlocator',
        help: '엘리먼트 셀렉터 선택 또는 입력',
      },
      {
        key: 'before',
        label: '실행 전',
        type: 'object',
        fields: [
          { key: 'scrollIntoView', label: '스크롤하여 보이게', type: 'boolean', default: true },
          { key: 'waitForSelector', label: '셀렉터 대기', type: 'boolean', default: true },
        ],
      },
      {
        key: 'after',
        label: '실행 후',
        type: 'object',
        fields: [
          { key: 'waitForNavigation', label: '이동 완료 대기', type: 'boolean', default: false },
          {
            key: 'waitForNetworkIdle',
            label: '네트워크 유휴 대기',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
    defaults: { before: { scrollIntoView: true, waitForSelector: true }, after: {} },
  });
  registerNodeSpec({
    type: STEP_TYPES.DBLCLICK,
    version: 1,
    display: { label: '더블클릭', iconClass: 'icon-click', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '대상', type: 'json', widget: 'targetlocator' },
      {
        key: 'before',
        label: '실행 전',
        type: 'object',
        fields: [
          { key: 'scrollIntoView', label: '스크롤하여 보이게', type: 'boolean', default: true },
          { key: 'waitForSelector', label: '셀렉터 대기', type: 'boolean', default: true },
        ],
      },
      {
        key: 'after',
        label: '실행 후',
        type: 'object',
        fields: [
          { key: 'waitForNavigation', label: '이동 완료 대기', type: 'boolean', default: false },
          {
            key: 'waitForNetworkIdle',
            label: '네트워크 유휴 대기',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
    defaults: { before: { scrollIntoView: true, waitForSelector: true }, after: {} },
  });

  // Fill
  registerNodeSpec({
    type: STEP_TYPES.FILL,
    version: 1,
    display: { label: '채우기', iconClass: 'icon-fill', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '대상', type: 'json', widget: 'targetlocator' },
      { key: 'value', label: '입력값', type: 'string', required: true, help: '{var} 템플릿 지원' },
    ],
    defaults: { value: '' },
  });

  // Key
  registerNodeSpec({
    type: STEP_TYPES.KEY,
    version: 1,
    display: { label: '키보드', iconClass: 'icon-key', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'keys',
        label: '키 시퀀스',
        type: 'string',
        widget: 'keysequence',
        required: true,
        help: '예: Backspace, Enter 등 cmd+a',
      },
      { key: 'target', label: '포커스 대상 (선택)', type: 'json', widget: 'targetlocator' },
    ],
    defaults: { keys: '' },
  });

  // Scroll
  registerNodeSpec({
    type: STEP_TYPES.SCROLL,
    version: 1,
    display: { label: '스크롤', iconClass: 'icon-scroll', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'mode',
        label: '모드',
        type: 'select',
        options: [
          { label: '엘리먼트', value: 'element' },
          { label: '오프셋', value: 'offset' },
          { label: '컨테이너', value: 'container' },
        ] as any,
        default: 'offset',
      },
      { key: 'target', label: '대상 (엘리먼트/컨테이너)', type: 'json', widget: 'targetlocator' },
      {
        key: 'offset',
        label: '오프셋',
        type: 'object',
        fields: [
          { key: 'x', label: 'X', type: 'number' },
          { key: 'y', label: 'Y', type: 'number' },
        ],
      },
    ],
    defaults: { mode: 'offset', offset: { x: 0, y: 300 } },
  });

  // Drag
  registerNodeSpec({
    type: STEP_TYPES.DRAG,
    version: 1,
    display: { label: '드래그', iconClass: 'icon-drag', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'start', label: '시작점', type: 'json', widget: 'targetlocator' },
      { key: 'end', label: '끝점', type: 'json', widget: 'targetlocator' },
      {
        key: 'path',
        label: '경로 좌표',
        type: 'array',
        item: {
          key: 'p',
          label: '포인트',
          type: 'object',
          fields: [
            { key: 'x', label: 'X', type: 'number' },
            { key: 'y', label: 'Y', type: 'number' },
          ],
        } as any,
      },
    ],
    defaults: {},
  });

  // Wait
  registerNodeSpec({
    type: STEP_TYPES.WAIT,
    version: 1,
    display: { label: '대기', iconClass: 'icon-wait', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'condition',
        label: '조건(JSON)',
        type: 'json',
        help: '예: {"sleep":1000} 등 {"text":"Hello","appear":true}',
      },
    ],
    defaults: { condition: { sleep: 500 } },
  });

  // Assert
  registerNodeSpec({
    type: STEP_TYPES.ASSERT,
    version: 1,
    display: { label: '검증', iconClass: 'icon-assert', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }, { label: 'onError' }] },
    schema: [
      {
        key: 'assert',
        label: '검증(JSON)',
        type: 'json',
        help: '예 {"exists":"#id"} / {"visible":".btn"}',
      },
      {
        key: 'failStrategy',
        label: '실패 전략',
        type: 'select',
        options: [
          { label: '중지', value: 'stop' },
          { label: '경고', value: 'warn' },
          { label: '재시도', value: 'retry' },
        ] as any,
        default: 'stop',
      },
    ],
    defaults: { assert: {} },
  });

  // HTTP
  registerNodeSpec({
    type: STEP_TYPES.HTTP,
    version: 1,
    display: { label: 'HTTP', iconClass: 'icon-http', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'method',
        label: '메서드',
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({
          label: m,
          value: m,
        })) as any,
        default: 'GET',
      },
      { key: 'url', label: 'URL', type: 'string', required: true },
      { key: 'headers', label: '요청 헤더(JSON)', type: 'json' },
      { key: 'body', label: '요청 본문(JSON)', type: 'json' },
      { key: 'formData', label: '폼(JSON)', type: 'json' },
      { key: 'saveAs', label: '변수로 저장', type: 'string' },
      { key: 'assign', label: '매핑(JSON)', type: 'json' },
    ],
    defaults: { method: 'GET' },
  });

  // Extract
  registerNodeSpec({
    type: STEP_TYPES.EXTRACT,
    version: 1,
    display: { label: '추출', iconClass: 'icon-extract', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: '셀렉터', type: 'string', widget: 'selector' },
      {
        key: 'attr',
        label: '속성',
        type: 'select',
        options: [
          { label: '텍스트(text)', value: 'text' },
          { label: '텍스트(textContent)', value: 'textContent' },
          { label: '커스텀 속성명', value: 'attr' },
        ] as any,
      },
      { key: 'js', label: '커스텀JS', type: 'string', help: '페이지에서 실행 후 값 반환' },
      { key: 'saveAs', label: '변수 저장', type: 'string', required: true },
    ],
    defaults: { saveAs: '' },
  });

  // Screenshot
  registerNodeSpec({
    type: STEP_TYPES.SCREENSHOT,
    version: 1,
    display: { label: '스크린샷', iconClass: 'icon-screenshot', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: '대상셀렉터', type: 'string' },
      { key: 'fullPage', label: '전체 페이지 스크린샷', type: 'boolean', default: false },
      { key: 'saveAs', label: '변수 저장', type: 'string' },
    ],
    defaults: { fullPage: false },
  });

  // TriggerEvent
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER_EVENT,
    version: 1,
    display: { label: '트리거 이벤트', iconClass: 'icon-trigger', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '대상', type: 'json', widget: 'targetlocator' },
      { key: 'event', label: '이벤트 타입', type: 'string', required: true },
      { key: 'bubbles', label: '버블', type: 'boolean', default: true },
      { key: 'cancelable', label: '취소 가능', type: 'boolean', default: false },
    ],
    defaults: { event: '' },
  });

  // SetAttribute
  registerNodeSpec({
    type: STEP_TYPES.SET_ATTRIBUTE,
    version: 1,
    display: { label: '속성 설정', iconClass: 'icon-attr', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '대상', type: 'json', widget: 'targetlocator' },
      { key: 'name', label: '속성 이름', type: 'string', required: true },
      { key: 'value', label: '속성 값', type: 'string' },
      { key: 'remove', label: '속성 제거', type: 'boolean', default: false },
    ],
    defaults: { remove: false },
  });

  // LoopElements
  registerNodeSpec({
    type: STEP_TYPES.LOOP_ELEMENTS,
    version: 1,
    display: { label: '루프 요소', iconClass: 'icon-loop', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: '셀렉터', type: 'string', required: true },
      { key: 'saveAs', label: '리스트 변수명', type: 'string', default: 'elements' },
      { key: 'itemVar', label: '아이템 변수명', type: 'string', default: 'item' },
      { key: 'subflowId', label: '서브플로우 ID', type: 'string', required: true },
    ],
    defaults: { saveAs: 'elements', itemVar: 'item' },
  });

  // SwitchFrame
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_FRAME,
    version: 1,
    display: { label: '전환Frame', iconClass: 'icon-frame', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'frame',
        label: 'frame위치',
        type: 'object',
        fields: [
          { key: 'index', label: '인덱스', type: 'number' },
          { key: 'urlContains', label: 'URL포함', type: 'string' },
        ],
      },
    ],
    defaults: {},
  });

  // HandleDownload
  registerNodeSpec({
    type: STEP_TYPES.HANDLE_DOWNLOAD,
    version: 1,
    display: { label: '다운로드 처리', iconClass: 'icon-download', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'filenameContains', label: '파일명 포함', type: 'string' },
      { key: 'waitForComplete', label: '완료 대기', type: 'boolean', default: true },
      { key: 'timeoutMs', label: '타임아웃(ms)', type: 'number', default: 60000 },
      { key: 'saveAs', label: '변수 저장', type: 'string' },
    ],
    defaults: { waitForComplete: true, timeoutMs: 60000 },
  });

  // Script
  registerNodeSpec({
    type: STEP_TYPES.SCRIPT,
    version: 1,
    display: { label: '스크립트', iconClass: 'icon-script', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'world',
        label: '실행 컨텍스트',
        type: 'select',
        options: [
          { label: 'ISOLATED', value: 'ISOLATED' },
          { label: 'MAIN', value: 'MAIN' },
        ] as any,
        default: 'ISOLATED',
      },
      { key: 'code', label: '스크립트 코드', type: 'string', widget: 'code', required: true },
      {
        key: 'when',
        label: '실행 타이밍',
        type: 'select',
        options: [
          { label: 'before', value: 'before' },
          { label: 'after', value: 'after' },
        ] as any,
        default: 'after',
      },
      { key: 'assign', label: '매핑(JSON)', type: 'json' },
      { key: 'saveAs', label: '변수 저장', type: 'string' },
    ],
    defaults: { world: 'ISOLATED', when: 'after' },
  });

  // Tabs
  registerNodeSpec({
    type: STEP_TYPES.OPEN_TAB,
    version: 1,
    display: { label: '탭 열기', iconClass: 'icon-openTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'url', label: 'URL', type: 'string' },
      { key: 'newWindow', label: '새 창', type: 'boolean', default: false },
    ],
    defaults: { newWindow: false },
  });
  registerNodeSpec({
    type: 'executeFlow' as any,
    version: 1,
    display: { label: '서브플로우 실행', iconClass: 'icon-exec', category: 'Flow' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'flowId', label: '플로우ID', type: 'string', required: true },
      { key: 'inline', label: '인라인 실행', type: 'boolean', default: false },
      { key: 'args', label: '파라미터(JSON)', type: 'json' },
    ],
    defaults: { inline: false },
  });
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_TAB,
    version: 1,
    display: { label: '탭 전환', iconClass: 'icon-switchTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'tabId', label: 'TabId', type: 'number' },
      { key: 'urlContains', label: 'URL포함', type: 'string' },
      { key: 'titleContains', label: '제목 포함', type: 'string' },
    ],
    defaults: {},
  });
  registerNodeSpec({
    type: STEP_TYPES.CLOSE_TAB,
    version: 1,
    display: { label: '탭 닫기', iconClass: 'icon-closeTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'tabIds',
        label: 'TabIds',
        type: 'array',
        item: { key: 'id', label: 'id', type: 'number' } as any,
      },
      { key: 'url', label: 'URL', type: 'string' },
    ],
    defaults: {},
  });

  // Logic
  registerNodeSpec({
    type: STEP_TYPES.IF,
    version: 1,
    display: { label: '조건', iconClass: 'icon-if', category: 'Logic' },
    ports: { inputs: 1, outputs: 'any' },
    schema: [
      {
        key: 'condition',
        label: '조건표현식(JSON)',
        type: 'json',
        help: '예: {"expression":"vars.a>0"} 등',
      },
      {
        key: 'branches',
        label: '분기',
        type: 'array',
        item: {
          key: 'b',
          label: 'case',
          type: 'object',
          fields: [
            { key: 'id', label: 'ID', type: 'string' },
            { key: 'name', label: '이름', type: 'string' },
            { key: 'expr', label: '표현식', type: 'string' },
          ],
        } as any,
      },
      { key: 'else', label: '활성화 else', type: 'boolean', default: true },
    ],
    defaults: { else: true },
  });
  registerNodeSpec({
    type: STEP_TYPES.FOREACH,
    version: 1,
    display: { label: '루프', iconClass: 'icon-foreach', category: 'Logic' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'listVar', label: '리스트 변수', type: 'string', required: true },
      { key: 'itemVar', label: '아이템 변수', type: 'string', default: 'item' },
      { key: 'subflowId', label: '서브플로우 ID', type: 'string', required: true },
      {
        key: 'concurrency',
        label: '병렬 개수',
        type: 'number',
        default: 1,
        help: '병렬 서브플로우 실행 (변수 얕은 복사, 자동 병합 X）',
      },
    ],
    defaults: { itemVar: 'item' },
  });
  registerNodeSpec({
    type: STEP_TYPES.WHILE,
    version: 1,
    display: { label: '루프', iconClass: 'icon-while', category: 'Logic' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'condition', label: '조건(JSON)', type: 'json' },
      { key: 'subflowId', label: '서브플로우 ID', type: 'string', required: true },
      { key: 'maxIterations', label: '최대 횟수', type: 'number', default: 100 },
    ],
    defaults: { maxIterations: 100 },
  });

  // Delay (UI-only helper)
  registerNodeSpec({
    type: STEP_TYPES.DELAY,
    version: 1,
    display: { label: '지연', iconClass: 'icon-delay', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'sleep',
        label: '지연',
        type: 'number',
        widget: 'duration',
        required: true,
        default: 1000,
      },
    ],
    defaults: { sleep: 1000 },
  });

  // Trigger (builder-only, flow-level node)
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER,
    version: 1,
    display: { label: '트리거', iconClass: 'icon-trigger', category: 'Flow' },
    ports: { inputs: 0, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'enabled', label: '활성화', type: 'boolean', default: true },
      { key: 'description', label: '설명', type: 'string' },
      {
        key: 'modes',
        label: '모드',
        type: 'object',
        fields: [
          { key: 'manual', label: '수동', type: 'boolean', default: true },
          { key: 'url', label: 'URL 트리거', type: 'boolean', default: false },
          { key: 'contextMenu', label: '오른쪽 클릭 메뉴', type: 'boolean', default: false },
          { key: 'command', label: '단축키', type: 'boolean', default: false },
          { key: 'dom', label: 'DOM 이벤트', type: 'boolean', default: false },
          { key: 'schedule', label: '예약', type: 'boolean', default: false },
        ],
      },
      {
        key: 'url',
        label: 'URL 규칙',
        type: 'object',
        fields: [
          {
            key: 'rules',
            label: '규칙 목록',
            type: 'array',
            item: {
              key: 'rule',
              label: '규칙',
              type: 'object',
              fields: [
                {
                  key: 'kind',
                  label: '타입',
                  type: 'select',
                  options: [
                    { label: 'URL', value: 'url' },
                    { label: '도메인', value: 'domain' },
                    { label: '경로', value: 'path' },
                  ] as any,
                  default: 'url',
                },
                { key: 'value', label: '값', type: 'string' },
              ],
            } as any,
          },
        ],
      },
      {
        key: 'contextMenu',
        label: '오른쪽 클릭 메뉴',
        type: 'object',
        fields: [
          { key: 'title', label: '제목', type: 'string', default: '워크플로우 실행' },
          { key: 'enabled', label: '활성화', type: 'boolean', default: false },
        ],
      },
      {
        key: 'command',
        label: '단축키',
        type: 'object',
        fields: [
          { key: 'commandKey', label: '단축키', type: 'string' },
          { key: 'enabled', label: '활성화', type: 'boolean', default: false },
        ],
      },
      {
        key: 'dom',
        label: 'DOM 이벤트',
        type: 'object',
        fields: [
          { key: 'selector', label: '셀렉터', type: 'string' },
          { key: 'appear', label: '등장', type: 'boolean', default: true },
          { key: 'once', label: '1회', type: 'boolean', default: true },
          { key: 'debounceMs', label: '디바운스(ms)', type: 'number', default: 800 },
          { key: 'enabled', label: '활성화', type: 'boolean', default: false },
        ],
      },
      {
        key: 'schedules',
        label: '예약',
        type: 'array',
        item: {
          key: 'sched',
          label: '계획',
          type: 'object',
          fields: [
            { key: 'id', label: 'ID', type: 'string' },
            {
              key: 'type',
              label: '타입',
              type: 'select',
              options: [
                { label: '1회', value: 'once' },
                { label: '간격', value: 'interval' },
                { label: '매일', value: 'daily' },
              ] as any,
            },
            { key: 'when', label: '시간(ISO/cron)', type: 'string' },
            { key: 'enabled', label: '활성화', type: 'boolean', default: true },
          ],
        } as any,
      },
    ],
    defaults: { enabled: true },
  });
}
