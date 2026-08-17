# Auto Chrome MCP 자동 설치 스크립트 (Windows)
# 사용법: PowerShell에 아래 한 줄을 붙여넣고 Enter
#   irm https://raw.githubusercontent.com/cw02326/auto-chrome-mcp/main/install.ps1 | iex
param(
  [switch]$SkipNpm,      # 테스트용: 브리지 설치 건너뛰기
  [switch]$SkipRegister, # 테스트용: 클로드 등록 건너뛰기
  [switch]$SkipDownload  # 테스트용: 확장 다운로드 건너뛰기
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=====================================" -ForegroundColor Magenta
Write-Host "  Auto Chrome MCP 자동 설치" -ForegroundColor Magenta
Write-Host "=====================================" -ForegroundColor Magenta

# ---------- 1. Node.js 확인 ----------
Step 1 "Node.js 확인 중..."
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $ver = (node -v) -replace 'v',''
  if ([int]($ver.Split('.')[0]) -ge 20) {
    Ok "Node.js $ver 설치되어 있음"
  } else {
    Warn "Node.js 버전이 낮습니다($ver). 20 이상으로 업데이트합니다..."
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Warn "Node.js 업데이트 완료. PowerShell 창을 닫고 새로 연 뒤 이 명령을 다시 실행해 주세요."
    return
  }
} else {
  Warn "Node.js가 없습니다. 자동으로 설치합니다 (1~2분)..."
  winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Warn "Node.js 설치 완료. PowerShell 창을 닫고 새로 연 뒤 이 명령을 다시 실행해 주세요."
  return
}

# ---------- 2. 브리지 설치 ----------
if (-not $SkipNpm) {
  Step 2 "연결 프로그램(브리지) 설치 중... (1~2분)"
  npm install -g auto-chrome-mcp-bridge | Out-Null
  Ok "브리지 설치 완료"
  Step 3 "연결 상태 자동 점검·수리 중..."
  try { auto-chrome-mcp-bridge doctor --fix | Out-Host } catch { Warn "점검 중 경고가 있었지만 계속 진행합니다." }
} else { Step 2 "브리지 설치 건너뜀 (테스트 모드)" }

# ---------- 3. 클로드 코드에 등록 ----------
if (-not $SkipRegister) {
  Step 4 "클로드 코드에 등록 중..."
  $npmRoot = (npm root -g).Trim()
  $stdioPath = Join-Path $npmRoot "auto-chrome-mcp-bridge\dist\mcp\mcp-server-stdio.js"
  if (-not (Test-Path $stdioPath)) { throw "브리지 파일을 찾을 수 없습니다: $stdioPath" }

  $claude = Get-Command claude -ErrorAction SilentlyContinue
  $registered = $false
  if ($claude) {
    try {
      claude mcp remove --scope user chrome-mcp-stdio 2>$null | Out-Null
    } catch {}
    try {
      claude mcp add --scope user --transport stdio chrome-mcp-stdio -e CHROME_PORT=12320 -- node "$stdioPath" | Out-Null
      Ok "클로드 코드 전역 등록 완료 (어느 폴더에서 실행해도 사용 가능)"
      $registered = $true
    } catch { Warn "claude mcp 등록 실패 — 설정 파일 방식으로 대신 등록합니다." }
  }
  if (-not $registered) {
    # fallback: 홈 폴더 .mcp.json 에 병합 (홈 폴더에서 클로드 실행 시 적용)
    $mcpFile = Join-Path $HOME ".mcp.json"
    $cfg = if (Test-Path $mcpFile) { Get-Content $mcpFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    if (-not $cfg.PSObject.Properties['mcpServers']) {
      $cfg | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{})
    }
    $server = [pscustomobject]@{
      type = "stdio"; command = "node"
      args = @($stdioPath)
      env  = [pscustomobject]@{ CHROME_PORT = "12320" }
    }
    if ($cfg.mcpServers.PSObject.Properties['chrome-mcp-stdio']) {
      $cfg.mcpServers.'chrome-mcp-stdio' = $server
    } else {
      $cfg.mcpServers | Add-Member -MemberType NoteProperty -Name 'chrome-mcp-stdio' -Value $server
    }
    $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $mcpFile -Encoding UTF8
    Ok "설정 파일 등록 완료: $mcpFile"
  }
} else { Step 4 "클로드 등록 건너뜀 (테스트 모드)" }

# ---------- 4. 크롬 확장 다운로드 ----------
if (-not $SkipDownload) {
  Step 5 "크롬 확장 프로그램 다운로드 중..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/cw02326/auto-chrome-mcp/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -like "*chrome.zip" } | Select-Object -First 1
  if (-not $asset) { throw "확장 zip을 찾을 수 없습니다." }
  $extDir = Join-Path $HOME "Documents\AutoChromeMCP-확장프로그램"
  $zipTmp = Join-Path $env:TEMP "auto-chrome-mcp-ext.zip"
  Invoke-WebRequest $asset.browser_download_url -OutFile $zipTmp
  if (Test-Path $extDir) { Remove-Item $extDir -Recurse -Force }
  Expand-Archive -Path $zipTmp -DestinationPath $extDir -Force
  Remove-Item $zipTmp -Force
  Ok "확장 프로그램 준비 완료: $extDir"

  # 크롬 확장 페이지와 폴더를 열어준다
  Start-Process explorer.exe $extDir
  try { Start-Process "chrome" "chrome://extensions" } catch { Warn "크롬을 직접 열어 주소창에 chrome://extensions 를 입력하세요." }
} else { Step 5 "확장 다운로드 건너뜀 (테스트 모드)" }

# ---------- 안내 ----------
Write-Host ""
Write-Host "=====================================" -ForegroundColor Magenta
Write-Host "  거의 다 됐어요! 남은 일은 2가지" -ForegroundColor Magenta
Write-Host "=====================================" -ForegroundColor Magenta
Write-Host @"

 1. 방금 열린 크롬 '확장 프로그램' 화면에서:
    - 오른쪽 위 '개발자 모드' 스위치 켜기
    - '압축해제된 확장 프로그램을 로드합니다' 클릭
    - 방금 열린 폴더(문서 > AutoChromeMCP-확장프로그램) 선택

 2. 클로드 코드를 껐다가 다시 켜기

 확인: 클로드 코드에 /mcp 를 입력했을 때 chrome-mcp-stdio 가 보이면 성공!

"@
