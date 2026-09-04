# batch 값 전달·조건·반복 설계 (2026-09-04)

## 배경

`chrome_batch` 는 step 배열을 한 왕복으로 순차 실행하고, `chrome_shortcut` 은 그 배열을 이름 붙여 저장·재실행한다. 2026-09-04 코드 조사(읽기 전용) 결과, 두 도구의 한계는 다음 셋이다. 경로는 `app/chrome-extension/entrypoints/background/tools/browser/` 기준.

1. `batch.ts:141~221`, `shortcut.ts:267~339` 의 실행 루프는 step 인자를 그대로 넘긴다. 앞 step 의 결과(`resultText` 문자열)는 응답에만 실리고 뒤 step 이 읽을 길이 없다.
2. 흐름 제어는 `continueOnError` 하나다. 건너뛰기, 조기 종료, 반복이 없다.
3. shortcut 은 저장 시 `args` 가 그대로 박제된다(`shortcut.ts:213~220`). 로그인 계정처럼 실행마다 다른 값을 넣을 수 없고, 비밀번호가 `chrome.storage.local` 에 평문으로 남는다.

옛 record-replay 엔진에 if/foreach/while 핸들러가 있지만, 사용자 활성 탭을 직접 조회하는 곳이 28곳이라 `work-tab-gate.ts:47~49` 가 백그라운드 모드에서 통째로 거절한다. 그쪽을 고쳐 쓰는 대신 batch 안에 작은 흐름 제어를 넣는다. 게이트를 이미 통과하는 실행 경로(각 step 이 `handleCallTool` 을 거침) 위에 얹는 편이 안전하기 때문이다.

값을 꺼내 쓸 대표 도구의 반환 형식은 다음과 같다. 둘 다 `content[0].text` 에 JSON 문자열 하나다.

- `chrome_find` (`find.ts:434~465, 605~635`): `{ success, tabId, query, scanned, matches: [{ rank, score, ref, role, name, text?, cx, cy, frameId?, frameUrl?, hint }], truncated? }`
- `chrome_extract` (`extract.ts:43~49, 301~316`): `{ success, tabId, url, values: { 필드명: string | string[] | null }, missing: string[], invalidSelectors?, truncated? }`

## 목표

모델이 한 번의 `chrome_batch` 호출로 "찾고, 그 결과로 클릭하고, 없으면 멈추고, 있으면 다음 페이지로" 를 끝낼 수 있게 한다. 기존 호출은 실행 의미가 동일하고, 출력에는 `status` 필드만 추가된다. 게이트가 지키는 "사용자 탭을 건드리지 않는다" 는 값 전달이 생겨도 그대로 지켜져야 한다.

## 목표가 아닌 것

- record-replay 엔진 수정이나 MCP 노출.
- 병렬 step, 중첩 batch, 임의 JS 조건식. 이유는 마지막 절.
- 세션을 넘어 남는 변수. 이름 붙인 결과는 그 호출 안에서만 산다.

## 1. step 간 값 전달

### 후보 비교

| 항목                                    | A. `as` + 문자열 안 `{{name.path}}` | B. `from: {step, path}` 객체 참조        | C. 결과 전체를 `prev` 로만 참조 |
| --------------------------------------- | ----------------------------------- | ---------------------------------------- | ------------------------------- |
| 표기 길이                               | 짧다. 기존 args 안에 그대로 끼운다  | 인자마다 객체 하나. 길고 중첩이 깊어진다 | 가장 짧다                       |
| 타입 보존                               | 규칙 필요(아래)                     | 자연스럽다                               | 자연스럽다                      |
| 문자열 조합(`"https://x.com/{{a.id}}"`) | 된다                                | 안 된다. 별도 concat 문법이 또 필요하다  | 안 된다                         |
| 두 step 전 결과 참조                    | 된다                                | 된다                                     | 안 된다                         |
| 모델이 익숙한가                         | 템플릿 문법이라 익숙하다            | 낯설다                                   | 익숙하나 표현력이 부족하다      |

**확정: A.** 왜: 모델이 쓰는 표기가 가장 짧고, URL 조립처럼 문자열 안에 값을 끼우는 경우가 실제로 많다. B 의 장점인 타입 보존은 아래 "통째 치환" 규칙으로 얻는다.

### 활성화 규칙 (호환의 핵심)

치환은 최상위 `templates: true` 이거나 새 흐름 키(`as`, `when`, `stopIf`, `repeat`, `return`, `params`)가 하나라도 있을 때만 켜진다. 그 외 v1 호출은 `{{...}}` 가 있어도 literal 로 넘긴다. shortcut 은 저장 시 이 활성 여부를 레코드에 `templates` 필드로 함께 기록하고, 필드가 없는 legacy 레코드는 절대 치환하지 않는다. 왜: 기존 호출·기존 저장본의 실행 의미를 한 글자도 바꾸지 않기 위해서다.

### 문법 (고정)

