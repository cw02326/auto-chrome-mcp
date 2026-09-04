# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.11.1] 산출물 저장 위치·자동 정리·doctor 포트 탐색 (2026-09-05)

확장과 브리지를 함께 1.11.1 로 올린다. 자동 정리는 새 브리지가 시작할 때부터 돈다.

### Changed

- **확장이 저장하는 파일이 전부 `Downloads/mcp-screenshots/YYYY-MM-DD/` 로 모인다.** 스크린샷,
  GIF 녹화, PDF, 성능 트레이스가 다운로드 폴더 루트에 흩어지던 것을 날짜 폴더 하나로 모았다.
  파일 이름은 `<종류>_<이름>_<시각>.<확장자>` 이고 이름에 경로를 넣어도 폴더 밖으로 나가지 않는다.
- **브리지가 시작할 때 오래된 산출물을 보관 폴더로 옮긴다.** `~/.auto-chrome-mcp/config.json` 의
  `artifactArchiveDir`(절대 경로), `artifactRetentionDays`(기본 7, 최소 1), `artifactCleanup`
  (`archive`, `delete`, `off`)을 읽어 날짜 폴더만 대상으로 옮기거나 지운다. 오늘 폴더와 진행 중인
  다운로드는 건드리지 않고, 정리 폴더가 junction 이면 건너뛰며, 여러 브리지가 동시에 뜨면 잠금으로
  한 번만 돈다. `auto-chrome-mcp-bridge artifacts --dry-run` 으로 미리 볼 수 있다.
- **알려진 한계.** 산출물 이동은 복사 뒤 원본을 다시 재서 같을 때만 지우지만, 그 재확인과 삭제
  사이의 아주 짧은 순간에 원본이 바뀌면 바뀐 파일이 지워질 수 있다. 이 폴더는 확장만이 고유한
  이름으로 쓰므로 실제로는 일어나기 어렵고, 잠금 회수의 같은 성격 경합은 파일 손실로 이어지지 않는다.
- **doctor 가 윈도우에서도 실행 중인 브리지 포트를 찾는다.** 지금까지는 ps·lsof 기반이라
  윈도우에서 항상 빈 결과였다. 이제 Get-NetTCPConnection(실패 시 netstat)으로 12300번대
  loopback 포트를 찾아 /ping 으로 확인하고, 설정 포트가 살아 있어도 항상 탐색한다. 브리지가
  둘 이상 떠 있으면 새 항목 `port.activeBridges` 가 경고한다.
- **포트 탐색이 정말로 항상 돌고, doctor 를 붙잡지 않는다.** "항상 돈다" 고 적어 둔 탐색이
  실제로는 stdio-config.json 이 있고 파싱까지 성공했을 때만 돌아서, 파일이 없거나 깨지면
  `port.activeBridges` 항목 자체가 사라졌다. 이제 설정 파일 상태와 무관하게 한 번 돈다.
  탐색은 포트를 8개씩 동시에 두드리고 전체 4초에서 끊으며(예전에는 최대 100개를 500ms 씩
  순차로 기다렸다), 포트 목록을 읽는 OS 명령에도 3초 제한과 출력 상한을 건다.

### Fixed

- **보관하려던 파일 대신 방금 만들어진 새 파일을 지우던 문제.** 산출물 정리가 파일을 복사하고
  fsync 하는 사이에 크롬이 같은 이름으로 새 산출물을 쓰면, 그다음에 지우는 것은 우리가 보관한
  그 파일이 아니라 새 파일이었다. 이제 복사 전에 원본의 크기·수정 시각·inode·device 를 재 두고
  지우기 직전에 다시 재서 넷이 모두 같을 때만 지운다. 하나라도 다르면 보관본은 그대로 두고
  원본은 남긴 뒤, 결과의 건너뛴 항목에 이유를 적는다.
- **정리 잠금이 남의 잠금을 지울 수 있던 문제.** 잠금 파일 이름이 고정이라 "지금 이 파일이 내
  잠금인가" 를 확인하지 않고 풀었고, 죽은 잠금 회수도 상태 확인과 삭제 사이가 벌어져 있었다.
  이제 잠금 파일에 소유자 토큰을 적고 그 토큰이 같을 때만 푼다. 오래된 잠금은 먼저 자기 이름으로
  옮겨 온 뒤에 지우고, 옮기기가 실패하면 다른 쪽이 먼저 회수한 것으로 보고 물러난다.
- **하드 링크를 못 쓰는 파일 시스템에서 보관본이 덮어써질 수 있던 문제.** 폴백이 이름의 존재를
  확인하고 rename 하는 방식이라, 확인과 rename 사이에 다른 정리가 같은 이름을 만들면 그 파일이
  조용히 사라졌다. 이제 새 파일로만 열리는 방식으로 자리를 먼저 잡고 그 자리에만 내용을 써 넣는다.
  이름이 이미 있으면 접미사를 올리고, 도중에 실패하면 반쪽짜리 파일을 지운다.
- **doctor 가 브리지 2개를 찾고도 정상이라고 하던 문제.** 설정 파일이 없거나 깨졌을 때도 포크
  기본 포트를 설정 포트로 쳐서 집계에서 빼는 바람에, 서로 다른 포트에서 브리지 둘이 돌아도
  `port.activeBridges` 가 정상으로 나왔다. 이제 개수는 언제나 탐색으로 식별한 포트 전부를 세고,
  "설정 포트는 빼고 센다" 는 설정을 실제로 읽어 냈을 때만 적용한다. 항목에 `liveBridgePorts` 와
  `liveBridgeCount` 를 함께 싣는다.
- **아무 서비스나 브리지로 집계되던 문제.** 무인증 응답의 `fork`·`version` 이 비어 있지만 않으면
  브리지로 인정해서, 12300번대에서 JSON 을 돌려주는 다른 프로그램이 "브리지가 하나 더 있다" 로
  보고됐다. 이제 `fork` 가 `auto-chrome-mcp` 와 정확히 같고 `version` 이 semver 형식일 때만
  브리지로 센다. 그 밖의 응답은 예전처럼 `unidentifiedPorts` 로만 적는다.
- **전역 fetch 가 없는 런타임에서 포트 탐색이 통째로 멈추던 문제.** package.json 의 지원 범위는
  `node >=14.0.0` 인데 탐색은 전역 fetch 에만 기대고 있어서, fetch 가 없으면 후보 포트를 하나도
  확인하지 못했다. 이제 그런 런타임에서는 `http.get` 기반 최소 구현으로 대신 확인한다. 본문은
  256KB 에서 끊고, 예전처럼 어떤 요청에도 토큰을 붙이지 않는다.

### Security

- **탐색으로 찾은 포트에는 브리지 토큰을 보내지 않는다.** 12300~12399 에서 LISTEN 중인 것이
  우리 브리지라는 보장이 없다. 아무 서비스나 `/ping` 에 200 만 돌려주면 doctor 가 그 포트를
  살아 있는 브리지로 보고, 그 뒤에 `Authorization: Bearer <토큰>` 을 붙여 `/health` 를
  조회했다. 이제 탐색 단계는 토큰 없이만 두드리고, 우리 브리지인지는 무인증 응답의
  `fork`·`version` 으로만 판정해 보고한다(응답은 했지만 식별되지 않은 포트는
  `unidentifiedPorts` 로 따로 적는다). 토큰이 붙는 조회는 설정 포트·`CHROME_PORT`·포크 기본
  포트에만 간다. 그래서 설정과 다른 동적 포트에만 브리지가 있는 설치에서는 확장 토큰 검사가
  "not checked" 로 남는다. 없는 검사를 통과했다고 쓰지 않기 위한 것이다.

## [v1.11.0] batch 흐름 제어·속도·안정성 (2026-09-05)

확장과 브리지를 함께 1.11.0 으로 올려야 새 batch 키(as, when, stopIf, repeat, params)가 보인다. 브리지 갱신 뒤 Claude Code 를 재시작해야 스키마가 반영된다.

### Fixed

- **스크린샷을 파일로 저장하면 응답에 이미지 전체가 한 번 더 실리던 문제.** 다운로드 시작
  이벤트의 url 필드에 data URL 본문(base64)이 그대로 들어가 스크린샷 한 장에 40만 자가
  붙었다. 이제 data·blob URL 은 종류와 길이만 남기고 일반 URL 도 200자에서 자른다.

### Added

- **`chrome_batch`·`chrome_shortcut` 이 step 사이로 값을 넘길 수 있다.** step 에 `as: "hit"` 를
  붙이면 그 결과가 이름으로 남고, 뒤 step 의 인자에서 `{{hit.matches[0].ref}}` 로 꺼내 쓴다.
  문자열 전체가 토큰 하나면 원래 타입(숫자·불리언·객체·배열·null)이 보존되고, 문자열 안에
  끼우면 문자열로 들어간다. 값이 없으면 빈 문자열로 조용히 넘어가지 않고 그 step 이
  `unresolved_reference` 로 실패한다. 참조 뿌리는 표시용으로 4,000자 잘린 `resultText` 가 아니라
  도구 응답의 첫 text 블록 원문이라 긴 결과에서도 `matches[19]` 같은 참조가 정확히 풀린다.
  `{{name.$ok}}`·`{{name.$text}}`·`{{name.$error}}` 메타와 직전 실행 결과 `{{prev...}}` 도 쓸 수 있다.
  최상위 `return: ["hit"]` 를 주면 응답에 `results` 객체가 실린다(없으면 그 필드 자체가 없다).
- **조건과 반복이 생겼다.** step 의 `when` 이 거짓이면 그 step 을 실행하지 않고 `skipped` 로
  남기고, `stopIf` 가 참이면 그 step 에서 호출 전체가 끝나며 뒤 step 은 `skipped` 가 된다.
  조건은 문자열 표현식이 아니라 JSON 객체(`{ "path": "hit.matches", "op": "notEmpty" }` 또는
  `all`·`any`·`not`)라 임의 코드 실행 경로가 없다. 연산자는 `exists`·`notExists`·`empty`·
  `notEmpty`·`eq`·`ne`·`gt`·`gte`·`lt`·`lte`·`contains` 이며, `value` 에 `{{...}}` 를 넣으면
  평가 직전에 치환돼 두 결과값을 비교할 수 있다. `{ repeat: { max, until, delayMs }, steps: [...] }`
  묶음은 최대 20회차를 돌고, 회차마다 안쪽 이름과 `prev` 를 비우며(`{{loop.index}}`·
  `{{loop.count}}` 사용 가능), 응답에는 항목 하나로 `attempts: { count, stoppedBy }` 만 싣는다.
  묶음에 `as` 를 주면 회차별 스냅샷 배열을 받는다. 묶음 중첩은 막았고, 흐름 제어가 켜진 호출은
  도구 호출 100회(`total_runs_exceeded`)와 벽시계 100초(`timeout`)에서 멈추고 그때까지의 결과를
  돌려준다. 새 키가 없는 기존 호출에는 이 상한이 적용되지 않는다.
- **`chrome_shortcut` 이 실행마다 다른 값을 받는다.** 저장 시 `params` 로 이름을 선언하고
  (`required`·`default`·`secret`·`description`, 최대 16개), 실행 시 `params` 로 값을 넘겨
  step 안에서 `{{params.user}}` 로 쓴다. 전달값이 `default` 를 이기고, 필수 누락은
  `missing_param`, 선언에 없는 이름은 `unknown_param`, 선언 없이 `{{params.x}}` 를 쓰면 저장
  시점에 `undeclared_param` 이다. `secret` 은 문자열만 받고 저장소에 쓰지 않으며 응답 문자열
  어디서든 `***` 로 가린다(8자 미만이면 오탐 가능성 경고가 붙는다). 실행 시 전달한 값은
  저장소에 남지 않고 `runCount` 만 오른다. `list` 응답에는 선언 요약이 실린다.
- **치환은 새 키가 있을 때만 켜진다.** `templates: true` 이거나 `as`·`return` 같은 새 흐름 키가
  하나라도 있을 때만 동작하므로, 기존 호출은 `{{...}}` 가 있어도 예전처럼 literal 로 전달된다.
  저장된 shortcut 도 레코드에 `templates` 표시가 있는 것만 치환한다(옛 레코드는 그대로 실행).
- **대상 탭을 고르는 인자는 치환할 수 없다.** `tabId`·`tabIds`·`windowId`·`lane`·`_mcpSessionId`,
  그리고 `url` 이 곧 대상 지정인 도구(`chrome_get_web_content`·`chrome_console`·
  `chrome_network_capture` 계열·`chrome_close_tabs`)의 `url` 에 `{{...}}` 를 넣으면
  `template_forbidden_key` 로 실행 전에 막는다. 치환으로 새로 생긴 객체 안의 같은 키도 다시
  훑어서 잡는다. 페이지에서 온 값이 사용자 탭을 가리키게 만드는 경로를 원천 차단한다.
  같은 이유로 새 형식(v2) shortcut 은 저장 시점에 `tabId`·`windowId`·`tabIds` 와
  `chrome_close_tabs` 의 `url` 을 아예 담지 못한다(`stale_target_forbidden`).
- **응답의 각 step 에 `status` 가 붙는다**(`completed | skipped | stopped | failed`). 기존 `ok` 는
  그대로이고, 조기 종료가 있었으면 `stoppedBy: { step, reason }` 이 함께 실린다
  (`reason` 은 `stopIf`·`total_runs_exceeded`·`timeout`).
