# 사이드패널 1단계: 녹화부터 발행까지 한 화면 (2026-09-05)

사용자 결정: 구버전 노드 빌더(`entrypoints/builder`, `builder.html`)는 폐기 → **삭제됨(2026-09-06, 3단계)**. 예약은 `chrome_shortcut` 예약 엔진으로 통일(record-replay 트리거 엔진은 UI 없이 그대로 둠). 1단계 4개를 먼저 끝내고 실제 녹화·발행·실행을 한 번 해 본 뒤 2단계로 간다.

## 배경(조사 결과, 2026-09-05)

- 팝업 녹화 시작·중지는 `showComingSoonToast` 로 막혀 있고(`entrypoints/popup/App.vue:464-474`), 사이드패널에는 녹화 버튼이 없다. 백그라운드는 `RR_START_RECORDING`/`RR_STOP_RECORDING` 을 이미 받는다(`entrypoints/background/record-replay/index.ts:232,238`).
- 사이드패널 새로 만들기·편집은 `alert('V3 Builder 尚未实现')`(`entrypoints/sidepanel/App.vue:453-463`).
- 발행은 `flow-store.ts:409 publishFlow(flow, slug?)` 가 있으나 `RR_PUBLISH_FLOW`/`RR_UNPUBLISH_FLOW` 를 부르는 Vue 코드가 없다. 그래서 `record_replay_list_published` 가 항상 빈 목록이다.
- 녹화기(`inject-scripts/recorder.js`)는 click·fill·change·checkbox·scroll·단축키를 잡고, URL 이동(navigate)은 잡지 않는다.
- `record_replay_flow_run` 은 작업 탭이 없으면 `no_work_tab` 으로 거절한다(`tools/record-replay.ts`, `docs/TOOLS.md:1308`).
- 사이드패널 문구는 중국어 104곳·영어 10곳 하드코딩(`sidepanel/App.vue`, `SidepanelNavigator.vue`, `loading-texts.ts`, `components/workflows/*.vue`). 팝업만 `getMessage` + `_locales/ko`(458키, `default_locale: ko`) 를 쓴다.

## 목표 사용 절차 (이것이 합격 기준의 뼈대)

1. 사이드패널을 연다 → 상단에 **녹화 시작** 버튼이 보인다.
2. 녹화 시작을 누르면 현재 활성 탭에서 녹화가 시작되고, 패널에 녹화 중 표시(빨간 점, 경과 시간, 잡힌 단계 수)와 **녹화 중지** 버튼이 뜬다.
3. 사이트에서 로그인·검색·페이지 이동 등을 한다. 페이지 이동도 단계로 잡힌다.
4. 녹화 중지를 누르면 **저장 화면(마법사) 한 장**이 뜬다. 항목: 이름(기본값 자동), 시작 URL(자동), 감지된 변수 목록(체크·이름·민감 여부), 단계 목록(읽기 전용, 단계 삭제만 가능), **시험 실행** 버튼, **저장하고 발행**(기본) / **저장만** 버튼.
5. 저장하고 발행을 누르면 목록 카드에 "발행됨" 배지가 붙고, Claude Code 에서 `record_replay_list_published` 에 나타난다.
6. Claude Code 에서 `record_replay_flow_run { flowId }` 만 호출하면(먼저 `chrome_navigate` 를 하지 않아도) 시작 URL 로 백그라운드 탭이 열리고 실행된다.
7. 위 모든 화면 문구가 한국어다.

## 작업 분할

### C. 사이드패널 한국어화 (sonnet, 먼저 시작)

- 대상: `entrypoints/sidepanel/**` 와 `components/workflows/**` 중 사이드패널에서 실제 import 되는 것. `entrypoints/builder/**` 와 `components/rr-v3/**` 는 **삭제됨(2026-09-06, 3단계)**.
- 방법: 팝업과 같은 `getMessage`(`utils/i18n.ts`) + `_locales/ko/messages.json` 키 추가. `_locales/en` 에도 같은 키를 영어로 추가(다른 로케일은 en 폴백이면 그대로). 키 이름은 `sidepanel_` 접두사.
- `loading-texts.ts` 의 중국어 49개는 한국어 문구로 교체(키로 뺄 필요 없이 파일 안에서 한국어 배열로 둬도 됨).
- 용어 통일: 흐름(flow), 발행(publish), 예약(schedule), 실행 이력(run history), 시험 실행(test run), 시작 URL, 변수, 민감값.
- 합격: `rg -n "[\u4e00-\u9fff]" entrypoints/sidepanel components/workflows` 가 0건(주석 제외 아님, 주석도 한국어로). 영어 UI 문구 0건(코드 식별자·로그 제외). `pnpm --filter auto-chrome-mcp-extension build` 성공. vitest 기존 통과 유지.

