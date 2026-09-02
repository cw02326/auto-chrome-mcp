/* eslint-disable */
// click-helper.js
// This script is injected into the page to handle click operations

if (window.__CLICK_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__CLICK_HELPER_INITIALIZED__ = true;

  // ===== auto-chrome-mcp fork (A1/A3): 요소 대기 + 가림(obstruction) 진단 =====
  // A1 — 요소가 아직 렌더되지 않았을 때 즉시 실패하지 않고 짧게 폴링한다.
  //      SPA/지연 렌더 페이지에서 "클릭 실패 → wait_for → 재클릭" 3회 왕복을 1회로 줄인다.
  // A3 — 클릭이 가려서 실패했을 때, 이미 계산해 두고 버리던 elementFromPoint 결과를
  //      "무엇이 가리는지"로 정리해 돌려준다. 페이지 동작은 전혀 바꾸지 않는다.

  const OBSTRUCTION_POLL_MS = 100;

  function __acmSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** selector 요소가 나타날 때까지 폴링. 못 찾으면 null. */
  async function waitForSelectorElement(selector, timeoutMs) {
    let element = null;
    try {
      element = document.querySelector(selector);
    } catch (e) {
      return null; // 잘못된 셀렉터 — 호출부가 기존 오류 경로로 처리
    }
    if (element || !(timeoutMs > 0)) return element;
    const deadline = Date.now() + timeoutMs;
    while (!element && Date.now() < deadline) {
      await __acmSleep(OBSTRUCTION_POLL_MS);
      try {
        element = document.querySelector(selector);
      } catch (e) {
        return null;
      }
    }
    return element;
  }

  /** 요소가 보이는 상태가 될 때까지 폴링 (등장 애니메이션·오버레이 사라짐 대응). */
  async function waitUntilElementVisible(element, timeoutMs) {
    if (isElementVisible(element)) return true;
    if (!(timeoutMs > 0)) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await __acmSleep(OBSTRUCTION_POLL_MS);
      if (isElementVisible(element)) return true;
    }
    return false;
  }

  function __acmSummarizeElement(el) {
    if (!el || !(el instanceof Element)) return null;
    let style = null;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      style = null;
    }
    const rect = el.getBoundingClientRect();
    const cls =
      typeof el.className === 'string'
        ? el.className.trim().slice(0, 120)
        : el.getAttribute
          ? el.getAttribute('class') || null
          : null;
    return {
      tagName: el.tagName,
      id: el.id || null,
      className: cls || null,
      role: el.getAttribute ? el.getAttribute('role') : null,
      ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      position: style ? style.position : null,
      zIndex: style ? style.zIndex : null,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  /**
   * 가리는 요소에서 위로 올라가며 "모달/오버레이로 볼 만한" 조상을 찾는다.
   * 생김새(클래스명)가 아니라 성질로 판정한다 — 사이트마다 마크업이 달라도 잡히도록.
   */
  function __acmFindOverlayAncestor(startEl) {
    let node = startEl;
    let depth = 0;
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    while (node && node instanceof Element && depth < 12) {
      let style = null;
      try {
        style = window.getComputedStyle(node);
      } catch (e) {
        style = null;
      }
      const rect = node.getBoundingClientRect();
      const coverage = (rect.width * rect.height) / viewportArea;
      const role = node.getAttribute ? node.getAttribute('role') : null;
      const ariaModal = node.getAttribute ? node.getAttribute('aria-modal') : null;
      const isDialogEl = node.tagName === 'DIALOG' && node.hasAttribute('open');
      const isAriaDialog = role === 'dialog' || role === 'alertdialog' || ariaModal === 'true';
      const layered =
        style &&
        (style.position === 'fixed' ||
          style.position === 'sticky' ||
          style.position === 'absolute');
      const zi = style ? parseInt(style.zIndex, 10) : NaN;
      if (isDialogEl || isAriaDialog) {
        return { node, detectedAs: isDialogEl ? 'dialog-element' : 'aria-dialog', coverage };
      }
      if (layered && (coverage >= 0.15 || (Number.isFinite(zi) && zi >= 100))) {
        return { node, detectedAs: 'layered-overlay', coverage };
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  /**
   * 요소가 보이지 않는 이유를 진단한다. 가려진 게 아니면 reason 만, 가려졌으면
   * 가리는 요소와 (있으면) 모달 조상을 함께 돌려준다. 가려지지 않았으면 null.
   */
  function describeObstruction(element) {
    try {
      if (!element || !(element instanceof Element)) return null;
      let style = null;
      try {
        style = window.getComputedStyle(element);
      } catch (e) {
        style = null;
      }
      if (style && (style.display === 'none' || style.visibility === 'hidden')) {
        return {
          reason: 'hidden_by_css',
          cssDisplay: style.display,
          cssVisibility: style.visibility,
        };
      }
      if (style && style.opacity === '0') {
        return { reason: 'transparent', cssOpacity: style.opacity };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { reason: 'zero_size', rect: { width: rect.width, height: rect.height } };
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
        return {
          reason: 'outside_viewport',
          point: { x: Math.round(cx), y: Math.round(cy) },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          hint: 'The element is scrolled out of the viewport. Scroll it into view and retry.',
        };
      }
      const at = document.elementFromPoint(cx, cy);
      if (!at)
        return { reason: 'nothing_at_point', point: { x: Math.round(cx), y: Math.round(cy) } };
      if (at === element || element.contains(at)) return null; // 가려지지 않음

      const overlay = __acmFindOverlayAncestor(at);
      let bodyScrollLocked = false;
      try {
        bodyScrollLocked = window.getComputedStyle(document.body).overflow === 'hidden';
      } catch (e) {
        bodyScrollLocked = false;
      }
      const result = {
        reason: 'covered_by_other_element',
        point: { x: Math.round(cx), y: Math.round(cy) },
        obstructedBy: __acmSummarizeElement(at),
        likelyModal: !!overlay,
        bodyScrollLocked,
      };
      if (overlay) {
        result.overlay = Object.assign(__acmSummarizeElement(overlay.node), {
          detectedAs: overlay.detectedAs,
          viewportCoverage: Math.round(overlay.coverage * 100) / 100,
        });
        result.hint =
          'A modal/overlay is covering the target. Find and click its close/accept control (e.g. 닫기, 동의, 확인, Accept, Close, ✕) — chrome_find is useful for this — then retry the click.';
      } else {
        result.hint =
          'Another element sits on top of the target. Scroll the target to a clear area, or click the overlaying element reported in obstructedBy.';
      }
      return result;
    } catch (e) {
      return { reason: 'obstruction_check_failed', error: String((e && e.message) || e) };
    }
  }
  // ===== /A1·A3 helpers =====
  /**
   * Click on an element matching the selector or at specific coordinates
   * @param {string} selector - CSS selector for the element to click
   * @param {boolean} waitForNavigation - Whether to wait for navigation to complete after click
   * @param {number} timeout - Timeout in milliseconds for waiting for the element or navigation
   * @param {Object} coordinates - Optional coordinates for clicking at a specific position
   * @param {number} coordinates.x - X coordinate relative to the viewport
   * @param {number} coordinates.y - Y coordinate relative to the viewport
   * @returns {Promise<Object>} - Result of the click operation
   */
  async function clickElement(
    selector,
    waitForNavigation = false,
    timeout = 5000,
    coordinates = null,
    ref = null,
    double = false,
    options = {},
    waitForElementMs = 0,
  ) {
    try {
      let element = null;
      let elementInfo = null;
      let clickX, clickY;
      // auto-chrome-mcp fork(A3): 가려짐 진단 결과 (성공 응답에도 경고로 실릴 수 있음)
      let obstruction = null;
      const waitDeadline = Date.now() + (waitForElementMs > 0 ? waitForElementMs : 0);

      if (ref && typeof ref === 'string') {
        // Resolve element from weak map
        let target = null;
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          target = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }

        if (!target || !(target instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }

        element = target;
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 80));

        const rect = element.getBoundingClientRect();
        clickX = rect.left + rect.width / 2;
        clickY = rect.top + rect.height / 2;
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim().substring(0, 100) || '',
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'ref',
          ref,
        };

        // auto-chrome-mcp fork(A3): ref 클릭은 요소에 직접 이벤트를 쏘므로 가려져 있어도
        // "성공"으로 보고된다. 실제로는 사이트가 무시하는 경우가 있어 가려짐을 경고로 남긴다.
        elementInfo.isVisible = isElementVisible(element);
        if (!elementInfo.isVisible) {
          obstruction = describeObstruction(element);
        }
      } else if (
        coordinates &&
        typeof coordinates.x === 'number' &&
        typeof coordinates.y === 'number'
      ) {
        clickX = coordinates.x;
        clickY = coordinates.y;

        element = document.elementFromPoint(clickX, clickY);

        if (element) {
          const rect = element.getBoundingClientRect();
          elementInfo = {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            text: element.textContent?.trim().substring(0, 100) || '',
            href: element.href || null,
            type: element.type || null,
            isVisible: true,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
          };
        } else {
          elementInfo = {
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
            warning: 'No element found at the specified coordinates',
          };
        }
      } else {
        // auto-chrome-mcp fork(A1): 아직 렌더되지 않았을 수 있으므로 짧게 기다린다.
        element = await waitForSelectorElement(selector, waitForElementMs);
        if (!element) {
          return {
            error: `Element with selector "${selector}" not found`,
            waitedMs: waitForElementMs > 0 ? waitForElementMs : 0,
          };
        }

        const rect = element.getBoundingClientRect();
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim().substring(0, 100) || '',
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'selector',
        };

        // First sroll so that the element is in view, then check visibility.
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        // auto-chrome-mcp fork(A1): 등장 애니메이션·오버레이가 걷히는 것을 남은 시간만큼 기다린다.
        elementInfo.isVisible = await waitUntilElementVisible(
          element,
          Math.max(0, waitDeadline - Date.now()),
        );
        if (!elementInfo.isVisible) {
          // auto-chrome-mcp fork(A3): 왜 못 눌렀는지 — 무엇이 가리는지 함께 보고한다.
          return {
            error: `Element with selector "${selector}" is not visible`,
            elementInfo,
            obstruction: describeObstruction(element),
          };
        }

        const updatedRect = element.getBoundingClientRect();
        clickX = updatedRect.left + updatedRect.width / 2;
        clickY = updatedRect.top + updatedRect.height / 2;
      }

      let navigationPromise;
      if (waitForNavigation) {
        navigationPromise = new Promise((resolve) => {
          const beforeUnloadListener = () => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(true);
          };
          window.addEventListener('beforeunload', beforeUnloadListener);

          setTimeout(() => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(false);
          }, timeout);
        });
      }

      if (
        element &&
        (elementInfo.clickMethod === 'selector' || elementInfo.clickMethod === 'ref')
      ) {
        if (double) {
          dispatchClickSequence(element, clickX, clickY, options, true);
        } else {
          dispatchClickSequence(element, clickX, clickY, options, false);
        }
      } else {
        if (double) simulateDoubleClick(clickX, clickY, options);
        else simulateClick(clickX, clickY, options);
      }

      // Wait for navigation if needed
      let navigationOccurred = false;
      if (waitForNavigation) {
        navigationOccurred = await navigationPromise;
      }

      const successPayload = {
        success: true,
        message: 'Element clicked successfully',
        elementInfo,
        navigationOccurred,
      };
      // auto-chrome-mcp fork(A3): 가려진 요소를 직접 이벤트로 눌렀을 때의 경고
      if (obstruction) {
        successPayload.obstruction = obstruction;
        successPayload.warning =
          'The click was dispatched directly on the element, but the element was covered at click time. The site may have ignored it — verify the expected result, and close the overlay if nothing happened.';
      }
      return successPayload;
    } catch (error) {
      return {
        error: `Error clicking element: ${error.message}`,
      };
    }
  }

  /**
   * Simulate a mouse click at specific coordinates
   * @param {number} x - X coordinate relative to the viewport
   * @param {number} y - Y coordinate relative to the viewport
   */
  function simulateClick(x, y, options = {}) {
    const element = document.elementFromPoint(x, y);
    if (!element) return;
    dispatchClickSequence(element, x, y, options, false);
  }

  /**
   * Simulate a double click sequence at specific coordinates
   */
  function simulateDoubleClick(x, y, options = {}) {
    const element = document.elementFromPoint(x, y);
    if (!element) return;
    dispatchClickSequence(element, x, y, options, true);
  }

  /**
   * Simulate double click using element when available
   */
  function simulateDomDoubleClick(element, x, y, options) {
    dispatchClickSequence(element, x, y, options, true);
  }

  function normalizeMouseOpts(x, y, options = {}) {
    const bubbles = options.bubbles !== false; // default true
    const cancelable = options.cancelable !== false; // default true
    const altKey = !!(options.modifiers && options.modifiers.altKey);
    const ctrlKey = !!(options.modifiers && options.modifiers.ctrlKey);
    const metaKey = !!(options.modifiers && options.modifiers.metaKey);
    const shiftKey = !!(options.modifiers && options.modifiers.shiftKey);
    const btn = String(options.button || 'left');
    const button = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
    const buttons = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
    return {
      bubbles,
      cancelable,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      button,
      buttons,
      clientX: x,
      clientY: y,
      view: window,
    };
  }

  function dispatchClickSequence(element, x, y, options = {}, isDouble = false) {
    const base = normalizeMouseOpts(x, y, options);
    const down = new MouseEvent('mousedown', base);
    const up = new MouseEvent('mouseup', base);
    const click = new MouseEvent('click', base);
    try {
      element.dispatchEvent(down);
    } catch {}
    try {
      element.dispatchEvent(up);
    } catch {}
    try {
      element.dispatchEvent(click);
    } catch {}
    if (base.button === 2) {
      // right button contextmenu
      const ctx = new MouseEvent('contextmenu', base);
      try {
        element.dispatchEvent(ctx);
      } catch {}
    }
    if (isDouble) {
      // second sequence + dblclick
      setTimeout(() => {
        try {
          element.dispatchEvent(new MouseEvent('mousedown', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('mouseup', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('click', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('dblclick', base));
        } catch {}
      }, 30);
    }
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return element === elementAtPoint || element.contains(elementAtPoint);
  }

  /**
   * auto-chrome-mcp fork: iframe 탐색용 probe.
   * 부수효과 없이 "이 프레임에 해당 셀렉터/ref 요소가 있는가"만 확인한다.
   * background 의 frame-resolver 가 각 프레임에 이 메시지를 보내 대상 프레임을 고른다.
   * 주의: 응답에 `error` 키를 쓰면 sendMessageToTab 이 throw 하므로 probeError 를 쓴다.
   */
  function probeTarget(selector, ref, isXPath) {
    try {
      let element = null;
      if (ref && typeof ref === 'string') {
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          const target = weak && typeof weak.deref === 'function' ? weak.deref() : null;
          element = target instanceof Element ? target : null;
        } catch (e) {
          element = null;
        }
      } else if (selector && typeof selector === 'string') {
        if (isXPath) {
          try {
            const result = document.evaluate(
              selector,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            );
            const node = result && result.singleNodeValue;
            element = node && node.nodeType === 1 ? node : null;
          } catch (e) {
            element = null;
          }
        } else {
          element = document.querySelector(selector);
        }
      }

      return {
        success: true,
        found: !!element,
        visible: element ? isElementVisible(element) : false,
        tagName: element ? element.tagName : null,
        frameUrl: location.href,
      };
    } catch (e) {
      return {
        success: true,
        found: false,
        visible: false,
        tagName: null,
        frameUrl: location.href,
        probeError: String((e && e.message) || e),
      };
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'clickElement') {
      clickElement(
        request.selector,
        request.waitForNavigation,
        request.timeout,
        request.coordinates,
        request.ref,
        !!request.double,
        {
          button: request.button,
          bubbles: request.bubbles,
          cancelable: request.cancelable,
          modifiers: request.modifiers,
        },
        request.waitForElementMs,
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_click_element_ping') {
      sendResponse({ status: 'pong' });
      return false;
    } else if (request.action === 'chrome_click_element_probe_selector') {
      // auto-chrome-mcp fork: iframe 대상 프레임 탐색용 probe (조회 전용)
      sendResponse(probeTarget(request.selector, request.ref, request.isXPath));
      return false;
    }
  });
}