- `chrome_batch` 와 `chrome_shortcut` 에 복사돼 있던 step 실행 루프를 공용 실행기
  `entrypoints/background/tools/browser/batch-runner.ts` 로 합쳤다. 20 step 상한, 4,000자
  `resultText`, 이미지 4장 상한, `continueOnError`, 중첩 금지 도구 목록은 그대로다.
- **`chrome_shortcut` 도 반복 묶음을 저장한다.** 예전에는 저장 검증이 모든 항목에 `tool` 을
  요구해 `{ repeat: {...}, steps: [...] }` 묶음을 아예 저장할 수 없었다(batch 로만 쓸 수 있었다).
  이제 묶음을 갈라내고 안쪽 step 을 재귀로 검사한다 - 중첩 금지 도구와 v2 의
  `stale_target_forbidden` 은 묶음 안쪽에도 그대로 적용된다. `list` 의 `tools` 에는 `repeat` 와
  안쪽 도구 이름이 함께 실린다.

### Security

- **치환된 인자가 prototype 을 타고 대상 탭을 바꾸는 경로를 막았다.** step 인자에
  `{"__proto__": "{{...}}"}` 를 넣으면 치환 결과가 인자 객체의 prototype 이 되어, own 키만 보는
  금지 키 검사에는 잡히지 않으면서 게이트에는 상속된 `tabId` 가 보였다(사용자가 보고 있는
  탭을 지정하는 우회). 이제 `__proto__`·`constructor`·`prototype` 은 인자 이름으로 쓸 수 없고
  (`forbidden_path_segment`), 치환은 키를 항상 own 데이터 속성으로 만들며, 도구 호출 직전에
  인자 트리의 prototype 을 확인한다(`template_forbidden_key`). 게이트도 대상 지정 키를
  own 속성으로만 읽는다.
- **비밀값이 확장 콘솔에 평문으로 남지 않는다.** `chrome_fill_or_select` 의 `value`,
  `chrome_keyboard` 의 `keys`, `chrome_network_request` 의 `body`·`headers` 처럼 `secret`
  파라미터가 흘러가는 인자를 도구 진입점이 `console.log(..., args)` 로 통째로 찍고 있었다.
  이제 비민감 필드만 남기는 사본(`utils/log-redact.ts`)을 찍는다. `url` 은 쿼리·해시를 떼고
  origin 과 경로만 남긴다. 같은 방식으로 bookmark·close_tabs·file_upload·history·screenshot·
  web_fetcher·network_capture 의 인자 로그도 함께 가렸다. 진입점 뒤에서 같은 URL 을 다시
  원문으로 찍던 후속 로그(navigate 의 탭 조회·재사용, close_tabs 의 패턴 조회, web_fetcher·
  inject_script 의 세션 탭 조회, network_request 의 전송 로그와 응답 덤프, network_capture 의
  요청 로그, user_consent 의 파싱 실패)도 같은 `redactUrlForLog` 로 origin 과 경로만 남긴다.
- **치환이 켜진 흐름 안에서 `chrome_userscript` 는 읽기 전용 `list`·`get` 만 허용한다**
  (`flow_stateful_tool_forbidden`). 영속된 스크립트는 이후 매칭되는 모든 탭에 다시 주입되므로
  치환된 비밀이 한 호출을 넘어 남고 퍼진다. `create`·`update`·`enable` 뿐 아니라
  `disable`·`remove` 도 같은 저장소를 쓰고, `send_command` 는 이미 영속된 스크립트에 치환된
  payload 를 밀어 넣으며, `export` 는 저장된 스크립트 본문을 통째로 흐름 캡처로 끌어온다.
  새 action 이 늘 때 빠뜨리지 않도록 금지 목록이 아니라 허용 목록으로 판정한다. 단일 호출과
  새 키가 없는 기존 batch 호출은 영향이 없다.
- **흐름의 100초 상한이 실제 상한이 됐다.** 예전에는 step 시작 시점의 "남은 시간" 을 넘겨서
  게이트 조회·속도 제한 지연·탭 락 대기 동안 그 값이 낡았고, 남은 시간이 0 이면 상한이 아예
  무시돼 도구가 최대 120초짜리 워치독으로 새로 돌기 시작했다. 이제 절대 마감 시각을 넘겨
  게이트 앞·지연 뒤·락 획득 뒤·실행 직전 네 지점에서 확인하고, 만료로 끊긴 step 은
  `stopped` 로 닫고 `stoppedBy: { reason: "timeout" }` 으로 보고한다.

### Fixed

- **상한으로 멈춘 반복 묶음이 "정상 완료"로 보고됐다.** `timeout`·`total_runs_exceeded` 로
  끊긴 묶음도 `status: "completed"`, `attempts.stoppedBy: "max"` 로 남아, 묶음 항목만 읽는 쪽은
  20회를 다 돌고 끝난 것으로 잘못 읽었다. 이제 묶음도 `status: "stopped"` 이고
  `attempts.stoppedBy` 에 `timeout`·`total_runs` 가 실린다(enum 에 두 값 추가).
- **실패로 확정된 step 뒤에서 `{{prev.$ok}}` 가 `true` 였다.** 캡처를 raw 성공으로 먼저 기록한
  뒤 `capture_too_large` 나 `stopIf` 평가 오류가 그 step 을 실패로 바꿔도 캡처의 `$ok`·`$error`
  는 그대로였다. 최종 상태가 정해진 뒤 `prev` 와 이름 붙인 캡처를 함께 맞춘다.
- **반복 묶음이 `stopIf` 로 멈추면 응답에 `resultText` 가 비어 있었다.** 멈춘 회차의 step 도
  실제로 실행돼 결과가 있는데 상태가 `stopped` 라는 이유로 후보에서 빠졌다. 이제 그 결과가
  묶음의 `resultText` 로 실린다 - 묶음이 멈춘 이유를 응답에서 바로 볼 수 있다.

### Changed

- **Playwright CDP 폴백 레지스트리의 죽은 stub 을 고쳤다.** `chrome_` 접두사 오기로 절대
  매치되지 않던 키 5개(`chrome_semantic_search` → `search_tabs_content`,
  `chrome_performance_start_trace` → `performance_start_trace`,
  `chrome_performance_stop_trace` → `performance_stop_trace`,
  `chrome_performance_analyze_insight` → `performance_analyze_insight`,
  `chrome_get_windows_and_tabs` → `get_windows_and_tabs`)를 실제 도구 이름으로 바로잡았다.
  포크가 추가한 뒤 이 레지스트리에 한 번도 반영되지 않았던 도구 12개
  (`chrome_request_user_consent`, `chrome_batch`, `chrome_set_work_tab`, `chrome_wait_for`,
  `chrome_scroll_collect`, `chrome_storage`, `chrome_save_pdf`, `chrome_emulate`,
  `chrome_network_rules`, `chrome_extract`, `chrome_find`, `chrome_shortcut`)도 공통
  "native messaging 전용" stub 으로 등록해, 폴백 모드에서 호출하면 안내 없이 무반응하는
  대신 이유가 담긴 에러를 즉시 돌려준다. 개별 구현은 하지 않았다.
- `docs/PLAYWRIGHT_FALLBACK.md` 의 도구 커버리지 표를 위 수정에 맞춰 다시 썼다(옛 33개
  upstream 기준 대신 현재 48개 전달 가능 도구 기준).
- `docs/TOOLS.md` 에 "Hidden Tools (Internal Only)" 절을 새로 만들어
  `search_tabs_content`·`chrome_inject_script`·`chrome_send_command_to_inject_script`·
  `chrome_userscript`·`chrome_get_interactive_elements` 를 문서화했다. 다섯 다 디스패치
  등록과 구현 파일이 실제로 있어 삭제하지 않고 유지하되, 왜 `TOOL_SCHEMAS`(MCP 에 광고하는
  목록)에는 없는지를 남겨 다음 정리에서 죽은 코드로 오인되지 않게 했다.
- `packages/shared/src/tools.ts` 의 `TOOL_NAMES` 에서 위 다섯 항목 옆에 같은 취지의 주석을
  달았다. 노출 여부(스키마)는 바꾸지 않았다.

- **고정 대기 일부를 조건 대기로 바꿔 도구 응답이 빨라졌다.** `chrome_screenshot` 은 헬퍼를
  주입한 뒤 무조건 100ms 를 쉬는 대신 ping 에 pong 이 오면 즉시 넘어간다. `chrome_wait_for` 는
  250ms 폴링을 그대로 기다리지 않고 페이지의 DOM 변화(MutationObserver)로 깨어나 조건을 다시
  확인하며, 변화가 없으면 예전과 같은 간격의 폴링이 폴백으로 남는다. 관찰자는 문서당 하나만
  두고 새로 걸기 전에 이전 것을 끊으며, 기준 시계는 확장 쪽 타이머 하나뿐이라 백그라운드 탭에서
  페이지 타이머가 스로틀돼도 전체 소요가 `timeoutMs` 를 넘지 않는다.
  `chrome_scroll_collect` 는 스크롤 뒤 문서가 자라고, 같은 수치가 연속 3회(각 150ms) 나오고,
  진행 중인 네트워크 요청도 없을 때만 다음 패스로 넘어간다. 셋 중 하나라도 확인하지 못하면
  예전처럼 `delayMs` 를 다 기다리므로 지연 로딩 콘텐츠가 빠지지 않는다.
  `chrome_console`(snapshot)의 2초 플러시 대기는 그대로 두었다. "조용해지면 반환"으로 바꿔
  봤더니 300ms 조용해진 뒤 800ms 만에 터지는 예외를 놓쳐서, 스냅샷은 유실 방지를 우선한다.
  작업 창 탭을 활성화한 뒤의 대기는 프레임이 그려진 것(rAF 두 번)을 확인하고도 최소 150ms 는
  채우고, 확인할 수 없는 탭에서는 300ms 까지만 기다린다. 활성화 직후의 중간 프레임이 찍히는
  것을 막기 위해서다.
- **`chrome_click_element`·`chrome_fill_or_select` 가 전송 전에 멈춘 실패만 1회 자동 재시도한다.**
  요소가 잠깐 가려졌거나(오버레이·뷰포트 밖·크기 0), 재렌더로 떨어져서 헬퍼가 이벤트를 쏘기
  전에 되돌아온 경우가 대상이다. 최대 300ms 안정화(조건이 충족되면 즉시)를 거쳐 같은 탭·같은
  프레임에서 한 번 더 시도하고, 결과에 `retried: true` 와 `retryReason` 을 싣는다.
  재시도는 최초 실패 시점에 고정한 요소(ref)로만 간다. selector 를 다시 해석하지 않고 프레임을
  다시 검색하지도 않으므로, DOM 이 재정렬돼도 다른 요소를 누르지 않는다. 요소를 고정할 수
  없거나 상태를 확인할 수 없으면 재시도하지 않는다.
  포트가 끊기거나 컨텍스트가 사라진 실패는 **보낸 뒤 응답만 잃은** 것일 수 있으므로 재시도하지
  않는다. 그때는 원래 오류에 "이미 반영됐을 수 있으니 상태를 확인하라"는 안내가 붙는다.
  셀렉터 불일치, 대기 후에도 요소 없음, 채울 수 없는 요소 같은 영구 실패도 그대로 실패한다.
  재시도 사이에 URL 이나 문서(documentId)가 바뀌었으면 두 번 누르는 사고를 막기 위해
  중단한다. 실패 응답의 형식은 예전 그대로이고 문구 끝에 `(retried once: ...)` 만 덧붙는다.
  파라미터·스키마 변경은 없다.

## [v1.10.1] 무간섭 게이트·브리지 인증·토큰 절감 (2026-09-04)

확장과 브리지를 **함께** 1.10.1 로 올려야 한다. 브리지만 올리면 팝업의 강제 재연결이 401 이 나고, 확장만 올리면 새 스키마가 보이지 않는다.

### Changed

- **도구 스키마가 19% 가벼워졌다(62,572자 → 50,611자).** 33개 도구에 반복되던 `lane` 설명을
  절반으로 줄이고, `tabId`·`windowId`·`frameId` 같은 공통 파라미터 설명을 한 벌로 통일했으며,
  `chrome_gif_recorder`·`chrome_computer` 의 중첩 옵션 설명에서 반복 예시를 걷어냈다. 파라미터
  이름·타입·필수 여부·enum 은 하나도 바뀌지 않았다. `tabId` 설명은 현재 동작(생략 시 세션 작업 탭)에
  맞게 고쳤다.
- **`chrome_read_page` 응답의 고정 안내문을 도구 설명으로 옮겼다.** 호출마다 250자 넘게 붙던
  tips 를 없애고 compact 포맷 규칙은 스키마 description 에 남겼다. 요소가 극히 적을 때만 한 줄
  안내가 붙는다.
- **`get_windows_and_tabs` 가 탭 제목을 80자, URL 을 200자로 잘라 돌려준다.** 탭을 수십 개
  열어 둔 환경에서 응답이 끝없이 커지던 것을 막는다.

- **작업 창 기본값이 `current` 로 돌아왔다.** v1.9.0 의 `dedicated` 기본값은 작업마다 새 창을
  만들어 오히려 더 방해가 됐다. 이제 저장값이 없으면 사용자가 열어 둔 창에 백그라운드 새 탭을
  만든다. 저장 키 우선순위(새 키 > 구버전 키 > 기본값)는 그대로다.
- 팝업의 **"무간섭 권장 설정으로 되돌리기"** 버튼도 작업 창 모드를 `current` 로 맞춘다.
  팝업이 storage 변경을 반영할 때 값이 `dedicated` 일 때만 토글을 켠 것으로 표시한다
  (키가 지워진 경우 기본값과 어긋나던 문제 수정).