### B. 페이지 이동 녹화 + 시작 URL + 도구 실행 시 탭 자동 열기 (opus, C 와 병렬)

- 녹화기: 녹화 시작 시점의 URL 을 `startUrl` 로 기록. 전체 페이지 이동(문서 재로드)과 SPA 이동(pushState/replaceState/popstate) 을 `navigate` 단계로 잡는다. 클릭 직후 일어난 이동은 클릭 단계의 결과이므로 중복 navigate 단계를 만들지 않는다(클릭 단계에 `expectsNavigation` 같은 힌트를 두거나, 클릭 후 N초 안의 이동은 합친다. 방식은 구현자가 정하되 설계 근거를 문서에 남긴다).
- 흐름 모델: `startUrl` 필드 추가(V3 flow 타입, 저장·발행 스냅샷·내보내기에 포함). 마이그레이션은 "없으면 undefined" 로 충분.
- `record_replay_flow_run`: `startUrl` 인자가 없고 흐름에 `startUrl` 이 있으면 그것을 쓴다. 작업 탭이 없고 `startUrl` 이 정해지면 `chrome_navigate(background:true)` 와 같은 게이트 경로로 작업 탭을 만든 뒤 실행한다(엔진이 탭을 고르지 않는다는 원칙은 유지: 탭은 게이트가 만든다). 둘 다 없을 때만 `no_work_tab`.
- `packages/shared/src/tools.ts` 의 스키마는 바꾸지 않는다(설명 문구만 갱신 가능). 바꿔야만 한다면 이유를 결과에 적는다(바꾸면 전역 bridge 재발행이 필요하다).
- 합격: vitest 에 (1) navigate 단계 기록 (2) 클릭 유발 이동 중복 제거 (3) flow_run 의 startUrl 폴백·탭 자동 생성·둘 다 없을 때 no_work_tab 테스트 추가. `docs/TOOLS.md` 의 `record_replay_flow_run` 절 갱신. 기존 테스트 통과.

### A. 녹화 버튼 + 저장 마법사 + 발행 (opus, C 완료 후 시작)

- 사이드패널 상단 툴바에 녹화 시작/중지. 녹화 상태는 백그라운드가 진실이며(`RR_GET_RECORDING_STATE` 류가 없으면 추가), 패널을 닫았다 열어도 상태가 복원된다.
- 녹화 중지 → 저장 화면. 저장 화면은 별도 컴포넌트(`components/workflows/SaveFlowWizard.vue` 같은 이름) 하나. 기존 카드의 편집 버튼도 같은 화면을 연다(이름·시작 URL·변수·발행 상태·단계 삭제).
- 변수 자동 감지: 녹화된 fill 단계의 입력값을 후보로 보여준다. `type=password` 는 기본 체크 + 민감. 체크한 것은 흐름 변수로 바뀌고 단계 값은 `{{변수명}}` 참조가 된다. 민감 변수의 값은 흐름에 저장하지 않는다(실행 때 입력).
- 시험 실행: 새 백그라운드 탭에서 실행하고 결과(성공 단계 수/실패 단계/걸린 시간) 를 같은 화면에 표시.
- 저장하고 발행: `RR_PUBLISH_FLOW`(slug 자동). 저장만: 발행 안 함. 카드에 발행됨 배지 + 발행/발행 해제 토글.
- 팝업의 녹화 시작·중지 버튼: "준비 중" 대신 사이드패널을 열고 녹화를 시작한다. `createFlow()`/`edit()` 의 alert 는 제거.
- 새 문구는 전부 `getMessage` 키(`sidepanel_` 접두사, ko·en 둘 다).
- 합격: 위 "목표 사용 절차" 1~5·7 을 배포본 리로드 후 실제로 수행. vitest 에 변수 치환(값→`{{var}}`, 민감값 미저장) 과 발행 메시지 호출 테스트 추가. 빌드·기존 테스트 통과.

## Codex 2차 의견(GPT-5.6-sol)에서 1단계에 반영할 것

