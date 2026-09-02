# 무간섭 모드 완성 설계 (2026-09-02)

## 배경

사용자 불만: "MCP가 새 크롬 탭을 띄우면 백그라운드에 머물지 않고 실제로 앞에 떠서, 내가 PC를 쓰는 중에 방해가 된다."

2026-09-02 코드 조사(읽기 전용)로 확인한 원인. 파일 경로는 `app/chrome-extension/` 기준.

1. 작업 창 기본값이 `'current'`(`utils/mcp-window-manager.ts:31`). v1.1.0에서는 `dedicated`가 기본이었으나 v1.4.0에서 바뀌었다. `getCurrentUserWindowId()`(같은 파일 161~186)는 `chrome.windows.getLastFocused()`를 1순위로 고르므로, MCP는 사용자가 지금 쓰는 바로 그 창에 탭을 만든다. 이 상태에서 탭 활성화가 한 번이라도 일어나면 사용자 화면에서 일어난다.
2. `utils/focus-policy.ts`의 강제 포커스 토글(기본 OFF)은 `windows.update({focused:true})`만 막는다. 파일 상단 주석이 명시하듯 `tabs.update({active:true})`, `tabs.create({active:true})`는 범위 밖이다.
3. 전용 작업 창을 켜도(`mcp-window-manager.ts:125~132`) `focused:false`일 뿐 `state`, `left`, `top` 지정이 없어 화면에 보이는 일반 창으로 뜬다. 페이지가 스스로 여는 팝업에는 `utils/spawned-tab-tracker.ts:36~59`의 "300ms/1200ms 지연 후 두 번 focused:false" 완화책이 있지만, MCP가 직접 만드는 창에는 없다.
4. `tools/browser/common.ts:518~532`: `newWindow:true`가 아니어도 `width`/`height`만 지정하면 새 창을 만든다. `docs/TOOLS.md` 예제가 이 패턴을 권한다.
5. `record-replay/actions/handlers/tabs.ts:176~185`: 플로우 재생의 `switchTab`이 백그라운드 게이트 없이 무조건 `tabs.update({active:true})`.
6. `common.ts:660~720`의 폴백 두 곳: "마지막 포커스 창" 폴백은 `background!==true`면 활성 탭을 만들고, 최후 폴백(712~720)은 `background` 인자를 아예 참조하지 않는다.
7. `docs/TOOLS.md:39~41, 131`은 `background` 기본값을 false라고 적었지만 실제 런타임 기본값은 true(`tools/index.ts:145~148`의 중앙 게이트). 문서를 믿고 `background:false`를 넣는 순간 활성화 분기가 열린다.

스크린샷은 CDP `Page.captureScreenshot`이 1순위(`tools/browser/screenshot.ts:382~403`)라 탭 활성화가 필요 없다. `captureVisibleTab`은 폴백이며 비활성 탭이면 활성화하지 않고 에러를 낸다. 따라서 포커스를 없애도 캡처가 깨질 위험은 낮다.

## 목표