- **MCP 작업 탭이 초록색 탭 그룹 "MCP" 로 묶인다.** 작업 창 기본값이 `current` 로 돌아온 뒤
  MCP 가 만든 탭이 사용자 탭과 같은 탭 스트립에 섞이게 됐다. 이제 MCP 가 직접 만든 탭과
  `chrome_set_work_tab` 으로 지정한 탭이 창마다 하나씩 있는 "MCP" 그룹에 자동으로 들어가
  한눈에 구분되고, 그룹째 접거나 닫을 수 있다. 사용자가 직접 연 탭은 편입되지 않는다.
  편입은 탭을 활성화하거나 창 포커스를 바꾸지 않으며, 그룹을 접지도 않는다. 권한이 없거나
  탭이 이미 사라졌으면 경고 로그만 남기고 도구 결과에는 영향을 주지 않는다.
  팝업의 **"작업 탭 그룹 표시"** 토글로 끌 수 있다(기본 켜짐). manifest 에 `tabGroups`
  권한이 추가됐으므로 확장을 다시 로드해야 적용된다.

### Fixed

- **작업 탭이 없을 때 도구가 사용자의 활성 탭으로 흘러가던 문제.** 백그라운드 작업 모드에서
  게이트는 작업 탭이 있을 때만 `tabId` 를 주입했다. 그래서 새 세션이 `chrome_navigate` 없이
  `chrome_click_element` · `chrome_fill_or_select` · `chrome_read_page` · `chrome_screenshot`
  을 먼저 부르면, 각 도구 구현이 활성 탭으로 떨어져 사용자가 보고 있는 탭을 읽고 조작했다.
  이제 이런 호출은 구조화 오류 `no_work_tab` 으로 거절하고, 작업 탭을 먼저 만들라고
  알려 준다. 호출자가 `tabId` 를 직접 준 경우, `chrome_switch_tab` ·
  `chrome_set_work_tab` · `get_windows_and_tabs` 처럼 정의상 사용자 탭을 다루는 도구,
  그리고 대상 탭을 아예 찾지 않는 호출(`chrome_network_rules`, `url` 을 직접 준 쿠키 조작)은
  그대로 통과한다. 백그라운드 작업 모드를 끄면 예전 동작을 유지한다.
- **`chrome_navigate` 의 `refresh` · `back` · `forward` 가 세션 작업 탭을 무시하던 문제.**
  이 세 분기는 작업 탭을 조회하지 않고 활성 탭을 잡았다. 그래서 레인의 작업 탭이 멀쩡히
  있어도 `{refresh:true, lane:"a"}` 가 사용자 탭을 새로고침하고, 그 탭을 그 레인의 작업 탭으로
  기록해 이후 호출까지 사용자 탭을 대상으로 삼았다. 이제 해석 순서가 하나로 정해졌다:
  명시한 `tabId`, 그 레인의 작업 탭, 그리고 백그라운드 작업 모드가 꺼져 있을 때만 지정한
  창의 활성 탭. 모드가 켜져 있고 작업 탭이 없으면 `no_work_tab` 으로 거절한다.
- **작업 탭·레인 기록이 동시 변경에 유실되던 문제.** 작업 탭 map, 소유 탭 목록, 전용 작업 창
  표지가 모두 "읽어서 복제한 뒤 비동기로 저장" 이었다. 두 레인이 동시에 `chrome_navigate` 를
  부르면 둘 다 옛 상태를 복제해 마지막 저장만 남았고(한쪽 레인의 작업 탭 기록이 조용히
  사라진다), 소유 탭 표시의 3초 디바운스 저장은 그 사이 정리된 탭을 되살렸다. 이제 초기
  적재는 promise 를 공유하고, 모든 상태 변경과 저장은 단일 큐로 직렬화하며, 디바운스 저장은
  캡처한 상태가 아니라 실행 시점의 최신 상태를 쓴다. 공개 API 시그니처는 그대로다.
- **업로드 임시 파일 이름으로 디렉터리를 벗어날 수 있던 문제.** `chrome_upload_file` 의
  `fileName` 이 검증 없이 경로 조합에 쓰였다. 그래서 `../../x` 같은 값이 오면 임시
  디렉터리 밖 아무 곳에나 파일을 썼고, 정리(cleanup) 검사도 문자열 접두어 비교라
  `chrome-mcp-uploads-evil` 같은 형제 디렉터리를 통과시켰다. 이제 `fileName` 은 경로가
  아닌 파일명만 받고(구분자·`..`·빈 값·널 바이트 거부), 최종 경로가 임시 디렉터리 안에
  있는지 정규화해서 확인한다. 정리도 같은 기준을 쓴다. 임시 디렉터리도 공유 임시 폴더의
  고정된 이름에서 사용자 전용 상태 디렉터리 아래로 옮겼다. 예전에는 같은 컴퓨터의 다른
  사용자가 그 폴더를 먼저 만들고 파일 이름을 심볼릭 링크로 심어 두면 업로드가 링크를 따라가
  링크가 가리키는 파일을 덮어썼다. 이제 파일은 새로 만드는 방식으로만 열고(그 자리에 이미
  무언가 있으면 실패), 쓰기 전에 링크이거나 일반 파일이 아니면 거부한다.
- **stdio 프록시의 첫 연결이 병렬 호출에 안전하지 않던 문제.** 연결이 끝나기 전에 공용
  client 를 전역에 먼저 넣어 두었기 때문에, 세션 시작 직후 도구 호출 두 개가 동시에 오면
  두 번째 호출이 아직 연결 중인 client 에 ping 을 던져 실패하고 그 client 를 닫아버렸다.
  첫 호출은 닫힌 client 로 실패하고 브리지에는 쓰이지 않는 HTTP 세션이 하나 남았다. 이제
  연결이 진행 중이면 모든 호출이 같은 약속(promise) 하나를 기다리고, 새 client 는 연결이
  성공한 뒤에만 전역에 반영되며, client 닫기는 끝까지 기다린다. 연결 중에
  `chrome_use_browser` 로 대상이 바뀌면 그 연결은 버린다.
- **잘못된 `tabId` 로 작업 탭 게이트를 우회할 수 있던 문제.** 게이트는 `tabId` 가
  `undefined` 만 아니면 "호출자가 지정했다" 로 보고 그대로 통과시켰다. 그래서
  `tabId: null` · `"x"` · `0` 처럼 탭 id 가 될 수 없는 값이 오면, 게이트는 통과시키고
  도구 구현은 그 값을 못 쓰니 사용자의 활성 탭으로 떨어졌다. 이제 `tabId` 는 양의 정수만
  지정으로 인정하고, 그 밖의 값은 구조화 오류 `invalid_tab_id` 로 즉시 거절한다
  (작업 탭으로 몰래 바꿔치기하지도 않는다). 백그라운드 작업 모드를 꺼 두었을 때와
  `chrome_switch_tab` 같은 예외 도구에도 똑같이 적용된다.
- **탭이 필요 없는 정당한 호출이 새로 막히던 문제.** 쿠키 조회·삭제는 `url` 대신
  `domain` 으로 범위를 줄 수 있는데 게이트가 `url` 만 인정해 작업 탭을 요구했다. 또
  `windowId` 를 지정한 호출은 사용자가 대상 창을 고른 것인데도 거절되거나, 작업 탭이
  끼어들어 지정한 창이 무시됐다. 이제 `domain` 만 준 쿠키 `get` · `clear` 는 탭 없이
  통과하고(`set` · `remove` 는 `url` 이 필요하므로 그대로), 양의 정수 `windowId` 를 준
  호출은 그 창의 활성 탭을 쓰도록 통과시킨다.
- **전용 작업 창 표지가 판정 도중 갱신돼도 지워지던 문제.** 표지 대조는 크롬 API 응답을
  기다리는 동안 다른 레인이 새 작업 탭을 등록해도 그것을 보지 못하고, 판정이 끝나면 갱신된
  표지까지 통째로 지웠다. 멀쩡한 작업 창을 버리고 새 창을 만들었고, 그 사이 작업 창을
  사용자 창으로 오인해 탭 활성화 보호가 풀렸다. 이제 무효화는 "판정 때 읽은 표지와 지금
  표지가 같을 때만" 지우고(compare-and-clear), 창 생성과 표지 기록은 하나의 임계 구역에서
  끝낸다. 창이 닫혔을 때의 정리도 같은 방식이다.
- **모든 도구 호출에 저장소 쓰기가 하나씩 붙던 문제.** 작업 탭 조회가 호출마다 LRU 표시를
  `chrome.storage.session` 에 저장했고, 게이트는 도구 호출마다 그 조회를 했다. 이제 표시는
  메모리에서 갱신하고 저장은 기존 디바운스에 태운다. 게이트도 판정 순서를 바꿔, 사용자 대면
  예외 도구와 `tabId` 를 직접 준 호출에서는 작업 탭을 아예 조회하지 않는다.
- **흐름 재생의 클릭·입력이 재생 중인 탭을 명시하지 않던 문제.** 요소를 찾기 전에 부르는
  `chrome_read_page` 에 `tabId` 를 넘기지 않아, 게이트가 다른 작업 탭을 주입하거나
  (모드를 꺼 두었으면) 사용자의 활성 탭을 읽었다. 이제 재생 중인 탭을 명시한다.

- **명시적 `windowId` 로 작업 탭 게이트를 우회할 수 있던 문제.** `windowId` 만 주면 모든 탭 대상
  도구가 통과됐는데, `chrome_javascript`·`chrome_extract`·`chrome_wait_for` 처럼 `windowId` 를
  읽지 않는 도구는 사용자의 활성 탭으로 흘러갔다. 이제 `windowId` 로 실제 대상을 고르는 도구
  14개만 예외로 두고 나머지는 작업 탭 규칙을 그대로 적용한다. 그중
  `chrome_get_web_content`·`chrome_console`·`chrome_inject_script` 는 `url` 을 함께 주면 창 지정을
  버리고 모든 창에서 URL 이 일치하는 탭을 골랐으므로, `url` 이 있으면 창 예외를 주지 않는다.
  이 세 도구와 네트워크 캡처의 URL 조회 자체도 이 세션이 소유한 탭 안에서만 하고, 없으면 새 탭을
  만든다. 사용자 탭은 후보에서 빠진다. 새 탭은 지정한 창, 지정이 없으면 이 세션의 작업 탭이
  있는 창에 백그라운드로 만들고 세션 소유로 등록한다.
- **`url` 을 준 호출이 엉뚱한 페이지를 돌려주던 문제.** 게이트는 `tabId` 가 없으면 작업 탭 id 를
  넣었는데, 위 네 도구는 `tabId` 분기를 `url` 분기보다 먼저 본다. 그래서 세션에 작업 탭이 있으면
  `chrome_get_web_content({url:"https://a.com"})` 이 a.com 을 찾지도 열지도 않고 기존 작업 탭
  내용을 돌려줬고, 작업 탭이 없으면 `no_work_tab` 으로 거절했다. 이제 `url` 이 대상 지정인
  호출에는 작업 탭 id 를 주입하지도, 작업 탭이 없다고 거절하지도 않는다. `tabId` 와 `url` 을
  둘 다 주면 예전대로 `tabId` 가 이긴다. 백그라운드 작업 모드를 끄면 예전 동작 그대로다.
- **게이트가 주입한 `tabId` 를 버리던 도구들.** `chrome_get_interactive_elements` 는 `tabId`
  파라미터 자체가 없어 항상 활성 탭을 읽었고, 통합 `chrome_network_capture` 는 실제 캡처 도구로
  넘길 때 `tabId` 를 빠뜨렸으며, `chrome_userscript` 는 중첩된 `args.tabId` 만 읽었다. 캡처 시작은
  `url` 분기가 `tabId` 보다 앞이라 주입값을 덮어썼다. 네 경로 모두 지정된 `tabId` 를 먼저 쓴다
  (`url` 만 준 호출에는 애초에 작업 탭이 주입되지 않는다).
- **닫힌 창의 id 가 새 작업 창에 재사용되면 표지가 지워지던 문제.** 창 제거 이벤트가 잠금 뒤에서
  기다리는 사이 같은 id 로 새 작업 창이 생기면 새 표지를 지웠다. 이제 그 id 의 창이 아직 존재하는지
  부터 확인해, 존재하면(재사용) 지우지 않고 존재하지 않으면(진짜 닫힘) 그 사이 작업 탭이 등록돼
  표지가 달라졌더라도 지운다. 예전 순서는 표지 대조가 먼저라 진짜 닫힌 창의 표지가 남았다.
- **`record_replay_flow_run` 이 백그라운드 작업 모드를 무시하던 문제.** 재생 엔진은 대상 탭을 스스로
  고른다(`tabTarget` 이 없거나 `current` 면 사용자의 활성 탭, 대부분의 단계도 활성 탭을 다시 조회).
  그래서 게이트가 작업 탭을 주입해도 소비하는 곳이 없었다. 엔진이 대상 탭을 존중하도록 고치기
  전까지, 백그라운드 작업 모드에서는 이 도구를 구조화 오류 `background_mode_unsupported` 로
  거절하고 MCP 도구 목록에도 싣지 않는다. 모드를 끄거나 사이드패널에서 직접 실행하면 그대로
  동작한다.

### Security