- 녹화 중지 시 이미 흐름이 자동 저장된다(`recording/recorder-manager.ts:227,255`). 마법사는 새 저장이 아니라 **방금 저장된 흐름을 여는 편집 화면**으로 만든다. 저장 실패 경로가 하나 줄어든다.
- 녹화기가 변수 후보를 이미 수집한다(`recording/session-manager.ts:404`). 마법사의 변수 자동 감지는 이 수집 결과를 우선 쓰고, 부족하면 fill 단계에서 보충한다.
- 사이드패널 목록 모델에 발행 여부·버전이 없다(`sidepanel/composables/useWorkflowsV3.ts:23`, `flow-store.ts:448`). 목록 조회에 `published`(발행 slug·버전) 를 실어 카드 배지를 그린다. "수정 후 재발행 필요" 상태(발행 스냅샷과 현재 flow 의 updatedAt 차이) 도 함께.
- 실행 실패가 콘솔·빈 catch 로 삼켜진다(`sidepanel/App.vue:446`, `useWorkflowsV3.ts:220`). 실행 결과는 토스트나 카드 상태로 보여준다.
- 2단계 메모: `record_replay_flow_run` 은 `chrome_shortcut` 단계 안에 넣을 수 없다(`docs/TOOLS.md:1311-1314`). 예약 통일은 "shortcut 단계로 흐름을 감싸기" 가 아니라 예약 레코드가 흐름 id 를 직접 가리키는 방식이어야 한다. 1단계에서는 손대지 않는다.

## 공통 규칙

- 사용자에게 보이는 한국어 문구에 대시류(U+2014, U+2013, U+3161, U+2015, U+2012, U+FF0D, U+2212) 금지. 문장을 다시 쓴다.
- 박스 왼쪽 세로 액센트 띠(`border-left`, `border-inline-start`, `::before` 세로 막대) 금지.
- 기존 도구·팝업·quick-panel 동작을 바꾸지 않는다. 빌더 폴더는 건드리지 않는다.
- 결과 보고에는 실행한 명령과 종료 코드, 추가·수정한 파일, 추가한 테스트 이름, 미해결 항목을 적는다. 하지 않은 검사를 했다고 쓰지 않는다.

## 검증 순서

1. `pnpm build:shared` → `pnpm --filter auto-chrome-mcp-extension build` → `pnpm --filter auto-chrome-mcp-extension test` → `pnpm --filter auto-chrome-mcp-bridge test`.
2. Codex 교차 리뷰(diff 기준).
3. 배포본 `C:/PROJECTS/auto-chrome-mcp-extension` 교체 + 확장 리로드(options.html 에서 `chrome.runtime.reload()`).
4. 실제 시연: example.com 또는 로그인 없는 사이트에서 녹화 → 저장하고 발행 → `record_replay_list_published` 1건 → `record_replay_flow_run` 성공.

## B 구현 메모 (2026-09-05 구현자 기록)

### 왜 navigate 단계를 배경에서만 만드는가

recorder.js 는 자기가 떠나는 이동을 끝까지 볼 수 없다. 전체 문서 이동은 content script 를
통째로 죽이고, SPA 의 `history.pushState` 는 **페이지 세계**에서 일어나므로 격리된 세계에서
도는 content script 가 가로챌 수 없다(MAIN world 주입이 필요한데, 그건 사용자 페이지에 코드를
심는 훨씬 큰 변경이다). 그래서 이동 관측은 `chrome.webNavigation` 한 곳으로 모았다.

- `onCommitted` (frameId 0): 전체 문서 이동
- `onHistoryStateUpdated` (frameId 0): pushState / replaceState
- `onReferenceFragmentUpdated` (frameId 0): 해시 이동

navigate 단계를 만드는 코드는 `recording/browser-event-listener.ts` → `recordNavigation()`
하나뿐이다. 두 곳에서 만들면 같은 이동이 두 단계가 된다.

### 클릭 유발 이동 판정 (중복 제거)

판정은 `RecordingSessionManager.recordNavigation()` 에 있고 세 단계다.

1. **중복 제거** - 같은 URL 이 `NAV_DEDUPE_WINDOW_MS`(1500ms) 안에 다시 들어오면 버린다.
   라우터가 커밋 직후 `replaceState` 를 부르면 한 번의 이동에 이벤트가 두 번 온다.
2. **원인 판정** - transitionType 과 transitionQualifiers 로 "사용자 조작만으로 일어난
   이동" 인지 본다. `typed`, `generated`, `keyword`, `keyword_generated`, `auto_bookmark`,
   `reload`, `start_page`, `auto_toplevel` 과 `forward_back` 자격자는 사용자 조작이다.
   이 이동들은 클릭과 시간이 가까워도 절대 합치지 않는다. 재생이 그 주소로 갈 방법이
   navigate 단계뿐이기 때문이다(주소창 입력·북마크·뒤로가기 요구사항).