**기본 설정 그대로 설치한 사용자가 MCP 작업 중 아무 방해도 받지 않는다.** 구체적으로, MCP가 `chrome_navigate`, `chrome_screenshot`, `chrome_click_element`, `chrome_get_web_content`, `chrome_read_page`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_scroll_collect`를 아무 순서로 호출해도

- 사용자의 활성 창(OS 포커스)이 바뀌지 않는다.
- 사용자 창의 활성 탭이 바뀌지 않는다.
- 사용자 화면에 새 창이 떠서 보이지 않는다.
- 그러면서 스크린샷은 정상(빈 이미지가 아님)으로 찍히고 클릭·입력은 동작한다.

예외는 사용자가 명시적으로 요청하는 두 도구뿐이다. `chrome_switch_tab`(탭을 앞으로 가져오라는 요청 자체)과 `chrome_request_element_selection`(사용자가 화면에서 요소를 골라야 함), 그리고 `chrome_request_user_consent`(사용자 대면 동작).

## 목표가 아닌 것

- 사용자가 `강제 포커스` 토글을 직접 켠 경우의 동작 변경. 켜면 지금처럼 포커스를 가져온다.
- 녹화·재생 기능 자체의 완성이나 제거(별도 후보 5번).
- npm 발행, GitHub 릴리스. 이 라운드는 로컬 빌드와 배포 폴더 교체까지만 한다.
- Playwright 폴백 경로. 네이티브 메시징 경로만 다룬다.

## 설정과 기본값

| 키 (`chrome.storage.local`)                                               | 값                                            | 새 기본값                            | 비고                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `mcpWorkWindowMode`                                                       | `'current'` \| `'dedicated'`                  | **`'dedicated'`** (기존 `'current'`) | 구버전 호환 키 `dedicatedWorkWindow`(boolean)도 계속 같이 기록 |
| `mcpWorkWindowPlacement` (신설)                                           | `'minimized'` \| `'offscreen'` \| `'visible'` | 아래 "배치 결정" 참조                | 전용 창을 어떻게 숨길지                                        |
| `forceFocusOnToolCall`                                                    | boolean                                       | `false` (변경 없음)                  |                                                                |
| `backgroundWorkMode` (기존 키 이름은 `utils/background-mode.ts`에서 확인) | boolean                                       | 변경 없음                            |                                                                |

**이미 값을 저장한 사용자**는 저장값을 그대로 존중한다. 저장값이 없을 때만 새 기본값이 적용된다. 단, 팝업에 "무간섭 모드 권장 설정으로 되돌리기" 버튼 하나를 두어 한 번에 `dedicated` + 권장 배치로 맞출 수 있게 한다.

### 배치 결정 (구현 중 실측으로 확정)

`'minimized'`는 `chrome.windows.create({state:'minimized'})`로 만든다. 크롬은 최소화된 창의 렌더링을 멈출 수 있어 CDP 캡처가 빈 이미지가 될 위험이 있다. 이 저장소에는 백그라운드 탭용 프레임 펌프(`utils/render-keepalive.ts`)가 이미 있으므로, 최소화 창에서도 같은 장치를 붙였을 때 캡처가 정상인지 **실제 크롬으로 실측**한다.

- 최소화 + 프레임 펌프에서 `chrome_screenshot`(뷰포트·전체 페이지·요소)이 3회 연속 정상이면 기본값은 `'minimized'`.
- 하나라도 빈 이미지가 나오면 기본값은 `'offscreen'`. 오프스크린은 `state:'normal'`로 만든 뒤 `windows.update({left, top})`으로 화면 밖으로 밀되, 크롬이 좌표를 화면 안으로 되돌리는지(클램핑) 확인해 되돌리면 "가장 작은 크기로 화면 구석"을 차선으로 한다.
- 실측 결과와 선택 근거를 `docs/CHANGELOG.md`와 이 문서 끝의 "실측 기록" 절에 남긴다. 추정으로 적지 않는다.

`'visible'`은 지금 동작(보이는 일반 창)이며 디버깅용으로만 남긴다.

## 동작 변경 항목

### A. 전용 작업 창 생성 (`utils/mcp-window-manager.ts`)

1. `focused:false` 유지. 배치 설정에 따라 `state` 또는 좌표 적용.
2. 생성 직후 `spawned-tab-tracker.ts`의 지연 이중 포커스 해제(300ms, 1200ms에 `windows.update({focused:false})`)를 재사용한다. 그 함수를 공용 유틸로 빼서 두 곳이 같은 코드를 쓰게 한다.
3. 생성 전 사용자의 마지막 포커스 창 id를 기록해 두고, 이중 해제 후에도 OS 포커스가 우리 창에 있으면 `windows.update(userWindowId, {focused:true})`로 **사용자 창을 되돌린다**. 이때만 예외적으로 focused:true를 쓰며, 대상은 반드시 사용자 창이어야 한다.
4. 전용 창이 사용자에 의해 닫히면 다음 호출에서 같은 규칙으로 다시 만든다(지금 로직 유지).

### B. `openInNewWindow` 경로 (`tools/browser/common.ts:518~532`)

1. `width`/`height`만으로는 새 창을 만들지 않는다. 뷰포트 크기 요구는 `tools/browser/computer.ts:322~335`가 이미 쓰는 CDP `Emulation.setDeviceMetricsOverride`로 작업 탭에 적용한다.
2. `newWindow:true`일 때만 새 창을 만들고, 그 창도 A의 관리자(배치·이중 해제·복귀)를 통해 만든다. 직접 `chrome.windows.create`를 호출하는 곳이 남지 않게 한다.
3. `docs/TOOLS.md`의 `newWindow:true,width,height` 예제를 새 동작에 맞게 고친다.

### C. `'current'` 모드 (사용자가 직접 고른 경우)

새 탭은 항상 `active:false`. 지금도 그렇지만(`common.ts:629` `active: dedicated`), 폴백 두 곳(660~720)이 `background` 인자에 따라 활성 탭을 만들 수 있으므로 **폴백에서도 `active:false` 고정, `focusWindowIfAllowed`만 호출**로 바꾼다. 최후 폴백(712~720)은 `background` 인자를 참조하도록 고친다.

### D. 플로우 재생의 `switchTab` (`record-replay/actions/handlers/tabs.ts`)

`base-browser.ts:189~205`의 `ensureFocus()`와 같은 백그라운드 게이트를 적용한다. 백그라운드 모드가 켜져 있으면 `tabs.update({active:true})`를 부르지 않고 작업 탭 포인터만 바꾼다. 플로우 단계에 `foreground:true`를 명시한 경우만 예외. 기존 저장 플로우는 값이 없으므로 게이트를 탄다.

### E. 명시적 예외 도구

`chrome_switch_tab`, `chrome_request_element_selection`, `chrome_request_user_consent`는 지금처럼 `GATE_EXEMPT_TOOLS`에 둔다. 대신 `packages/shared/src/tools.ts`의 `chrome_switch_tab` 설명에 "사용자가 탭을 앞으로 가져오라고 명시적으로 요청했을 때만 사용. 자동화 단계에서 작업 탭을 바꾸려면 `chrome_set_work_tab`을 사용"을 넣는다. 이 설명은 bridge에 번들되므로 다음 bridge 발행 때 반영된다는 점을 CHANGELOG에 적는다.

### F. 팝업 UI (`entrypoints/popup/App.vue`)

- "전용 작업 창" 토글 기본 ON.
- 배치 선택(최소화 / 화면 밖 / 보이게) 추가. 기본값은 실측으로 확정한 값.
- "무간섭 모드 권장 설정으로 되돌리기" 버튼.
- 강제 포커스 토글 설명에 "탭 활성화는 이 토글과 무관하게 전용 작업 창 안에서만 일어난다"를 한 줄 추가.

### G. 문서

- `docs/TOOLS.md`: `background` 기본값을 true로 정정(39~41, 131). B의 예제 수정.
- `README.md`, `docs/INSTALL-GUIDE-ko.md`: "무간섭 모드" 절 신설. 기본 동작, 방해받을 때 확인할 토글 2개, 예외 도구 3개.
- `docs/CHANGELOG.md`: 변경 항목과 배치 실측 결과.
- `docs/REGRESSION_CASES.md`: 아래 회귀 케이스 추가.

## 테스트

### 단위 테스트 (vitest, chrome API 모킹)

1. 전용 창 생성 시 `focused:false`와 배치 설정이 `windows.create` 인자에 반영된다.
2. 생성 후 300ms, 1200ms에 `windows.update({focused:false})`가 호출된다. 사용자 창 id가 기록돼 있고 포커스가 남아 있으면 사용자 창으로 복귀 호출이 한 번 나간다.
3. `width`/`height`만 있는 `chrome_navigate`는 `windows.create`를 부르지 않고 `Emulation.setDeviceMetricsOverride`를 부른다.
4. `newWindow:true`는 관리자 경로로만 창을 만든다(직접 `windows.create` 호출 0회).
5. 폴백 두 곳이 `active:true`로 탭을 만들지 않는다.
6. 플로우 `switchTab`은 백그라운드 모드 ON이면 `tabs.update({active:true})`를 부르지 않고, `foreground:true`면 부른다.
7. 저장값이 없으면 `mcpWorkWindowMode`가 `'dedicated'`, 저장값이 있으면 그대로다.

### 실기 회귀 (실제 크롬, 배포 후)

`docs/REGRESSION_CASES.md`에 "사용자 활성 탭 불변" 케이스를 추가하고 다음 절차로 확인한다.

1. 사용자 창에서 활성 탭 id와 `windows.getLastFocused().id`를 기록.
2. 새 세션에서 `chrome_navigate`(예: https://example.com 과 https://news.ycombinator.com), `chrome_screenshot` 3종, `chrome_click_element`, `chrome_get_web_content`, `chrome_read_page`, `chrome_scroll_collect` 실행.
3. 사용자 창의 활성 탭 id와 마지막 포커스 창 id가 1과 같다.
4. 스크린샷 3종의 파일 크기가 0이 아니고, 이미지를 열어 실제 페이지가 보인다(단색 이미지가 아님).
5. 화면에 새 창이 보이지 않는다(최소화면 작업 표시줄에만 있음).

## 손대지 않는 것

- 배포 폴더 `C:\PROJECTS\auto-chrome-mcp-extension`의 이름·위치. 내용만 교체한다.
- 백업 폴더 두 개(`...-backup-1.4.2`, `...-backup-1.7.0`). 삭제는 사용자 확인 후 별도로.
- npm 발행, GitHub 릴리스, `npm i -g`. 세션 안에서 실행하지 않는다.
- 녹화·재생 기능의 다른 부분, Playwright 폴백, 사이트 권한 정책.

## 버전

`1.8.0` → `1.9.0`으로 모노레포 전체(루트, 확장, native-server, shared)를 같이 올린다. 발행은 하지 않지만 배포 폴더의 manifest 버전이 바뀌어야 리로드 시 옛 버전이 남는 함정(메모리 기록)을 피할 수 있다.

## 반영 절차

1. 브랜치 `feat/no-interference-mode`에서 구현.
2. `pnpm --filter chrome-extension test`(vitest)와 `pnpm --filter auto-chrome-mcp-bridge test`(jest) 통과. 기존 통과 수보다 줄면 안 된다.
3. 확장 빌드 → 배포 폴더 내용 교체 → 확장 리로드(메모리 파일의 CDP 리로드 절차) → 실기 회귀 5단계.
4. 결과 보고에는 실행한 명령과 종료 코드, 테스트 통과 수(전/후), 실기 회귀의 탭 id·창 id 실측값, 스크린샷 파일 경로를 포함한다. 하지 않은 검사를 했다고 쓰지 않는다.

## 교차 검증 반영 (2026-09-02, Codex 검토 결과)

설계 초안을 Codex가 코드와 대조해 검토했다. 다음을 요구사항에 추가한다. 위 A~G보다 우선한다.

### H. 활성화 경로를 개별 수정하지 않고 공용 가드 하나로 막는다

설계가 놓친 활성화 경로가 여럿 확인됐다(모두 `app/chrome-extension/entrypoints/background/` 기준).

- `tools/browser/common.ts:565~580` 기존 작업 탭 재사용이 창 소유 확인 없이 먼저 실행된다. 모드를 `dedicated`로 바꾼 뒤에도 사용자 창에 남은 옛 작업 탭을 활성화할 수 있다.
- 플로우 `openTab`: `record-replay/actions/handlers/tabs.ts:55~69`, 구형 경로 `record-replay/rr-utils.ts:71, 94`, `record-replay/nodes/tabs.ts:13~17`.
- 조건부 활성화: `tools/browser/web-fetcher.ts:82, 107`, `tools/browser/console.ts:405`, `tools/browser/inject-script.ts:58~60`, `tools/browser/network-capture-debugger.ts:800, 820`.
- `tools/browser/gif-recorder.ts:320~325, 693~704`는 "포커스 안 된 창"만 확인하고 전용 창인지 보지 않는다.

따라서 경로마다 고치는 대신 **공용 가드** `utils/activation-guard.ts`(이름은 자유)를 만들어 다음을 강제한다.

1. `activateTab(tabId, reason)`: 탭이 속한 창이 전용 MCP 창이면 `tabs.update({active:true})`, 아니면 아무것도 하지 않고 로그만 남긴다. 예외 도구(`chrome_switch_tab`, `chrome_request_element_selection`, `chrome_request_user_consent`)만 `{force:true}`로 우회할 수 있다.
2. `focusWindow(windowId)`: 기존 `focusWindowIfAllowed`를 이 모듈로 옮기고 같은 규칙을 적용한다.
3. 위에 나열한 모든 호출부와 A~D의 호출부가 `chrome.tabs.update({active:true})`, `chrome.tabs.create({active:true})`, `chrome.windows.update({focused:true})`, `chrome.windows.create`를 **직접 부르지 않고** 이 가드를 거치게 바꾼다. 남은 직접 호출은 grep으로 0건이어야 한다(예외: 가드 모듈 자신, 팝업·퀵패널 등 사용자 UI 진입점).
4. 작업 탭 재사용: 모드가 `dedicated`일 때 옛 작업 탭이 전용 창 밖에 있으면 재사용하지 않고 전용 창에 새로 만든다.

### I. 포커스 복귀(A.3)의 안전장치

생성 후 300ms/1200ms 사이에 사용자가 다른 창이나 다른 앱으로 이동했을 수 있다. `chrome.windows.onFocusChanged`를 생성 직후부터 구독해, 기록해 둔 사용자 창이 아닌 곳으로 포커스가 한 번이라도 바뀌었으면 복귀를 취소한다. 복귀는 "우리 창이 여전히 포커스를 쥐고 있을 때"만 한다.

### J. 마이그레이션

**확정된 저장 키 우선순위** (2026-09-02 독립 검토에서 다시 확인): 신규 키
`mcpWorkWindowMode` > 구버전 키 `dedicatedWorkWindow` > 기본값 `dedicated`.

1. `mcpWorkWindowMode` 가 `'current' | 'dedicated'` 이면 그 값을 쓴다.
2. 없으면 구버전 boolean `dedicatedWorkWindow` 를 해석한다(`true` → dedicated,
   `false` → current).
3. **두 키가 모두 없을 때만** v1.9.0 의 새 기본값 `dedicated` 가 적용된다.

즉 저장값은 언제나 새 기본값보다 우선한다. 과거에 토글을 끈 사용자는 팝업의
"무간섭 권장 설정으로 되돌리기" 버튼으로만 바뀐다. 이 순서를 코드 주석·CHANGELOG·
단위 테스트(세 경우 모두)에 못박는다.

### K. 범용 회귀 테스트

경로별 단위 테스트만으로는 미래에 추가되는 도구를 못 잡는다. 다음 테스트를 추가한다.

- Chrome API 추적 모의객체를 만들어, 등록된 모든 도구(`GATE_EXEMPT_TOOLS` 제외)를 대표 인자로 한 번씩 실행한다.
- 전용 창이 아닌 창의 탭에 `active:true`가 한 번이라도 가면 실패, 예외 도구 외에서 `focused:true`가 가면 실패.
- 테스트 fixture의 도구 이름 집합이 도구 레지스트리와 정확히 일치하는지도 검사해, 새 도구가 fixture 없이 추가되면 실패한다.

### L. 문구 정정

- "화면에 새 창이 보이지 않는다"는 "바탕화면 작업 영역에 창이 나타나지 않는다. 작업 표시줄 항목은 허용"으로 정정한다.
- 오프스크린 좌표는 크롬이 항상 화면 안으로 되돌리지 않는다. 모니터 배열·DPI·버전에 따라 다르므로 실측으로 판단하되, 되돌려지지 않으면 오프스크린을 최소화보다 우선 후보로 본다(렌더링이 멈추지 않으므로).
- `width`/`height`를 창 크기에서 뷰포트 에뮬레이션으로 바꾸는 것은 API 의미 변경이다. 이 저장소의 유일한 소비자가 이 사용자이므로 진행하되, `docs/TOOLS.md`와 CHANGELOG에 "의미 변경"으로 명시한다.

## 실측 기록 (2026-09-02, 구현 중 실제 크롬에서 측정)

측정 환경: Windows 11, 사용자 크롬 창 1개(maximized 1936x1048), 확장 v1.9.0 배포본.

### 배치 후보별 결과

| 배치                    | 결과          | 근거                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offscreen`             | **사용 불가** | `chrome.windows.update({left:-32000, top:-32000})` 이 예외로 거부됐다: `Invalid value for bounds. Bounds must be at least 50% within visible screen space.` 좌표를 클램핑하는 것이 아니라 호출 자체를 거부한다. 설계 L 의 "클램핑되지 않으면 오프스크린 우선" 조건은 성립하지 않는다.                                                                                |
| `minimized` (생성 즉시) | **사용 불가** | `chrome.windows.create({state:'minimized'})` 의 state 는 무시된다(만들어 보면 `normal`). `windows.update({state:'minimized'})` 는 먹지만, **한 번도 그려진 적 없는 창을 최소화하면 그 창의 CDP `Page.captureScreenshot` 이 영영 돌아오지 않는다** — `chrome_screenshot` 이 3회 연속 타임아웃했고, 창을 `normal` 로 되돌리는 순간 밀려 있던 캡처가 한꺼번에 완료됐다. |
| `minimized` (워밍업 후) | **채택**      | 창을 `normal`·비포커스로 만들고 작업 탭이 생긴 뒤 CDP 로 프레임을 1장 강제한 다음 최소화하면 캡처가 정상이다. 최소화 상태에서 다른 URL 로 이동해도 계속 정상이었다.                                                                                                                                                                                                  |

