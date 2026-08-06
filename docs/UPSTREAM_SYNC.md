# Upstream Sync Policy

> 매주 자동 검사 + 월 1회 정기 sync.

## 자동 검사

`.github/workflows/upstream-check.yml` 가 매주 화요일 00:00 UTC 에 실행:

1. `git fetch upstream master`
2. baseline commit hash (UPSTREAM_DIFF.md 의 `Baseline commit:`) 과 비교
3. 우리 cherry-pick 한 7 PR (#346, #338, #312, #302, #304, #329, #313) 중 upstream 에 머지된 게 있는지 commit message grep
4. retire 후보 발견 → GitHub issue 자동 생성 (label: `upstream-sync` + `automated`)

## 월 1회 사람 작업

1. retire issue 확인 (또는 manual `gh workflow run upstream-check.yml`)
2. upstream master 의 새 commits cherry-pick:
   ```bash
   git fetch upstream master
   git rebase upstream/master  # 또는 merge
   # 충돌 시 우리 변경 우선 (theirs 가 아니라 ours)
   ```
3. 우리 cherry-pick 중 upstream 머지된 건 retire:
   - `git rebase -i` 로 해당 commit drop
   - `UPSTREAM_DIFF.md` 갱신 (status: 머지된 PR = ❎ retired)
4. 회귀 8 케이스 통과 확인:
   ```bash
   pnpm install --ignore-scripts
   pnpm build
   (cd app/native-server && npx jest)
   ```
5. 새 baseline SHA 박제:
   ```bash
   # UPSTREAM_DIFF.md 의 'Baseline commit' 라인 갱신
   # 'Last sync' 라인 = 오늘 날짜
   # 동기화 로그 테이블에 새 row 추가
   ```
6. tag v2.0.0 push (또는 minor/patch — 자세히는 § 버전 정책)

## 버전 정책

semver `MAJOR.MINOR.PATCH`:

- **MAJOR** = upstream 추적 indicator. upstream 의 의미 있는 변경 흡수 시 bump.
- **MINOR** = fork 의 신규 feature (예: Playwright fallback 의 새 도구 미러 묶음)
- **PATCH** = bug fix

예:

- `1.0.0` = 첫 출시 (upstream `f48e717` 기준)
- `1.1.0` = stub 30개 중 12개 1to1 매핑 구현 (fork minor feature)
- `2.0.0` = upstream master 새 베이스로 rebase + 새 PR 흡수

## Retire 의 의미

upstream 에 우리 cherry-pick 이 머지되면:

- 우리 commit 제거 (없으면 conflict 가능성 ↑)
- `UPSTREAM_DIFF.md` 의 status 컬럼 ❎ retired
- README 의 "흡수한 PR" 목록 갱신 (또는 별도 sealing 인 "Historical fixes" 섹션)

## 충돌 처리 원칙

- **우리 fork 의 design intent 우선** — Playwright fallback, Force Reconnect, Diagnostic UI 는 절대 retire 안 됨
- **upstream 의 의도된 변경 채택** — 새 도구 추가, 보안 fix, 의존성 업그레이드 등
- **모호 시 ADR** — 충돌 큰 경우 `docs/adr/YYYY-MM-DD-{topic}.md` 박제 후 사용자 confirm

## 응급 패치

upstream 이 보안 fix 머지 시 (e.g. XSS, CSRF):

1. `git cherry-pick <upstream-fix-commit>` (즉시)
2. patch version bump (1.0.1)
3. 평소 sync 일정과 무관 즉시 release

upstream-check.yml 의 label `security-urgent` 자동 부착 (commit msg 의 `security:` / `fix(security):` grep).

## 현재 동기화 상태

→ [`../UPSTREAM_DIFF.md`](../UPSTREAM_DIFF.md)
