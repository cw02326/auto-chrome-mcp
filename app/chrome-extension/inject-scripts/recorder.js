/* eslint-disable */
// recorder.js - content script for recording user interactions into steps

(function () {
  if (window.__RR_RECORDER_INSTALLED__) return;
  window.__RR_RECORDER_INSTALLED__ = true;

  // ================================================================
  // 1) CONFIG + STATELESS HELPERS (namespaced)
  // ================================================================
  const CONFIG = {
    // Increase debounce to improve step merging for slow/DOM-replacing inputs
    INPUT_DEBOUNCE_MS: 800,
    BATCH_SEND_MS: 100,
    SCROLL_DEBOUNCE_MS: 350,
    SENSITIVE_INPUT_TYPES: new Set(['password']),
    UI_MAX_STEPS: 30,
    // Maximum time to hold flush while user is typing (prevents unbounded batch accumulation)
    MAX_TYPING_HOLD_MS: 1500,
  };
  // Cross-frame event channel
  const FRAME_EVENT = 'rr_iframe_event';

  // Memoization caches for selector computations during recording
  const __cacheUnique = new WeakMap();
  const __cachePath = new WeakMap();

  const SelectorEngine = {
    buildTarget(el) {
      const candidates = [];
      const attrNames = ['data-testid', 'data-testId', 'data-test', 'data-qa', 'data-cy'];
      for (const an of attrNames) {
        const v = el.getAttribute && el.getAttribute(an);
        if (v) candidates.push({ type: 'attr', value: `[${an}="${CSS.escape(v)}"]` });
      }
      const classSel = this._uniqueClassSelector(el);
      if (classSel) candidates.push({ type: 'css', value: classSel });
      const css = this._generateSelector(el);
      if (css) candidates.push({ type: 'css', value: css });
      const name = el.getAttribute && el.getAttribute('name');
      if (name) candidates.push({ type: 'attr', value: `[name="${CSS.escape(name)}"]` });
      const title = el.getAttribute && el.getAttribute('title');
      if (title) candidates.push({ type: 'attr', value: `[title="${CSS.escape(title)}"]` });
      const alt = el.getAttribute && el.getAttribute('alt');
      if (alt) candidates.push({ type: 'attr', value: `[alt="${CSS.escape(alt)}"]` });
      const aria = el.getAttribute && el.getAttribute('aria-label');
      const role = el.getAttribute && el.getAttribute('role');
      if (aria) {
        if (role) candidates.push({ type: 'aria', value: `${role}[name=${aria}]` });
        else candidates.push({ type: 'aria', value: `textbox[name=${aria}]` });
      }
      const tag = el.tagName?.toLowerCase?.() || '';
      if (['button', 'a', 'summary'].includes(tag)) {
        const text = (el.textContent || '').trim();
        if (text) candidates.push({ type: 'text', value: text.substring(0, 64) });
      }
      const selector = SelectorEngine._choosePrimary(el, candidates);
      return { selector, candidates, tag };
    },

    _choosePrimary(el, candidates) {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        return `#${CSS.escape(el.id)}`;
      }
      const priority = ['attr', 'css'];
      for (const p of priority) {
        const c = candidates.find((c) => c.type === p);
        if (c) {
          try {
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (p === 'attr' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
              const val = String(c.value || '').trim();
              if (val.startsWith('[')) return `${tag}${val}`;
            }
          } catch {}
          return c.value;
        }
      }
      if (candidates.length) return candidates[0].value;
      return SelectorEngine._generateSelector(el) || '';
    },

    _uniqueClassSelector(el) {
      if (__cacheUnique.has(el)) return __cacheUnique.get(el);
      let result = '';
      try {
        const classes = Array.from(el.classList || []).filter(
          (c) => c && /^[a-zA-Z0-9_-]+$/.test(c),
        );
        for (const cls of classes) {
          const sel = `.${CSS.escape(cls)}`;
          if (document.querySelectorAll(sel).length === 1) {
            result = sel;
            break;
          }
        }
        if (!result) {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          for (const cls of classes) {
            const sel = `${tag}.${CSS.escape(cls)}`;
            if (document.querySelectorAll(sel).length === 1) {
              result = sel;
              break;
            }
          }
        }
        if (!result) {
          for (let i = 0; i < Math.min(classes.length, 3) && !result; i++) {
            for (let j = i + 1; j < Math.min(classes.length, 3); j++) {
              const sel = `.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
              if (document.querySelectorAll(sel).length === 1) {
                result = sel;
                break;
              }
            }
          }
        }
      } catch {}
      __cacheUnique.set(el, result);
      return result;
    },

    _generateSelector(el) {
      if (!(el instanceof Element)) return '';
      if (__cachePath.has(el)) return __cachePath.get(el);
      if (el.id) {
        const idSel = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      }
      for (const attr of ['data-testid', 'data-cy', 'name']) {
        const attrValue = el.getAttribute(attr);
        if (attrValue) {
          const s = `[${attr}="${CSS.escape(attrValue)}"]`;
          if (document.querySelectorAll(s).length === 1) return s;
        }
      }
      let path = '';
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName !== 'BODY') {
        let selector = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (child) => child.tagName === current.tagName,
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
        path = path ? `${selector} > ${path}` : selector;
        current = parent;
      }
      const res = path ? `body > ${path}` : 'body';
      __cachePath.set(el, res);
      return res;
    },
  };
  // Extend SelectorEngine with a shared ref helper (attached after declaration)
  SelectorEngine._ensureGlobalRef = function (el) {
    try {
      if (!window.__claudeElementMap) window.__claudeElementMap = {};
      if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
      for (const k in window.__claudeElementMap) {
        const w = window.__claudeElementMap[k];
        if (w && typeof w.deref === 'function' && w.deref() === el) return k;
      }
      const id = `ref_${++window.__claudeRefCounter}`;
      window.__claudeElementMap[id] = new WeakRef(el);
      return id;
    } catch {
      return null;
    }
  };

  // ================================================================
  // 1.5) i18n: chrome.i18n.getMessage 우선, 실패 시 한국어 폴백 사전
  // ================================================================
  // 폴백 문자열도 $1, $2 치환을 지원한다(치환 없는 문자열은 그대로 반환).
  const FALLBACK_KO = {
    recorder_badge_recording: '녹화 중',
    recorder_badge_paused: '잠시 멈춤',
    recorder_badge_steps: '$1단계',
    recorder_opt_hide_values: '입력한 글자 가리기',
    recorder_opt_highlight: '클릭할 곳 표시',
    recorder_btn_collapse: '접기',
    recorder_btn_expand: '펼치기',
    recorder_btn_pause: '일시정지',
    recorder_btn_resume: '이어서 녹화',
    recorder_btn_stop: '녹화 끝내기',
    recorder_timeline_title: '녹화된 단계',
    recorder_step_unknown: '알 수 없는 단계',
    recorder_step_click: '클릭: $1',
    recorder_step_dblclick: '두 번 클릭: $1',
    recorder_step_fill: '입력: $1',
    recorder_step_scroll: '스크롤($1): y=$2, x=$3',
    recorder_scroll_container: '목록 안',
    recorder_scroll_page: '페이지',
    recorder_step_open_tab: '새 탭 열기: $1',
    recorder_step_switch_tab: '다른 탭으로 이동',
    recorder_step_url_contains: '주소에 포함 $1',
    recorder_step_switch_frame: '페이지 안 작은 화면으로 이동',
    recorder_step_wait: '기다리기: $1',
    recorder_move_hint: '끌어서 옆으로 옮기기. 이 줄을 누른 뒤 방향키를 눌러도 옮길 수 있습니다.',
    recorder_step_navigate: '이동: $1',
    recorder_step_key: '키 입력: $1',
    recorder_step_close_tab: '탭 닫기',
    recorder_step_generic: '단계',
    recorder_step_target_document: '문서 전체',
    recorder_session_untitled: '이름 없는 녹화',
  };

  /**
   * 문구 조회 헬퍼. chrome.i18n.getMessage 를 우선 쓰고, 실패하거나 빈 문자열이면
   * 한국어 폴백 사전을 쓴다. chrome 객체 자체가 없는 환경(테스트 등)에서도 예외를
   * 던지지 않는다.
   * @param {string} key
   * @param {Array<string|number>|string|number} [subs] 치환값. $1, $2 순서로 들어간다.
   * @returns {string}
   */
  function t(key, subs) {
    const substitutions =
      subs === undefined || subs === null ? undefined : Array.isArray(subs) ? subs : [subs];
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis.chrome : undefined;
      if (g && g.i18n && typeof g.i18n.getMessage === 'function') {
        const msg = g.i18n.getMessage(key, substitutions);
        if (typeof msg === 'string' && msg.length > 0) return msg;
      }
    } catch {
      // chrome 이 없거나 getMessage 가 실패해도 폴백으로 내려간다
    }
    const fallback = FALLBACK_KO[key];
    if (typeof fallback !== 'string') return key;
    if (!substitutions || substitutions.length === 0) return fallback;
    return fallback.replace(/\$(\d+)/g, (whole, n) => {
      const idx = parseInt(n, 10) - 1;
      return idx >= 0 && idx < substitutions.length ? String(substitutions[idx]) : whole;
    });
  }

  // ================================================================
  // 2) UI CLASS (injected via constructor)
  // ================================================================
  // 접힌 상태에서도 "녹화 끝내기" 는 알약 안에 남아 한 번에 누를 수 있어야 한다.
  const RR_HOST_ID = '__rr_rec_overlay';
  const RR_UI_BUILD = '2026-09-09.2';
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const DEFAULT_CORNER = 'top-right';
  const CORNER_STORAGE_KEY = 'rr_toolbar_corner';
  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  const TOOLBAR_CSS = `
    .rr-wrap {
      all: initial;
      display: block;
      font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Malgun Gothic', sans-serif;
      color: #191f28;
      font-size: 13px;
      line-height: 1.4;
      direction: ltr;
    }
    .rr-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      /* 뒤 내용이 비치되 글자는 묻히지 않게 한다. 배경만 반투명으로 두고
         뒤쪽을 흐리게 깔아 대비를 지킨다. 글자와 아이콘은 불투명 그대로다. */
      background: rgba(255, 255, 255, 0.86);
      backdrop-filter: blur(12px) saturate(1.15);
      -webkit-backdrop-filter: blur(12px) saturate(1.15);
      color: #191f28;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
      padding: 10px 12px;
      width: 360px;
      max-width: calc(100vw - 20px);
      box-sizing: border-box;
    }
    @media (max-width: 480px) {
      .rr-panel { width: calc(100vw - 20px); }
    }
    /* 흐림 효과를 못 쓰는 환경에서는 거의 불투명하게 두어 가독성을 지킨다. */
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .rr-panel { background: rgba(255, 255, 255, 0.97); }
    }
    /* 마우스를 올리거나 초점이 들어오면 또렷해진다. */
    .rr-panel:hover,
    .rr-panel:focus-within {
      background: rgba(255, 255, 255, 0.99);
    }
    /* 끌어 옮기는 동안에는 가리는 부분을 확인할 수 있게 더 비친다. */
    .rr-panel.rr-dragging { background: rgba(255, 255, 255, 0.72); }
    .rr-panel { cursor: grab; }
    .rr-panel button,
    .rr-panel input,
    .rr-panel label { cursor: pointer; }
    .rr-timeline { cursor: auto; }
    .rr-panel.rr-dragging { transition: none; cursor: grabbing; }
    .rr-status-row:focus-visible {
      outline: 2px solid #3182f6;
      outline-offset: 2px;
      border-radius: 6px;
    }
    .rr-panel.rr-collapsed {
      display: inline-flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 6px 12px;
      width: auto;
      max-width: calc(100vw - 20px);
    }
    .rr-controls { display: flex; flex-direction: column; gap: 8px; order: 1; }
    .rr-panel.rr-collapsed .rr-controls {
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }
    .rr-timeline { order: 2; }
    .rr-wrap.rr-anchor-bottom .rr-controls { order: 2; }
    .rr-wrap.rr-anchor-bottom .rr-timeline { order: 1; }
    .rr-status-row {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .rr-status-row:active { cursor: grabbing; }
    .rr-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef3341;
      flex: none;
      animation: rr-blink 1s step-start infinite;
    }
    .rr-dot.rr-paused { background: #c3c8d1; animation: none; }
    @media ${REDUCED_MOTION_QUERY} {
      .rr-dot { animation: none; }
    }
    @keyframes rr-blink {
      50% { opacity: 0.25; }
    }
    .rr-badge-text { font-weight: 600; font-size: 13px; white-space: nowrap; }
    .rr-time-text, .rr-count-text { font-size: 12px; color: #4e5968; white-space: nowrap; }
    .rr-options-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .rr-opt-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .rr-buttons-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
    }
    .rr-panel.rr-collapsed .rr-buttons-row { justify-content: flex-start; flex-wrap: nowrap; }
    .rr-btn {
      border: none;
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }
    .rr-btn-neutral { background: #f6f7f9; color: #191f28; }
    .rr-btn-neutral:hover { background: #e9ebee; }
    .rr-btn-primary { background: #3182f6; color: #ffffff; }
    .rr-btn-primary:hover { background: #2272eb; }
    .rr-btn-danger { background: #ef3341; color: #ffffff; }
    .rr-btn-danger:hover { background: #de2b39; }
    .rr-timeline {
      /* 막대 배경을 그대로 비치게 두어 판 전체가 같은 투명도로 보이게 한다. */
      background: transparent;
      max-height: 220px;
      overflow: auto;
    }
    .rr-timeline-title { font-size: 12px; color: #4e5968; margin-bottom: 4px; }
    .rr-timeline-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .rr-timeline-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 4px 0;
      border-bottom: 1px solid #f2f4f6;
      font-size: 12px;
    }
    .rr-timeline-item:last-child { border-bottom: none; }
    .rr-timeline-idx { min-width: 18px; text-align: right; color: #8b95a1; flex: none; }
    .rr-timeline-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rr-hidden { display: none !important; }
  `;

  class UI {
    constructor(recorder) {
      this.recorder = recorder;
      this._box = null;
      // Timeline elements state
      this._timeline = null;
      this._count = 0;
      this._timelineBox = null;
      this._collapsed = false;
      this._host = null;
      this._shadow = null;
      this._observer = null;
      this._reattachAttempts = 0;
      this._corner = DEFAULT_CORNER;
      this._position = null;
      this._startedAt = 0;
      this._tickTimer = null;
      this._dragState = null;
      this._els = {};
    }

    // 페이지가 host 를 지워도 최대 3회까지 다시 붙인다(1.4).
    _watchHostRemoval() {
      try {
        if (this._observer) this._observer.disconnect();
        this._observer = new MutationObserver(() => {
          if (!this._host) return;
          if (document.documentElement.contains(this._host)) return;
          if (this._reattachAttempts >= 3) {
            this._observer && this._observer.disconnect();
            this._observer = null;
            return;
          }
          this._reattachAttempts += 1;
          try {
            document.documentElement.appendChild(this._host);
          } catch {}
        });
        this._observer.observe(document.documentElement, { childList: true });
      } catch {}
    }

    _createStyleSheet(root) {
      // 3단계: CSSStyleSheet -> replaceSync -> adoptedStyleSheets. 하나라도 실패하면 <style> 폴백.
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(TOOLBAR_CSS);
        root.adoptedStyleSheets = [sheet];
        return;
      } catch {}
      try {
        const styleEl = document.createElement('style');
        styleEl.textContent = TOOLBAR_CSS;
        root.appendChild(styleEl);
      } catch {}
    }

    /**
     * 좌클릭으로 잡아 끌면 막대가 커서를 따라 움직인다. 손을 뗀 자리에 그대로 남고,
     * 화면 밖으로는 나가지 않게 가장자리에서 멈춘다. 자유 위치는 화면 크기에 대한
     * 비율로 저장해, 창 크기가 다른 탭에서도 비슷한 자리에 뜬다.
     */
    _bindDrag(handle) {
      try {
        handle.addEventListener('pointerdown', (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          // 버튼, 체크박스, 단계 목록에서 시작한 것은 끌기가 아니다.
          // 그 밖의 빈 곳은 어디를 잡아도 막대를 옮길 수 있다.
          const t = e.target;
          if (t && typeof t.closest === 'function') {
            if (t.closest('button, input, label, a, .rr-timeline')) return;
          }
          const host = this._host;
          if (!host) return;
          // 막대 어디를 눌러도 방향키가 바로 먹도록 키보드 대상에 초점을 준다.
          try {
            const row = this._els.statusRow;
            if (row && typeof row.focus === 'function') row.focus({ preventScroll: true });
          } catch {}
          const rect = host.getBoundingClientRect();
          this._dragState = {
            moved: false,
            startX: e.clientX,
            startY: e.clientY,
            baseLeft: rect.left,
            baseTop: rect.top,
          };
          try {
            handle.setPointerCapture(e.pointerId);
          } catch {}
        });
        handle.addEventListener('pointermove', (e) => {
          const state = this._dragState;
          if (!state) return;
          const dx = e.clientX - state.startX;
          const dy = e.clientY - state.startY;
          // 손떨림으로 클릭이 드래그가 되지 않게 한다.
          if (!state.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
          if (!state.moved) {
            state.moved = true;
            const panel = this._els.panel;
            if (panel) panel.classList.add('rr-dragging');
          }
          e.preventDefault();
          this._moveTo(state.baseLeft + dx, state.baseTop + dy, { persist: false });
        });
        const finish = () => {
          const state = this._dragState;
          if (!state) return;
          this._dragState = null;
          const panel = this._els.panel;
          if (panel) panel.classList.remove('rr-dragging');
          if (!state.moved) return;
          this._persistPosition();
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      } catch {}
    }

    /** 화면 안으로 가둔 좌표로 막대를 옮긴다. */
    _moveTo(left, top, opts = {}) {
      const host = this._host;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const margin = 10;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const x = Math.min(Math.max(left, margin), maxLeft);
      const y = Math.min(Math.max(top, margin), maxTop);
      host.style.left = `${Math.round(x)}px`;
      host.style.top = `${Math.round(y)}px`;
      host.style.right = '';
      host.style.bottom = '';
      this._position = { left: x, top: y };
      this._corner = null;
      if (this._els.wrap) {
        this._els.wrap.classList.toggle('rr-anchor-bottom', y > window.innerHeight / 2);
      }
      if (opts.persist !== false) this._persistPosition();
    }

    _persistPosition() {
      try {
        const pos = this._position;
        if (!pos) return;
        const g = globalThis.chrome;
        if (!g || !g.storage || !g.storage.local) return;
        const w = Math.max(1, window.innerWidth);
        const h = Math.max(1, window.innerHeight);
        g.storage.local.set({
          [CORNER_STORAGE_KEY]: { xRatio: pos.left / w, yRatio: pos.top / h },
        });
      } catch {}
    }

    _applyCornerStyle(corner) {
      const host = this._host;
      if (!host) return;
      const [vert, horiz] = corner.split('-');
      host.style.top = vert === 'top' ? '10px' : '';
      host.style.bottom = vert === 'bottom' ? '10px' : '';
      host.style.left = horiz === 'left' ? '10px' : '';
      host.style.right = horiz === 'right' ? '10px' : '';
      if (this._els.wrap) {
        this._els.wrap.classList.toggle('rr-anchor-bottom', vert === 'bottom');
      }
    }

    _setCorner(corner, opts = {}) {
      if (CORNERS.indexOf(corner) === -1) return;
      this._corner = corner;
      this._position = null;
      this._applyCornerStyle(corner);
      if (opts.persist !== false) {
        try {
          if (globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local) {
            globalThis.chrome.storage.local.set({ [CORNER_STORAGE_KEY]: corner });
          }
        } catch {}
      }
    }

    _loadStoredCorner() {
      try {
        const g = globalThis.chrome;
        if (!g || !g.storage || !g.storage.local || typeof g.storage.local.get !== 'function') {
          return;
        }
        const result = g.storage.local.get(CORNER_STORAGE_KEY, (res) => {
          try {
            const stored = res && res[CORNER_STORAGE_KEY];
            if (typeof stored === 'string' && CORNERS.indexOf(stored) !== -1) {
              this._setCorner(stored, { persist: false });
              return;
            }
            // 끌어서 옮긴 자유 위치는 비율로 저장돼 있다.
            if (stored && typeof stored === 'object') {
              const xr = Number(stored.xRatio);
              const yr = Number(stored.yRatio);
              if (Number.isFinite(xr) && Number.isFinite(yr)) {
                this._moveTo(xr * window.innerWidth, yr * window.innerHeight, { persist: false });
              }
            }
          } catch {}
        });
        // 프로미스를 돌려주는 구현도 있다.
        if (result && typeof result.then === 'function') {
          result
            .then((res) => {
              const stored = res && res[CORNER_STORAGE_KEY];
              if (typeof stored === 'string' && CORNERS.indexOf(stored) !== -1) {
                this._setCorner(stored, { persist: false });
                return;
              }
              if (stored && typeof stored === 'object') {
                const xr = Number(stored.xRatio);
                const yr = Number(stored.yRatio);
                if (Number.isFinite(xr) && Number.isFinite(yr)) {
                  this._moveTo(xr * window.innerWidth, yr * window.innerHeight, { persist: false });
                }
              }
            })
            .catch(() => {});
        }
      } catch {}
    }

    _bindKeyboardMove(el, opts = {}) {
      try {
        if (opts.focusable !== false) el.setAttribute('tabindex', '0');
        el.addEventListener('keydown', (e) => {
          // 막대에 초점이 있을 때는 방향키만으로 옮긴다. alt 조합도 그대로 받는다.
          // 초점이 페이지에 있을 때는 아무것도 하지 않는다(브라우저 뒤로 가기 등을 뺏지 않는다).
          const dirMap = {
            ArrowUp: 'top',
            ArrowDown: 'bottom',
            ArrowLeft: 'left',
            ArrowRight: 'right',
          };
          const part = dirMap[e.key];
          if (!part) return;
          e.preventDefault();
          const [vert, horiz] = this._corner.split('-');
          const nextVert = part === 'top' || part === 'bottom' ? part : vert;
          const nextHoriz = part === 'left' || part === 'right' ? part : horiz;
          this._setCorner(`${nextVert}-${nextHoriz}`);
        });
      } catch {}
    }

    _makeButton(className, initialText) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `rr-btn ${className}`;
      btn.textContent = initialText;
      return btn;
    }

    ensure() {
      const rec = this.recorder;
      if (window !== window.top) return;
      if (this._host && document.documentElement.contains(this._host)) return;

      const host = document.createElement('div');
      host.id = RR_HOST_ID;
      // 어떤 판이 주입돼 있는지 확인할 수 있게 남긴다(문제 확인용).
      host.setAttribute('data-rr-ui', RR_UI_BUILD);
      Object.assign(host.style, {
        all: 'initial',
        position: 'fixed',
        zIndex: '2147483646',
      });
      this._host = host;
      this._reattachAttempts = 0;

      let shadow;
      try {
        shadow = host.attachShadow({ mode: 'closed' });
      } catch {
        // Shadow DOM 을 못 만드는 극히 드문 환경: host 를 그대로 루트로 쓴다(격리는 포기).
        shadow = host;
      }
      this._shadow = shadow;
      this._createStyleSheet(shadow);

      const wrap = document.createElement('div');
      wrap.className = 'rr-wrap';
      this._els.wrap = wrap;

      const panel = document.createElement('div');
      panel.className = 'rr-panel';
      this._els.panel = panel;

      const controls = document.createElement('div');
      controls.className = 'rr-controls';

      // 상태 줄: 점 + 배지 + 경과 시간 + 단계 수
      const statusRow = document.createElement('div');
      statusRow.className = 'rr-status-row';
      const dot = document.createElement('span');
      dot.className = 'rr-dot';
      const badgeText = document.createElement('span');
      badgeText.className = 'rr-badge-text';
      const timeText = document.createElement('span');
      timeText.className = 'rr-time-text';
      timeText.textContent = '00:00';
      const countText = document.createElement('span');
      countText.className = 'rr-count-text';
      countText.textContent = t('recorder_badge_steps', [0]);
      statusRow.appendChild(dot);
      statusRow.appendChild(badgeText);
      statusRow.appendChild(timeText);
      statusRow.appendChild(countText);
      this._els.statusRow = statusRow;
      this._els.dot = dot;
      this._els.badgeText = badgeText;
      this._els.timeText = timeText;
      this._els.countText = countText;
      statusRow.setAttribute('title', t('recorder_move_hint'));
      statusRow.setAttribute('aria-label', t('recorder_move_hint'));
      this._bindDrag(panel);
      this._bindKeyboardMove(statusRow);
      // 버튼에 초점이 있을 때도 방향키로 옮길 수 있게 패널에도 건다(패널 자체는 초점 대상이 아니다).
      this._bindKeyboardMove(panel, { focusable: false });

      // 옵션 줄: 체크박스 두 개
      const optionsRow = document.createElement('div');
      optionsRow.className = 'rr-options-row';
      const hideLabel = document.createElement('label');
      hideLabel.className = 'rr-opt-label';
      const hideChk = document.createElement('input');
      hideChk.type = 'checkbox';
      hideChk.id = '__rr_hide_values';
      const hideText = document.createElement('span');
      hideText.textContent = t('recorder_opt_hide_values');
      hideLabel.appendChild(hideChk);
      hideLabel.appendChild(hideText);
      const highlightLabel = document.createElement('label');
      highlightLabel.className = 'rr-opt-label';
      const highlightChk = document.createElement('input');
      highlightChk.type = 'checkbox';
      highlightChk.id = '__rr_enable_highlight';
      const highlightText = document.createElement('span');
      highlightText.textContent = t('recorder_opt_highlight');
      highlightLabel.appendChild(highlightChk);
      highlightLabel.appendChild(highlightText);
      optionsRow.appendChild(hideLabel);
      optionsRow.appendChild(highlightLabel);
      this._els.optionsRow = optionsRow;

      // 버튼 줄
      const buttonsRow = document.createElement('div');
      buttonsRow.className = 'rr-buttons-row';
      const btnToggle = this._makeButton('rr-btn-neutral', t('recorder_btn_collapse'));
      const btnPause = this._makeButton('rr-btn-neutral', t('recorder_btn_pause'));
      const btnStop = this._makeButton('rr-btn-danger', t('recorder_btn_stop'));
      buttonsRow.appendChild(btnToggle);
      buttonsRow.appendChild(btnPause);
      buttonsRow.appendChild(btnStop);
      this._els.btnToggle = btnToggle;
      this._els.btnPause = btnPause;
      this._els.btnStop = btnStop;

      controls.appendChild(statusRow);
      controls.appendChild(optionsRow);
      controls.appendChild(buttonsRow);

      // 타임라인
      const timelineBox = document.createElement('div');
      timelineBox.className = 'rr-timeline';
      const timelineTitle = document.createElement('div');
      timelineTitle.className = 'rr-timeline-title';
      timelineTitle.textContent = t('recorder_timeline_title');
      const list = document.createElement('ol');
      list.className = 'rr-timeline-list';
      timelineBox.appendChild(timelineTitle);
      timelineBox.appendChild(list);
      this._timeline = list;
      this._timelineBox = timelineBox;

      panel.appendChild(controls);
      panel.appendChild(timelineBox);
      wrap.appendChild(panel);
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);
      this._watchHostRemoval();

      hideChk.checked = !!rec.hideInputValues;
      hideChk.addEventListener('change', () => (rec.hideInputValues = hideChk.checked));
      highlightChk.checked = !!rec.highlightEnabled;
      highlightChk.addEventListener('change', () => {
        rec.highlightEnabled = !!highlightChk.checked;
        rec._updateHoverListener();
      });
      btnToggle.addEventListener('click', () => {
        this._setCollapsed(!this._collapsed);
      });
      btnPause.addEventListener('click', () => {
        if (!rec.isPaused) rec.pause();
        else rec.resume();
      });
      btnStop.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'rr_stop_recording' });
      });

      this._box = document.createElement('div');
      Object.assign(this._box.style, {
        position: 'fixed',
        border: '2px solid rgba(59,130,246,0.9)',
        borderRadius: '4px',
        background: 'rgba(59,130,246,0.15)',
        pointerEvents: 'none',
        zIndex: 2147483645,
      });
      document.documentElement.appendChild(this._box);
      if (rec.highlightEnabled)
        document.addEventListener('mousemove', rec._onMouseMove, { capture: true, passive: true });

      this._applyCornerStyle(this._corner);
      this._loadStoredCorner();
      if (!this._resizeBound) {
        this._resizeBound = true;
        window.addEventListener('resize', () => {
          try {
            if (!this._host) return;
            if (this._position) {
              this._moveTo(this._position.left, this._position.top, { persist: false });
            }
          } catch {}
        });
      }
      this._setCollapsed(false);
      this._startTicking();
      this.updateStatus();
    }

    _setCollapsed(collapsed) {
      this._collapsed = !!collapsed;
      const panel = this._els.panel;
      if (panel) panel.classList.toggle('rr-collapsed', this._collapsed);
      if (this._els.optionsRow) this._els.optionsRow.classList.toggle('rr-hidden', this._collapsed);
      if (this._els.btnPause) this._els.btnPause.classList.toggle('rr-hidden', this._collapsed);
      if (this._timelineBox) this._timelineBox.classList.toggle('rr-hidden', this._collapsed);
      if (this._els.btnToggle) {
        this._els.btnToggle.textContent = this._collapsed
          ? t('recorder_btn_expand')
          : t('recorder_btn_collapse');
      }
    }

    // 배경이 보내는 startedAt 으로 로컬 1초 타이머를 돌린다(배경은 매초 쏘지 않는다, 1.5).
    setStartedAt(startedAt) {
      const ts = typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now();
      if (this._startedAt === ts) return;
      this._startedAt = ts;
      this._tick();
    }

    setStepCount(count) {
      const n = typeof count === 'number' && count >= 0 ? count : 0;
      if (this._els.countText) this._els.countText.textContent = t('recorder_badge_steps', [n]);
    }

    _tick() {
      if (!this._els.timeText) return;
      const base = this._startedAt || Date.now();
      this._els.timeText.textContent = formatElapsed(Date.now() - base);
    }

    _startTicking() {
      this._stopTicking();
      if (!this._startedAt) this._startedAt = Date.now();
      this._tick();
      this._tickTimer = setInterval(() => this._tick(), 1000);
    }

    _stopTicking() {
      if (this._tickTimer) {
        clearInterval(this._tickTimer);
        this._tickTimer = null;
      }
    }

    remove() {
      if (window === window.top) {
        this._stopTicking();
        if (this._observer) {
          this._observer.disconnect();
          this._observer = null;
        }
        if (this._host) this._host.remove();
        if (this._box) this._box.remove();
        this._host = null;
        this._shadow = null;
        this._timeline = null;
        this._timelineBox = null;
        this._els = {};
        this._startedAt = 0;
      }
    }

    // pausedOverride 는 배경 브로드캐스트(status 필드)로 다른 탭의 표시만 맞출 때 쓴다.
    // 이 탭 자신의 리스너 부착 여부(rec.isPaused)는 건드리지 않는다.
    updateStatus(pausedOverride) {
      const paused = typeof pausedOverride === 'boolean' ? pausedOverride : this.recorder.isPaused;
      if (this._els.badgeText) {
        this._els.badgeText.textContent = paused
          ? t('recorder_badge_paused')
          : t('recorder_badge_recording');
      }
      if (this._els.dot) this._els.dot.classList.toggle('rr-paused', paused);
      if (this._els.btnPause) {
        this._els.btnPause.textContent = paused
          ? t('recorder_btn_resume')
          : t('recorder_btn_pause');
      }
    }

    // Reset the timeline list content
    resetTimeline() {
      this._count = 0;
      if (this._timeline) this._timeline.textContent = '';
      this.setStepCount(0);
    }

    // Append a new recorded step into the timeline UI
    appendStep(step) {
      const list = this._timeline;
      if (!list) return;
      this._count += 1;
      this._appendStepWithIndex(step, this._count);
      while (list.children.length > CONFIG.UI_MAX_STEPS) {
        list.removeChild(list.firstChild);
      }
      this.setStepCount(this._count);
      const container = list.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    }

    /**
     * Apply a full timeline update from background.
     * Steps can be upserted in place (same id, updated fields) during fill debouncing.
     * Uses smart diffing to minimize DOM operations while ensuring fill values are accurate.
     */
    applyTimelineUpdate(steps) {
      try {
        if (window !== window.top) return;
        const list = Array.isArray(steps) ? steps : [];
        const total = list.length;
        // Ensure UI exists
        if (!this._timeline) this.ensure();
        if (!this._timeline) return;
        if (total === 0) {
          this.resetTimeline();
          return;
        }

        // Calculate the window of steps to display (last N steps)
        const windowStart = Math.max(0, total - CONFIG.UI_MAX_STEPS);
        const windowSteps = list.slice(windowStart);

        // Get current displayed step IDs
        const currentItems = this._timeline.children;
        const currentIds = [];
        for (let i = 0; i < currentItems.length; i++) {
          currentIds.push(currentItems[i].getAttribute('data-step-id') || '');
        }

        // Check if we need a full rebuild or can do incremental update
        const newIds = windowSteps.map((s) => s.id || '');
        const needsRebuild =
          currentIds.length !== newIds.length || currentIds.some((id, i) => id !== newIds[i]);

        if (needsRebuild) {
          // Full rebuild: either structure changed or it's simpler to rebuild
          this.resetTimeline();
          for (let i = 0; i < windowSteps.length; i++) {
            this._appendStepWithIndex(windowSteps[i], windowStart + i + 1);
          }
        } else {
          // Incremental update: same steps, just update values
          for (let i = 0; i < windowSteps.length; i++) {
            const step = windowSteps[i];
            const item = currentItems[i];
            if (item) {
              // Update the text content for this step
              const textSpan = item.querySelector('.rr-timeline-text');
              if (textSpan) {
                const newText = this._formatStepText(step, windowStart + i + 1);
                if (textSpan.textContent !== newText) {
                  textSpan.textContent = newText;
                }
              }
            }
          }
        }
        this._count = total;
        this.setStepCount(total);
      } catch {}
    }

    /**
     * Internal method to append a step with a specific display index.
     * Used by applyTimelineUpdate for proper numbering.
     */
    _appendStepWithIndex(step, displayIndex) {
      const list = this._timeline;
      if (!list) return;
      const item = document.createElement('li');
      item.className = 'rr-timeline-item';
      item.setAttribute('data-step-id', step.id || '');
      const idxSpan = document.createElement('span');
      idxSpan.className = 'rr-timeline-idx';
      idxSpan.textContent = `${displayIndex}.`;
      const textSpan = document.createElement('span');
      textSpan.className = 'rr-timeline-text';
      textSpan.textContent = this._formatStepText(step, displayIndex);
      item.appendChild(idxSpan);
      item.appendChild(textSpan);
      list.appendChild(item);
      const container = list.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    }

    // Create a short, human-readable text for a recorded step.
    // 민감값 규칙(1.3): 입력 단계는 셀렉터까지만 표시하고 값은 표시하지 않는다.
    _formatStepText(step, _idx) {
      try {
        if (!step || typeof step !== 'object') return t('recorder_step_unknown');
        const type = step.type;
        const sel = step.target && step.target.selector ? step.target.selector : '';
        const target = sel || t('recorder_step_target_document');
        if (type === 'click') return t('recorder_step_click', [target]);
        if (type === 'dblclick') return t('recorder_step_dblclick', [target]);
        if (type === 'fill') return t('recorder_step_fill', [target]);
        if (type === 'scroll') {
          const mode =
            step.mode === 'container' ? t('recorder_scroll_container') : t('recorder_scroll_page');
          const off = step.offset || {};
          return t('recorder_step_scroll', [mode, off.y ?? 0, off.x ?? 0]);
        }
        if (type === 'openTab') return t('recorder_step_open_tab', [step.url || '']);
        if (type === 'switchTab') {
          const urlPart = t('recorder_step_url_contains', [step.urlContains || '']);
          return `${t('recorder_step_switch_tab')}: ${urlPart}`;
        }
        if (type === 'switchFrame') {
          const frameUrl = step.frame && step.frame.urlContains ? step.frame.urlContains : '';
          const urlPart = t('recorder_step_url_contains', [frameUrl]);
          return `${t('recorder_step_switch_frame')}: ${urlPart}`;
        }
        if (type === 'waitFor') return t('recorder_step_wait', [sel || step.until || '']);
        if (type === 'navigate') return t('recorder_step_navigate', [step.url || '']);
        if (type === 'key') return t('recorder_step_key', [step.keys || '']);
        if (type === 'closeTab') return t('recorder_step_close_tab');
        return t('recorder_step_generic');
      } catch (_) {
        return t('recorder_step_generic');
      }
    }
  }

  // ================================================================
  // 3) MAIN CLASS: ContentRecorder (stateful)
  // ================================================================
  class ContentRecorder {
    constructor() {
      // State
      this.isRecording = false;
      this.isPaused = false;
      this.hideInputValues = false;
      this.highlightEnabled = true;
      this.hoverRAF = 0;
      this.frameSwitchPushed = false;
      this.batch = [];
      this.batchTimer = null;
      this.scrollTimer = null;

      // Local, content-side buffer for batching/merging steps during recording.
      // Not the authoritative Flow (background holds the real one).
      this.sessionBuffer = this._createSessionBuffer();
      // lastFill tracks the most recent fill step for debounce/merge
      // el: DOM element reference for reading final value on finalize
      this.lastFill = { step: null, ts: 0, el: null };
      // Input activity tracking for flush gate (separate from merge state)
      // Updated by both local input and iframe upsert messages
      this._lastInputActivityTs = 0;
      // Flush gate: tracks when a typing burst started to enforce MAX_TYPING_HOLD_MS
      this._typingBurstStartTs = 0;
      // Force flush timer: ensures MAX_TYPING_HOLD_MS is a hard upper bound
      // This timer is NOT reset on each input, only cleared on actual flush
      this._forceFlushTimer = null;
      // Recording-time element identity map (not persisted)
      this.el2ref = new WeakMap();
      this.refCounter = 0;

      // Bind handlers
      this._onClick = this._onClick.bind(this);
      this._onInput = this._onInput.bind(this);
      this._onDocInput = this._onDocInput.bind(this);
      this._onChange = this._onChange.bind(this);
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onScroll = this._onScroll.bind(this);
      this._onFocusIn = this._onFocusIn.bind(this);
      this._onFocusOut = this._onFocusOut.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);
      this._onKeyUp = this._onKeyUp.bind(this);
      this._onWindowMessage = this._onWindowMessage.bind(this);
      // Page lifecycle handlers for best-effort flush on navigation/close
      this._onPageHide = this._onPageHide.bind(this);
      this._onVisibilityChange = this._onVisibilityChange.bind(this);
      this.ui = new UI(this);
      this._scrollPending = null;

      // Focus tracking for per-element input listening
      this._focusedEl = null;
      // Keyboard state for combo recording
      this._pressed = new Set();
      this._lastKeyTs = 0;
      // Map to avoid duplicate switchFrame per iframe source (keyed by frame selector)
      this._frameSwitchMap = new Set();
    }

    // Lifecycle
    start(flowMeta) {
      // Idempotent start: if already recording (and not paused), just ensure UI and listeners
      if (this.isRecording && !this.isPaused) {
        this.ui.ensure();
        this._updateHoverListener();
        return;
      }
      // If paused, treat start as resume to avoid resetting local buffer/UI timeline
      if (this.isPaused) {
        this.resume();
        return;
      }
      this._reset(flowMeta || {});
      this.isRecording = true;
      this.isPaused = false;
      this._attach();
      this.ui.ensure();
      this.ui.resetTimeline();
    }

    /**
     * Stop recording and flush all pending data.
     * This is the reliable stop that ensures no data is lost.
     * Waits for background to acknowledge receipt of all data before returning.
     * @returns {Promise<{ack: boolean, steps: number, variables: number}>}
     */
    async stop() {
      if (!this.isRecording) {
        return { ack: true, steps: 0, variables: 0 };
      }

      this.isRecording = false;
      // Stop should clear paused state so detach fully cleans up (and barrier works consistently)
      this.isPaused = false;

      // Step 1: Finalize pending click (dblclick detector)
      this._finalizePendingClick();

      // Step 2: Finalize any pending input (draft mode)
      this._finalizePendingInput();

      // Step 3: Finalize any pending scroll
      this._finalizePendingScroll();

      // Step 4: In iframes, ensure the top-frame aggregator has processed our final postMessages
      // before we ACK the background stop (prevents missing iframe steps)
      let topSyncOk = true;
      if (window !== window.top) {
        topSyncOk = await this._syncStopBarrierToTop();
      }

      // Step 5: Clear timers BEFORE flush (prevent race conditions)
      if (this.batchTimer) clearTimeout(this.batchTimer);
      this.batchTimer = null;
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
      if (this.hoverRAF) cancelAnimationFrame(this.hoverRAF);
      this.hoverRAF = 0;

      // Step 6: Flush any remaining batched steps and WAIT for ack
      const stepsCount = this.batch.length;
      let stepsAck = true;
      if (stepsCount > 0) {
        stepsAck = await this._flush();
      }

      // Step 7: Send all collected variables and WAIT for ack
      const variablesCount = this.sessionBuffer.variables?.length || 0;
      let variablesAck = true;
      if (variablesCount > 0) {
        variablesAck = await this._sendVariables();
      }

      // Step 8: Detach listeners and clean up UI
      this._detach();
      this.ui.remove();

      // Step 9: Reset state
      this.lastFill = { step: null, ts: 0, el: null };
      this._lastInputActivityTs = 0;
      this._typingBurstStartTs = 0;
      if (this._forceFlushTimer) {
        clearTimeout(this._forceFlushTimer);
        this._forceFlushTimer = null;
      }
      this.sessionBuffer.steps = [];

      // Return acknowledgment with stats
      // ack is true only if all sends were acknowledged
      return {
        ack: stepsAck && variablesAck && topSyncOk,
        steps: stepsCount,
        variables: variablesCount,
      };
    }

    /**
     * Finalize a pending click that hasn't been emitted yet.
     * The dblclick detector holds single clicks temporarily to detect double-clicks.
     * This ensures stop/pause flush includes the last single click.
     */
    _finalizePendingClick() {
      try {
        if (this._pendingClickTimer) clearTimeout(this._pendingClickTimer);
      } catch {}
      this._pendingClickTimer = null;

      try {
        if (this._pendingClick) this._pushStep(this._pendingClick);
      } catch {}
      this._pendingClick = null;
    }

    /**
     * Finalize any pending input that hasn't been flushed yet.
     * This ensures the last input value is captured before stop/pause/navigation.
     * Uses lastFill.el (DOM reference) to read the current value.
     */
    _finalizePendingInput() {
      const last = this.lastFill;
      if (!last || !last.step) return;

      // Commit the latest value from the DOM element
      try {
        const el = last.el;
        if (el) {
          const freshValue = this._getElementValue(el, last.step.value);
          if (freshValue !== last.step.value) {
            last.step.value = freshValue;
            this.sessionBuffer.meta.updatedAt = new Date().toISOString();
          }
        }
      } catch {
        // Element may no longer exist, that's OK - we keep the last known value
      }

      // Enqueue for upsert to ensure background gets the final value
      try {
        this._enqueueForUpsert(last.step);
      } catch {}

      // Reset state
      this.lastFill = { step: null, ts: 0, el: null };
      this._typingBurstStartTs = 0;
    }

    /**
     * Get the current value from an element, handling sensitive fields and contenteditable.
     * @param {Element} el - The element to read from
     * @param {string} existingValue - The existing recorded value (may be a variable placeholder)
     * @returns {string} The value to record
     */
    _getElementValue(el, existingValue) {
      if (!el) return existingValue || '';

      const isContentEditable =
        el.nodeType === 1 && /** @type {HTMLElement} */ (el).isContentEditable === true;

      // If existing value is already a variable placeholder, preserve it
      // Use strict pattern to avoid false positives for user input like "{abc}"
      const existing = typeof existingValue === 'string' ? existingValue : '';
      const varPlaceholderPattern =
        /^\{(?:var_[a-z0-9]{4}|file_[a-z0-9]{4}|[a-zA-Z_][a-zA-Z0-9_]*)\}$/;
      if (varPlaceholderPattern.test(existing)) {
        return existing;
      }

      // Check if this is a sensitive field
      const isSensitive =
        this.hideInputValues ||
        (!isContentEditable &&
          CONFIG.SENSITIVE_INPUT_TYPES.has(
            ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase(),
          ));

      if (isSensitive) {
        // Return existing variable or create new one (should already exist from initial capture)
        return existing;
      }

      // Read fresh value from DOM
      try {
        if (isContentEditable) {
          return /** @type {HTMLElement} */ (el).innerText || '';
        }
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          return el.value || '';
        }
      } catch {}

      return existing || '';
    }

    /**
     * Finalize any pending scroll that hasn't been committed yet.
     * Converts the pending scroll data into a proper scroll step.
     */
    _finalizePendingScroll() {
      if (!this._scrollPending) return;

      const pending = this._scrollPending;
      this._scrollPending = null;

      const { isDoc, target, top, left } = pending;

      // Try merge with last step (same logic as _onScroll timer callback)
      const steps = this.sessionBuffer.steps;
      const last = steps.length ? steps[steps.length - 1] : null;
      if (last && last.type === 'scroll') {
        const sameDoc = isDoc && !last.target && last.mode === 'offset';
        const sameEl =
          !isDoc &&
          last.target &&
          last.target.selector &&
          target &&
          last.target.selector === target.selector &&
          last.mode === 'container';
        if (sameDoc || sameEl) {
          last.offset = { y: top, x: left };
          this.sessionBuffer.meta.updatedAt = new Date().toISOString();
          return;
        }
      }

      // Create new scroll step
      if (isDoc) {
        this._pushStep({
          type: 'scroll',
          mode: 'offset',
          offset: { y: top, x: left },
          screenshotOnFail: false,
        });
      } else {
        this._pushStep({
          type: 'scroll',
          mode: 'container',
          target: target,
          offset: { y: top, x: left },
          screenshotOnFail: false,
        });
      }
    }

    /**
     * Send all collected variables to background.
     * @returns {Promise<boolean>} - Resolves when background acknowledges receipt
     */
    async _sendVariables() {
      if (!this.sessionBuffer.variables || this.sessionBuffer.variables.length === 0) {
        return true;
      }
      return this._send({ kind: 'variables', variables: this.sessionBuffer.variables });
    }

    /**
     * Pause recording. Flushes pending data before pausing.
     */
    pause() {
      if (!this.isRecording || this.isPaused) return;

      // Finalize pending data before pausing
      this._finalizePendingClick();
      this._finalizePendingInput();
      this._finalizePendingScroll();

      // Flush batched steps
      if (this.batch.length > 0) {
        this._flush();
      }

      // Clear timers
      if (this.batchTimer) clearTimeout(this.batchTimer);
      this.batchTimer = null;
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = null;

      this.isPaused = true;
      this._detach();
      this.ui.updateStatus();
    }

    /**
     * Resume recording after pause.
     */
    resume() {
      if (!this.isPaused) return;

      this.isRecording = true;
      this.isPaused = false;
      this._attach();
      this.ui.ensure();
      this.ui.updateStatus();
    }

    // DOM listeners
    _attach() {
      document.addEventListener('click', this._onClick, true);
      // Use focusin/out to attach input listener only to focused element
      document.addEventListener('focusin', this._onFocusIn, true);
      document.addEventListener('focusout', this._onFocusOut, true);
      // Document-level input capture to support Shadow DOM (custom elements)
      // Use capture phase + composedPath to find inner editable control
      document.addEventListener('input', this._onDocInput, true);
      document.addEventListener('change', this._onChange, true);
      // capture-phase scroll to catch non-bubbling events on any container (passive to avoid jank)
      document.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
      // Keyboard: record Enter and modifier combos
      document.addEventListener('keydown', this._onKeyDown, true);
      document.addEventListener('keyup', this._onKeyUp, true);
      // Page lifecycle: best-effort flush on navigation/close
      window.addEventListener('pagehide', this._onPageHide, true);
      document.addEventListener('visibilitychange', this._onVisibilityChange, true);
      // Cross-frame: top window aggregates iframe-recorded steps
      if (window === window.top) window.addEventListener('message', this._onWindowMessage, true);
      this._updateHoverListener();
    }

    _detach() {
      document.removeEventListener('click', this._onClick, true);
      document.removeEventListener('focusin', this._onFocusIn, true);
      document.removeEventListener('focusout', this._onFocusOut, true);
      document.removeEventListener('input', this._onDocInput, true);
      document.removeEventListener('change', this._onChange, true);
      document.removeEventListener('scroll', this._onScroll, { capture: true });
      document.removeEventListener('keydown', this._onKeyDown, true);
      document.removeEventListener('keyup', this._onKeyUp, true);
      window.removeEventListener('pagehide', this._onPageHide, true);
      document.removeEventListener('visibilitychange', this._onVisibilityChange, true);
      document.removeEventListener('mousemove', this._onMouseMove, { capture: true });
      // Keep top-frame aggregator alive during pause; stop() clears isPaused and will remove it
      if (window === window.top && !this.isPaused)
        window.removeEventListener('message', this._onWindowMessage, true);
      // Detach per-element input listener if any
      if (this._focusedEl) this._focusedEl.removeEventListener('input', this._onInput, true);
      this._focusedEl = null;
      // Best-effort cleanup for timers/raf when detaching
      if (this.batchTimer) clearTimeout(this.batchTimer);
      this.batchTimer = null;
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
      if (this.hoverRAF) cancelAnimationFrame(this.hoverRAF);
      this.hoverRAF = 0;
      // Clear pending click state (stop/pause flush it before detach)
      if (this._pendingClickTimer) {
        clearTimeout(this._pendingClickTimer);
      }
      this._pendingClickTimer = null;
      this._pendingClick = null;
    }

    _updateHoverListener() {
      if (window !== window.top) return;
      document.removeEventListener('mousemove', this._onMouseMove, { capture: true });
      if (this.isRecording && !this.isPaused && this.highlightEnabled) {
        document.addEventListener('mousemove', this._onMouseMove, { capture: true, passive: true });
      }
    }

    // Flow helpers (content-side buffer only)
    _createSessionBuffer() {
      const nowIso = new Date().toISOString();
      return {
        id: `flow_${Date.now()}`,
        name: t('recorder_session_untitled'),
        version: 1,
        steps: [],
        variables: [],
        meta: { createdAt: nowIso, updatedAt: nowIso },
      };
    }

    _reset(meta) {
      this.sessionBuffer = this._createSessionBuffer();
      try {
        if (meta && typeof meta === 'object') {
          if (meta.id) this.sessionBuffer.id = String(meta.id);
          if (meta.name) this.sessionBuffer.name = String(meta.name);
          if (meta.description) this.sessionBuffer.description = String(meta.description);
        }
      } catch {}
      this.lastFill = { step: null, ts: 0, el: null };
      this._lastInputActivityTs = 0;
      this._typingBurstStartTs = 0;
      if (this._forceFlushTimer) {
        clearTimeout(this._forceFlushTimer);
        this._forceFlushTimer = null;
      }
      this.frameSwitchPushed = false;
    }

    /**
     * Update input activity timestamp (used for flush gate).
     * Called on local input and iframe upsert messages.
     */
    _updateInputActivity() {
      const now = Date.now();
      const prevActivityTs = this._lastInputActivityTs || 0;
      this._lastInputActivityTs = now;
      // Start a new burst if previous one expired (or this is first input)
      if (!this._typingBurstStartTs || now - prevActivityTs > CONFIG.INPUT_DEBOUNCE_MS) {
        this._typingBurstStartTs = now;
        // Start force flush timer (hard upper bound for MAX_TYPING_HOLD_MS)
        this._startForceFlushTimer();
      }
    }

    /**
     * Start the force flush timer.
     * This timer ensures MAX_TYPING_HOLD_MS is a hard upper bound.
     * Unlike batchTimer, this timer is NOT reset on each input.
     */
    _startForceFlushTimer() {
      // Don't restart if already running
      if (this._forceFlushTimer) return;
      this._forceFlushTimer = setTimeout(() => {
        this._forceFlushTimer = null;
        // Force flush regardless of current input state
        if (this.batch.length > 0) {
          this._flush();
        }
      }, CONFIG.MAX_TYPING_HOLD_MS);
    }

    /**
     * Clear the force flush timer (called on actual flush).
     */
    _clearForceFlushTimer() {
      if (this._forceFlushTimer) {
        clearTimeout(this._forceFlushTimer);
        this._forceFlushTimer = null;
      }
      this._typingBurstStartTs = 0;
    }

    /**
     * Unified commit and flush logic.
     * Called at commit points: focusout, Enter key, pagehide, visibilitychange.
     * @param {Object} options
     * @param {boolean} [options.bestEffort=false] - If true, don't await (for unload events)
     */
    _commitAndFlush(options = {}) {
      if (!this.isRecording || this.isPaused) return;

      try {
        this._finalizePendingInput();
        this._finalizePendingScroll();
      } catch {}

      // Reset flush gate to allow immediate flush
      this._lastInputActivityTs = 0;
      this._typingBurstStartTs = 0;
      this._clearForceFlushTimer();

      // Flush (best-effort for unload events)
      try {
        if (this.batch.length > 0) this._flush();
      } catch {}
      try {
        const variablesCount = this.sessionBuffer.variables?.length || 0;
        if (variablesCount > 0) this._sendVariables();
      } catch {}

      // If in iframe, ask top to flush too
      this._requestTopFlush();
    }

    _pushStep(step) {
      step.id = step.id || `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      // In iframes, forward to top for aggregation (compute frame selector there)
      if (window !== window.top) {
        try {
          const payload = {
            kind: 'iframeStep',
            href: String(location && location.href ? location.href : ''),
            step,
          };
          window.top.postMessage({ type: FRAME_EVENT, payload }, '*');
          return; // Do not push locally in subframe
        } catch {}
      }
      // Top window: optionally insert a switchFrame if this step originated from an iframe message
      this.sessionBuffer.steps.push(step);
      this.sessionBuffer.meta.updatedAt = new Date().toISOString();
      this.batch.push(step);

      // Track input activity for fill steps (to enforce flush gate)
      if (step && step.type === 'fill') {
        this._updateInputActivity();
      }

      this._scheduleFlush();
    }

    /**
     * Calculate the appropriate flush delay based on typing activity.
     * During active typing, delay flush to avoid sending incomplete values.
     * Note: MAX_TYPING_HOLD_MS is enforced by _forceFlushTimer, not here.
     * @returns {number} Delay in milliseconds before next flush
     */
    _getFlushDelayMs() {
      const now = Date.now();
      const lastInputTs = this._lastInputActivityTs || 0;

      // If no recent input activity, use default batch delay
      if (!lastInputTs || now - lastInputTs >= CONFIG.INPUT_DEBOUNCE_MS) {
        return CONFIG.BATCH_SEND_MS;
      }

      // Wait for input debounce to complete
      const notBefore = lastInputTs + CONFIG.INPUT_DEBOUNCE_MS;
      const delay = Math.max(CONFIG.BATCH_SEND_MS, notBefore - now);

      return delay;
    }

    /**
     * Schedule a batch flush with appropriate delay.
     * Respects typing gate to avoid flushing incomplete fill values.
     */
    _scheduleFlush() {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
      }
      const delay = this._getFlushDelayMs();
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this._flush();
      }, delay);
    }

    /**
     * Request top frame to immediately flush its aggregated buffer.
     * Used by iframes on commit points (focusout, navigation) to ensure
     * their updates are sent to background promptly.
     */
    _requestTopFlush() {
      if (window === window.top) return;
      try {
        const payload = {
          kind: 'iframeFlush',
          href: String(location && location.href ? location.href : ''),
        };
        window.top.postMessage({ type: FRAME_EVENT, payload }, '*');
      } catch {}
    }

    /**
     * Iframe -> top stop barrier sync.
     * Ensures the top frame has processed all prior iframe postMessages (steps/upserts)
     * before this iframe responds to background STOP.
     * @returns {Promise<boolean>}
     */
    _syncStopBarrierToTop() {
      if (window === window.top) return Promise.resolve(true);
      const id = `sb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const href = String(location && location.href ? location.href : '');
      const timeoutMs = 400;

      return new Promise((resolve) => {
        let done = false;
        const cleanup = (ok) => {
          if (done) return;
          done = true;
          try {
            window.removeEventListener('message', onMessage, true);
          } catch {}
          try {
            clearTimeout(t);
          } catch {}
          resolve(!!ok);
        };

        const onMessage = (ev) => {
          try {
            if (ev.source !== window.top) return;
            const d = ev && ev.data;
            if (!d || d.type !== FRAME_EVENT || !d.payload) return;
            const p = d.payload || {};
            if (p.kind !== 'iframeStopBarrierAck' || p.id !== id) return;
            cleanup(true);
          } catch {}
        };

        const t = setTimeout(() => cleanup(false), timeoutMs);
        try {
          window.addEventListener('message', onMessage, true);
          window.top.postMessage(
            { type: FRAME_EVENT, payload: { kind: 'iframeStopBarrier', id, href } },
            '*',
          );
        } catch {
          cleanup(false);
        }
      });
    }

    /**
     * Best-effort drain and flush on page navigation/close.
     * Called by pagehide/visibilitychange handlers.
     * Does not await - unload events are time-constrained.
     */
    _bestEffortDrainAndFlush() {
      if (!this.isRecording || this.isPaused) return;

      // Flush pending single click (dblclick detector) before we may be unloaded
      this._finalizePendingClick();

      // Cancel timers (unload may not wait for them)
      try {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = null;
        if (this.scrollTimer) clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
      } catch {}

      // Use unified commit and flush
      this._commitAndFlush({ bestEffort: true });
    }

    /**
     * Handle pagehide event - best-effort flush before navigation/close.
     */
    _onPageHide() {
      this._bestEffortDrainAndFlush();
    }

    /**
     * Handle visibilitychange event - flush when page becomes hidden.
     * This catches some cases that pagehide misses (e.g., tab switch before navigation).
     */
    _onVisibilityChange() {
      try {
        if (document.visibilityState === 'hidden') {
          this._bestEffortDrainAndFlush();
        }
      } catch {}
    }

    /**
     * Flush batched steps to background.
     * @returns {Promise<boolean>} - Resolves when background acknowledges receipt
     */
    async _flush() {
      if (!this.batch.length) return true;

      // Clear force flush timer since we're flushing now
      this._clearForceFlushTimer();

      const steps = this.batch.map((s) => {
        // sanitize internal fields before sending to background
        const { _recordingRef, ...rest } = s || {};
        return rest;
      });
      this.batch.length = 0;
      return this._send({ kind: 'steps', steps });
    }

    /**
     * Send payload to background and wait for acknowledgment.
     * @param {Object} payload - The payload to send
     * @returns {Promise<boolean>} - Resolves true if background acknowledged, false otherwise
     */
    _send(payload) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'rr_recorder_event', payload }, (response) => {
            // Check for runtime error (e.g., no receiver)
            if (chrome.runtime.lastError) {
              console.warn('Recorder: send failed', chrome.runtime.lastError.message);
              resolve(false);
              return;
            }
            resolve(response && response.ok);
          });
        } catch (e) {
          console.warn('Recorder: send exception', e);
          resolve(false);
        }
      });
    }

    _addVariable(key, sensitive, defVal) {
      if (!this.sessionBuffer.variables) this.sessionBuffer.variables = [];
      if (this.sessionBuffer.variables.find((v) => v.key === key)) return;
      this.sessionBuffer.variables.push({ key, sensitive: !!sensitive, default: defVal || '' });
    }

    // Handlers
    // Pending click state for dblclick detection
    _pendingClick = null;
    _pendingClickTimer = null;
    _DBLCLICK_THRESHOLD_MS = 300;

    _onClick(e) {
      if (!this.isRecording || this.isPaused) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      try {
        if (el instanceof HTMLInputElement) {
          const t = (el.getAttribute && el.getAttribute('type')) || '';
          const tt = String(t).toLowerCase();
          if (tt === 'checkbox' || tt === 'radio') return; // avoid duplicate with change
        }
        const host = this.ui && this.ui._host;
        if (host) {
          const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
          if (path.indexOf(host) !== -1) return;
        }
        const a = el.closest && el.closest('a[href]');
        const href = a && a.getAttribute && a.getAttribute('href');
        const tgt = a && a.getAttribute && a.getAttribute('target');
        if (a && href && tgt && tgt.toLowerCase() === '_blank') {
          // 새 탭으로 여는 링크는 여기서 아무 단계도 만들지 않는다 (2026-09-09 축소 결정).
          //
          // 예전에는 이 클릭을 "그 href 로 새 탭 열기" 로 바꿔 두고, 나중에 실제로 뜬 탭을
          // 주소로 짝지어 같은 번호에 이어 붙였다. 그런데 `/orders?id=1` 과 `/orders?id=2`
          // 처럼 주소가 비슷한 두 탭을 그 방식으로는 가릴 수 없어, 서로 다른 업무 대상이
          // 한 번호로 합쳐졌다.
          //
          // 이제 새 탭은 **사용자가 그 탭을 실제로 볼 때** 그때의 진짜 주소로만 기록한다
          // (배경의 joinTab). 링크만 누르고 그 탭에서 아무 일도 하지 않았다면 흐름에도
          // 아무것도 남지 않는 것이 맞다.
          return;
        }
      } catch {}

      const target = SelectorEngine.buildTarget(el);
      try {
        const gref = SelectorEngine._ensureGlobalRef && SelectorEngine._ensureGlobalRef(el);
        if (gref) target.ref = gref;
      } catch {}

      // 2026-09-05 사이드패널 1단계 B: 이 클릭이 페이지 이동을 부를 것 같으면 단계에 표시해 둔다.
      // 실제 이동 기록·중복 제거는 배경(webNavigation)이 하지만, 클릭과 이동 사이의 시간이
      // 벌어져 합치기 창을 놓쳐도 이 표시는 남는다.
      const expectsNavigation = this._clickExpectsNavigation(el);

      // Double-click detection: if e.detail >= 2 means this is the second click of a dblclick
      if (e.detail >= 2) {
        // Cancel pending single click and record dblclick instead
        if (this._pendingClickTimer) {
          clearTimeout(this._pendingClickTimer);
          this._pendingClickTimer = null;
        }
        this._pendingClick = null;
        this._pushStep({
          type: 'dblclick',
          target,
          screenshotOnFail: true,
          ...(expectsNavigation ? { expectsNavigation: true } : {}),
        });
        return;
      }

      // Single click: wait briefly to see if it becomes a dblclick
      // Cancel any previous pending click first
      if (this._pendingClickTimer) {
        clearTimeout(this._pendingClickTimer);
        // Flush previous pending click before starting new one
        if (this._pendingClick) {
          this._pushStep(this._pendingClick);
        }
      }

      this._pendingClick = {
        type: 'click',
        target,
        screenshotOnFail: true,
        ...(expectsNavigation ? { expectsNavigation: true } : {}),
      };

      this._pendingClickTimer = setTimeout(() => {
        if (this._pendingClick) {
          this._pushStep(this._pendingClick);
          this._pendingClick = null;
        }
        this._pendingClickTimer = null;
      }, this._DBLCLICK_THRESHOLD_MS);
    }

    /**
     * 이 클릭이 페이지 이동을 부를 것으로 보이는가 (2026-09-05 사이드패널 1단계 B).
     *
     * 확실한 경우만 참으로 본다: 실제 문서로 가는 링크, 그리고 폼 안의 제출 컨트롤.
     * 추측을 넓히면 재생 때 오지 않을 이동을 기다리다 단계가 실패한다.
     *
     * 이 값은 힌트일 뿐이고, 재생 엔진이 실제로 기다리게 만드는 `after.waitForNavigation`
     * 은 배경이 **이동을 실제로 관측했을 때만** 붙인다(session-manager.recordNavigation).
     *
     * @param {Element} el 클릭된 요소
     * @returns {boolean}
     */
    _clickExpectsNavigation(el) {
      try {
        const a = el.closest && el.closest('a[href]');
        if (a) {
          const href = String((a.getAttribute && a.getAttribute('href')) || '').trim();
          if (!href) return false;
          const lowered = href.toLowerCase();
          // 같은 문서 안의 앵커·스크립트 링크는 문서 이동이 아니다.
          if (lowered.startsWith('#')) return false;
          if (lowered.startsWith('javascript:')) return false;
          return true;
        }
        const submit =
          el.closest &&
          el.closest(
            'button[type="submit"], input[type="submit"], input[type="image"], form button:not([type])',
          );
        if (submit && submit.closest && submit.closest('form')) return true;
      } catch (_) {}
      return false;
    }

    // Per-element input handler (attached on focusin for native inputs/textarea/contenteditable)
    _onInput(e) {
      if (!this.isRecording || this.isPaused) return;
      // Avoid mid-composition spam (IME): handle final committed value
      try {
        if (e && typeof e.isComposing === 'boolean' && e.isComposing) return;
      } catch {}
      const target = e.target;
      // Support input/textarea and contenteditable elements
      const el =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target
          : target &&
              target.nodeType === 1 &&
              /** @type {HTMLElement} */ (target).isContentEditable === true
            ? /** @type {HTMLElement} */ (target)
            : null;
      if (!el) return;
      this._handleInputForElement(el);
    }

    // Document-level input handler: supports composed events from Shadow DOM (custom elements)
    _onDocInput(e) {
      if (!this.isRecording || this.isPaused) return;
      try {
        if (e && typeof e.isComposing === 'boolean' && e.isComposing) return;
      } catch {}
      // Avoid double handling when per-element listener already attached to same element
      if (this._focusedEl && e.target === this._focusedEl) return;
      // Find the innermost editable element from composedPath
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      let el = null;
      for (let i = 0; i < path.length; i++) {
        const n = path[i];
        if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) {
          el = n;
          break;
        }
        // Also check for contenteditable
        if (n && n.nodeType === 1 && /** @type {HTMLElement} */ (n).isContentEditable === true) {
          el = /** @type {HTMLElement} */ (n);
          break;
        }
      }
      // As a fallback, walk down activeElement chain (deep active element via shadow roots)
      if (!el) {
        try {
          let ae = document.activeElement;
          let guard = 0;
          while (ae && guard++ < 10) {
            if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
              el = ae;
              break;
            }
            // Check contenteditable in shadow DOM traversal
            if (
              ae &&
              ae.nodeType === 1 &&
              /** @type {HTMLElement} */ (ae).isContentEditable === true
            ) {
              el = /** @type {HTMLElement} */ (ae);
              break;
            }
            const anyAe = ae;
            if (anyAe && anyAe.shadowRoot && anyAe.shadowRoot.activeElement) {
              ae = anyAe.shadowRoot.activeElement;
              continue;
            }
            break;
          }
        } catch {}
      }
      if (!el) return;
      this._handleInputForElement(el);
    }

    // Shared input processing logic (debounce/merge/sensitivity)
    // Uses Draft/Upsert model: updates are re-enqueued to ensure background gets final value
    _handleInputForElement(el) {
      try {
        const t = (el.getAttribute && el.getAttribute('type')) || '';
        const tt = String(t).toLowerCase();
        if (tt === 'checkbox' || tt === 'radio' || tt === 'file') return;
      } catch {}
      const elRef = this._getElRef(el);
      const target = SelectorEngine.buildTarget(el);

      // Check if element is contenteditable
      const isContentEditable =
        el.nodeType === 1 && /** @type {HTMLElement} */ (el).isContentEditable === true;

      const isSensitive =
        this.hideInputValues ||
        (!isContentEditable &&
          CONFIG.SENSITIVE_INPUT_TYPES.has(
            ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase(),
          ));

      // Get value: use .value for input/textarea, .innerText for contenteditable
      let value = isContentEditable
        ? /** @type {HTMLElement} */ (el).innerText || ''
        : el.value || '';
      if (isSensitive) {
        const varKey = el.name ? el.name : `var_${Math.random().toString(36).slice(2, 6)}`;
        this._addVariable(varKey, true, '');
        value = `{${varKey}}`;
      }
      const nowTs = Date.now();
      const last = this.lastFill.step;
      const sameRef = !!(last && last._recordingRef === elRef);
      const sameSelector = !!(
        last &&
        last.target &&
        last.target.selector &&
        target &&
        target.selector &&
        last.target.selector === target.selector
      );
      const within = nowTs - this.lastFill.ts <= CONFIG.INPUT_DEBOUNCE_MS;
      if ((sameRef || sameSelector) && within) {
        // Update existing step's value
        this.lastFill.step.value = value;
        this.sessionBuffer.meta.updatedAt = new Date().toISOString();
        this.lastFill.ts = nowTs;
        this.lastFill.el = el; // Keep DOM reference updated for finalize
        // Keep flush gate aligned to the latest keystroke
        this._updateInputActivity();
        // Re-enqueue the updated step for upsert (ensures background gets final value)
        this._enqueueForUpsert(this.lastFill.step);
        return;
      }
      const newStep = { type: 'fill', target, value, screenshotOnFail: true };
      newStep._recordingRef = elRef;
      this._pushStep(newStep);
      this.lastFill = { step: newStep, ts: nowTs, el: el };
    }

    /**
     * Enqueue a step for upsert - if step with same id exists in batch, update it.
     * This ensures the background receives the final value for fill steps.
     * In iframes, forwards to top window to maintain selector composition consistency.
     */
    _enqueueForUpsert(step) {
      if (!step || !step.id) return;

      // In iframes, forward upsert updates to top so we don't lose composed selectors.
      // The top window aggregates iframe steps and computes "frame |> inner" selectors.
      // If iframe sends directly to background, it would overwrite the composed selector.
      if (window !== window.top) {
        try {
          const payload = {
            kind: 'iframeStepUpsert',
            href: String(location && location.href ? location.href : ''),
            step,
          };
          window.top.postMessage({ type: FRAME_EVENT, payload }, '*');
        } catch {}
        return;
      }

      // Check if step already in batch
      const existingIdx = this.batch.findIndex((s) => s.id === step.id);
      if (existingIdx >= 0) {
        // Update existing entry in batch
        this.batch[existingIdx] = step;
      } else {
        // Add to batch (step was already flushed, so we need to send update)
        this.batch.push(step);
      }

      // Schedule flush with appropriate delay (respects typing gate)
      this._scheduleFlush();
    }

    _onChange(e) {
      if (!this.isRecording || this.isPaused) return;
      const el = e.target;
      if (el instanceof HTMLSelectElement) {
        const val = el.value;
        const nowTs = Date.now();
        const elRef = this._getElRef(el);
        const sameRef = !!(this.lastFill.step && this.lastFill.step._recordingRef === elRef);
        const within = nowTs - this.lastFill.ts <= CONFIG.INPUT_DEBOUNCE_MS;
        if (sameRef && within) {
          this.lastFill.step.value = val;
          this.sessionBuffer.meta.updatedAt = new Date().toISOString();
          this.lastFill.ts = nowTs;
          this.lastFill.el = el; // Keep DOM reference updated
          // Re-enqueue for upsert
          this._enqueueForUpsert(this.lastFill.step);
          return;
        }
        const target = SelectorEngine.buildTarget(el);
        try {
          const gref = SelectorEngine._ensureGlobalRef && SelectorEngine._ensureGlobalRef(el);
          if (gref) target.ref = gref;
        } catch {}
        const st = { type: 'fill', target, value: val, screenshotOnFail: true };
        st._recordingRef = elRef;
        this._pushStep(st);
        this.lastFill = { step: st, ts: nowTs, el: el };
        return;
      }
      if (el instanceof HTMLInputElement) {
        const t = (el.getAttribute && el.getAttribute('type')) || '';
        const tt = String(t).toLowerCase();
        const target = SelectorEngine.buildTarget(el);
        try {
          const gref = SelectorEngine._ensureGlobalRef && SelectorEngine._ensureGlobalRef(el);
          if (gref) target.ref = gref;
        } catch {}
        const elRef = this._getElRef(el);
        if (tt === 'checkbox') {
          const st = { type: 'fill', target, value: !!el.checked, screenshotOnFail: true };
          st._recordingRef = elRef;
          this._pushStep(st);
          return;
        }
        if (tt === 'radio') {
          const st = { type: 'fill', target, value: true, screenshotOnFail: true };
          st._recordingRef = elRef;
          this._pushStep(st);
          return;
        }
        if (tt === 'file') {
          const varKey = el.name ? el.name : `file_${Math.random().toString(36).slice(2, 6)}`;
          this._addVariable(varKey, false, '');
          this._pushStep({ type: 'fill', target, value: `{${varKey}}`, screenshotOnFail: true });
          return;
        }
      }
    }

    _getElRef(el) {
      try {
        let ref = this.el2ref.get(el);
        if (ref) return ref;
        ref = `ref_${++this.refCounter}`;
        this.el2ref.set(el, ref);
        return ref;
      } catch {
        // Fallback to timestamp-based ref if WeakMap fails (should not happen)
        return `ref_${Date.now()}`;
      }
    }

    // UI handled by injected UI class

    _onFocusIn(e) {
      if (!this.isRecording || this.isPaused) return;
      const el = e.target;
      const isEditable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el && el.nodeType === 1 && /** @type {HTMLElement} */ (el).isContentEditable === true);
      if (!isEditable) return;
      if (this._focusedEl && this._focusedEl !== el)
        this._focusedEl.removeEventListener('input', this._onInput, true);
      el.addEventListener('input', this._onInput, true);
      this._focusedEl = el;
    }

    _onFocusOut(e) {
      const el = e.target;
      if (!el) return;
      if (this._focusedEl === el) {
        // Commit point: leaving an input field - finalize and flush pending input
        // This ensures we don't lose values when user tabs away or clicks elsewhere
        this._commitAndFlush();
        el.removeEventListener('input', this._onInput, true);
        this._focusedEl = null;
      }
    }

    _onMouseMove(e) {
      if (!this.highlightEnabled || !this.ui._box || !this.isRecording || this.isPaused) return;
      if (this.hoverRAF) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      this.hoverRAF = requestAnimationFrame(() => {
        try {
          const r = el.getBoundingClientRect();
          Object.assign(this.ui._box.style, {
            left: `${Math.round(r.left)}px`,
            top: `${Math.round(r.top)}px`,
            width: `${Math.round(Math.max(0, r.width))}px`,
            height: `${Math.round(Math.max(0, r.height))}px`,
            display: r.width > 0 && r.height > 0 ? 'block' : 'none',
          });
        } catch {}
        this.hoverRAF = 0;
      });
    }

    _onScroll(e) {
      if (!this.isRecording || this.isPaused) return;
      try {
        const host = this.ui && this.ui._host;
        if (host) {
          // Use composedPath for shadow DOM compatibility, fallback to target
          const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
          for (const element of path) {
            // If the event path contains our toolbar host, ignore this scroll event
            if (element === host) {
              return;
            }
          }
        }
      } catch {
        // ignore
      }
      // Determine scroll source and positions
      const isDoc = e.target === document;
      const el = isDoc ? document.documentElement : e.target instanceof Element ? e.target : null;
      if (!el) return;
      let top = 0,
        left = 0;
      try {
        if (isDoc) {
          top =
            typeof window.scrollY === 'number'
              ? window.scrollY
              : document.documentElement.scrollTop || 0;
          left =
            typeof window.scrollX === 'number'
              ? window.scrollX
              : document.documentElement.scrollLeft || 0;
        } else {
          top = el.scrollTop || 0;
          left = el.scrollLeft || 0;
        }
      } catch {}
      const target = isDoc ? null : SelectorEngine.buildTarget(el);
      // Debounce/coalesce
      this._scrollPending = { isDoc, target, top, left };
      if (this.scrollTimer) {
        clearTimeout(this.scrollTimer);
      }
      this.scrollTimer = setTimeout(() => {
        this.scrollTimer = null;
        const pending = this._scrollPending;
        this._scrollPending = null;
        if (!pending) return;
        const { isDoc: pDoc, target: pTarget, top: pTop, left: pLeft } = pending;
        // Try merge with last step
        const steps = this.sessionBuffer.steps;
        const last = steps.length ? steps[steps.length - 1] : null;
        if (last && last.type === 'scroll') {
          const sameDoc = pDoc && !last.target && last.mode === 'offset';
          const sameEl =
            !pDoc &&
            last.target &&
            last.target.selector &&
            pTarget &&
            last.target.selector === pTarget.selector &&
            last.mode === 'container';
          if (sameDoc || sameEl) {
            last.offset = { y: pTop, x: pLeft };
            this.sessionBuffer.meta.updatedAt = new Date().toISOString();
            return;
          }
        }
        // New scroll step
        if (pDoc) {
          this._pushStep({
            type: 'scroll',
            mode: 'offset',
            offset: { y: pTop, x: pLeft },
            screenshotOnFail: false,
          });
        } else {
          this._pushStep({
            type: 'scroll',
            mode: 'container',
            target: pTarget,
            offset: { y: pTop, x: pLeft },
            screenshotOnFail: false,
          });
        }
      }, CONFIG.SCROLL_DEBOUNCE_MS);
    }

    // Minimal key recorder: record Enter and modifier combos; avoid plain typing
    _onKeyDown(e) {
      if (!this.isRecording || this.isPaused) return;
      try {
        // Ignore autorepeat to prevent spam
        if (e.repeat) return;
        const key = String(e.key || '').toLowerCase();
        const isModifier = key === 'shift' || key === 'control' || key === 'meta' || key === 'alt';
        const isEditable =
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          (e.target &&
            e.target.nodeType === 1 &&
            /** @type {HTMLElement} */ (e.target).isContentEditable === true);
        const enterKey = key === 'enter';

        // Track pressed modifiers
        if (isModifier) this._pressed.add(key);

        // Handle Enter in editable contexts (including contenteditable)
        if (isEditable && enterKey) {
          // Commit point: Enter may trigger form submission/navigation
          // Record explicit key action with target first
          const target = SelectorEngine.buildTarget(/** @type {Element} */ (e.target));
          const combo = this._formatKeysCombo(e, 'Enter');
          this._pushStep({ type: 'key', keys: combo, target, screenshotOnFail: false });

          // Then commit and flush (form submit may navigate away)
          this._commitAndFlush();

          this._lastKeyTs = Date.now();
          return;
        }

        // For non-text fields: record modifier combos and special keys
        const special = enterKey || key === 'escape' || key === 'tab';
        if (special || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
          const comboName = this._formatKeysCombo(e, e.key);
          this._pushStep({ type: 'key', keys: comboName, screenshotOnFail: false });
          this._lastKeyTs = Date.now();
        }
      } catch {}
    }

    _onKeyUp(e) {
      const key = String(e.key || '').toLowerCase();
      if (key === 'shift' || key === 'control' || key === 'meta' || key === 'alt')
        this._pressed.delete(key);
    }

    _formatKeysCombo(e, mainKey) {
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Meta');
      const mk = String(mainKey || '').trim();
      // Normalize common names to match keyboard-helper parsing
      const norm = (s) => {
        const k = s.toLowerCase();
        if (k === 'escape') return 'Esc';
        if (k === ' ') return 'Space';
        if (k.length === 1) return k.toUpperCase();
        return s;
      };
      parts.push(norm(mk));
      return parts.join('+');
    }

    // Top-level aggregator: receives iframe events and merges into session
    _onWindowMessage(ev) {
      try {
        const d = ev && ev.data;
        if (!d || d.type !== FRAME_EVENT || !d.payload) return;

        // Security: validate message source is from a known iframe in our page
        // ev.source must match contentWindow of an iframe element we control
        let frameEl = null;
        try {
          const frames = document.querySelectorAll('iframe,frame');
          for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            if (f && f.contentWindow === ev.source) {
              frameEl = f;
              break;
            }
          }
        } catch {}

        // Reject messages not from a recognized iframe in our document
        if (!frameEl) {
          // Message source is not from a child iframe we control - ignore
          return;
        }

        // Additional origin check: only accept from same origin or about:blank iframes
        // (cross-origin iframes legitimately send from their origin)
        try {
          const selfOrigin = window.location.origin;
          const msgOrigin = ev.origin;
          // Allow same-origin, null (for sandboxed iframes), or if iframe src is same-origin
          const frameSrc = frameEl.getAttribute('src') || '';
          let iframeSameOrigin = false;
          try {
            if (!frameSrc || frameSrc === 'about:blank') {
              iframeSameOrigin = true;
            } else {
              const frameUrl = new URL(frameSrc, selfOrigin);
              iframeSameOrigin = frameUrl.origin === selfOrigin;
            }
          } catch {
            // Invalid URL - assume cross-origin
          }
          // If iframe is same-origin, message origin should match
          if (iframeSameOrigin && msgOrigin !== selfOrigin && msgOrigin !== 'null') {
            return; // Origin mismatch for same-origin iframe - suspicious
          }
        } catch {}

        const payload = d.payload || {};
        const kind = payload.kind;

        // Stop barrier sync: ACK back to the iframe so it can finish stop only after
        // its final postMessages have been processed by the top aggregator
        if (kind === 'iframeStopBarrier') {
          try {
            const id = payload.id;
            if (id && ev.source && typeof ev.source.postMessage === 'function') {
              ev.source.postMessage(
                { type: FRAME_EVENT, payload: { kind: 'iframeStopBarrierAck', id } },
                '*',
              );
            }
          } catch {}
          return;
        }

        // Handle iframe flush request: immediately flush top's aggregated buffer
        if (kind === 'iframeFlush') {
          this._lastInputActivityTs = 0;
          this._typingBurstStartTs = 0;
          this._clearForceFlushTimer();
          if (this.batchTimer) clearTimeout(this.batchTimer);
          this.batchTimer = null;
          if (this.batch.length > 0) this._flush();
          return;
        }

        const { step, href } = payload;
        if (!step || typeof step !== 'object') return;

        // Compose frame selector for iframe steps
        const frameTarget = SelectorEngine.buildTarget(frameEl);
        const frameSel = frameTarget?.selector || '';

        // For upsert: find existing step in session and update it
        if (kind === 'iframeStepUpsert') {
          // Update input activity for iframe fills (enables flush gate for iframe input)
          if (step.type === 'fill') {
            this._updateInputActivity();
          }

          // Find step by id in session buffer and update its value
          const existingIdx = this.sessionBuffer.steps.findIndex((s) => s.id === step.id);
          if (existingIdx >= 0) {
            // Update value but preserve the composed selector
            this.sessionBuffer.steps[existingIdx].value = step.value;
            this.sessionBuffer.meta.updatedAt = new Date().toISOString();
            // Also update in batch if present
            const batchIdx = this.batch.findIndex((s) => s.id === step.id);
            if (batchIdx >= 0) {
              this.batch[batchIdx].value = step.value;
            } else {
              // Step was already flushed, add updated version to batch
              const updatedStep = { ...this.sessionBuffer.steps[existingIdx] };
              this.batch.push(updatedStep);
            }
            this._scheduleFlush();
          }
          return;
        }

        // Regular iframe step: compose composite selector and push
        if (step.target) {
          const inner = String(step.target.selector || '').trim();
          if (frameSel && inner) {
            const composite = `${frameSel} |> ${inner}`;
            step.target.selector = composite;
            if (Array.isArray(step.target.candidates)) {
              step.target.candidates.unshift({ type: 'css', value: composite });
            }
          }
        }
        this._pushStep(step);
      } catch {}
    }
  }

  // ================================================================
  // 3) SINGLETON + MESSAGE HANDLERS
  // ================================================================
  let recorderInstance = null;
  function getRecorder() {
    if (!recorderInstance) recorderInstance = new ContentRecorder();
    return recorderInstance;
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (!request || !request.action) return false;
      if (request.action === 'rr_timeline_update') {
        const rec = getRecorder();
        // Only respond to timeline updates when recording is active
        if (!rec.isRecording) {
          sendResponse({ ok: true, ignored: true });
          return true;
        }
        // Replace entire timeline to avoid divergence across tabs
        const steps = Array.isArray(request.steps) ? request.steps : [];
        rec.ui.applyTimelineUpdate(steps);
        if (typeof request.startedAt === 'number' && request.startedAt > 0) {
          rec.ui.setStartedAt(request.startedAt);
        }
        if (typeof request.stepCount === 'number') {
          rec.ui.setStepCount(request.stepCount);
        } else {
          rec.ui.setStepCount(steps.length);
        }
        if (request.status === 'paused' || request.status === 'recording') {
          rec.ui.updateStatus(request.status === 'paused');
        }
        sendResponse({ ok: true });
        return true;
      }
      if (request.action === 'rr_recorder_control') {
        const rec = getRecorder();
        const cmd = request.cmd;
        if (cmd === 'start') {
          rec.start(request.meta || {});
          sendResponse({ success: true });
          return true;
        }
        if (cmd === 'pause') {
          rec.pause();
          sendResponse({ success: true });
          return true;
        }
        if (cmd === 'resume') {
          rec.resume();
          sendResponse({ success: true });
          return true;
        }
        if (cmd === 'stop') {
          // Stop is now async - flush all data and wait for ack before responding
          rec
            .stop()
            .then((result) => {
              sendResponse({ success: true, ack: result.ack, stats: result });
            })
            .catch((err) => {
              sendResponse({ success: false, ack: false, error: String(err) });
            });
          return true; // Keep channel open for async response
        }
        sendResponse({ success: false, error: 'Unknown command' });
        return true;
      }
      // Handle direct stop message with ack (sent by recorder-manager)
      if (request.action === 'stop' && request.requireAck) {
        const rec = getRecorder();
        rec
          .stop()
          .then((result) => {
            sendResponse({ ack: result.ack, stats: result });
          })
          .catch(() => {
            sendResponse({ ack: false });
          });
        return true;
      }
      if (request.action === 'rr_recorder_ping') {
        sendResponse({ status: 'pong' });
        return false;
      }
    } catch (e) {
      sendResponse({ success: false, error: String(e && e.message ? e.message : e) });
      return true;
    }
    return false;
  });

  console.log('Record & Replay recorder.js loaded');
})();