- step 의 `as: "name"` 이 그 step 의 결과를 저장한다. 이름은 `^[A-Za-z_][A-Za-z0-9_]{0,31}$` 이고 형식 위반은 `invalid_as_name`. `params`, `prev`, `loop` 는 예약어라 거절(`reserved_name`). 같은 scope 의 중복 `as`, repeat 묶음 `as` 와 그 안 step `as` 의 충돌은 저장·실행 전 검증에서 `duplicate_as` 로 거절한다.
- 토큰 정규식: `\{\{([A-Za-z_$][A-Za-z0-9_$]*)((\.[A-Za-z0-9_$-]+)|(\[(0|[1-9][0-9]*|-1)\]))*\}\}`. 중괄호 안 공백 불허(`{{ a.b }}` 는 malformed). 점 세그먼트 허용 문자는 `[A-Za-z0-9_$-]+` 다(`$` 는 아래 메타 키 `{{name.$ok}}` 때문에 필요하다). 음수 인덱스는 `[-1]`(마지막) 만. `{{name}}` 은 루트 전체.
- malformed 토큰은 literal 로 둔다. 같은 문자열에 유효 토큰이 섞여 있으면 유효 토큰만 치환한다.
- 이스케이프: `{{` 앞의 백슬래시 n 개는 floor(n/2) 개로 접히고, n 이 홀수면 그 `{{` 를 literal 로 둔다(백슬래시 halving). 그래서 `\{{` 는 literal `{{`, `\\{{a}}` 는 백슬래시 하나와 치환값이 된다.
- 참조 뿌리: 도구 응답 `content` 배열의 **첫 `type:"text"` 블록**(첫 primary text content) 원문을 `JSON.parse` 한 값. 표시용 `resultText`(4000자로 잘린 것)를 파싱하지 않는다. 왜: 잘린 문자열을 파싱하면 정상 JSON 도 깨진다. 파싱 실패 시 뿌리는 raw 문자열이며 `{{name}}` 이 그 문자열, path 접근은 `unresolved_reference`.
- 메타는 `$` 접두: `{{name.$ok}}`(boolean), `{{name.$text}}`(string, raw 원문), `{{name.$error}}`(string 또는 null). 메타 키는 실제 JSON 에 같은 이름의 키가 있어도 메타가 우선한다.
- `{{prev...}}` 는 직전에 실제로 실행된 step 의 결과다(실패 포함, `as` 없이도). 건너뛴 step 은 `prev` 를 갱신하지 않는다. `prev` 는 반복 회차 경계를 넘지 않는다(회차 시작 시 비움).
- 치환은 `args` 안의 모든 문자열 값에 재귀 적용(객체·배열 안까지). 키 이름과 `tool` 은 치환하지 않는다.
- path 세그먼트 `__proto__`, `prototype`, `constructor` 는 `forbidden_path_segment`. 순회는 own-property 만 본다. 꺼낸 객체·배열은 prototype 없는 deep clone 으로 넣는다. 왜: 페이지에서 온 JSON 이 도구 인자 객체를 오염시키지 못하게 한다.

### 치환 규칙과 함정

| 상황                               | 규칙                                                                                               | 왜                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 통째 치환(문자열 전체가 토큰 하나) | 원래 타입 그대로. 숫자·불리언·객체·배열·null 보존                                                  | `maxResults: "{{n}}"` 이 문자열 "5" 로 들어가면 도구 검증에서 튕긴다 |
| 끼움 치환(문자열 안 일부)          | 문자열·숫자·불리언은 `String()`, 객체·배열은 정확히 `JSON.stringify`, null 은 `embedded_null` 오류 | `[object Object]` 나 빈 문자열을 만들지 않는다                       |
| 값이 없음                          | 통째·끼움 모두 `unresolved_reference` 로 그 step 실패. `continueOnError` 규칙을 따른다             | 빈 문자열로 조용히 넘어가면 엉뚱한 요소를 클릭한다                   |
| 값 안의 중괄호                     | 단일 패스. 치환된 결과는 다시 스캔하지 않는다                                                      | 페이지 텍스트의 `{{` 로 재귀 치환이 일어나지 않는다                  |
| 크기                               | 참조 하나가 치환된 후 20,000자를 넘으면 `reference_too_large`                                      | 결과 전체를 인자로 넣어 도구 호출을 폭주시키지 않는다                |

### 캡처 상한 (UTF-8 byte 기준)

- 모든 실행 결과는 64KiB 상한의 ephemeral `prev` 로 보관한다. 넘으면 `prev` 는 `$ok`·`$error` 메타만 남기고 본문은 비운다(step 자체는 실패시키지 않는다).
- `as` 와 repeat 스냅샷은 persistent 저장이며 step 당 64KiB, batch 전체 256KiB. 넘으면 중간에서 자르지 않고 그 step 을 `capture_too_large` 로 실패시킨다. 왜: 반쯤 잘린 값으로 다음 step 을 돌리는 것보다 멈추는 편이 안전하다. 256KiB 총량에는 `as` 와 repeat 스냅샷만 센다.

## 2. 조건·반복·종료

조건은 문자열 표현식이 아니라 **JSON 객체** 다. 파서가 없으니 임의 코드 실행 경로가 없다.

```json
{ "path": "hit.matches[0].ref", "op": "exists" }
{ "path": "page.values.title", "op": "contains", "value": "품절" }
{ "any": [ { "path": "a.$ok", "op": "eq", "value": false }, { "path": "b.matches", "op": "empty" } ] }
```

- 조건 객체는 정확히 한 형태다: leaf(`path` + `op` + 필요 시 `value`) 또는 `all`/`any`/`not` 중 하나. 빈 `all`/`any`, 모르는 키, 두 형태 혼용은 `condition_invalid`. 트리 깊이 8, 노드 64 까지. 넘으면 `condition_too_deep`, `condition_too_large`.
- `path` 는 `{{ }}` 없이 같은 path 문법. `value` 는 리터럴이거나 `{{...}}` 를 품은 문자열. path 끼리 직접 비교하는 문법은 없고, `value: "{{b.y}}"` 처럼 templated value 로 같은 효과를 낸다.
- 정규식 연산자는 두지 않는다. 왜: ReDoS 와 엔진 차이 위험. "제목에 '품절' 이 들어가면" 은 위 `contains` 예로 충분하다.

