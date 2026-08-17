<style>
  body, h1, h2, h3, h4, p, li, td, th, blockquote, div {
    font-family: "Malgun Gothic", "맑은 고딕", "Noto Sans KR", Helvetica, Arial, sans-serif !important;
    word-break: keep-all;
    overflow-wrap: break-word;
  }
  body { font-size: 11pt; line-height: 1.65; }
  code, pre { font-family: Consolas, "Malgun Gothic", monospace !important; }
  pre { padding: 12px 14px; margin: 8px 0 12px 0; line-height: 1.45; font-size: 10.5pt;
        background: #1e293b !important; color: #e2e8f0 !important;
        border: 1px solid #0f172a; border-radius: 8px; }
  pre code { background: none !important; color: #e2e8f0 !important; }
  h1 { font-size: 20pt; margin: 0 0 4px 0; letter-spacing: -0.5px; }
  h2 { font-size: 14.5pt; margin: 24px 0 8px 0; padding: 6px 12px;
       background: #eef2f9; border-left: 5px solid #3b5bdb; border-radius: 3px;
       break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 14px 0 6px 0; break-after: avoid; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0 10px 0; padding-left: 24px; }
  li { margin: 5px 0; }
  blockquote { margin: 10px 0; padding: 8px 14px; border-left: 4px solid #f0b429;
               background: #fdf7e8; font-size: 10pt; border-radius: 3px; }
  blockquote p { margin: 2px 0; }
  hr { display: none; }
  .subtitle { color: #444; margin: 0 0 14px 0; }
  .bigcmd { background: #1e293b; color: #e2e8f0; padding: 12px 14px; border-radius: 8px;
            font-family: Consolas, monospace; font-size: 9.5pt; margin: 10px 0; }
  .tip { background: #e8f6ee; border-left: 4px solid #2f9e5f; padding: 8px 14px;
         margin: 10px 0; font-size: 10pt; border-radius: 3px; }
</style>

# Auto Chrome MCP 설치 가이드

<p class="subtitle">클로드(Claude Code)가 크롬 브라우저를 직접 움직여서, "이 사이트 들어가서 ○○ 좀 해줘" 같은 부탁을 대신 해주게 만드는 프로그램입니다. <b>컴퓨터를 잘 몰라도 괜찮아요.</b> 아래 3단계만 그대로 따라 하면 10분 안에 끝납니다. (Windows 기준)</p>

> **시작 전 확인** — 이 2가지는 이미 쓰고 계셔야 해요.
> ① 크롬 브라우저 ② 클로드 코드(Claude Code)
> 그 외 필요한 것들은 설치 과정에서 **자동으로** 깔립니다.

## 1단계 — 파란 창(PowerShell)에 명령 한 줄 붙여넣기

**PowerShell(파워셸)** 은 컴퓨터에 글자로 명령을 내리는 창이에요. 무섭게 생겼지만 우리는 딱 한 줄만 쓸 거예요.

1. 키보드에서 **윈도우 키(⊞)** 를 누릅니다.
2. **powershell** 이라고 입력하면 파란 아이콘의 "Windows PowerShell"이 나옵니다. **Enter**를 누르세요.
3. 파란(또는 검은) 창이 열리면, 아래 명령을 **전체 복사**해서 창에 **마우스 오른쪽 클릭으로 붙여넣고 Enter**를 누릅니다.

```
irm https://raw.githubusercontent.com/cw02326/auto-chrome-mcp/main/install.ps1 | iex
```

4. 이제 기다리기만 하면 됩니다 (2~5분). 이 한 줄이 필요한 프로그램 설치, 클로드 등록, 확장 프로그램 다운로드까지 **전부 자동으로** 해줍니다.

> **"다시 실행해 주세요"라는 노란 글씨가 나왔다면?** 당황하지 마세요. 필요한 프로그램(Node.js)을 방금 새로 깔았다는 뜻이에요. 창을 닫고, 위의 1~3번을 **한 번만 더** 반복하면 됩니다.

## 2단계 — 크롬에 확장 프로그램 등록하기 (클릭 3번)

1단계가 끝나면 **크롬의 "확장 프로그램" 화면**과 **폴더 창**이 자동으로 열립니다. 이제 클릭 3번만 하면 돼요.

1. 크롬 확장 프로그램 화면에서 **오른쪽 위에 있는 "개발자 모드" 스위치**를 클릭해서 켭니다 (파란색이 되면 켜진 거예요).
2. 왼쪽 위에 새로 나타난 **"압축해제된 확장 프로그램을 로드합니다"** 버튼을 클릭합니다.
3. 폴더 선택 창이 뜨면 **문서 → AutoChromeMCP-확장프로그램** 폴더를 찾아 선택하고 **폴더 선택** 버튼을 누릅니다.

목록에 **Auto Chrome MCP** 가 나타나면 성공!

> **주의:** 문서 폴더 안의 "AutoChromeMCP-확장프로그램" 폴더는 **지우면 안 돼요.** 지우면 확장 프로그램이 꺼집니다.

## 3단계 — 잘 됐는지 확인하기

1. 클로드 코드를 **완전히 껐다가 다시 켭니다.**
2. 클로드 코드 입력창에 **/mcp** 라고 입력하고 Enter를 누릅니다.
3. 목록에 **chrome-mcp-stdio** 가 보이면 설치 완료입니다! 🎉

<div class="tip"><b>바로 시험해 보세요</b> — 클로드에게 이렇게 말해 보세요: <b>"크롬으로 네이버 열어서 오늘 날씨 알려줘"</b>. 크롬이 뒤에서 조용히 움직이며 결과를 가져오면 성공입니다.</div>

## 뭔가 잘 안 될 때

- **가장 쉬운 방법:** 화면에 나온 오류 메시지를 그대로 복사해서 **클로드 코드에 붙여넣고 "이거 왜 안 돼?"라고 물어보세요.** 클로드가 원인을 찾아 고쳐줍니다.
- 크롬 오른쪽 위의 **Auto Chrome MCP 아이콘**을 눌렀을 때 연결 포트가 **12320** 인지 확인해 보세요.
- 그래도 안 되면 [문의 게시판](https://github.com/cw02326/auto-chrome-mcp/issues)에 오류 화면을 올려 주세요.

## 이걸 설치하면 뭐가 좋아요?

- **방해 없음** — 클로드가 크롬으로 일해도 **내가 보고 있는 화면은 건드리지 않아요.** 별도의 작업 창에서 조용히 움직입니다.
- **말로 시키기** — "로그인 버튼 눌러줘"처럼 말하면 알아서 찾아 클릭합니다.
- **똑똑한 대처** — 로그인 팝업이 떠도, 파일이 다운로드돼도 클로드가 알아차리고 이어서 작업합니다.
- **과속 방지** — 한 사이트에 요청이 몰리면 스스로 속도를 줄여 계정을 보호합니다.

<p>프로젝트 홈: <a href="https://github.com/cw02326/auto-chrome-mcp">github.com/cw02326/auto-chrome-mcp</a> · 이 가이드는 컴퓨터 초보자 기준으로 작성되었습니다.</p>