- **로컬 HTTP 브리지에 인증을 넣었다.** 브리지는 127.0.0.1 의 고정 포트에서 듣는데
  `/mcp` 와 `/admin/*` 에 아무 검사가 없었다. CORS 는 응답을 읽는 것만 막고 요청 실행은
  막지 못하므로, 사용자가 아무 웹페이지를 열어 두기만 해도 그 페이지가
  `POST /admin/kill-self` 한 번으로 브리지를 죽이거나 `POST /mcp` 로 새 MCP 세션을 열 수
  있었다. 이제 브리지가 listen 하기 전에 무작위 토큰을 만들어
  `~/.auto-chrome-mcp/auth-token` 에 소유자만 읽을 수 있게 저장하고, 보호 경로는 예외 없이
  그 토큰을 요구한다. 부작용 없는 조회인 `/ping` 과 `/health` 만 공개로 남는다. 다만
  `/health` 는 토큰이 없으면 살아 있다는 사실만 답한다. pid, node 버전, 메모리, 열려 있는
  세션 수 같은 상세는 토큰이 있을 때만 준다. 확장 팝업의 진단과 강제 재연결은 토큰을
  붙이므로 예전처럼 상세를 받는다.
  토큰 파일은 상태 디렉터리를 먼저 소유자 전용으로 잠근 뒤(윈도우는 icacls 로 상속을 끊고
  현재 사용자만 남긴다) 같은 디렉터리의 임시 파일에 쓰고 잠가서 최종 경로에 건다. 이때
  덮어쓰지 않는 방식(하드 링크)을 쓴다. 파일이 이미 있으면 실패하므로, 같은 순간에 뜬 두
  브리지 중 진 쪽은 남의 토큰을 지우지 않고 그 파일을 읽어 그대로 쓴다. 자리에 있는 것이
  형식이 깨진 쓸모없는 파일일 때만 지우고 다시 거는데, 지우고 거는 사이에 상대가 먼저
  자리를 잡으면 그 값을 채택한다. 하드 링크를 만들 수 없는 파일시스템에서는 최종 경로를
  "없을 때만 만들기" 로 직접 열어 같은 방식으로 자리를 잡는다. 이름 바꾸기로 교체하는
  경로는 없앴다. 이름 바꾸기는 조용히 덮어쓰기 때문에, 먼저 쓴 브리지가 자기 토큰을 확인한
  직후 다른 브리지가 덮어쓰면 서버가 검증하는 토큰과 디스크의 토큰이 어긋날 수 있었다.
  윈도우 권한 확인은 이름 목록에서 허용 목록으로 바꿨다. 예전에는 영문 그룹 이름 네 개만
  찾아서, 다른 계정을 콕 집어 준 권한이나 한국어·독일어처럼 현지화된 그룹 이름이 남아
  있어도 "소유자 전용" 으로 봤다. 이제 ACL 의 모든 항목을 읽어 현재 사용자와 SYSTEM 이
  아닌 것이 하나라도 있으면 위반으로 본다. 권한을 아예 읽지 못한 경우도 안전하다고 답하지
  않는다. 이미 있는 파일도 시작할 때마다 같은 기준으로 다시 확인하되, 위반이면 다시 잠그는
  것으로 끝내지 않는다. 느슨했던 동안 다른 로컬 계정이 이미 그 토큰을 읽어 갔을 수 있어서,
  다시 잠가도 그 값은 더 이상 비밀이 아니기 때문이다. 그래서 일반 파일이면서 잠그기 전에
  이미 소유자 전용이었던 파일만 그대로 쓰고, 그 밖의 경우(권한 위반, 권한을 못 읽음,
  심볼릭 링크, 일반 파일이 아님)에는 부모 디렉터리를 먼저 잠근 뒤 새 토큰으로 갈아끼우고
  그 사실을 stderr 에 남긴다. stdio 프록시는 연결할 때마다 토큰 파일을 다시 읽으므로
  다음 연결부터 새 토큰을 쓴다.
  잠금에 실패해도 브리지는 계속 뜨고, 그 사실을 stderr 와
  `auto-chrome-mcp-bridge doctor` 가 알려 준다.
  토큰은 두 경로로 전달된다. stdio 프록시는 토큰 파일을 직접 읽고, 파일을 읽을 수 없는
  확장은 네이티브 메시지 `SERVER_STARTED` 로 같은 토큰을 받아 세션 저장소에만 보관한다.
  둘 다 `Authorization: Bearer` 로 보내고 서버는 상수 시간 비교로 검증한다. 예전에는
  확장 origin(`chrome-extension://...`)을 신원으로 인정해 토큰 없이 통과시켰지만 그 예외는
  없앴다. Origin 헤더는 브라우저가 붙일 때만 의미가 있고 같은 컴퓨터의 다른 프로그램은 그
  값을 마음대로 붙일 수 있으며, 신뢰할 확장 목록이 비면 모든 확장을 통과시키는 구조인 데다
  실행 래퍼가 크롬이 준 인자를 브리지에 넘기지 않아 그 목록은 언제나 비어 있었다. 이제
  래퍼는 인자를 그대로 넘기고, 크롬이 준 호출자 origin 은 로그와 진단 표시용으로만 쓴다.
  그래서 새 브리지에는 새 확장이 필요하다. 옛 확장을 그대로 쓰면 팝업의 강제 재연결이
  401 을 받는다. 브리지는 이 상황을 조용히 넘기지 않는다. 확장 origin 이 붙은 요청이 토큰
  없이 들어와 거절되면 stderr 에 "확장 버전이 낮다" 고 남기고,
  `auto-chrome-mcp-bridge doctor` 의 `Extension token support` 항목이 같은 사실을 보고한다.
- **설치 스크립트가 더 이상 upstream 웹스토어 확장 ID 를 등록하지 않는다.**
  `auto-chrome-mcp-install` 은 네이티브 메시징 manifest 의 `allowed_origins` 에 사용자가
  준 ID 와 함께 upstream 확장 ID 를 언제나 넣었다. 여기 적힌 확장은 이 네이티브 호스트를
  띄울 수 있고, 붙는 순간 브리지가 `SERVER_STARTED` 로 bearer 토큰을 건넨다. 즉 upstream
  확장이 설치돼 있기만 해도 로컬 브리지를 그대로 조종할 수 있었다. 이제 기본은 포크 고정
  ID(`aogfhfajjknomcnmlkbjmihjbknlhbbi`) 하나뿐이고, 다른 ID 는 `--extension-id` 로 직접
  지정했을 때만 들어간다. 도움말이 안내하던 `--extension-id <ID>` 공백 표기도 이제 실제로
  동작한다(예전에는 `--extension-id=<ID>` 만 인식했다).
- **같은 이름으로 동시에 들어온 업로드가 서로의 파일을 덮어쓰지 않는다.** 네이티브 호스트는
  들어온 메시지를 순서대로 기다리지 않고 처리한다. 그래서 같은 `fileName` 으로 두 건이
  겹치면 내려받기와 디코딩 사이에서 서로 끼어들어, 먼저 끝난 쪽이 돌려받은 경로에 나중
  쪽의 내용이 들어 있었다. 확장이 이름을 주지 않으면 `uploaded-file` 로 고정되므로 실제로
  잘 겹치는 조합이었고, 그 결과 웹페이지에 엉뚱한 파일이 올라갈 수 있었다. 이제 요청마다
  임시 디렉터리 안에 무작위 이름의 하위 폴더를 하나 만들고 그 안에 넣는다. 페이지에 보이는
  파일 이름은 그대로 유지된다.
- **CORS origin 검사를 문자열 접두어 비교에서 URL 파싱으로 바꾸고 Host 검사를 더했다.**
  예전 검사는 `origin.startsWith('http://127.0.0.1')` 이라
  `http://127.0.0.1.attacker.example` 처럼 로컬 주소를 흉내낸 원격 origin 을 로컬로
  취급했다. 이제 protocol, hostname, port 를 각각 정확히 비교하고, Origin 헤더가 붙어
  있으면 확장이나 loopback 목록 안이어야 한다. Origin 만으로는 공격자가 자기 도메인을
  127.0.0.1 로 돌려놓는 수법(DNS 리바인딩)을 막지 못한다. 그때 브라우저는 같은 출처로 보고
  Origin 을 아예 붙이지 않기 때문이다. 그래서 요청의 Host 가 `127.0.0.1`, `localhost`,
  `[::1]` 중 하나이고 브리지가 듣는 포트와 같은지도 확인한다. 이 검사는 `/ping` 과
  `/health` 를 포함한 모든 경로에 적용된다.

## [v1.10.0] 이전 브랜딩 제거 (2026-09-02)

프로젝트 전반에 남아 있던 이전 브랜딩을 문서 문구부터 동작 식별자까지 모두 걷어냈다.
**네이티브 호스트 이름이 바뀌므로 브리지와 확장을 반드시 함께 1.10.0 으로 올려야 한다.**

### Changed

- **네이티브 메시징 호스트 이름을 `com.autochromemcp.nativehost` 로 바꿨다.** 확장과
  브리지 양쪽이 같은 이름을 써야 연결된다. 한쪽만 올리면 붙지 않는다.
- **런처 CLI 이름이 `auto-chrome-launcher` 다.** bin 래퍼 파일 이름도
  `auto-chrome-launcher.sh` / `.bat` / `.command` 로 바뀌었다. 런처 패키지 이름은
  `auto-chrome-mcp-launcher` 다.
- **Claude Code 트러블슈팅 스킬 이름이 `auto-chrome-mcp-doctor` 다.** 설치 경로는
  `~/.claude/skills/auto-chrome-mcp-doctor/SKILL.md` 이고, 버전 비교에 쓰는 SKILL.md 의
  마커도 `# auto-chrome-mcp-version:` 으로 바뀌었다.
- **스킬 자동 설치 opt-out 환경변수가 `AUTO_CHROME_MCP_NO_SKILL=1` 이다.** 확장 zip
  다운로드를 건너뛰는 변수도 `AUTO_CHROME_MCP_SKIP_EXTENSION_DOWNLOAD=1` 로 바뀌었다.
- **CDP 포트 파일 경로가 `~/.auto-chrome-mcp/cdp-port` 다.** 런처가 쓰고 브리지가 읽는
  파일이라 둘 다 같은 버전이어야 한다. 확장 zip 을 푸는 폴더도
  `~/Downloads/auto-chrome-mcp-extension-v<version>/` 이다.

### Removed

- **하위호환 bin 별칭을 없앴다.** 이전 이름의 bridge / stdio / install 별칭이 더 이상
  설치되지 않는다. 이전 별칭을 스크립트나 `.mcp.json` 에 적어 뒀다면
  `auto-chrome-mcp-bridge`, `auto-chrome-mcp-stdio`, `auto-chrome-mcp-install` 로 고쳐야 한다.

### Migration

- postinstall 이 이전 이름의 흔적을 정리한다(실패해도 설치는 계속된다). 이전 이름의 스킬
  디렉터리를 지우고, 이전 네이티브 호스트 manifest 를 OS 별 NativeMessagingHosts 에서
  지운다. Windows 에서는 같은 이름의 HKCU 레지스트리 키도 함께 지운다.

### 업그레이드 절차

1. 브리지를 올린다: `npm install -g auto-chrome-mcp-bridge`
2. 확장도 같은 1.10.0 으로 올린다. postinstall 이 받아 놓은
   `~/Downloads/auto-chrome-mcp-extension-v1.10.0/` 을 chrome://extensions 에서
   **Load unpacked** 로 다시 지정하고 새로고침한다.
3. 문제가 있으면 `auto-chrome-mcp-bridge doctor --fix` 를 돌린다.

## [v1.9.0] — 무간섭 모드 (2026-09-02)

사용자 불만 하나에서 출발했다: "MCP 가 새 크롬 탭을 띄우면 백그라운드에 머물지 않고 실제로
앞에 떠서, 내가 PC 를 쓰는 중에 방해가 된다." 원인은 하나가 아니었다 — 활성화·창 생성 경로가
파일마다 흩어져 각자 다른 조건을 쓰고 있었고, 그중 몇 개는 조건 자체가 없었다.

### Changed

- **작업 창 기본값이 다시 `dedicated` 다.** v1.4.0 에서 `current` 로 바뀐 뒤로 MCP 작업 탭이
  사용자가 쓰는 바로 그 창에 생겼다. v1.9.0 부터는 별도의 "MCP 작업 창" 에 모인다.
  ⚠️ **마이그레이션 — 확정된 저장 키 우선순위**: 신규 키 `mcpWorkWindowMode` > 구버전 키
  `dedicatedWorkWindow` > 기본값 `dedicated`. 즉 **두 키가 모두 없을 때만** 새 기본값이
  적용되고, 저장값은 언제나 새 기본값보다 우선한다. 예전에 토글을 껐던 사용자의 저장값은
  그대로 존중된다 — 팝업의 "무간섭 권장 설정으로 되돌리기" 버튼이 유일한 전환 통로다.
- **작업 창 배치 설정 신설** (`mcpWorkWindowPlacement`, 기본 `minimized`). 전용 작업 창을
  최소화 / 화면 밖 / 보이게 중에서 고른다. 팝업에서 바꿀 수 있다.
- **`chrome_navigate` 의 `width`/`height` 가 더 이상 새 창을 만들지 않는다(의미 변경).**
  이제 작업 탭의 **뷰포트**를 그 크기로 맞춘다(CDP `Emulation.setDeviceMetricsOverride`).
  창이 필요하면 `newWindow:true` 를 명시해야 한다.
