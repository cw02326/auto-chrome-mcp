# 사이드패널 토스증권 스타일 + 가독성 고도화 (2026-09-06)

사용자 요청: 사이드패널 UI/UX 를 https://www.tossinvest.com/ 과 같게, 그리고 가독성을 높일 것. 브랜치 `feat/sidepanel-toss-style`.

## 측정 근거 (2026-09-06 실측, 1280px 뷰포트, 라이트 고정)

토스증권은 `color-scheme: light only` 로 라이트만 렌더링한다. 스크린샷: `C:/PROJECTS/_작업물/2026-09/sidepanel-toss/ref-toss-*.png`.

| 역할                                | 실측값                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 앱 바탕(html)                       | `rgb(246,247,249)`                                                                                                                                          |
| 카드/표면                           | `#ffffff`, 리스트 행 `rgb(251,252,253)`                                                                                                                     |
| 옅은 표면(칩·보조 버튼·검색 트리거) | `rgba(7,25,76,0.04)`, `rgba(2,32,71,0.05)`                                                                                                                  |
| 구분선                              | 헤어라인 `rgba(0,27,55,0.10)` inset box-shadow 0.75px (border 거의 안 씀, 배경 대비로 구분)                                                                 |
| 본문 글자                           | `rgba(26,31,41,0.89)`                                                                                                                                       |
| 보조 글자                           | `rgb(78,89,104)`, 비활성 탭 `rgba(18,31,51,0.47)`, 희미 `rgba(19,30,54,0.30)`, 캡션 `rgb(139,149,161)`                                                      |
| 아이콘                              | `rgba(24,31,43,0.77)`, 회색 `rgb(143,149,158)`                                                                                                              |
| 강조(브랜드)                        | `#3182f6`(rgb 49,130,246), 링크·호버 `rgb(34,114,235)`, 옅은 파랑 `rgb(235,244,255)`                                                                        |
| 상승/위험 빨강                      | 글자 `rgb(222,43,57)`, 배경 `rgb(239,51,65)`, 옅은 빨강 `rgb(255,239,239)`                                                                                  |
| 하락 파랑                           | 글자 `rgb(27,100,218)`                                                                                                                                      |
| 글꼴                                | `Toss Product Sans` → 번들 불가. 대체 **Pretendard Variable**(OFL) + `-apple-system, "Noto Sans KR", "Segoe UI", "Apple SD Gothic Neo", Roboto, sans-serif` |
| 타이포                              | 메뉴 13/600/20, 캡션 12/500/16, 숫자 12~13/600, 상단 메뉴 14/600/20, 본문 15/500/21.75, 굵기 토큰 regular 400·medium 500·semibold 600·bold 700              |
| 간격                                | 8px 기준(4/6/8/12/16), gap 4·8                                                                                                                              |
| radius                              | 8px(최다), 999px(필), 7px(칩·아이콘 버튼), 4px, 큰 카드 16~20px                                                                                             |
| 헤더                                | 투명 배경, 메뉴 링크 padding 8px 12px radius 9px 14/600, 활성 = 글자색만 진하게(`rgba(26,31,41,0.89)`), 비활성 `rgba(22,31,46,0.61)`                        |
| 탭                                  | 활성 글자 `rgba(26,31,41,0.89)` + 밑줄 2px `rgba(0,12,30,0.8)` radius 10px, 비활성 `rgba(18,31,51,0.47)`, 높이 36px, 상단 헤어라인                          |
| 주 버튼                             | bg `#3182f6`, 흰 글자 14/600, radius 8px, padding 6px 12px, 높이 32px                                                                                       |
| 보조 버튼/칩                        | bg `rgba(7,25,76,0.04)`, 글자 본문색, radius 7px, padding 4px 8px, 13/600, inset 0.5px 헤어라인                                                             |
| 텍스트 버튼                         | 같은 옅은 배경 + 파랑 글자                                                                                                                                  |
| 아이콘 버튼                         | 투명, 28~32px, radius 7px                                                                                                                                   |
| 리스트 행                           | 높이 44px, 좌우 padding 12px, 셀 8px, 배경 `rgb(251,252,253)`, hover `#f2f4f6`, 등락은 글자색만                                                             |
| 입력(스타일시트 규칙)               | 포커스 시 inset 파랑 링 + bg `rgb(235,244,255)`                                                                                                             |
| 토글(스타일시트 규칙)               | radius 16px, ON 파랑, OFF 회색, disabled opacity 0.4                                                                                                        |
| 스크롤바                            | 6px, thumb `rgba(0,27,55,0.2)` radius 10px                                                                                                                  |
| 카드                                | 테두리·그림자 없음. 바탕색 위 흰 카드로만 구분                                                                                                              |

