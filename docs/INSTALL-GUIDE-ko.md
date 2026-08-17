<style>
  body, h1, h2, h3, h4, p, li, td, th, blockquote {
    font-family: "Malgun Gothic", "맑은 고딕", "Noto Sans KR", Helvetica, Arial, sans-serif !important;
    word-break: keep-all;
    overflow-wrap: break-word;
  }
  body { font-size: 10.5pt; line-height: 1.55; }
  code, pre { font-family: Consolas, "Malgun Gothic", monospace !important; }
  pre { padding: 8px 12px; margin: 8px 0 14px 0; line-height: 1.4; }
  h1 { font-size: 21pt; margin: 0 0 4px 0; letter-spacing: -0.5px; }
  h2 { font-size: 14pt; margin: 22px 0 8px 0; padding-bottom: 5px;
       border-bottom: 2px solid #222; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 14px 0 6px 0; break-after: avoid; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0 10px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  li > ul, li > ol { margin: 2px 0; }
  blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid #999;
               background: #f6f6f6; font-size: 9.5pt; }
  blockquote p { margin: 2px 0; }
  hr { display: none; }
  .subtitle { color: #444; margin: 0 0 18px 0; font-size: 10.5pt; }
  .prep { background: #f2f4f8; border: 1px solid #d9dee8; border-radius: 6px;
          padding: 10px 14px; margin: 0 0 6px 0; }
  .prep p { margin: 0 0 4px 0; font-weight: bold; }
  .prep ul { margin: 0; }
</style>

# Auto Chrome MCP 설치 가이드

<p class="subtitle">클로드 코드(Claude Code)가 크롬 브라우저를 직접 조작하게 해주는 도구입니다. 설치는 약 5분 걸립니다.</p>

<div class="prep">
<p>준비물</p>

- 크롬 브라우저
- Node.js 20 이상 — [nodejs.org](https://nodejs.org/ko)에서 LTS 버전 설치
- 클로드 코드 (Claude Code)

</div>

## 1단계 — 크롬 확장 설치

1. [최신 릴리스 페이지](https://github.com/cw02326/auto-chrome-mcp/releases/latest)를 열고 `...chrome.zip` 파일을 다운로드합니다.
2. 압축을 해제합니다. **이 폴더는 지우면 안 됩니다** — 문서 폴더 등 안전한 곳에 보관하세요.
3. 크롬 주소창에 `chrome://extensions` 를 입력해 확장 관리 페이지를 엽니다.
4. 우측 상단의 **개발자 모드**를 켭니다.
5. **"압축해제된 확장 프로그램을 로드합니다"** 버튼을 눌러 압축 푼 폴더를 선택합니다.
6. 목록에 **Auto Chrome MCP**가 나타나면 성공입니다.

## 2단계 — 브리지 설치

터미널(Windows는 PowerShell)을 열고 아래 두 명령을 순서대로 실행합니다.

```
npm install -g auto-chrome-mcp-bridge
auto-chrome-mcp-bridge doctor --fix
```

두 번째 명령의 결과가 전부 **[OK]** 로 나오면 성공입니다.

## 3단계 — 클로드 코드 연결

1. 터미널에서 `npm root -g` 를 실행해 나오는 경로를 복사해 둡니다.
2. 홈 폴더(또는 클로드 코드를 쓰는 프로젝트 폴더)에 `.mcp.json` 파일을 만들고 아래 내용을 저장합니다. `<npm경로>` 부분은 방금 복사한 경로로 바꿉니다.

```json
{
  "mcpServers": {
    "chrome-mcp-stdio": {
      "type": "stdio",
      "command": "node",
      "args": ["<npm경로>/auto-chrome-mcp-bridge/dist/mcp/mcp-server-stdio.js"],
      "env": { "CHROME_PORT": "12320" }
    }
  }
}
```

> **Windows 예시:** `"C:\\Users\\이름\\AppData\\Roaming\\npm\\node_modules\\auto-chrome-mcp-bridge\\dist\\mcp\\mcp-server-stdio.js"` — JSON 안에서는 역슬래시를 두 번(`\\`) 써야 합니다.

## 4단계 — 마무리 확인

1. 크롬 툴바에서 **Auto Chrome MCP 아이콘**을 클릭해 팝업을 열고, 연결 포트가 `12320` 인지 확인 후 연결합니다.
2. 클로드 코드를 재시작하고 `/mcp` 를 입력합니다.
3. 목록에 `chrome-mcp-stdio` 가 보이면 설치 완료입니다. 클로드에게 "크롬으로 네이버 열어봐"라고 시켜보세요.

## 문제가 생기면

- 터미널에서 `auto-chrome-mcp-bridge doctor` 를 실행하고 **[X]** 표시된 항목을 확인하세요. 대부분 `doctor --fix` 로 자동 해결됩니다.
- 해결되지 않으면 [GitHub 이슈 페이지](https://github.com/cw02326/auto-chrome-mcp/issues)에 `auto-chrome-mcp-bridge report --copy` 결과를 붙여 문의하세요.

## 주요 기능 (기본 켜짐)

- **무간섭 모드** — 클로드가 작업해도 내가 보고 있는 탭과 창을 건드리지 않습니다 (전용 "MCP 작업 창"에서 작업).
- **팝업·새 창 자동 인지** — 로그인 팝업 등이 열려도 작업이 끊기지 않습니다.
- **자연어 요소 찾기** — "로그인 버튼 찾아줘" 같은 지시가 가능합니다.
- **안전장치** — 같은 사이트에 과도한 요청이 몰리면 자동 감속하고, 반복 폭주를 차단합니다.

프로젝트 홈: [github.com/cw02326/auto-chrome-mcp](https://github.com/cw02326/auto-chrome-mcp)