- **`docs/TOOLS.md` 의 `background` 기본값 표기를 false → true 로 정정했다.** 실제 런타임은
  v1.6.0 부터 true 였다(백그라운드 작업 모드의 중앙 게이트가 주입). 문서를 믿고
  `background:false` 를 넣으면 활성화 분기가 열렸다.
- **`chrome_switch_tab` 설명**에 "사용자가 명시적으로 요청했을 때만 쓰고, 자동화 단계에서
  작업 대상을 옮기려면 `chrome_set_work_tab` 을 쓰라"를 넣었다. 스키마는 bridge 번들에
  들어가므로 **다음 bridge 발행 전까지는 모델에게 반영되지 않는다.**

### Fixed

- **활성화 경로가 파일마다 달랐다.** `utils/activation-guard.ts` 를 만들어
  `tabs.update({active:true})` · `tabs.create({active:true})` ·
  `windows.update({focused:true})` 를 한곳으로 모았다. 판정은 네 줄이다 — 예외 도구(force) /
  백그라운드 작업 모드 OFF / 대상이 전용 MCP 작업 창 / 그 외는 활성화하지 않는다.
  web-fetcher · console · inject-script · network-capture 2종 · gif-recorder ·
  플로우 재생(openTab/switchTab/rr-utils/nodes) · navigate 의 폴백 두 곳이 전부 이 통로를 쓴다.
  창 생성은 `utils/mcp-window-manager.ts` 의 `createManagedWindow` 하나로 모았다.
- **전용 작업 창이 만들어지면서 포커스를 훔쳤다.** `focused:false` 로 만들어도 창 안에 활성
  탭을 만드는 순간 그 창이 포커스를 가져간다(실측). 생성 직후 300ms·1200ms 에 비포커스를 다시
  걸고, 그래도 우리 창이 포커스를 쥐고 있으면 **사용자 창으로 되돌린다**. 그 사이 사용자가
  다른 창이나 다른 앱으로 옮겨갔으면(`windows.onFocusChanged`) 복귀를 취소한다.
- **`chrome_navigate` 의 최후 폴백이 `background` 인자를 아예 보지 않았다.** 폴백 두 곳 모두
  새 탭을 비활성으로 만들고, 창 생성은 관리자를 거치도록 고쳤다.
- **모드를 바꾼 뒤에도 사용자 창에 남은 옛 작업 탭을 계속 재사용했다.** `dedicated` 모드에서
  전용 창 밖의 작업 탭은 재사용하지 않고 전용 창에 새로 만든다.
- **플로우 재생의 `switchTab` 이 무조건 탭을 앞으로 가져왔다.** 백그라운드 작업 모드가 켜져
  있으면 작업 탭 포인터만 바꾼다. 단계에 `foreground:true` 를 명시한 경우만 예외다.

### 실측으로 확정한 것 (2026-09-02, Windows 11 + 실제 크롬)

- **오프스크린 배치는 크롬이 거부한다.** `windows.update({left:-32000,top:-32000})` 이
  `Invalid value for bounds. Bounds must be at least 50% within visible screen space.` 로 실패한다.
  좌표를 화면 안으로 되돌리는 게 아니라 호출 자체가 예외다. 그래서 `offscreen` 을 고르면
  자동으로 최소화로 대체한다.
- **`windows.create({state:'minimized'})` 의 state 는 무시된다.** 만들어 보면 `normal` 이다.
  배치는 창을 만든 뒤 `windows.update` 로 건다.
- **한 번도 그려진 적 없는 창을 최소화하면 그 창의 CDP `Page.captureScreenshot` 이 영영
  돌아오지 않는다.** `chrome_screenshot` 이 3회 연속 타임아웃했고, 창을 `normal` 로 되돌리는
  순간 밀려 있던 캡처가 완료됐다. 그래서 최소화 전에 **프레임을 1장 강제로 뽑고**(워밍업)
  성공했을 때만 최소화한다. 워밍업이 실패하면 창을 보이는 채로(비포커스) 남긴다 — 창이
  보이는 것보다 캡처가 죽는 쪽이 나쁘다.
- 워밍업 후 최소화한 창에서는 `chrome_screenshot` 뷰포트·전체 페이지·요소가 example.com 과
  news.ycombinator.com 에서 각각 3/3 정상이었다(18장 전부 실제 페이지, 단색 아님).
- **최소화된 창에서는 그 창의 활성 탭만 캡처된다.** 병렬 lane 처럼 탭이 여럿일 때를 위해
  캡처 직전에 전용 작업 창 안에서만 대상 탭을 활성화하도록 보강했다.

자세한 수치와 실기 회귀 결과는 `docs/plans/2026-09-02-no-interference-mode-design.md` 의
"실측 기록" 절과 `docs/REGRESSION_CASES.md` 에 있다.

### 독립 검토(Codex) 지적 반영 — 2026-09-02

병합 전 독립 검토에서 나온 5건을 같은 라운드에서 고쳤다.

- **기존 작업 창 재사용 경로에도 포커스 보호를 건다.** 창을 새로 만들 때만 예약하면 두 번째
  lane, `newTab:true`, 작업 탭이 닫힌 뒤의 재생성부터 보장이 깨졌다. 전용 창에 `active:true`
  탭을 만드는 자리에서 항상 `protectWorkWindowFocus()` 를 부른다.
- **포커스 감시를 창 생성 _전에_ 시작한다.** `beginFocusWatch()` 로 리스너를 먼저 걸고 창이
  만들어진 뒤 `arm()` 한다. 그 사이에 온 이벤트도 판정에 넣는다. 복귀 직전에는
  `windows.getLastFocused()` 로 "지금 포커스가 우리 창에 있다"를 **재검증**하고, await 를
  건널 때마다 취소 여부를 다시 본다.
- **복귀 대상은 "지금 실제로 포커스를 쥔 사용자 창" 만.** 마지막 포커스 창을 그대로 쓰면
  사용자가 이미 크롬 밖(메모장 등)에 있을 때 크롬을 앞으로 끌어내게 된다.
  `getFocusRestoreTargetWindowId()` 를 따로 두고 `focused === true` 인 창만 기록한다.
- **창 id 재사용 오인 방지.** 창 id 만 기억하면 크롬이 그 id 를 다른 창에 재사용했을 때
  사용자 창을 작업 창으로 오인한다. `chrome.storage.session` 에 `{id, createdAt, type, tabIds}`
  표지를 남기고, `isMcpWindow` 가 창 type 과 "우리가 만든 탭이 아직 그 창에 있는지"까지
  대조한다. 어긋나면 기록을 지워 다음 호출이 새 창을 만들게 한다.
- **전수 회귀 테스트를 조이고 인자를 위험 분기로 바꿨다.** 타임아웃을 실패로 처리하고,
  각 도구가 실제로 chrome API 를 건드렸는지(=실행 경로에 들어갔는지) 확인하며, "전용 작업 창"
  판정을 모의객체가 아니라 모듈의 실제 기록으로 한다. 비교 대상도 `TOOL_SCHEMAS` 가 아니라
  실제 레지스트리(`REGISTERED_TOOL_NAMES`)라 광고하지 않는 내부 도구까지 잡는다.
  fixture 는 navigate 를 뺀 전 도구에 **사용자 탭 id + `background:false`** 를 줘,
  도구들이 사용자 탭을 활성화하려 드는 상황을 만들어 놓고 가드가 막는지 본다.

### 알려진 한계 (2026-09-02 실측)

**최소화된 작업 창에 새 탭을 만들 때는 창을 잠깐 되돌린다.** 최소화된 창에 새로 만든 탭은
한 번도 그려지지 않아 그 탭의 CDP 캡처가 영영 돌아오지 않기 때문이다(스크린샷 도구가 멎는다).
되돌릴 때 `windows.update(id, {state:'normal', focused:false, drawAttention:false})` 로 포커스를
억제한다. 실측한 동작은 다음과 같다.

- 포커스 억제 조합 자체는 먹는다: 최소화된 창을 이 인자로 되돌리면 `state:'normal'` +
  `focused:false` 가 된다(에러 없음).
- 다만 **사용자의 최대화 창에 완전히 가려진 창은 렌더러가 프레임을 만들지 않는다.** 그래서
  포커스 없이 되돌리기만 하면 새 탭 워밍업이 실패하고, 그 탭의 캡처가 다시 멎었다(실측).
  그래서 워밍업이 실패하면 **딱 한 번** 창을 앞으로 꺼내(`focused:true`) 다시 워밍업한다.
  이때도 포커스 보호(지연 이중 비포커스 + 사용자 창 복귀)를 새로 걸어 둔다.
  캡처가 죽는 것보다 창이 잠깐 앞에 나오는 편이 낫다는 판단이다.
- 실기 관측 (사용자 창이 포커스를 쥔 상태에서 `newTab:true` 로 새 작업 탭 생성):

  | 항목                          | 전                    | 후                    |
  | ----------------------------- | --------------------- | --------------------- |
  | `windows.getLastFocused().id` | 384623014 (사용자 창) | 384623014 (사용자 창) |
  | 사용자 창 `focused`           | true                  | true                  |
  | 사용자 창 활성 탭             | 384623267             | 384623267             |
  | 작업 창                       | 384623375 minimized   | 384623375 minimized   |

  같은 조작을 포커스 억제만 넣고 워밍업 대체 경로가 없던 빌드에서 했을 때는
  `getLastFocused()` 는 사용자 창으로 유지됐지만 사용자 창의 `focused` 가 true → **false** 로
  떨어졌다(크롬 창 어느 쪽도 포커스를 갖지 않은 상태). 즉 되돌리는 순간의 포커스 이동은
  환경·타이밍에 따라 관측될 수 있다. 관측된 값을 그대로 남긴다.

- 거슬리면 팝업의 **작업 창 배치** 를 "보이게" 로 바꾸면 창을 되돌리는 동작 자체가 없어진다.

### Tests

확장 vitest 55파일/815건 → **57파일/847건**, 브리지 jest 7스위트/35건(변동 없음).
신규는 `tests/utils/no-interference-mode.test.ts`(21건: 배치·지연 비포커스·복귀 취소·
뷰포트 에뮬레이션·폴백·설정 기본값·가드 규칙)와
`tests/utils/no-interference-tool-sweep.test.ts`(2건: 등록된 비예외 도구 40개를 대표 인자로
한 번씩 돌려 전용 창 밖 활성화·강제 포커스가 0건인지 확인 + fixture 와 도구 레지스트리 일치).

### lint 게이트 (같은 릴리스에 병합)

v1.8.0 "남은 부채"에 적혀 있던 `app/chrome-extension` lint 에러 4건을 정리하고 CI 게이트로 추가했다.

- **`PropertyFormRenderer.vue` 의 prop 직접 변경 3건.** `node` prop 의 `config` 를
  `applyDefaults()` 와 `watch(model, ...)` 에서 직접 대입하고 있었다. 같은 디렉터리의
  `Property*.vue` 27개 파일이 전부 `node` prop 을 라이브 참조로 다루며
  `/* eslint-disable vue/no-mutating-props */` 를 스크립트 최상단에 두는 컨벤션을 따르고
  있어서(이미 각 파일에서 "Unused eslint-disable directive" 경고로 확인됨), 이 파일만
  그 disable 주석이 빠져 있었던 것으로 판단했다. emit 기반으로 새로 리팩터링하지 않고
  같은 컨벤션을 그대로 적용해 동작을 바꾸지 않았다. 호출부는 `PropertyFromSpec.vue`
  한 곳뿐이며 `:node="node"` 로 같은 참조를 그대로 넘기므로 계약에 변화가 없다.
- **`Diagnostic.vue` 의 `vue/multi-word-component-names`.** 이 규칙을 disable 하는
  선례가 저장소에 없어(전수 grep 결과 0건), 규칙을 끄는 대신 `DiagnosticReport.vue` 로
  파일명·컴포넌트 임포트·태그명을 함께 개명했다. 유일한 사용처인
  `entrypoints/popup/App.vue` 의 import 문과 `<Diagnostic .../>` 태그를 함께 갱신했다.
- **CI 게이트.** `.github/workflows/self-test.yml` 에 `Lint (extension)` 스텝
  (`pnpm --filter auto-chrome-mcp-extension lint`) 을 빌드 스텝들 뒤, vitest 스텝 앞에
  추가해 extension 패키지 lint 에러를 CI 실패로 게이트한다. `packages/shared` ·
  `app/native-server` 의 lint 는 이번 범위 밖이라 아직 게이트하지 않았다.
- **검증.** 수정 전 `pnpm --filter auto-chrome-mcp-extension lint` → 4 errors, 56
  warnings(둘 다 기존 그대로 유지, exit 1). 수정 후 → 0 errors, 56 warnings(exit 0).
  vitest 는 수정 전/후 모두 55 files / 815 tests 전부 통과(문서의 기존 베이스라인과 일치) —
  회귀 없음.

## [v1.8.0] — 조용히 새던 것들 (2026-08-25)

v1.7.0 배포 직후 코드를 다시 훑어 나온 결함들이다. 하나같이 "에러가 안 나서 몰랐던" 종류다 —
그림이 안 오고, 컨텍스트가 새고, 탭이 막히고, 정작 CI 는 한 번도 돈 적이 없었다.

### Fixed