## 현재 사이드패널 구조 (조사 결과)

- 토큰은 `entrypoints/sidepanel/styles/agent-chat.css` 의 `.agent-theme` 기본값 + `[data-agent-theme=...]` 6종. `useAgentTheme.ts` 가 `chrome.storage.local.agentTheme` 를 읽어 루트에 `data-agent-theme` 를 단다. 다크/라이트 자동 판별 없음.
- 화면 파일 11개의 scoped `<style>` 에 hex/rgb 직접 지정이 약 120곳. `ImportFlowDialog`·`RunVariablesDialog`·`DailyScheduleForm` 은 색을 `<script setup>` 의 computed 인라인 스타일로 넣는다.
- 웹폰트 번들 없음. 공용 UI 컴포넌트 없음(파일마다 로컬 클래스). 내비게이션은 `SidepanelNavigator.vue` 의 떠 있는 햄버거 버튼 + 오버레이 메뉴. 아이콘은 인라인 SVG `currentColor`.
- `tailwind.css` 의 `.btn/.card/.input` 등은 삭제된 빌더용 `--rr-*` 를 참조하는 죽은 규칙.

## 디자인 결정 (이 표가 구현 스펙)

### 테마

- 새 테마 `toss-light` 를 `agent-chat.css` 에 추가하고 **기본값**으로 삼는다. 저장된 테마가 없거나 옛 기본값(`warm-editorial`)이면 `toss-light` 로 읽는다(마이그레이션 1줄). 기존 6종은 남기되 선택 UI 가 없으면 그대로 둔다.
- `.agent-theme` 기본값 자체도 `toss-light` 값으로 바꾼다(폴백이 토스 값이 되도록).

### 토큰 (`--ac-*` 이름은 기존 것을 유지하고 값만 교체. 없는 것은 추가)

| 토큰                  | 값                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ac-bg`             | `#f6f7f9`                                                                                                                                     |
| `--ac-surface`        | `#ffffff`                                                                                                                                     |
| `--ac-surface-row`    | `#fbfcfd`                                                                                                                                     |
| `--ac-surface-muted`  | `rgba(7,25,76,0.04)`                                                                                                                          |
| `--ac-surface-hover`  | `#f2f4f6`                                                                                                                                     |
| `--ac-divider`        | `rgba(0,27,55,0.10)`                                                                                                                          |
| `--ac-text`           | `rgba(26,31,41,0.89)`                                                                                                                         |
| `--ac-text-secondary` | `rgb(78,89,104)`                                                                                                                              |
| `--ac-text-tertiary`  | `rgba(18,31,51,0.47)`                                                                                                                         |
| `--ac-text-disabled`  | `rgba(19,30,54,0.30)`                                                                                                                         |
| `--ac-icon`           | `rgba(24,31,43,0.77)`                                                                                                                         |
| `--ac-accent`         | `#3182f6`                                                                                                                                     |
| `--ac-accent-hover`   | `#2272eb`                                                                                                                                     |
| `--ac-accent-soft`    | `#ebf4ff`                                                                                                                                     |
| `--ac-accent-text`    | `#2272eb`                                                                                                                                     |
| `--ac-danger`         | `#ef3341`                                                                                                                                     |
| `--ac-danger-text`    | `#de2b39`                                                                                                                                     |
| `--ac-danger-soft`    | `#ffefef`                                                                                                                                     |
| `--ac-warning`        | `#f57a00`                                                                                                                                     |
| `--ac-warning-soft`   | `#fff4e5`                                                                                                                                     |
| `--ac-success`        | `#2272eb` (성공은 파랑 계열로 통일. 토스 상승색인 빨강을 성공에 쓰면 실패색과 헷갈린다)                                                       |
| `--ac-success-soft`   | `#ebf4ff`                                                                                                                                     |
| `--ac-toast-bg`       | `rgba(0,12,30,0.88)`                                                                                                                          |
| `--ac-radius-card`    | `16px`                                                                                                                                        |
| `--ac-radius`         | `8px`                                                                                                                                         |
| `--ac-radius-chip`    | `7px`                                                                                                                                         |
| `--ac-radius-pill`    | `999px`                                                                                                                                       |
| `--ac-font-sans`      | `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Noto Sans KR", "Segoe UI", "Apple SD Gothic Neo", Roboto, sans-serif` |
| `--ac-font-mono`      | `"JetBrains Mono", Consolas, "Courier New", monospace`                                                                                        |
| 그림자                | 카드 그림자 없음. 대화상자만 `0 8px 24px rgba(0,27,55,0.12)`                                                                                  |
| 스크롤바              | 6px, thumb `rgba(0,27,55,0.2)`, radius 10px                                                                                                   |