| op                    | 값 있음                                                                             | path 가 닿지 않음(missing)        | 비고                                         |
| --------------------- | ----------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------- |
| `exists`              | true                                                                                | false                             | null 도 "있음"                               |
| `notExists`           | false                                                                               | true                              |                                              |
| `empty`               | null·빈 문자열·빈 배열·빈 객체가 true                                               | true                              | 숫자·불리언과 내용이 있는 객체는 false       |
| `notEmpty`            | `!empty`                                                                            | false                             |                                              |
| `eq` / `ne`           | JSON 값 동등. 객체는 키 순서 무시 재귀, 배열은 순서 포함. 숫자와 숫자 문자열은 다름 | `condition_unresolved`(step 실패) |                                              |
| `gt` `gte` `lt` `lte` | 둘 다 유한 숫자일 때만 비교. 아니면 `condition_invalid`(step 실패)                  | `condition_unresolved`            | 조용한 false 는 판정을 뒤집으므로 실패시킨다 |
| `contains`            | 문자열 부분 일치, 배열은 원소 `eq`                                                  | `condition_unresolved`            | 그 외 타입은 false                           |

이 범위로 표현 못 하는 것: 산술, 패턴 일치, 날짜 비교, 배열 필터. 이럴 때는 `chrome_javascript` step 에 `as` 를 붙여 페이지 안에서 계산한 값을 돌려받고 그 값에 `exists`·`eq` 를 건다. 왜: 계산은 이미 격리된 페이지 컨텍스트에 맡기고 batch 는 판정만 한다.

### step 키 셋과 반복 묶음

| 키       | 위치                                                            | 평가 시점             | 동작                                                                                                                                                         |
| -------- | --------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `when`   | 일반 step                                                       | 실행 전               | 거짓이면 실행하지 않고 `status: "skipped"`. 실패가 아니다                                                                                                    |
| `stopIf` | 일반 step                                                       | 실행 후(그 결과 포함) | 참이면 그 step 은 `status: "stopped"`, 남은 선언 step 은 `skipped`, `stoppedBy: { step, reason: "stopIf" }`                                                  |
| `repeat` | 묶음 `{ repeat: { max, until?, delayMs? }, steps: [...], as? }` | 각 회차 끝            | `steps` 를 `max` 회 반복. `until` 참이면 그 회차 뒤 멈춤. `max` 필수, 정수 1~20(누락·0·비정수는 `repeat_max_invalid`). `delayMs` 정수 0~5000, 회차 사이 대기 |

반복 의미.

- 묶음 안에 또 `repeat` 을 넣을 수 없다(`nested_repeat`). 안쪽 step 은 `when`·`stopIf`·`as` 를 쓸 수 있다.
- 회차 시작 시 안쪽 `as` 와 `prev` 를 비운다. 건너뛴 step 은 스냅샷에 값을 남기지 않는다. 묶음에 `as: "pages"` 를 주면 `pages` 는 회차별 스냅샷 배열: `{{pages[-1].next.matches}}`. `{{loop.index}}`(0 시작), `{{loop.count}}` 는 묶음 안에서만 유효.
- 회차 종료 판정 우선순위: 치명적 실패 > `stopIf` > `until` > `continueOnError`. 안쪽 `stopIf` 로 batch 가 끝나면 묶음은 `status: "stopped"`, `attempts.stoppedBy: "stopIf"`. `attempts.stoppedBy` enum 은 `until | stopIf | max | failure | timeout | total_runs`.
- 묶음 항목의 필드: `ok` 는 실패 회차가 없을 때 true, `status` 는 실패면 `failed`, 중간에 멈췄으면(`stopIf`·`timeout`·`total_runs`) `stopped`, 아니면 `completed`, `error` 는 실패 회차의 안쪽 step 오류, `resultText` 는 마지막 회차 마지막 실행 step 의 표시용 텍스트.
- 선언 step 수 상한 20 계산에서 repeat 묶음은 1개로 센다(안쪽 step 은 따로 20 이내).
- 도구 호출 총량 상한 `MAX_TOTAL_RUNS = 100`(실행 횟수 기준). 100회까지 허용, 101번째 실행 직전에 `total_runs_exceeded` 로 멈추고 그때까지 결과를 돌려준다.
- 벽시계 상한 `MAX_BATCH_MS = 100000`. 왜: stdio 프록시가 도구 호출을 120초에 끊는다(stdio 2분 타임아웃). 호출 사이에 deadline 을 검사하고, 각 invocation 과 `delayMs` 에 남은 deadline 을 넘겨 기존 tool-watchdog 이 중단시킨다. watchdog 이 지켜지는 한 120초 전에 응답이 돌아간다. 반복은 페이지가 안 바뀌어도 도구가 성공해 무한히 돌 수 있으므로 시간과 횟수 둘 다로 막는다.

## 3. shortcut 파라미터

```json
{ "action": "save", "name": "site-login",
  "params": {
    "user": { "required": true, "description": "아이디" },
    "pw":   { "required": true, "secret": true },
    "url":  { "default": "https://example.com/login" }
  },
  "steps": [ ... ] }
```

- 선언: 이름은 `as` 와 같은 정규식. 허용 필드는 `required`(기본 false), `default`(JSON 값), `secret`(기본 false), `description` 뿐이며 그 외 필드는 `param_declaration_invalid`. `required` 와 `default` 동시 지정, `secret` 에 `default` 지정도 같은 오류. 최대 16개.
- 실행: 전달값 > `default` 순. `required` 누락은 `missing_param` 으로 실행 전 거절. 선언에 없는 이름은 `unknown_param`. optional 이고 `default` 도 없는 이름을 참조하면 `unresolved_reference`. `null` 은 "전달됨" 으로 보되 타입 검증(`secret` 은 string 만) 대상이다. 왜: 오타를 조용히 무시하면 로그인이 빈 문자열로 들어간다.
- `secret`: 값은 string 만 허용(`param_type_invalid`). 저장하지 않고, 응답 JSON 의 모든 문자열에서 그 값과 같은 부분 문자열을 길이와 무관하게 항상 `***` 로 가린다. 8자 미만이면 오탐 가능성 경고를 `warnings` 에 덧붙인다.
- 실행 시 전달된 `params` 값(비밀 아닌 것 포함)은 저장소에 쓰지 않는다. `runCount` 만 갱신한다.
- `list` 응답에 `params` 선언(이름·required·default·description)을 싣는다. `secret` 은 이름만.
- **v2 판정**: `params`, `as`, `when`, `stopIf`, `repeat`, `return`, `templates` 중 하나라도 쓰면 v2 다. v2 는 step args 에 literal `tabId`·`windowId`·`tabIds`, 그리고 `chrome_close_tabs` 의 `url` 을 담을 수 없다. 저장 시 `stale_target_forbidden` 으로 거절(중첩 객체 안도 검사). 왜: 저장된 탭 id·URL 은 시간이 지나면 다른 탭, 곧 사용자 탭을 가리킨다. legacy 레코드(v1)는 그대로 둔다(grandfathering).
- `{{params.x}}` 가 있는데 선언이 없으면 저장 시 `undeclared_param`.