3. **합치기** - 그 밖의 이동(link, form_submit, SPA 라우팅)은 직전
   `NAV_MERGE_WINDOW_MS`(3000ms) 안에 클릭·더블클릭·키 단계가 기록됐으면 별도 navigate
   단계를 만들지 않고, 그 단계에 `expectsNavigation: true` 와
   `after: { waitForNavigation: true }` 를 남긴다. 합친 뒤에는 기준점을 비워, 클릭 하나가
   그 뒤의 모든 이동을 삼키지 않게 한다.

값의 근거:

- 3000ms - 링크 클릭 후 커밋까지는 보통 1초 안쪽이지만 느린 서버·리다이렉트 체인은 2초를
  넘긴다. 더 키우면 "클릭하고 한참 뒤에 사용자가 스스로 이동한 것" 까지 삼켜 재생이 그
  페이지에 도달하지 못한다.
- 시간창만으로 판정하지 않고 transition 종류를 **먼저** 보는 이유: 클릭 직후 2초 만에
  주소창으로 이동해도 그것은 클릭의 결과가 아니다. 시간창은 보조 조건이다.
- 왜 `after.waitForNavigation` 인가: 이미 재생 엔진이 소비하는 필드다
  (`actions/handlers/click.ts`, `engine/runners/step-runner.ts`). 새 필드를 만들면 힌트가
  기록만 되고 아무도 읽지 않는다. `expectsNavigation` 은 사람이 읽는 표시로 함께 남긴다.
- 이 힌트를 **관측된 이동에만** 붙이는 이유: 오지 않을 이동을 기다리면 재생이 최대 15초를
  버리고 실패할 수 있다. recorder.js 가 붙이는 것은 `expectsNavigation` 뿐이고(진짜 문서로
  가는 링크와 폼 제출 컨트롤만), 엔진이 실제로 기다리게 만드는 값은 배경이 이동을 본 뒤에만
  붙인다.

### recorder.js 가 하는 일

`_clickExpectsNavigation()` 으로 클릭 대상이 진짜 문서로 가는 링크(`a[href]`, `#`·
`javascript:` 제외)이거나 폼 안의 제출 컨트롤이면 클릭 단계에 `expectsNavigation: true` 를
붙인다. 합치기 창을 놓쳐도 "이 클릭은 이동을 부른다" 는 사실이 흐름에 남는다.

### 작업 탭 자동 열기 (3항)

- 게이트(`utils/work-tab-gate.ts`)의 `NO_TAB_NEEDED` 에 `record_replay_flow_run` 을 넣어,
  작업 탭이 없다는 이유로 **게이트가 대신 거절하지 않게** 했다. 흐름을 읽어야 알 수 있는
  값(`flow.startUrl`)으로 판정이 갈리기 때문이다. 게이트의 fail-closed 근거는 "도구 구현이
  tabId 가 없으면 사용자의 활성 탭으로 fallback 한다" 인데, 이 도구에는 그 경로가 없다
  (engine/tab-context.ts, 소스 가드 테스트 tests/record-replay/no-active-tab-query.test.ts).
  작업 탭이 있으면 게이트가 tabId 를 주입하는 동작은 그대로다.
- 도구는 `startUrl` 인자 > `flow.startUrl` 순으로 시작 URL 을 고르고, 작업 탭이 없으면
  `handleCallTool(chrome_navigate, { background: true })` 를 불러 탭을 만든다. 즉 탭을 만드는
  주체는 여전히 게이트 쪽 코드이고, 만든 탭은 그 경로에서 이 세션의 작업 탭으로 등록된다.
  run 소유 탭으로 표시하지 않는다 - 이제 작업 탭이므로, 실행이 중단돼도 `chrome_navigate` 로
  만든 작업 탭과 똑같이 남는 것이 맞다.
- 방금 만든 탭에는 `tabTarget: 'new'` 를 한 번 더 적용하지 않는다(이미 새 탭이다).
- 응답에 `tabSource`(`work_tab` | `created_from_start_url` | `explicit`)를 실어 호출자가 어떤
  탭에서 돌았는지 되묻지 않아도 되게 했다.
- `packages/shared/src/tools.ts` 의 파라미터는 바꾸지 않았다(설명 문구만 갱신). 전역 bridge
  재발행이 필요 없다.

### Codex 교차 리뷰 반영 (2026-09-05, B 2차)