- **`chrome_batch` 가 스텝의 이미지를 통째로 버렸다.** 결과를 모을 때 text content 만
  이어붙였다. 정작 스키마 설명은 `click → fill → click → screenshot` 체인을 권한다 —
  배치로 스크린샷을 찍으면 그림이 영영 안 돌아왔다. 이제 스텝이 만든 이미지를 요약 JSON
  뒤에 순서대로 붙인다(어느 스텝에서 나왔는지 `attachedImages` 로 표시). 20 스텝이 전부
  스크린샷일 때를 대비해 뒤에서부터 4장만 남기고, 버린 수를 `droppedImages` 로 알린다.
  실패 스텝의 이미지(게이트가 붙인 실패 스크린샷)도 함께 살린다.
- **멎은 탭이 그 탭을 영구히 막았다.** `chrome.tabs.sendMessage` 는 상대가 `sendResponse`
  를 영영 안 부르면 pending 인 채로 남는다(헬퍼가 비동기 예외로 죽거나 페이지가 멎었을 때).
  탭 단위 직렬화는 "앞선 호출은 반드시 끝난다" 를 전제하므로, 그 탭의 이후 호출이 전부 뒤에
  줄을 서서 영원히 대기했다. 두 겹으로 막았다 — content script 응답 상한 60초(원인과 복구
  방법이 적힌 에러), 그리고 도구 실행 워치독(기본 120초, 도구별 상향, 호출자가 선언한
  대기 시간이 더 길면 그에 맞춰 확장). 워치독은 락을 풀어 다음 호출이 막히지 않게 한다.
- **`chrome_get_web_content` 의 HTML 경로에 길이 상한이 없었다.** 텍스트 경로에는 상한
  100k · reader 추출 · diff 가 다 있었는데 HTML 만 `document.documentElement.outerHTML` 을
  그대로 실어 보냈다 — 무거운 페이지 한 번에 수 MB 가 모델 컨텍스트로 들어갔다. 기본 100k
  상한을 두고(`maxChars` 로 조정), 잘렸으면 `truncated` · `fullHtmlChars` · `returnedChars`
  로 알린다. 텍스트에만 있던 diff 도 HTML 에 붙여, 안 바뀐 페이지를 다시 읽으면
  `{unchanged:true}` 로 끝난다(텍스트/HTML 은 별도 키로 추적).
- **도구가 예외를 던지면 실패 진단이 통째로 빠졌다.** `catch` 가 맨 에러 문자열만 돌려줘,
  정작 가장 알고 싶은 실패에서 단서가 제일 적었다. 이제 사라진 탭 안내(`target_tab_missing`)
  와 실패 스크린샷이 에러 결과와 예외 **둘 다**에 붙는다. 그 진단 자체도 5초에서 끊는다 —
  멎은 렌더러에서는 `Page.captureScreenshot` 도 안 돌아오기 때문이다.
- **죽은 탭을 가리키면 조용히 사용자 탭이 대상이 됐다.** 도구 25개가
  `tryGetTab(args.tabId) || getActiveTab...` 패턴을 공유한다 — 명시한 탭이 이미 닫혔으면
  null 이 떨어지고 그대로 활성 탭으로 흘러간다. 실브라우저 검증 중 실제로 터졌다:
  작업 탭이 닫힌 뒤 같은 tabId 로 `chrome_screenshot` 을 불렀더니 에러 대신 **사용자가 보고
  있던 유튜브 탭이 찍혀** 돌아왔다. `chrome_navigate(refresh:true)` 였다면 사용자 페이지를
  새로고침했을 것이다 — 백그라운드 작업 모드의 무간섭 원칙이 정확히 여기서 깨졌다.
  25곳을 각자 고치는 대신 게이트에서 한 번 막는다(`utils/target-tab-guard.ts`): 명시된
  tabId 가 없으면 도구를 돌리기 전에 끊고 `target_tab_missing` 안내를 준다.
- **같은 탭에 CDP attach 가 동시에 들어오면 하나가 죽었다.** attach 는 `getTargets` 와
  `debugger.attach` 사이에 await 를 건넌다. 둘이 동시에 "아무도 안 붙어 있다" 를 보고 각자
  붙으러 가서, 하나가 `Another debugger is already attached` 로 실패하고 refCount 도
  덮어써져 샜다(병렬 레인 + 스크린샷/네트워크 캡처 조합에서 간헐 실패). 탭별로 직렬화했다.

### Changed

- **`self-test` CI 가 한 번도 돈 적이 없었다.** 트리거가 이전 브랜치와 `master` 인데
  이 fork 의 기본 브랜치는 `main` 이다 — `gh run list` 에 self-test 기록이 전무하다.
  브랜치를 고치고, 어떤 패키지와도 안 맞던 필터를 실제 패키지 이름(`auto-chrome-mcp-bridge`)
  으로 바로잡고, **CI 에 아예 없던 vitest 회귀 809건을 추가**했다.
  그동안 게이트를 통과한 건 jest 35건뿐이었다.
- **`build-release.yml` 은 전체가 주석이었다** (유효한 스텝 0줄). GitHub 이 이걸 유효하지
  않은 워크플로로 보고 **main 에 푸시할 때마다 실패로 기록**했다 — 최근 커밋의 빨간불이
  전부 이것이다. 파일을 지웠다.
- `chrome_get_web_content` 설명을 실제 동작에 맞게 다시 썼다(upstream 의
  `'Fetch content from a web page'` 그대로였다). reader 기본 · diff · 상한 보고를 알리고,
  좁은 추출은 `chrome_extract`, 클릭 대상 찾기는 `chrome_read_page` 로 유도한다.
- **로컬 `npx eslint .` 이 빌드만 하면 못 쓰게 됐다.** flat config 의 무접두 무시 패턴은
  설정 파일 위치 기준이라 `'dist/'`·`'.output/'` 이 워크스페이스 하위를 못 걸렀다. 한 번
  빌드하고 나면 산출물에서만 9,637건이 쏟아져 실제 신호가 완전히 묻혔다(벤더 번들
  `public/libs/ort.min.js` 와 `commitlint.config.cjs` 까지 더해 총 554건이 더 남아 있었다).
  `**/` 접두로 고치고 벤더·설정 파일을 뺐다 — 이제 빌드 후에도 루트 lint 가 깨끗하다.
- 매 도구 호출마다 작업 탭을 두 번 조회하던 것을 한 번으로 줄였다(게이트가 구한 값을
  재사용) — 호출당 `chrome.storage.session` 쓰기가 절반이 된다.

### Tests

- 회귀 32건 추가 (extension vitest 783 → **815**, native-server jest 35 유지).
  `tool-watchdog` 8 · `web-fetcher-html-cap` 6 · `target-tab-guard` 6 · `batch-images` 5 ·
  `tab-message-timeout` 4 · `cdp-attach-race` 3. 핵심 회귀는 **"영원히 안 끝나는 도구가
  탭 락을 영구 점유하지 못한다"**, **"batch 가 스텝의 스크린샷을 돌려준다"**,
  **"죽은 탭을 가리킨 호출이 사용자 탭으로 새지 않는다"** 다.
- 게이트(`handleCallTool`) · `tab-lock` · `batch` · CDP 세션 관리는 그동안 단위 테스트가
  **하나도 없었다**. 테스트 49개 중 대부분이 upstream 의 record-replay·web-editor 였다.

### 검증

- 자동 회귀: vitest 815/815, jest 35/35.
- 실브라우저(확장 리로드 후 실측):
  ① batch 가 스텝 스크린샷을 실제로 반환 (`images:1` + `attachedImages`) — 고치기 전엔 0장.
  ② `maxChars` 가 helper 까지 전달돼 `returnedChars:150` · `truncated:true` ·
  `fullHtmlChars:443` · 안내 문구까지 정확.
  ③ 죽은 tabId 로 `chrome_screenshot` 호출 → 사용자 탭이 찍히는 대신
  `Tab not found` + `target_tab_missing` 으로 끊김. **이 버그 자체가 이 검증에서 나왔다.**
  ④ 실패한 `chrome_read_page` 의 실패 스크린샷이 batch 결과까지 살아서 전달됨
  (실패 진단 + batch 이미지 두 수정이 함께 동작).
  ⑤ 정상 경로 무손상: 레인 작업 탭 재사용(`reusedWorkTab:true`), `chrome_read_page` 정상.
- 재현 못 한 것: 무한 대기 자체는 실브라우저에서 유도하지 못했다. 메인 스레드를 90초
  점유해 봤지만 크롬이 pending 대신 즉시 에러를 냈다. 워치독·응답 상한이 노리는 건
  "헬퍼가 메시지를 받고 sendResponse 를 영영 안 부르는" 경우이고, 그건 단위 테스트로만
  덮여 있다.

> ⚠️ `chrome_get_web_content` 에 `maxChars` 가 새로 생기고 여러 도구 설명이 바뀌었다.
> 이 스키마를 쓰려면 **전역 bridge 갱신(`npm i -g auto-chrome-mcp-bridge`) + 확장 리로드 +
> Claude Code 세션 재시작**이 필요하다. 셋 다 하기 전에도 나머지 수정(batch 이미지 · 죽은 탭
> 가드 · 워치독 · HTML 기본 상한)은 **확장 리로드만으로** 그대로 동작한다 — 그 넷은 확장 쪽
> 코드이기 때문이다.

### 남은 부채

- `vue-tsc --noEmit` 이 **134건 실패**한다(전부 upstream `record-replay-v3`·
  `element-marker`·그 테스트 파일). `pnpm compile` 은 사실상 못 쓰는 상태이고 CI 게이트도
  없다. 이번엔 손대지 않았다 — 우리가 만진 파일에서는 0건.
- 확장 패키지 자체의 lint(`app/chrome-extension` 설정)에는 에러 4건이 남아 있다(upstream 빌더 UI `PropertyFormRenderer.vue` 의 prop 직접 변경
  3건 — 그 기능은 팝업에서 비활성 — 과 `Diagnostic.vue` 컴포넌트 이름 규칙). 첫날부터
  빨간 게이트를 만들지 않으려고 lint 는 CI 에 아직 안 넣었다.
- `chrome_read_page` 가 요소가 극히 적은 페이지(example.com 수준)에서
  `Accessibility tree is too sparse and fallback failed` 로 실패한다. 기존 동작이고 이번
  변경과 무관하지만(위키피디아 등 일반 페이지는 정상), 휴리스틱을 손볼 여지가 있다.
- 세 패키지의 `lint` 스크립트가 윈도우에서 안 돈다(작은따옴표 glob 을 셸이 안 펼친다).
  리눅스 CI 에서는 정상.

## [v1.7.0] — 병렬 에이전트가 서로를 죽이지 않는다 (2026-08-23)

사용자 보고에서 출발했다: "에이전트 4개를 띄웠더니 전원 `tab_not_found` 로 중단됐다.
`chrome_set_work_tab` 으로 보호해도 서로 덮어쓴다." 원인은 두 겹이었다.

1. 한 Claude Code 세션의 **서브에이전트는 stdio 프로세스를 공유**한다 — 확장 입장에선
   `_mcpSessionId` 가 전부 같아 넷이 한 세션으로 보인다. 세션당 작업 탭이 하나뿐이었으니
   서로의 작업 탭을 계속 덮어썼다.
2. v1.6.0 의 "새 작업 탭이 열리면 같은 세션의 유휴 탭을 닫는다" 정리가, `isTabBusy` 가
   **도구 실행 중일 때만** true 인 탓에 형제 탭을 유휴로 오인해 차례로 닫았다.

### Added

- **`lane` 인자 (병렬 작업 레인)**: 탭을 다루는 도구 33개에 선택적 `lane` 문자열이 붙었다.
  레인을 주면 같은 stdio 세션 안에서도 작업 탭 버킷이 갈라져, 에이전트마다 자기 작업 탭을
  갖는다. 다른 레인은 그 탭을 재지정할 수도, 정리로 닫을 수도 없다. `chrome_batch` /
  `chrome_shortcut` 은 step 마다 레인을 자동으로 물려준다. 단일 작업이면 안 써도 된다 —
  생략 시 동작은 이전과 같다.
- **`target_tab_missing` 안내**: 대상 탭이 사라져 실패하면 왜 사라졌는지(MCP 정리 / 사용자
  닫음)와 복구 방법을 결과에 싣는다. 같은 `tabId` 로 무한 재시도하다 죽는 흐름을 끊는다.

### Changed

- **탭 정리 기준을 다시 설계**: "실행 중이 아니면 닫는다" → 세 겹 판정.
  ① 절대 안 닫음(방금 만든 탭 / 실행 중 / 어느 레인이든 현재 작업 탭 / 사용자가 보는 탭)
  ② 90초 유예 안에 쓰인 탭은 남김 ③ 그러고도 남는 여분이 레인당 8개를 넘으면 오래된 순 정리.
  15분 넘게 안 쓰인 탭은 레인을 가리지 않고 회수해, 사라진 에이전트의 탭이 남지 않게 했다.
- **automation guard 버킷도 레인 단위**로 쪼갰다. 같은 일을 하는 병렬 에이전트들이 서로의
  반복 카운터를 밀어 "runaway loop" 로 오판되던 문제가 사라진다.
- 작업 탭 버킷 상한을 10 → 32 로 올렸다 (한 세션이 여러 레인을 쓰므로).

### 검증

세 겹으로 확인했다.

1. **자동 회귀** — extension vitest 783건 / native-server jest 35건 통과. 새 회귀 18건이
   `tests/utils/work-tab-parallel.test.ts` · `tool-schema-lane.test.ts` 와 automation-guard 에
   들어갔고, 핵심은 **레인이 다른 병렬 에이전트 4개의 작업 탭이 모두 살아남는다** 이다.