## 4. 게이트·안전과의 관계

`work-tab-gate.ts:18~21`: 양의 정수 `tabId` 는 "호출자가 고른 탭" 으로 통과한다. 양의 정수 `windowId` 도 `WINDOW_ID_AWARE_TOOLS` 에서 통과한다. `URL_SELECTS_TARGET_TOOLS` 의 `url` 은 그 URL 을 가진 기존 탭을 고른다. 셋 다 값 전달로 세탁이 가능하다. 예: `get_windows_and_tabs` 결과의 `tabs[0].id` 를 `chrome_click_element` 의 `tabId` 에 넣으면 사용자 탭을 클릭한다.

**규칙: 대상 지정 키에는 치환을 허용하지 않는다.** 왜: "치환 결과가 세션 소유 탭인지 확인" 은 판정을 게이트 밖에 하나 더 두는 셈이라 두 곳이 어긋날 수 있다. 원천 차단이 단순하고 fail-closed 다.

치환 금지 키는 "탭을 선택하거나 닫는 모든 인자" 를 감사한 명시 목록이다.

| 키                      | 근거 도구                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabId`                 | `TAB_ID_INJECT_TOOLS` 전체(`work-tab-gate.ts:66`), `chrome_find`, `chrome_extract`, `chrome_userscript` 의 중첩 `args.tabId`                                    |
| `tabIds`                | `chrome_close_tabs`                                                                                                                                             |
| `windowId`              | `WINDOW_ID_AWARE_TOOLS`(`work-tab-gate.ts:144`)                                                                                                                 |
| `url`                   | `URL_SELECTS_TARGET_TOOLS`(`work-tab-gate.ts:270`: web_fetcher, console, inject_script, network_capture 계열) 와 `chrome_close_tabs`(URL 패턴으로 닫을 탭 선택) |
| `_mcpSessionId`, `lane` | 실행 컨텍스트 전용(아래)                                                                                                                                        |

- 검사는 두 번 한다. 치환 전 원본 args 에서 값에 `{{` 가 든 금지 키를 잡고, **치환 후 전체 args 객체를 다시 순회**해 치환으로 생성된 subtree 안의 금지 키도 잡는다. 예: `args: "{{params.obj}}"` 가 `{ tabId: 123 }` 을 만들면 실행 전에 `template_forbidden_key`. 2차 검사의 대상은 치환으로 새로 생긴 subtree 뿐이고, 원래 literal 로 적혀 있던 `tabId` 는 그대로 통과한다(아래 batch 규칙). 키 이름 비교는 중첩 깊이와 무관하게 같은 이름이면 잡는다.
- `chrome_navigate` 의 `url` 은 허용. 왜: navigate 는 게이트 주입 대상이 아니고 작업 탭에서 이동하거나 세션 작업 탭을 새로 만드는 경로라 사용자 탭을 고르는 분기가 없다(`work-tab-gate.ts:268`).
- batch 의 literal `tabId` 는 지금과 같이 통과한다(shortcut v2 는 3절). 이 설계는 기존보다 구멍을 더 열지 않는다. `DISALLOWED_STEP_TOOLS` 유지, `tool` 은 항상 literal.
- **컨텍스트 적용 순서**: 치환 후 step args 의 `_mcpSessionId`·`lane` 을 무조건 제거한 뒤, batch/shortcut 실행 컨텍스트에 값이 있을 때만 재주입한다(현재 `batch.ts:181` 의 step 값 우선을 뒤집는다). 바깥 컨텍스트가 없으면 두 키 없이 게이트로 간다.
- **background**: runner 가 게이트 호출 전에 전역 background mode ON 이면 args 최상위의 `background` 를 무조건 `true` 로 덮는다. 치환된 subtree 에서 생성된 값도 최상위에 놓이면 함께 덮인다. 덮어쓰기는 치환이 켜진 호출(v2)에만 적용하고, 새 키가 없는 v1 호출은 예전처럼 게이트가 판단한다. 게이트 자체는 바꾸지 않는다.
- `chrome_javascript` 결과를 조건에 쓰면 페이지가 흐름을 조작할 수 있다. 그러나 조건은 어느 step 을 돌릴지만 정하고 대상 탭은 못 바꾸므로 피해 범위는 기존 javascript 도구와 같다.

## 5. 결과 형식·크기

- `steps[]` 항목에 `status`(`completed | skipped | stopped | failed`) 추가. 기존 `ok` 유지. `as` 가 있으면 `as` 도 싣는다. stop 이후 남은 선언 step 은 `skipped` 로 기록한다.
- 반복 묶음은 `steps[]` 에 항목 하나로, `attempts: { count, stoppedBy? }` 와 마지막 회차의 `resultText` 만. 왜: 20회차 × 4 step 이면 80항목이라 응답이 컨텍스트를 밀어낸다. 회차별 값은 `as` + `return` 으로 받는다. 따라서 `steps[]` 길이는 선언 step 수(최대 20)를 넘지 않는다.
- 최종 `success` 는 실행된 step 중 `failed` 가 없을 때만 true. `stopIf` 로 끝나도 실패가 있었으면 false.
- `resultText` 4000자 상한(표시용)과 이미지 4장 상한(마지막 4장)은 변경 없음. 표시용 자르기와 1절의 캡처 원본은 별개다.
- `return: ["hit", "pages"]` 가 있을 때만 `results: { hit, pages }` 를 싣고, 없으면 `results` 필드 자체를 생략한다. 모르는 이름은 실행 전 `unknown_return_name`. 항목당 8,000자, 전체 24,000자를 넘는 항목은 자르지 않고 통째로 빼고 `resultsTruncated: ["pages"]` 에 이름을 적는다. 왜: 잘린 JSON 은 파싱이 안 되어 쓸모가 없다.
- 종료 사유 코드: `stoppedAtStep`(기존, 실패), `stoppedBy: { step, reason: "stopIf" | "total_runs_exceeded" | "timeout" }`.

## 6. 호환

활성화 규칙(1절)에 따라 새 키가 없는 v1 호출은 치환기를 아예 타지 않는다. 실행 의미 동일, 출력에는 `status` 필드만 추가된다. 스키마 변경은 **추가만** 한다(`packages/shared/src/tools.ts:91~117, 141~172`).

| 도구              | 위치           | 추가                                                                                                                                |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `chrome_batch`    | `steps[]` 항목 | `as: string`, `when: object`, `stopIf: object`, `repeat: { max: number, until?: object, delayMs?: number }`, `steps: array`(묶음용) |
| `chrome_batch`    | 최상위         | `templates: boolean`, `return: string[]`                                                                                            |
| `chrome_shortcut` | `steps[]` 항목 | 위와 동일                                                                                                                           |
| `chrome_shortcut` | 최상위         | `templates: boolean`, `params: object`(save 는 선언, run 은 값), `return: string[]`(run)                                            |

`description` 에는 `{{name.path}}` 와 `{{params.x}}` 예를 한 줄씩만 넣는다. 스키마 설명이 길어지면 모든 호출의 토큰이 늘어난다.

## 7. 예시

(a) 검색 후 첫 결과 클릭.

```json
{
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://search.example.com/?q=크롬" } },
    {
      "tool": "chrome_find",
      "as": "hit",
      "args": { "query": "첫 번째 검색 결과 제목 링크", "maxResults": 1 }
    },
    {
      "tool": "chrome_click_element",
      "when": { "path": "hit.matches[0].ref", "op": "exists" },
      "args": { "ref": "{{hit.matches[0].ref}}", "frameId": "{{hit.matches[0].frameId}}" }
    },
    { "tool": "chrome_screenshot" }
  ]
}
```

`frameId` 가 결과에 없으면 `unresolved_reference` 로 실패한다. 프레임이 없을 수 있는 페이지면 `ref` 만 넘긴다.

(b) "다음" 버튼이 사라질 때까지 목록 수집.

```json
{
  "return": ["pages"],
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://list.example.com/items?page=1" } },
    {
      "repeat": { "max": 20, "until": { "path": "next.matches", "op": "empty" }, "delayMs": 500 },
      "as": "pages",
      "steps": [
        {
          "tool": "chrome_extract",
          "as": "page",
          "args": {
            "fields": {
              "titles": { "selector": ".item h3", "all": true },
              "links": { "selector": ".item a", "attr": "href", "all": true }
            }
          }
        },
        {
          "tool": "chrome_find",
          "as": "next",
          "args": { "query": "다음 페이지 버튼", "maxResults": 1 }
        },
        {
          "tool": "chrome_click_element",
          "when": { "path": "next.matches", "op": "notEmpty" },
          "args": { "ref": "{{next.matches[0].ref}}" }
        },
        {
          "tool": "chrome_wait_for",
          "when": { "path": "next.matches", "op": "notEmpty" },
          "args": { "selector": ".item", "timeout": 5000 }
        }
      ]
    }
  ]
}
```

`results.pages` 는 회차별 `{ page, next }` 배열이다. 20회차까지 "다음" 이 있으면 `attempts.stoppedBy === "max"`. 회차당 호출 4회이므로 20회차면 80회로 100회 상한 안이다.

(c) 파라미터 받는 로그인 shortcut. 선언은 3절의 JSON, steps 는 다음과 같다.

```json
[
  { "tool": "chrome_navigate", "args": { "url": "{{params.url}}" } },
  { "tool": "chrome_find", "as": "idBox", "args": { "query": "아이디 입력창", "maxResults": 1 } },
  {
    "tool": "chrome_fill_or_select",
    "args": { "ref": "{{idBox.matches[0].ref}}", "value": "{{params.user}}" }
  },
  { "tool": "chrome_find", "as": "pwBox", "args": { "query": "비밀번호 입력창", "maxResults": 1 } },
  {
    "tool": "chrome_fill_or_select",
    "args": { "ref": "{{pwBox.matches[0].ref}}", "value": "{{params.pw}}" }
  },
  { "tool": "chrome_keyboard", "args": { "keys": "Enter" } },
  {
    "tool": "chrome_find",
    "as": "logout",
    "args": { "query": "로그아웃 버튼", "maxResults": 1 },
    "stopIf": { "path": "logout.matches", "op": "notEmpty" }
  },
  { "tool": "chrome_screenshot" }
]
```

실행: `{ "action": "run", "name": "site-login", "params": { "user": "me@example.com", "pw": "..." } }`. 로그아웃 버튼이 보이면 스크린샷 전에 끝난다.

## 8. 합격 기준·검수 체크리스트

각 줄을 단위 테스트 또는 실제 크롬 실행으로 옮긴다. 하지 않은 검사를 했다고 쓰지 않는다.

1. 호환: 새 키 없는 v1 호출의 응답이 `status` 추가 외에 변경 전과 필드 단위로 같다.
   - 1a. v1 호출의 args 에 유효한 `{{name.path}}` 가 있어도 literal 로 도구에 전달된다. `templates: true` 를 붙이면 치환된다.
   - 1b. `templates` 필드 없는 legacy shortcut 레코드는 `{{...}}` 를 절대 치환하지 않는다.
2. 값 전달: `chrome_find` 의 `matches[0].ref` 가 다음 `chrome_click_element` 인자에 들어가 실제 요소를 맞춘다.
   - 2a. 원본 text content 가 4000자를 넘는 결과에서 `{{name.matches[19].ref}}` 가 해석된다(잘린 `resultText` 파싱이면 실패하는 입력). 65KiB 결과의 `as` 는 `capture_too_large`, `as` 없는 같은 결과는 step 성공에 `prev` 본문만 비어 있다. `as` 누적 257KiB 는 마지막 step 이 `capture_too_large`.
   - 2b. `__proto__`·`prototype`·`constructor` 세그먼트는 `forbidden_path_segment`. `"__proto__": {"polluted": true}` 결과를 통째 치환해도 `({}).polluted` 가 undefined, 꺼낸 객체의 prototype 이 null.
   - 2c. 이름: `9abc`·33자 이름은 `invalid_as_name`, `params`·`prev`·`loop` 는 `reserved_name`, 같은 scope 중복과 묶음/안쪽 충돌은 `duplicate_as`.
   - 2d. JSON 이 아닌 결과(plain text)는 `{{name}}` 이 그 문자열, `{{name.x}}` 는 `unresolved_reference`. `{{name.$ok}}` 는 boolean, `$text` 는 string, `$error` 는 실패 시 string, 성공 시 null. 결과 JSON 에 `"$ok": "fake"` 가 있어도 메타가 우선한다.
   - 2e. `prev` 는 실패한 step 도 담고, 건너뛴 step 은 건너뛰며, 회차 시작 시 비어 있다.
3. 타입: 통째 치환은 숫자·불리언·배열·객체·null 타입 보존. 끼움 치환은 숫자를 `String()`, 객체·배열을 `JSON.stringify` 와 바이트 단위로 같게, null 은 `embedded_null`.
4. 없는 이름·닿지 않는 path 는 `unresolved_reference` 로 그 step 만 실패하고 `continueOnError:false` 면 뒤 step 이 `skipped`.
5. 문법: 결과값 속 `{{x}}` 는 재치환되지 않는다. `\\{{` 는 `{{` 로, `\\\\{{a}}` 는 백슬래시 하나 + 치환값으로 전달된다. `{{ a.b }}`·`{{a..b}}`·`{{a[-2]}}` 는 literal 유지, 같은 문자열의 `{{a.b}}` 는 치환된다. `[-1]` 은 마지막 원소. 20,001자 치환은 `reference_too_large`.
6. 금지 키: `tabId`·`tabIds`·`windowId`·`lane`·`_mcpSessionId`, `chrome_get_web_content`·`chrome_console`·`chrome_network_capture` 계열의 `url`, `chrome_close_tabs` 의 `url` 에 `{{...}}` 를 넣으면 실행 전에 `template_forbidden_key`.
   - 6a. `args: "{{params.obj}}"` 로 생성된 `{ tabId: 123 }` 과 `chrome_userscript` 의 중첩 `args.tabId` 도 치환 후 재검사에서 잡힌다.
   - 6b. `DISALLOWED_STEP_TOOLS` 의 도구는 여전히 거절되고, `tool` 값의 `{{...}}` 는 치환되지 않는다.
7. `chrome_navigate.url` 치환은 허용되고 세션 작업 탭에서 이동한다. 사용자 활성 탭이 바뀌지 않는다(`get_windows_and_tabs` 전후 비교).
   - 7a. step args 의 `_mcpSessionId`·`lane`(literal·치환 모두)은 제거되고 batch 컨텍스트 값으로 재주입된다(invoker mock 으로 확인). 바깥 컨텍스트가 없으면 두 키가 없다.
   - 7b. background mode ON 에서 `background: false`(literal, 치환, 생성 subtree)는 게이트 진입 전에 `true` 로 덮인다.
8. `when` 거짓이면 `status: "skipped"`, `success` 무관.
   - 8a. truth table: missing path 에서 `exists=false`, `notExists=true`, `empty=true`, `notEmpty=false`, `eq`·`gt`·`contains` 는 `condition_unresolved` 로 step 실패. 값이 있어도 `gt` 계열의 양쪽이 유한 숫자가 아니면 `condition_invalid` 로 step 실패. `eq` 는 키 순서 다른 객체를 같게, 순서 다른 배열을 다르게 본다.
   - 8b. `value: "{{b.y}}"` 로 두 결과값을 비교할 수 있다. 빈 `all`, 모르는 키, leaf 와 `any` 혼용은 `condition_invalid`.
9. `stopIf` 참이면 그 step 이 `stopped`, 뒤 step 이 `skipped`, `stoppedBy.reason === "stopIf"`.
   - 9a. 앞에서 `continueOnError` 로 실패가 있었고 뒤에서 `stopIf` 로 끝나면 `success:false`.
10. `repeat` 는 `until` 참인 회차에서 `attempts.stoppedBy:"until"`, 끝내 거짓이면 정확히 `max` 회에 `"max"`. `as` 묶음 결과는 회차 수와 같은 길이, `steps[]` 에는 묶음 항목 하나, `resultText` 는 마지막 회차 마지막 실행 step 의 것. `delayMs: 500` 이면 회차 간격 500ms 이상.
    - 10a. `{{loop.index}}` 는 0,1,2..., 묶음 밖에서는 `unresolved_reference`. 안쪽 `when` 으로 건너뛴 step 은 스냅샷에 키가 없다.
    - 10b. 안쪽 실패는 `attempts.stoppedBy:"failure"`, 묶음 `status:"failed"`. 안쪽 `stopIf` 는 `"stopIf"`, 묶음 `status:"stopped"`, batch 종료.
    - 10c. `max` 누락·0·1.5·21, `delayMs` 5001, 묶음 안 `repeat`, 깊이 9, 노드 65, `op:"matches"` 는 각각 `repeat_max_invalid`, `delay_too_long`, `nested_repeat`, `condition_too_deep`, `condition_too_large`, `condition_invalid` 로 실행 전 거절.
    - 10d. 선언 step 19개 + 묶음(안쪽 5개) = 20 으로 통과, 묶음 2개 + 19개는 `steps must contain at most 20 items`.
11. 상한: 100번째 호출은 실행되고 101번째 직전에 `total_runs_exceeded`. invoker mock 이 호출당 2초를 쓰면 100초 근처에서 `timeout` 이며 invoker 가 받은 deadline 이 남은 시간과 같다. 둘 다 그때까지의 `results` 반환.
12. shortcut 선언: `required`+`default` 동시, `secret`+`default`, 모르는 필드, 17개 선언은 각각 거절. `list` 에 선언이 실리고 `secret` 은 이름만.
13. shortcut 실행: `required` 누락 `missing_param`, 미선언 이름 `unknown_param`, `{{params.x}}` 미선언 저장 `undeclared_param`, optional 무값 참조 `unresolved_reference`, `null` 전달은 provided, `secret` 에 숫자는 `param_type_invalid`. `secret` 원문이 저장소 덤프와 응답 어디에도 없고 3자 비밀도 가려지며 `warnings` 가 붙는다. run 뒤 저장소에 전달 `params` 값이 없고 `runCount` 만 1 증가.
    - 13a. v2(`params` 없이 `as` 만 써도) 의 step args 에 literal `tabId`·`windowId`·`tabIds`(중첩 포함) 또는 `chrome_close_tabs.url` 이 있으면 `stale_target_forbidden`. legacy 는 그대로 저장된다.
14. `return` 없으면 응답에 `results` 키가 없다. 모르는 이름은 실행 전 `unknown_return_name`. 8,001자 항목은 통째로 빠지고 `resultsTruncated` 에 이름이 있다. 스크린샷 6장 batch 는 마지막 4장만 붙는다.
15. 사용자에게 보이는 문구(스키마 description, 오류 텍스트)에 U+2014, U+2013, U+3161 이 없다(파이썬 스캔).

### 구현하면서 정한 것 (3·4단계)

- 100회·100초 상한은 흐름 제어가 켜진 호출에만 적용한다. 새 키가 없는 v1 호출의 실행 의미를 바꾸지 않기 위해서다. 남은 시간은 각 도구 호출에 `deadlineMs` 로 함께 넘긴다.
- 상한으로 멈춘 반복 묶음도 `status: "stopped"` 이고 `attempts.stoppedBy` 에 실제 사유(`timeout`·`total_runs`)를 싣는다. 최상위 `stoppedBy.reason` 에도 그대로 남는다. 예전에는 enum 을 넷으로 유지하려고 `max`·`completed` 로 남겼는데, 묶음 항목만 읽는 쪽이 "20회 다 돌고 정상 종료"로 잘못 읽었다(2026-09-05 Codex 재확인 3).
- 반복 묶음 항목의 `tool` 값은 `"repeat"` 이다. 묶음에는 도구 이름이 없다.
- `repeat` 에 모르는 키가 있으면 `repeat_invalid`, `delayMs` 가 정수가 아니거나 음수면 `delay_invalid` 로 실행 전에 거절한다. 오타를 조용히 무시하지 않기 위해서다.
- 묶음도 `when` 과 `stopIf` 를 받는다. `when` 은 묶음 시작 전, `stopIf` 는 묶음이 끝난 뒤 판정한다.
- 조건 `path` 는 `{{ }}` 없는 같은 문법이므로 `params.user` 처럼 파라미터도 가리킬 수 있다. shortcut 저장 시 선언 대조는 args 토큰과 조건 path 를 함께 훑는다.
- `{{loop.count}}` 는 그 회차 번호(1부터)다. `{{loop.index}}` 는 0부터다.
- 스키마의 step 항목에서 `required: ["tool"]` 을 뺐다. 반복 묶음 항목에는 `tool` 이 없기 때문이다.
- `list` 의 `secret` 항목은 이름·`required`·`description` 만 싣는다(`secret` 은 `default` 를 가질 수 없어 값이 될 만한 것이 애초에 없다).

### 구현하면서 정한 것 (최종 검토 반영)

- **args 키 이름 `__proto__`·`constructor`·`prototype` 은 입력 단계에서 거절한다**(`forbidden_path_segment`). 치환기가 `out[key] = 값` 으로 대입하면 `__proto__` 는 대입이 아니라 prototype 교체가 되어, `Object.keys` 기반의 금지 키 2차 검사가 아무것도 못 보고 상속된 `tabId` 가 게이트에 읽힌다. 같은 이유로 치환이 만드는 객체의 키 대입은 전부 `Object.defineProperty` 로 하고(항상 own 데이터 속성), 도구 호출 직전에 args 트리의 모든 객체가 prototype 이 `null` 또는 `Object.prototype` 인지 확인한다(아니면 `template_forbidden_key`). 게이트(`utils/work-tab-gate.ts`)도 `tabId`·`windowId`·`tabIds`·`url`·`lane`·`_mcpSessionId`·`background` 를 `Object.hasOwn` 으로만 읽는다.
- **흐름 안에서 `chrome_userscript` 는 읽기 전용 `list`·`get` 만 허용한다**(`flow_stateful_tool_forbidden`). 판정은 치환이 끝난 `args.action` 으로 한다. 처음에는 `create`·`update`·`enable` 만 막았지만 `disable`·`remove` 도 같은 저장소를 쓰고, `send_command` 는 이미 영속된 스크립트에 치환된 payload 를 밀어 넣으며, `export` 는 저장된 본문을 통째로 흐름 캡처로 끌어온다. 새 action 이 늘 때 빠뜨리지 않도록 허용 목록으로 뒤집었다(2026-09-05 Codex 재확인 2). `action` 이 문자열이 아니면 도구가 스스로 `Unknown action` 으로 거절하므로 그대로 내려보낸다. v1 batch 와 단일 호출은 그대로다.
- **벽시계 상한은 절대 마감(`deadlineAt`, epoch ms)으로 넘긴다.** 상대값(남은 ms)은 게이트 조회·automation guard 지연·탭 락 대기 동안 낡는다. 마감은 게이트 앞, 지연 뒤, 락 획득 뒤, 워치독 상한 네 지점에서 확인하고, 남은 시간이 0 이하면 도구를 실행하지 않는다. 만료는 `FlowDeadlineExceededError` 로 러너까지 올려 그 step 을 `stopped` 로 닫고 `stoppedBy: { reason: "timeout" }` 으로 보고한다.
- **step 이 실패로 확정되면 그 step 의 `prev` 와 named capture 의 `$ok`·`$error` 를 맞춘다.** `capture_too_large` 나 `stopIf` 평가 오류처럼 캡처를 만든 뒤 상태가 뒤집히는 경우가 있어, 맞추지 않으면 `{{prev.$ok}}` 가 실패한 step 을 성공으로 보고한다. 본문(`$text`·값)은 실제로 돌아온 것이므로 그대로 둔다.
- **반복 묶음의 `resultText` 는 `stopIf` 로 멈춘 회차의 결과도 후보로 삼는다.** 그 step 도 실제로 실행됐으므로, 제외하면 묶음이 정작 멈춘 이유가 된 결과가 응답에서 사라진다.
- **shortcut 도 반복 묶음을 저장한다.** 저장 검증은 묶음 항목을 먼저 갈라내고 안쪽 step 을 재귀로 검사한다(`tool` 필수, 중첩 금지 도구, v2 의 `stale_target_forbidden` 이 안쪽에도 그대로 적용). `list` 의 `tools` 에는 `"repeat"` 와 안쪽 도구 이름이 함께 실린다.

## 9. 하지 않을 것

| 항목                                                           | 이유                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| batch·shortcut 중첩                                            | 상한(20 step, 100회, 100초)을 곱셈으로 뚫는다. `DISALLOWED_STEP_TOOLS` 유지                                                            |
| 문자열 표현식·임의 JS 조건                                     | 파서·평가기가 곧 공격면이다. 계산은 `chrome_javascript` step 으로 페이지 안에서                                                        |
| 조건식 정규식 연산자                                           | ReDoS 와 엔진 차이. `contains` 또는 javascript step 으로 대체                                                                          |
| 병렬 step                                                      | 모든 step 이 같은 작업 탭을 보므로 병렬은 곧 경쟁 상태다. 병렬은 레인으로 이미 해결한다                                                |
| `tabId` 등 대상 키 치환                                        | 4절. 게이트 우회 경로가 된다                                                                                                           |
| 회차 사이 `break`·`continue` 별도 키                           | `until` 과 `when` 조합으로 표현 가능. 키가 늘면 모델이 헷갈린다                                                                        |
| 값 변환 함수(`upper`, `slice`, `map`)                          | 표현력이 필요하면 javascript step. batch 는 배선만 한다                                                                                |
| 호출을 넘어 남는 변수                                          | shortcut 의 `params` 가 그 역할이다. 세션 상태를 늘리지 않는다                                                                         |
| `while`(실행 전 판정) 루프                                     | `repeat` + 첫 step 의 `when` 으로 같은 효과. 반복 형태를 하나로 유지                                                                   |
| 흐름 안에서 `chrome_userscript` 의 `list`·`get` 외 모든 action | 저장된 스크립트가 이후 매칭되는 모든 탭에 다시 주입된다. 치환된 비밀이 그대로 영속·전파되므로 `flow_stateful_tool_forbidden` 으로 거절 |

## 구현 순서

1. **공통 실행기 분리.** `batch.ts` 와 `shortcut.ts` 의 중복 루프를 `tools/browser/batch-runner.ts` 로 뽑고 두 파일이 호출하게 한다. `status` 필드 추가 외 동작 변경 없음. 산출물: `batch-runner.ts`, 두 파일의 호출 교체. 테스트: 체크리스트 1.
2. **치환기와 이름 붙이기.** `utils/step-template.ts` 에 활성화 판정, 토큰 파서, 치환기, 금지 키 2단 검사, 금지 세그먼트, prototype 없는 clone 을 순수 함수로(크롬 API 의존 없음). 실행기에 첫 text 블록 캡처(`prev` 64KiB, persistent 64/256KiB), `as`·`prev`·`return`, 컨텍스트 제거·재주입, background 덮어쓰기. 산출물: `step-template.ts` + 단위 테스트, 스키마에 `templates`·`as`·`return`. 테스트: 1a~7b, 14.
3. **조건·반복·종료.** `utils/step-condition.ts` 에 조건 검증·평가기(순수 함수), 실행기에 `when`·`stopIf`·`repeat`, 100회·100초 상한과 deadline 전달, `attempts` envelope. 산출물: 평가기 + 단위 테스트, 스키마 추가, `docs/TOOLS.md` 예시 (a)(b). 테스트: 8~11.
4. **shortcut 파라미터와 마무리.** `params` 선언 검증, 주입, `secret` 마스킹, v2 판정과 `stale_target_forbidden`, `templates` 레코드 필드, `list` 확장. 스키마 description, `docs/CHANGELOG.md`, 대시 스캔. 산출물: `shortcut.ts` 변경, 예시 (c). 테스트: 12, 13, 13a, 15, 실제 크롬에서 (a)(b)(c) 각 1회 실행 로그.