### 채택한 기본값: `minimized` (워밍업 후 최소화)

최종 빌드(워밍업 포함)로 다시 측정한 결과 — 전용 작업 창은 확장이 직접 만들고 최소화한 창이다.

| 페이지                        | 뷰포트   | 전체 페이지 | 요소                 |
| ----------------------------- | -------- | ----------- | -------------------- |
| https://example.com/          | 3/3 정상 | 3/3 정상    | 3/3 정상 (`div`)     |
| https://news.ycombinator.com/ | 3/3 정상 | 3/3 정상    | 3/3 정상 (`#hnmain`) |

18장 모두 실제 페이지가 보였다(단색 아님). 저장한 PNG 를 파이썬으로 다시 열어 색 수를 센 결과도
154~598 색으로, 빈 이미지가 아님을 기계적으로도 확인했다.

### 독립 검토 반영 뒤 다시 확인한 것 (2026-09-02)

- **탭마다 최초 1회는 그려져야 한다.** 창을 만들 때 한 번 워밍업하는 것만으로는 부족했다.
  이미 최소화된 작업 창에 새 탭(두 번째 lane 등)을 만들면 그 탭은 그려진 적이 없어
  `chrome_screenshot` 이 그대로 멎었다(실측 재현). 그래서 새 탭을 만들기 **전에** 창을
  normal 로 되돌리고, 탭을 만든 뒤 워밍업하고 다시 최소화한다.
