# 확장 컨텍스트 메뉴 재설계 (2026-09-06, 사후 기록)

사용자 신고: 툴바 확장 아이콘을 우클릭하면 중국어 메뉴가 나온다. 조사·재설계·구현은 2026-09-06 07:40~15:00 에 끝났고(PR #4 커밋 0e6e074), 이 문서는 결정 사항을 남기기 위한 사후 기록이다.

## 조사 결과

- 메뉴 3개가 소스에 중국어 리터럴로 박혀 있었다: `element-marker/index.ts` "标注元素", `web-editor/index.ts` "切换网页编辑模式", `record-replay/index.ts` 동적 메뉴 기본값 "运行工作流".
- 셋 다 `contexts: ['all']` 로 등록돼 있었다. `all` 은 `action`(툴바 아이콘 우클릭)을 포함하므로 페이지용 메뉴가 아이콘 메뉴에도 떴다.
- `chrome.contextMenus.removeAll()` 호출이 없었다. 3단계에서 삭제된 V3 트리거 엔진이 만든 `rr_v3_*` 메뉴가 사용자 크롬에 남아 있을 수 있었다.
- `type:'contextMenu'` 트리거를 만드는 UI·도구가 없어 동적 메뉴는 도달 불가능한 죽은 경로였다.

## 결정

- **단일 소유:** `entrypoints/background/context-menus.ts`(등록·클릭 처리)와 `context-menus-spec.ts`(순수 명세·문구·녹화 문구 갱신)만 메뉴를 만든다. 다른 모듈은 클릭 처리 함수만 export 한다(`injectMarkerHelper`, `toggleEditorInTab`, `toggleQuickPanelInActiveTab`, `forceReconnectRespawn`). 파일을 둘로 나눈 이유: record-replay 가 녹화 문구 갱신을 위해 한 파일을 import 하면 native-host → tools 전체가 딸려와 테스트가 깨졌다.
- **기동 시 `removeAll()` 후 재생성.** onInstalled 와 서비스 워커 기동 둘 다. 옛 엔진 잔여 메뉴가 이걸로 사라진다.
- **아이콘 메뉴(contexts `action`)와 페이지 메뉴(page·frame·selection·link·image·video·audio·editable)를 분리.** 페이지 메뉴는 부모 "Auto Chrome MCP" 하나만 노출해 사용자 페이지 메뉴를 어지럽히지 않는다.
- 문구는 `chrome.i18n.getMessage('menu_*')`(ko·en). 키가 없으면 ko 문구 폴백.
- record-replay 의 contextMenu 트리거 경로(`refreshContextMenus`, `rr_menu_*`, `TriggerType 'contextMenu'`)는 삭제. 배경 코드의 한자 리터럴은 전부 제거(1006자 → 0).
- 강제 재연결을 배경에서 부르려면 배경이 자기 자신에게 `sendMessage` 해도 리스너에 닿지 않으므로 `utils/force-reconnect.ts` 에 `transport` 옵션을 두어 직접 함수 호출로 우회했다.

## 메뉴 표

**아이콘 우클릭**

| 순서 | id                    | ko                              | 동작                                                                                                                                                                   |
| ---- | --------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `acm_open_sidepanel`  | 사이드패널 열기                 | `sidePanel.open({windowId})` 동기 호출 → `setOptions(?tab=workflows)`, 실패 시 탭 폴백                                                                                 |
| 2    | `acm_daily`           | 매일 작업                       | 같은 방식, `?tab=daily`                                                                                                                                                |
| 3    | `acm_record`          | 이 탭에서 녹화 시작 / 녹화 중지 | `?tab=workflows&record=start\|stop&tabId=<클릭한 탭>`. 문구는 녹화 시작·중지 처리 직후 `syncRecordingMenuTitles()` 로 갱신, 클릭 순간 상태를 다시 읽어 start/stop 결정 |
| 4    | `acm_markers`         | 요소 마킹                       | `?tab=element-markers`                                                                                                                                                 |
|      | 구분선                |                                 |                                                                                                                                                                        |
| 5    | `acm_web_editor`      | 웹 에디터 켜기/끄기             | `toggleEditorInTab(tabId)`                                                                                                                                             |
| 6    | `acm_quick_panel`     | 빠른 패널                       | 단축키와 같은 함수                                                                                                                                                     |
|      | 구분선                |                                 |                                                                                                                                                                        |
| 7    | `acm_userscripts`     | 유저스크립트 관리               | `chrome.runtime.openOptionsPage()`                                                                                                                                     |
| 8    | `acm_force_reconnect` | 강제 재연결                     | `forceReconnect()` + `chrome.notifications` 한 줄                                                                                                                      |

**페이지 우클릭:** `acm_page_root` "Auto Chrome MCP" 아래 `acm_page_mark_element` 이 요소 마킹, `acm_page_web_editor` 웹 에디터 켜기/끄기, `acm_page_record` 이 탭에서 녹화 시작/중지.

## 검증

- `tests/background/context-menus.test.ts` 19건: 아이콘 메뉴 id·contexts·순서, 페이지 메뉴 부모, 녹화 중 문구, 클릭 디스패치, removeAll 이 create 보다 먼저, 배경 한자 0, 모르는 id 무시.
- 실기기: 사용자가 아이콘 우클릭·페이지 우클릭 메뉴를 눈으로 확인("문제없이 잘 보여", 2026-09-06).

## 남은 것

- `packages/shared/src/node-specs-builtin.ts` 의 흐름 편집기 trigger 노드 스펙에 contextMenu 옵션 2개가 남아 있다(켜도 아무 일도 안 하는 죽은 옵션). 다른 패키지라 다음 스키마 변경 릴리스에서 지운다.
