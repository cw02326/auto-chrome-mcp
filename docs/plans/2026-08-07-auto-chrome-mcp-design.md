# auto-chrome-mcp Chrome MCP — 설계 문서

> 작성일: 2026-08-07 · 상태: 구현 착수
> 한 줄 요약: `mcp-chrome-vibemaker`의 **업데이트 버전**. 이름·확장·명령어를 전부 새 브랜딩으로 바꾸고, **자동 재연결(무인 self-heal)** 을 얹는다. 안정성은 최소한 vibemaker와 동급이어야 한다.

## 1. 목표 & 제약

- **목표:** vibemaker 포크를 "auto-chrome-mcp Chrome MCP"로 리브랜딩한 **나만의 배포판**. npm 공개 배포 + `cw02326` GitHub 레포.
- **핵심 제약:** 리브랜딩하면서 **작동 안정성이 vibemaker보다 나빠지면 안 된다.** 기능은 동결 복제 후 이름만 교체하는 순서로 회귀(regression)를 원천 차단.
- **소유/배포:** npm(`auto-chrome-mcp-bridge`) 공개 + GitHub `cw02326/auto-chrome-mcp`.
- **로컬 이관:** 완성 후 사용자 맥에서 vibemaker 제거 → auto-chrome-mcp 설치.

## 2. 베이스

- `bambwc20/mcp-chrome-vibemaker`(= `hangwin/mcp-chrome`의 reliability 포크)를 클론 → 리브랜딩.
- 모노레포(pnpm workspace): `app/chrome-extension`(Vue 확장) + `app/native-server`(node 브리지, npm 본체) + `packages/{shared,chrome-launcher,wasm-simd}`.

## 3. 리브랜딩 매핑

| 항목             | 옛것                                                       | 새것                                                        |
| ---------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| monorepo         | `mcp-chrome-vibemaker-monorepo`                            | `auto-chrome-mcp-monorepo`                                  |
| 브리지(npm 본체) | `mcp-chrome-vibemaker-bridge`                              | `auto-chrome-mcp-bridge`                                    |
| 확장             | `chrome-mcp-vibemaker`                                     | `auto-chrome-mcp-extension`                                 |
| shared           | `chrome-mcp-vibemaker-shared`                              | `auto-chrome-mcp-shared`                                    |
| launcher         | `mcp-chrome-vibemaker-launcher`                            | `auto-chrome-mcp-launcher`                                  |
| CLI bin          | `mcp-chrome-vibemaker-bridge`/`-stdio`/`vibemaker-install` | `auto-chrome-mcp-bridge`/`-stdio`/`auto-chrome-mcp-install` |
| 네이티브 호스트  | `com.chromemcpvibemaker.nativehost`                        | `com.autochromemcp.nativehost`                              |
| 기본 포트        | `12316`                                                    | `12320`                                                     |
| 확장 ID          | `epadcnnkkmnhalmhlemjlompmggbfjfa`                         | **새 RSA 키로 재생성(고정)**                                |
| 텍스트 브랜드    | Vibemaker/VibeMaker                                        | auto-chrome-mcp                                             |

- **완전 분리 원칙:** 포트·확장ID·호스트명을 전부 다르게 → 제거 이관 중 vibemaker와 안 엉킴.
- **잔재 0건:** `vibemaker`, `12316`, `chromemcpvibemaker`, 옛 확장ID를 grep 0건까지 훑음.
- **attribution 유지:** LICENSE(MIT)와 upstream(hangwin)·vibemaker 출처 표기 보존.

## 4. 신규 기능 — 자동 재연결(무인 self-heal)

vibemaker의 **수동** Force Reconnect는 폴백으로 유지하고, 그 위에 **무인 복구** 루프를 얹는다.

- **heartbeat:** 확장 background가 브리지(12320)에 주기적 핑. 기본 5초.
- **끊김 감지:** 연속 3회 실패 시 "끊김" 판정.
- **자동 복구:** 지수 백오프(2→4→8…초, 상한 30초)로 재연결 재시도. 성공 시 원복.
- **상태 뱃지:** 팝업 🟢연결 / 🟡복구중 / 🔴실패 실시간 표시.
- **폴백:** 최대 재시도 초과 시에만 수동 Force Reconnect 안내.
- **설정값 상수화:** 핑 주기·실패 임계치·최대 백오프·최대 재시도(하드코딩 지양).
- **격리 원칙:** 기존 연결 로직을 건드리지 않고 위에 얹어 다운그레이드 위험 0.

## 5. 작업 절차

1. **동결 복제** — 소스 클론, 기능 무변경 (vibemaker 100% 동일 동작 보장 지점).
2. **리브랜딩 치환** — 표(§3) 기계적 치환 + 잔재 grep 0건 검증.
3. **새 확장 키/ID** — 새 RSA 키쌍 생성 → manifest.key 고정 → 새 ID를 5개 참조처에 반영.
4. **자동 재연결 추가** — §4를 격리 구현.
5. **빌드·검증** — 모노레포 빌드, `doctor` 초록불, 실제 크롬 탭/클릭/스크린샷, 자동재연결 테스트.
6. **배포** — GitHub 레포 생성·푸시 → `npm publish`(사용자 login) → 로컬 이관.

## 6. 검증 기준 ("vibemaker 동급")

- `doctor` 9개 항목 전부 OK.
- 실제 크롬 연결 후 기본 도구(탭 열기·클릭·스크린샷·콘솔) 정상.
- 브리지 강제 종료 → 자동 재연결이 사람 개입 없이 복구.
- 옛 브랜드 잔재 grep 0건.