1. **다른 탭 이동 차단 (HIGH).** `browser-event-listener` 가 frameId 만 보고 있었다. 이제
   `session.hasTab(tabId)`(activeTabs 또는 originTabId)와 `documentLifecycle === 'active'` 를
   함께 확인한다. 판정 상태(직전 조작·중복 제거·이동 사슬)도 `Map<tabId, TabNavState>` 로
   탭마다 따로 둔다. 단계가 어느 탭에서 왔는지는 `appendSteps(steps, { tabId })` 로 받고,
   content script 경로는 `sender.tab.id` 를 넘긴다. 녹화기 주입도 세션 탭과 **세션 탭이 연
   탭**(openerTabId)에만 한다. 다만 `tabs.onActivated` 는 사용자가 직접 그 탭으로 옮긴
   조작이므로 예전처럼 무조건 세션에 넣는다.
2. **새로고침·뒤로가기가 중복으로 지워지던 문제 (HIGH).** 중복 제거를 `userDriven` 판정
   **뒤로** 옮겼다. 사용자 조작 이동은 창을 타지 않고 항상 기록되며, 중복 제거 키는
   `{tabId, url}` 이다.
3. **details.url 사용 + 세션 재확인 (MEDIUM).** `chrome.tabs.get()` 을 기다린 뒤 기록하던
   것을 없애고 이벤트가 실어 준 `details.url` 을 그대로 쓴다. 기록은 await 앞에서 동기로
   끝나므로 연속 이동에서 주소가 뒤바뀌지 않는다. await 가 남아 있는 주입·브로드캐스트
   경로는 시작 시점의 `sessionId` 를 잡아 두고 단계마다 다시 확인한다.
4. **이동이 클릭보다 먼저 도착하는 경우 (MEDIUM).** 방금 만든 navigate 단계를
   `pendingNav` 로 들고 있다가, `NAV_REVERSE_MERGE_WINDOW_MS`(1200ms) 안에 클릭·키 단계가
   도착하면 그 navigate 단계를 지우고 힌트를 새 단계로 옮긴다(되돌려 합치기). 사용자 조작
   이동은 이 후보가 되지 않는다. 리다이렉트·replaceState 사슬은 첫 합치기 뒤에도
   `NAV_CHAIN_WINDOW_MS`(2000ms) 안이면 같은 사슬로 흡수한다. 평범한 링크 이동은 흡수하지
   않는다(그것은 다음 조작의 결과다).
5. **key 단계 재생 대기 (MEDIUM).** `StepKey.after` 와 `KeyParams.after` 타입을 추가하고,
   `step-runner` 의 이동 대기 분기와 `actions/handlers/key.ts` 가 `after.waitForNavigation`
   (및 `waitForNetworkIdle`)을 소비하게 했다. 표시가 없는 key 는 예전 그대로 아무 대기도
   하지 않는다 - 짧은 정찰 대기(`maybeQuickWaitForNav`)는 클릭 전용으로 남겼다.
6. **시작 페이지 두 번 로드 (LOW).** `prepareRunTab` 은 탭이 이미 그 주소면 다시 이동시키지
   않는다(`isSameUrlForPrepare`). 그리고 도구가 시작 URL 로 탭을 방금 연 경우에 한해,
   첫 노드가 같은 주소의 navigate 이고 그 노드로 들어오는 간선이 없으면 그 단계를 뺀 복사본을
   실행한다(`stripLeadingStartUrlNavigate`). 사이드패널 Run 경로는 그대로 두었으므로 첫
   navigate 노드에 의존하는 기존 동작은 깨지지 않는다.

### 설계와 달리한 점

- 설계 문서는 "녹화기(recorder.js)가 페이지 이동을 잡는다" 고 적었지만, 위의 격리 세계 제약
  때문에 navigate 단계 생성은 배경으로 옮겼다. recorder.js 는 힌트만 붙인다.
- `tests/utils/work-tab-gate.test.ts` 의 "전역 OFF + 작업 탭 없음이면 no_work_tab 으로
  거절한다" 는 게이트 단위 테스트를 새 계약(게이트는 통과시키고 도구가 거절한다)에 맞게
  고쳤다. 모델이 보는 오류 문구·코드는 그대로 `no_work_tab` 이다.
- 되돌려 합치기(교차 리뷰 4) 때문에 "navigate 단계가 생긴 직후 1.2초 안에 도착한 클릭" 은
  그 navigate 단계를 지운다. 지연 전송을 감당하려면 필요한 규칙이지만, 이동과 무관한 클릭이
  바로 뒤따르는 경우에는 정당한 navigate 단계가 사라진다. 창을 짧게(1.2초) 잡아 위험을
  줄였고, 사용자 조작 이동은 아예 후보에서 뺐다.