### 글꼴

- `public/fonts/PretendardVariable.woff2` 를 번들한다(https://github.com/orioncactus/pretendard 릴리스의 `web/variable/woff2/PretendardVariable.woff2`, OFL 1.1. LICENSE 파일도 `public/fonts/` 에 동봉). `@font-face { font-family: "Pretendard Variable"; src: url(...) format("woff2-variations"); font-weight: 45 920; font-display: swap; }` 를 사이드패널 CSS 에 넣는다. 숫자는 `font-variant-numeric: tabular-nums`.
- 다운로드는 curl 로 받고 크기·sha256 을 결과에 적는다. 받지 못하면 Pretendard 없이 시스템 스택만 쓰고 미해결로 남긴다.

### 타이포 스케일 (가독성 기준. 토스 원본보다 한 단계 키운 곳은 이유 표기)

| 용도                            | 크기/굵기/행간                                          |
| ------------------------------- | ------------------------------------------------------- |
| 화면 제목(매일 작업, 흐름 저장) | 18/700/26                                               |
| 섹션 제목·카드 제목(흐름 이름)  | 15/600/22                                               |
| 본문·목록 주 텍스트·입력값      | 14/500/20 (토스 메뉴 13 → 14. 좁은 패널에서 13 은 작다) |
| 보조 텍스트(설명, 마지막 성공)  | 13/500/18                                               |
| 캡션·배지·시각                  | 12/500/16 (**12 미만 금지**)                            |
| 숫자(단계 수, 시각, 개수)       | 같은 크기, 600, tabular-nums                            |
| 버튼                            | 14/600                                                  |
| 탭                              | 14/600                                                  |

### 구성 요소

- **내비게이션**: 떠 있는 햄버거 대신 **상단 고정 탭 바**로 바꾼다. 흐름 / 매일 작업 / 요소 마킹 세 탭. 토스 탭 스타일(활성 글자 진하게 + 2px 밑줄 radius 10, 비활성 `--ac-text-tertiary`, 높이 40px, 아래 헤어라인). 탭 바는 sticky top, 배경 `--ac-bg`. 드래그 이동·더블클릭 초기화 기능은 제거.
- **녹화 표시줄**: 탭 바 아래 흰 카드(radius 16, padding 12 16). 녹화 시작 = 주 버튼(빨간 점 아이콘 + "녹화 시작"), 녹화 중 = 빨간 점(맥박) + 경과 + 단계 수 + 보조 버튼 "녹화 중지".
- **카드(흐름)**: 흰 배경, 테두리·그림자 없음, radius 16, padding 16, 카드 사이 gap 8, 바탕 `--ac-bg`. 제목 15/600, 아래 보조 13. 배지는 필(`--ac-radius-pill`) 12/600, 발행됨 = accent-soft/accent-text, 재발행 필요 = warning-soft/warning, 예약 = accent-soft, 최근 실패 = danger-soft/danger-text. 실행·예약·편집·더보기는 아이콘 버튼(28px, radius 7, hover `--ac-surface-muted`), 실행은 주 버튼 아이콘형.
- **필터 칩**: 보조 버튼 스타일(`--ac-surface-muted`, radius 7, 13/600). 선택된 칩 = accent-soft 배경 + accent-text 글자.
- **매일 작업 줄**: 카드 안 행 높이 최소 52px(토스 44 + 가독성), 이름 15/600, 예약 요약·다음 실행 13 보조, 마지막 결과는 글자색만(성공 파랑, 실패 빨강, 로그인 필요 주황). 스위치는 토스 토글(44×24, radius 16, ON accent, OFF `rgba(0,27,55,0.2)`, 흰 손잡이). 펼침 이력은 행 목록(각 행 44px, 상태 색 글자, 시각·소요 tabular).
- **대화상자(저장 마법사·예약 폼·가져오기·변수 입력)**: 흰 카드 radius 16, 그림자 위 표, 배경 딤 `rgba(0,12,30,0.4)`, 폭 `min(480px, 100% - 24px)`, padding 20, 제목 18/700, 섹션 라벨 13/600 `--ac-text-secondary`, 입력 높이 40, 바닥 버튼 오른쪽 정렬(취소 = 보조, 확인 = 주). 인라인 JS 색 객체는 전부 토큰으로.
- **입력·select·time**: 배경 `rgba(2,32,71,0.05)`, 테두리 없음, radius 8, 높이 40, 글자 14, placeholder `--ac-text-disabled`, 포커스 `box-shadow: inset 0 0 0 1.5px var(--ac-accent)` + 배경 `--ac-accent-soft`. 오류 = inset 링 danger + 아래 12px 빨간 문구.
- **토스트**: 하단 중앙, `--ac-toast-bg`, 흰 글자 14/500, radius 12, padding 12 16.
- **빈 상태**: 아이콘 없이 15/600 제목 + 13 보조 + 주 버튼.
- **아이콘**: 인라인 SVG 유지, 색은 `--ac-icon`, 크기 16(행 안) / 20(버튼).
- **세로 액센트 띠 금지**(border-left 등). 카드 왼쪽 색 막대 절대 사용 안 함.

### 가독성 규칙 (전부 적용)

1. 글자 최소 12px, 보조 텍스트 최소 13px, 본문 14px. 행간 1.4 이상.
2. 본문 글자 대비 = `rgba(26,31,41,0.89)` on white(≥ 12:1). 보조는 `rgb(78,89,104)`(≥ 5:1). 희미한 색은 비활성·placeholder 에만.
3. 누를 수 있는 것은 높이 32px 이상, 주 버튼 36px, 입력 40px.
4. 긴 이름·URL 은 한 줄 말줄임(`text-overflow: ellipsis`) + `title` 속성. 단계 목록의 셀렉터는 mono 12 회색.
5. 숫자·시각은 `tabular-nums` 600.
6. 카드 사이·섹션 사이 여백 8/16/24 로 위계.
7. 상태는 색 + 글자(아이콘 없이 색만으로 구분하지 않는다).
8. 스크롤 컨테이너 안쪽 여백 16, 마지막 요소 아래 24.

## 작업 범위와 금지

- 범위: `entrypoints/sidepanel/**`(모든 .vue 의 스타일·인라인 색 객체, `styles/agent-chat.css`, `composables/useAgentTheme.ts`, `main.ts`, `index.html`), `public/fonts/`, `wxt.config.ts`(web_accessible_resources 가 필요하면), `tailwind.css` 의 죽은 `--rr-*` 규칙 삭제.
- 금지: 팝업·옵션·content script·백그라운드 로직 변경, 문구(i18n 키) 변경, 기능 동작 변경. 대시류 문자(U+2014, U+2013, U+3161, U+2015, U+2012, U+FF0D, U+2212) 신규 사용 금지.

## 합격 기준

1. `entrypoints/sidepanel/**/*.vue` 의 `<style>` 과 `<script>` 에 hex/rgb 색 직접 지정 **0건**(파이썬으로 `#[0-9a-f]{3,8}`, `rgba?\(` 검사. 예외: SVG `fill="none"` 류 아닌 색은 전부 토큰).
2. 빌드 0, vitest 통과, `document.fonts.check('14px "Pretendard Variable"')` 가 true(배포본 리로드 후 실측).
3. 배포본 리로드 후 스크린샷: 흐름 탭(카드 2개 이상), 매일 작업 탭(예약 1개 + 펼침), 저장 마법사, 예약 폼, 가져오기 대화상자, 변수 입력 폼, 빈 상태. 저장 위치 `C:/PROJECTS/_작업물/2026-09/sidepanel-toss/after-*.png`. 이 스크린샷은 메인이 찍는다(구현자는 빌드까지).
4. 세로 액센트 띠 0건, 12px 미만 font-size 0건(파이썬 검사), 대시류 0건.
5. 탭 전환·녹화·마법사·예약·가져오기가 스타일 변경 전과 같은 동작(기능 회귀 없음. 기존 테스트 통과로 확인).