2. **실브라우저 병렬** — 에이전트 4개 동시 실행에서 MCP 탭 8개 전량 생존, `tab_not_found` 0건.
   `mcpWorkTabSessions` 가 `stdio-<pid>-xxxxxx::agent-1..4` 로 찍혀, "서브에이전트는 stdio
   세션을 공유한다" 는 전제를 실측으로 확인했다. 자세한 내용은 `docs/REGRESSION_CASES.md`.
3. **배포물 E2E** — 발행된 bridge 를 Claude Code 없이 직접 띄워 MCP 프로토콜로 검증(6/6):
   `tools/list` 가 lane 을 33개 도구에 광고하고 어디서도 required 가 아니며, lane 을 실은
   navigate 가 연 탭이 해당 레인의 작업 탭으로 기록되고, 그 탭만 정확히 닫혔다.

> ⚠️ 도구 스키마가 바뀌었으므로 `lane` 을 쓰려면 **Claude Code 세션을 재시작**해야 한다
> (확장 리로드 + 전역 bridge 갱신 후).

### 발행 과정에서 드러난 CI 결함 2건 (같은 릴리스에서 수정)

태그를 밀고 나서 두 번 실패했다. 둘 다 **레지스트리 거부 단계**라 npm 에 반쪽 발행물이 올라간
적은 없고, `v1.7.0` 번호도 태우지 않고 태그를 다시 만들어 재사용했다.

- **`npm publish` 인자가 GitHub 단축 표기로 해석됐다** (`EALLOWGIT`). 워크플로가 매번
  `npm@latest` 를 까는데 러너의 npm 이 12.0.2 였고, npm 12 부터 git 타입 fetch 가 기본 차단이라
  `dist-tarballs/foo.tgz` 가 `owner/repo` 로 읽혔다. 경로 앞에 `./` 를 붙여 고쳤다.
- **provenance 검증에서 거부됐다** (`E422`). trusted publishing 이 붙인 provenance 와 패키지
  자신의 `repository.url` 을 레지스트리가 대조하는데, `packages/shared/package.json` 에 그 필드가
  아예 없었다(bridge·루트에는 있었다). 필드를 채워 고쳤다.

⚠️ **리허설(`gh workflow run release.yml`)로는 위 둘을 잡을 수 없다** — 발행 스텝이
`if: github.event_name == 'push'` 라 수동 실행에서는 통째로 건너뛴다. 리허설 통과는 "빌드·테스트·
팩까지 성하다" 는 뜻이지 "발행이 된다" 는 보장이 아니다.

## [v1.6.0] — 백그라운드 탭에서도 제대로 도는 자동화 (2026-08-23)

사용자 증상 하나에서 출발했다: "백그라운드 탭에서 무한 스크롤이 20개쯤에서 멈추고 푸터가
뜬다 — 크롬인크롬은 되는데." 원인은 크롬이 **비활성 탭의 렌더링 프레임을 만들지 않는 것**
이었고, 파고드는 과정에서 로딩 대기·스냅샷 병합의 결함까지 함께 드러났다.

### Added

- **백그라운드 탭 렌더링 유지** (`chrome_scroll_collect` 의 `renderMode`): 비활성 탭은
  `requestAnimationFrame` 이 멈춰 무한 스크롤이 의존하는 `IntersectionObserver` 가 영영
  발화하지 않는다. CDP 로 주기적으로 프레임을 강제해(250ms 간격) 탭을 앞으로 끌어내지
  않고도 지연 로딩이 정상 동작한다. `auto`(기본, 탭이 안 보일 때만) / `force` / `off`.
  결과에 실제로 적용된 수단을 `renderAssist` 로 싣고, 살리지 못한 채 멈추면
  `stoppedReason` 을 `noGrowthWhileHidden` 으로 정정한다(바닥 도달로 오보고하지 않는다).
- **작업 탭 재사용·정리**: 이 세션이 만든 작업 탭이 **유휴일 때만** 재사용하고, 새 작업
  탭이 열리면 같은 세션의 유휴 탭을 닫는다. 탭이 무한히 쌓이지 않으면서 병렬 작업은
  서로의 페이지를 덮어쓰지 않는다. `chrome_navigate` 의 `newTab:true` 로 강제할 수 있고,
  사용자가 `chrome_set_work_tab` 으로 지정한 탭은 절대 끌려가지 않는다.
- **"Claude 작업 중" 표시**: 작업 탭 페이지에 보라색 테두리와 배지를 띄운다. shadow DOM 이라
  사이트 CSS·텍스트 수집과 섞이지 않고, `pointer-events:none` 이라 클릭을 막지 않는다.

### Fixed

- **렌더링 유지가 실제로는 동작하지 않았다**: `Page.startScreencast` 는 "생산된 프레임을
  받아 가는" 수동적 장치라, 프레임이 아예 안 나오는 숨은 탭에서는 첫 프레임이 영원히 오지
  않는다(실측: force 모드 15초에 페이지 rAF 0회). 프레임 생산을 강제하는
  `Page.captureScreenshot` 을 주기적으로 눌러 주는 방식으로 교체했다. 실측 결과 같은
  페이지에서 10개 → 100개 전량 수집.
- **`chrome_navigate` 의 `waitUntil` 이 무력했다**: 내비게이션이 커밋되기 전에는 이전
  문서가 살아 있고 `readyState` 가 `complete` 라, 대기가 1~7ms 만에 끝나고 결과의
  url·title 도 이전 페이지 것이 나갔다. 이동을 걸기 **전에** 시작 신호를 잡고, 문서
  식별자·탭 상태·목표 URL 커밋 여부로 판정한다. 탭이 닫히면 즉시 `tab_not_found`,
  주입할 수 없는 문서(about:blank·PDF)는 탭 상태로 판정해(`not_injectable`) 타임아웃까지
  헛돌지 않는다.
- **`waitUntil:'none'` 이 탭 점유를 풀지 않았다**: 재사용 탭이 영원히 busy 로 남아 이후
  호출이 새 탭만 계속 만들었다.
- **`chrome_scroll_collect` 텍스트가 패스마다 페이지 전체를 중복 누적했다**: 푸터나 로딩
  스피너 때문에 새 항목이 가운데로 들어오면 접두·접미 겹침이 둘 다 빗나갔다(실측: 최종
  16.8KB 페이지가 120KB). 줄 단위 정렬로 다시 짜서 같은 페이지가 16.9KB 로 수렴한다.

### Changed

- `docs/TOOLS.md` 를 실제 도구 41개에 맞춰 동기화했다(문서에는 21개만 있었고 그중 6개는
  이미 없어진 도구였다). 공통 파라미터를 한 절로 뽑고, Performance·Automation 섹션을 추가.

### Tests

- 이 영역들에는 단위 테스트가 없었다 — 그래서 깨진 채로 배포됐다. 56건을 추가했고,
  그중 24건은 무한 스크롤 페이지 모양 4종 × 시드 3개 × 페이지 크기 2종을 돌려 매 패스마다
  "손실 0 · 중복 0 · 크기 폭발 없음" 을 확인하는 퍼즈 테스트다. 확장 762건 + 브리지 25건 통과.

## [v1.5.0] - 상호작용 안정화 + 신규 도구 4종 (2026-08-20)

### Added - 안정화 (A1~A3)

- **클릭/입력 요소 대기 내장** (`waitForElementMs`, 기본 2000ms): `chrome_click_element` /
  `chrome_fill_or_select` 가 대상 요소가 아직 렌더되지 않았을 때 즉시 실패하지 않고
  짧게 폴링한다. 요소를 찾은 뒤에는 남은 시간 동안 "보이는 상태"가 되기를 기다린다
  (등장 애니메이션·오버레이가 걷히는 경우). SPA 에서 반복되던
  `클릭 실패 -> chrome_wait_for -> 재클릭` 3회 왕복이 1회로 줄어든다. `0` 이면 종전처럼 즉시 실패.
- **`chrome_navigate` 로딩 완료 대기** (`waitUntil`, 기본 `domcontentloaded`):
  이동 직후 `read_page` / `click` 이 빈 페이지를 보던 문제를 없앤다.
  `none` / `domcontentloaded` / `load` / `networkidle` 중 선택하며, 관측된 로드 상태는
  결과의 `load` 필드로 돌아온다 (타임아웃은 오류가 아니라 관측 결과로 보고). 대기 후의
  최종 URL/제목으로 결과를 갱신하므로 리다이렉트도 반영된다.
- **클릭 실패 원인 보고 (`obstruction`)**: 클릭이 "가려져서" 실패하면 무엇이 가리는지
  함께 돌려준다 - 가리는 요소(태그/id/class/텍스트/z-index/좌표), 모달로 볼 만한 조상
  (`<dialog open>` / `role=dialog` / `aria-modal` / 높은 z-index 의 레이어), 뷰포트 점유율,
  body 스크롤 잠금 여부, 그리고 다음 행동 힌트. 기존에는 `elementFromPoint` 로 가리는 요소를
  알아내고도 버려서 모델이 같은 클릭을 반복했다. 가시성 외의 실패도 구분해 보고한다
  (`hidden_by_css` / `transparent` / `zero_size` / `outside_viewport`).
  `ref` 로 클릭한 경우에는 요소에 직접 이벤트를 쏘므로 클릭 자체는 성공하지만, 가려진
  상태였다면 결과에 경고를 붙인다 (사이트가 무시했을 수 있음).

### Added - 신규 도구 (B1~B4)

- **`chrome_storage`**: 쿠키 / localStorage / sessionStorage 조회·설정·삭제. 로그인 세션
  저장·복원, 로그아웃 상태 테스트, 동의 쿠키 미리 심기, 프론트엔드 상태 디버깅에 쓴다.
  값은 기본적으로 마스킹해서 돌려주고(`includeValues:true` 로만 노출), `clear` 는 범위
  (url 또는 domain)를 반드시 요구해 브라우저 전체 쿠키가 날아가는 것을 막는다.
  manifest 에 `cookies` 권한 추가.
- **`chrome_save_pdf`**: 현재 페이지를 PDF 로 저장 (CDP `Page.printToPDF`).
  스크린샷과 달리 텍스트가 살아 있고 여러 페이지를 온전히 담아 공고문·계약서·리포트
  보관에 맞다. 용지/방향/배율/여백/페이지 범위 지정 가능. base64 는 반환하지 않고
  `Downloads/mcp-pdf/` 에 저장한 뒤 파일명만 돌려준다 (토큰 폭증 방지).
- **`chrome_emulate`**: 디바이스 뷰포트 에뮬레이션 (크기/픽셀 밀도/터치/User-Agent).
  프리셋 7종(iphone-se, iphone-15, pixel-8, galaxy-s23, ipad, desktop-1280, desktop-1080p)
  또는 직접 지정. 실제 창 크기를 바꾸지 않으므로 백그라운드 작업 탭에서도 동작한다.
  `set` 은 CDP 세션을 유지하고 `reset` 에서 해제한다 (탭이 닫히면 자동 정리).
- **`chrome_network_rules`**: declarativeNetRequest 세션 규칙으로 요청 차단.
  선언만 해두고 쓰이지 않던 권한을 실제 기능으로 만들었다. 프리셋(ads / trackers /
  images / media / fonts) 또는 커스텀 urlFilter 패턴. 탭 단위 적용 가능, 브라우저 재시작 시
  자동 소멸. 광고·추적을 막으면 페이지 로드가 빨라지고 `read_page` 가 읽는 잡동사니가 줄어
  토큰도 절약된다. 규칙 id 는 9000-9899 대역만 사용해 다른 세션 규칙과 섞이지 않는다.

### Changed

- `sendMessageToTab` 이 content script 의 오류 응답 전체를 `Error.response` 에 실어 보낸다.
  이전에는 메시지 문자열만 남기고 `elementInfo` / `obstruction` 같은 진단 정보를 버렸다.

## [v1.4.2] — 발행 수정 (2026-08-18)

### Fixed

- **v1.4.0 / v1.4.1 은 npm 에서 설치할 수 없다.** 모노레포 내부 의존성
  `auto-chrome-mcp-shared: "workspace:*"` 가 치환되지 않은 채 발행돼
  `npm install -g` 이 `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"` 로 실패한다.
  `npm publish` 로 올렸기 때문 — **workspace 프로토콜을 실제 버전으로 바꿔주는 것은 pnpm 뿐이다.**
  v1.4.2 는 `pnpm publish` 로 올렸고, 발행 전 `pnpm pack` 으로 tarball 안의
  dependencies 를 확인했다.
- 깨진 1.4.0 / 1.4.1 은 deprecate 처리했다.

### 릴리스 절차 (재발 방지)

1. 버전 올리기 (4개 package.json)
2. `pnpm --filter ... build` 로 전체 빌드
3. **`pnpm pack` 으로 tarball 의 `dependencies` 에 `workspace:` 가 남아있지 않은지 확인**
4. `pnpm publish` 로 발행 (`npm publish` 금지)

## [v1.4.1] — 이중 응답 수정 (2026-08-18)

### Fixed

- **`ERR_HTTP_HEADERS_SENT` 대량 발생**: MCP transport 가 `reply.raw` 에 직접 응답을 쓰는데
  Fastify 는 그것을 모른 채 핸들러 종료 후 자체 응답을 한 번 더 보내고 있었다. 결과적으로
  요청 한 건마다 stderr 에 스택이 쌓였다. `/mcp` POST·GET·DELETE, `/sse`, `/messages` 전부
  transport 에 `reply.raw` 를 넘기기 **전에** `reply.hijack()` 하도록 고쳤다.