- 그 결과 남는 한계: 되돌리는 순간 그 창이 크롬 안에서 "마지막으로 포커스된 창" 이 된다.
  크롬이 백그라운드일 때는 사용자 창을 다시 앞으로 끌어내는 것이 오히려 방해가 되므로
  되돌리지 않는다(설계 I 의 취지). 실기 회귀에서도 사용자 창의 활성 탭은 그대로였지만
  `windows.getLastFocused()` 는 작업 창을 가리켰다. 배치를 "보이게" 로 두면 이 동작 자체가
  사라진다.

### 함께 확인된 것들

- **최소화된 창에서는 그 창의 "활성 탭" 만 캡처된다.** 비활성 탭을 대상으로 하면
  `Cannot capture background tab` 으로 실패한다(창이 `normal` 이면 비활성 탭도 정상 캡처된다).
  병렬 lane 처럼 작업 창에 탭이 여러 개인 경우를 위해, 캡처 직전에 **전용 작업 창 안에서만**
  대상 탭을 활성화하도록 `screenshot.ts` 에 보강했다. 사용자 창은 건드리지 않는다.
- **최소화된 창을 `normal` 로 되돌리면 그 창이 포커스를 가져간다**(`focused:false` 를 같이 줘도).
  그래서 복구 목적이라도 창을 되돌리는 동작은 넣지 않았다.