- 기존 에러 처리의 `if (!reply.sent)` 가드는 raw 쓰기를 반영하지 않아 무력했다. hijack 이후
  상태를 볼 수 있는 `reply.raw.headersSent` / `writableEnded` 기준으로 바꾸고 공용 헬퍼
  `endRawWithError` 로 정리했다.
- GET `/mcp` 는 헤더를 flush 한 뒤에야 hijack 하고 있었다. 순서를 바로잡았다.

MCP 클라이언트를 둘 이상(Claude Code + Codex) 동시에 붙이면서 드러난 문제다. jest 25 통과.

## [v1.4.0] — 현재 창 작업 탭 (2026-08-18)

### Changed — MCP 작업 탭 기본 위치

- **작업 탭이 별도 창이 아니라 사용자가 열어 둔 현재 창에 열린다.** 설정이
  `dedicatedWorkWindow`(boolean) → `mcpWorkWindowMode`(`current` | `dedicated`) 로 바뀌고
  기본값은 `current`. 구버전 boolean 설정은 자동 승계된다.
- `current` 모드의 탭은 항상 비활성(`active: false`)으로 생성 — 사용자가 보던 탭을
  뺏지 않는다. 스크린샷·read_page 는 CDP 경로라 보이지 않는 탭에서도 동작한다.
- 대상 창은 열린 창 중 type `normal` 만 후보로 삼는다 (팝업·개발자도구·앱 창, 시크릿 창,
  이전에 만든 전용 작업 창 제외). 적격 창이 없으면 종전처럼 새 창을 만든다.
- 전용 작업 창은 팝업 토글로 계속 쓸 수 있다 (기본 OFF).

### Fixed

- **사용자 탭 하이재킹**: 같은 URL 재사용 후보에서 사용자 탭을 빼는 필터가 전용 작업 창이
  켜져 있을 때만 걸려 있었다. 토글을 끄면 MCP 가 사용자가 열어 둔 탭을 잡아 조작했다.
  이제 백그라운드 작업 모드면 창 모드와 무관하게 항상 적용된다.
- **doctor 가 남의 npm 패키지 설치를 안내하던 문제**: 복구 명령의 패키지명이
  이전 패키지 이름이었다. 그 이름은 npm 에서 타 계정 소유다.
  실제 패키지명 `auto-chrome-mcp-bridge` 로 정정했다.
- **postinstall 안내의 잘못된 경로**: 이전 패키지 이름의 경로로
  안내했으나 실제 설치 폴더는 `auto-chrome-mcp-bridge` 다. 아울러 프로젝트별 `.mcp.json`
  대신 `claude mcp add -s user` 전역 등록을 안내하도록 바꿨다 (프로젝트마다 넣으면
  경로가 어긋나 깨지기 쉽다).
- doctor 의 bridge 프로세스 탐지가 구 폴더명만 찾던 것을 두 이름 모두 인정하도록 수정.

### Chore

- 주석·문서의 이전 브랜딩 표기를 `auto-chrome-mcp` 로 정리 (95개 파일). 네이티브 호스트
  id, npm 패키지명·bin 별칭, 워크스페이스 package.json name, doctor 스킬명, 런타임 데이터
  폴더는 기존 설치 호환을 위해 그대로 뒀다.

## [v1.3.0] — Auto Chrome MCP (2026-08-17)

### Added — Claude-in-Chrome 격차 해소 (사용자 선택 1–3)

- **`chrome_find`**: natural-language element search (Korean/English) over the accessibility tree — synonym + fuzzy scoring, iframe search included; returns ranked refs/coordinates/frameId usable directly with click/fill/computer.
- **Multi-browser switching** (stdio-local tools, never forwarded to the extension): `chrome_list_browsers` probes candidate bridge ports (active + `CHROME_PORTS` env + defaults) via GET /ping; `chrome_use_browser` switches the session's active browser profile mid-session with clean session termination on the old bridge.
- **`chrome_shortcut`**: named saved macros (chrome_batch step format) — save/run/list/delete, stored in extension storage, executed through the normal tool gate (session work tabs, guards, locks all apply).

## [v1.2.0] — Auto Chrome MCP (2026-08-17)

### Added — 팝업 인지 · 신뢰성 (F1–F7)

- **Popup/new-tab awareness**: tool calls that spawn new tabs/popup windows (OAuth logins, target=\_blank) now report `new_tabs_opened` in the result; new `chrome_set_work_tab` retargets the session work tab without focusing anything; `get_windows_and_tabs` marks work tabs, the MCP window, and recently spawned tabs.
- **`chrome_wait_for`**: wait for selector/text/document-ready/network-idle before acting (timeout returns observed state, not an error).
- **Frame-aware interaction**: click/fill auto-search iframes when the selector isn't in the top frame (probe protocol, first-found wins, frameId reported); `read_page`/interactive-elements gain `allFrames`.
- **Failure screenshots**: failed tool calls attach a downscaled JPEG of the target tab (`errorScreenshotOnFailure` to disable).
- **Login-redirect detection**: `login_required_suspected` warning when the target tab lands on a login page mid-call.
- **Download awareness**: downloads started during a call are reported (`downloads_started`).
- **Popup focus return**: popup windows opened by MCP work tabs are blurred so the user's window regains OS focus.
- **`chrome_scroll_collect`**: one-call infinite-scroll content collection (virtualized-list overlap handling included).

### Added — 토큰 절감 (T1–T7, 품질 무손실)

- **Screenshots as MCP image blocks**: `storeBase64` no longer returns base64 inside text (was 100k+ text tokens per shot); images are auto-downscaled to ≤1568px long edge with exact `imageScale` metadata (also fixes a long-standing coordinate-mapping drift on downscaled screenshots); `fullResolution` opt-out. computer zoom had the same leak — fixed.
- **Diff mode** (`diff`, default on): `read_page`/`get_web_content` return `{unchanged:true}` instead of re-sending identical content (ref map stays fresh).
- **`chrome_extract`**: CSS-selector field extraction — return only the values you need instead of full-page reads.
- **Reader mode** (`raw:false` default): `get_web_content` strips nav/footer/cookie/ad boilerplate and no longer dumps full body text when Readability fails.
- **Lossless a11y-tree compaction** (`compact`, default on): 35–50% smaller `read_page` output (wrapper collapse, dedup, notation shortening; refs/roles/states preserved).
- **Pagination**: console/network-capture/history gain `limit`/`offset`/`countOnly`.
- Failure screenshots are downscaled ~40% further.

## [v1.1.0] — auto-chrome-mcp fork (2026-08-17)

### Added — 백그라운드 작업 모드 (non-interference)

- **Background work mode** (`backgroundWorkMode`, default ON, popup toggle "백그라운드 작업"): MCP tools no longer activate tabs or steal focus; all tools default `background: true` via a central gate in `tools/index.ts`.
- **Per-session work tabs** (max 10, LRU): each Claude Code session's stdio proxy injects `_mcpSessionId` into every call; `chrome_navigate` records the session's work tab, and tabId-less tool calls target it instead of the user's active tab. Work tabs show an "MCP" action badge.
- **Dedicated MCP work window** (`dedicatedWorkWindow`, default ON, popup toggle "전용 작업 창"): MCP tabs are created in a separate unfocused window; URL-reuse never grabs tabs from user windows in background mode.
- **`chrome_batch` tool**: run up to 20 tool steps in one MCP round-trip (stop-on-error or continueOnError).
- **Screenshot auto-save**: `saveToDownloads`/`filename` params save captures under `Downloads/mcp-screenshots/`.
- **Automation guard** (`automationGuardEnabled`, default ON): per-domain soft throttle (30 actions/10s, delay ≤5s) and runaway-loop breaker (identical call ×12 in 120s → blocked).
- **Per-tab serialization**: concurrent tool calls targeting the same tab are queued, so two sessions can't interleave input on one tab.
- **`tabId` param added** to dialog / network_request / network_capture / performance×3 / userscript / bookmark_add schemas.

### Fixed

- Screenshots are now CDP-first: background tabs capture correctly (incl. fullPage via `captureBeyondViewport`); the captureVisibleTab fallback errors instead of silently returning the wrong tab.
- `chrome_computer` sub-delegations (screenshot/click/fill/keyboard, 10 call sites) now forward the resolved `tabId`.
- Removed needless `tabs.update({active:true})` in console / inject-script / network-capture / web-fetcher; two raw `windows.update({focused:true})` calls now respect the force-focus policy; record-replay window focus routed through the same policy.
- GIF recording of tabs in non-focused windows activates the tab within its own window (animations keep running) and restores the previous tab afterwards.
- `chrome_console` deep-serializes lossy objects (depth 4, 5000 chars, budgeted CDP calls) instead of returning truncated previews (upstream #215).
- CDP attach conflicts retry once (300ms) and report an actionable error; stale debugger sessions are cleaned on force-detach.
- `chrome_close_tabs` with no args closes the session work tab, never the user's active tab, in background mode.

## [v0.0.5]

### Improved

- **Image Compression**: Compress base64 images when using screenshot tool
- **Interactive Elements Detection Optimization**: Enhanced interactive elements detection tool with expanded search scope, now supports finding interactive div elements

## [v0.0.4]

### Added

- **STDIO Connection Support**: Added support for connecting to the MCP server via standard input/output (stdio) method
- **Console Output Capture Tool**: New `chrome_console` tool for capturing browser console output

## [v0.0.3]

### Added

- **Inject script tool**: For injecting content scripts into web page
- **Send command to inject script tool**: For sending commands to the injected script

## [v0.0.2]

### Added

- **Conditional Semantic Engine Initialization**: Smart cache-based initialization that only loads models when cached versions are available
- **Enhanced Model Cache Management**: Comprehensive cache management system with automatic cleanup and size limits
- **Windows Platform Compatibility**: Full support for Windows Chrome Native Messaging with registry-based manifest detection
- **Cache Statistics and Manual Management**: User interface for viewing cache stats and manual cache cleanup
- **Concurrent Initialization Protection**: Prevents duplicate initialization attempts across components

### Improved

- **Startup Performance**: Dramatically reduced startup time when no model cache exists (from ~3s to ~0.5s)
- **Memory Usage**: Optimized memory consumption through on-demand model loading
- **Cache Expiration Logic**: Intelligent cache expiration (14 days) with automatic cleanup
- **Error Handling**: Enhanced error handling for model initialization failures
- **Component Coordination**: Simplified initialization flow between semantic engine and content indexer

### Fixed

- **Windows Native Host Issues**: Resolved Node.js environment conflicts with multiple NVM installations
- **Race Condition Prevention**: Eliminated concurrent initialization attempts that could cause conflicts
- **Cache Size Management**: Automatic cleanup when cache exceeds 500MB limit
- **Model Download Optimization**: Prevents unnecessary model downloads during plugin startup

### Technical Improvements

- **ModelCacheManager**: Added `isModelCached()` and `hasAnyValidCache()` methods for cache detection
- **SemanticSimilarityEngine**: Added cache checking functions and conditional initialization logic
- **Background Script**: Implemented smart initialization based on cache availability
- **VectorSearchTool**: Simplified to passive initialization model
- **ContentIndexer**: Enhanced with semantic engine readiness checks

### Documentation

- Added comprehensive conditional initialization documentation
- Updated cache management system documentation
- Created troubleshooting guides for Windows platform issues

## [v0.0.1]

### Added

- **Core Browser Tools**: Complete set of browser automation tools for web interaction
  - **Click Tool**: Intelligent element clicking with coordinate and selector support
  - **Fill Tool**: Form filling with text input and selection capabilities
  - **Screenshot Tool**: Full page and element-specific screenshot capture
  - **Navigation Tools**: URL navigation and page interaction utilities
  - **Keyboard Tool**: Keyboard input simulation and hotkey support

- **Vector Search Engine**: Advanced semantic search capabilities
  - **Content Indexing**: Automatic indexing of browser tab content
  - **Semantic Similarity**: AI-powered text similarity matching
  - **Vector Database**: Efficient storage and retrieval of embeddings
  - **Multi-language Support**: Comprehensive multilingual text processing

- **Native Host Integration**: Seamless communication with external applications
  - **Chrome Native Messaging**: Bidirectional communication channel
  - **Cross-platform Support**: Windows, macOS, and Linux compatibility
  - **Message Protocol**: Structured messaging system for tool execution

- **AI Model Integration**: State-of-the-art language models for semantic processing
  - **Transformer Models**: Support for multiple pre-trained models
  - **ONNX Runtime**: Optimized model inference with WebAssembly
  - **Model Management**: Dynamic model loading and switching
  - **Performance Optimization**: SIMD acceleration and memory pooling

- **User Interface**: Intuitive popup interface for extension management
  - **Model Selection**: Easy switching between different AI models
  - **Status Monitoring**: Real-time initialization and download progress
  - **Settings Management**: User preferences and configuration options
  - **Cache Management**: Visual cache statistics and cleanup controls

### Technical Foundation

- **Extension Architecture**: Robust Chrome extension with background scripts and content injection
- **Worker-based Processing**: Offscreen document for heavy computational tasks
- **Memory Management**: LRU caching and efficient resource utilization
- **Error Handling**: Comprehensive error reporting and recovery mechanisms
- **TypeScript Implementation**: Full type safety and modern JavaScript features

### Initial Features

- Multi-tab content analysis and search
- Real-time semantic similarity computation
- Automated web page interaction
- Cross-platform native messaging
- Extensible tool framework for future enhancements