- `chrome.tabs.create({active:true})` 를 비포커스 창에 하면 그 창이 포커스를 가져간다.
  지연 이중 비포커스 + 사용자 창 복귀(A.2/A.3)가 실제로 필요한 이유가 이것이다.
- `h1` 처럼 인라인 요소를 `selector` 로 주면 `Invalid calculated crop size (<=0)` 로 실패한다.
  배치와 무관한 기존 동작이라 이번 라운드에서 건드리지 않았다.

### 실기 회귀 (설계 "실기 회귀" 5단계, 최종 빌드)

| 항목                          | 실행 전               | 실행 후               |
| ----------------------------- | --------------------- | --------------------- |
| 사용자 창 id                  | 384623014 (maximized) | 384623014 (maximized) |
| 사용자 창의 활성 탭 id        | 384623194             | 384623194             |
| `windows.getLastFocused().id` | 384623014             | 384623014             |
| MCP 작업 창                   | 384623237 (minimized) | 384623237 (minimized) |

실행한 도구: `chrome_navigate`(example.com → news.ycombinator.com), `chrome_screenshot`
3종, `chrome_click_element`, `chrome_get_web_content`, `chrome_read_page`,
`chrome_scroll_collect`(renderAssist `frame-pump` 로 동작). 전부 성공했고 사용자 탭·포커스는
그대로였다. 작업 창은 최소화 상태를 유지해 바탕화면 작업 영역에 나타나지 않았다.

스크린샷 파일:
`%LOCALAPPDATA%/Temp/claude/C--Users-user/f0cdd8be-913d-461e-890c-1e718a474126/scratchpad/no-interference/`
의 `final-example-viewport.png`, `final-example-element.png`, `regression-viewport.png`,
`hn-viewport-3.png`, `example-viewport-3.png`, `example-fullpage-2.png`, `example-element-3.png`,
`hn-element-3.png`.
