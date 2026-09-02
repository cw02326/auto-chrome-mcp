/* eslint-disable */
// fill-helper.js
// This script is injected into the page to handle form filling operations

if (window.__FILL_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__FILL_HELPER_INITIALIZED__ = true;

  // auto-chrome-mcp fork(A1): 입력 대상이 아직 렌더되지 않았을 때 즉시 실패하지 않고 짧게 폴링한다.
  async function __acmWaitForSelectorElement(selector, timeoutMs) {
    let element = null;
    try {
      element = document.querySelector(selector);
    } catch (e) {
      return null; // 잘못된 셀렉터 — 기존 오류 경로로
    }
    if (element || !(timeoutMs > 0)) return element;
    const deadline = Date.now() + timeoutMs;
    while (!element && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        element = document.querySelector(selector);
      } catch (e) {
        return null;
      }
    }
    return element;
  }
  /**
   * Fill an input element with the specified value
   * @param {string} selector - CSS selector for the element to fill
   * @param {string} value - Value to fill into the element
   * @returns {Promise<Object>} - Result of the fill operation
   */
  /**
   * 오류 메시지용 대상 설명. ref 로 지정하면 selector 가 undefined 라
   * 예전엔 `selector "undefined"` 라고 찍혀 원인을 알 수 없었다.
   * @param {string|null|undefined} selector
   * @param {string|null|undefined} ref
   * @returns {string}
   */
  function describeTarget(selector, ref) {
    if (selector) return `Element with selector "${selector}"`;
    if (ref) return `Element with ref "${ref}"`;
    return 'Target element';
  }

  /**
   * contenteditable 편집기에 값을 넣는다. Google Flow·Gemini·ChatGPT·노션 등
   * 최신 입력창은 INPUT/TEXTAREA 가 아니라 contenteditable 이라 기존 분기로는
   * 전부 실패했다. 기존 fill 동작과 맞추기 위해 내용을 통째로 교체한다.
   * @param {Element} element
   * @param {*} value
   * @param {object} elementInfo
   */
  function fillContentEditable(element, value, elementInfo) {
    const text = value == null ? '' : String(value);
    const previousLength = (element.textContent || '').length;

    if (typeof element.focus === 'function') element.focus();

    // 기존 내용을 전부 선택해 두면 insertText 가 교체로 동작한다.
    let replaced = false;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      // execCommand 는 beforeinput/input 을 네이티브로 발생시켜 프레임워크가 인식한다.
      replaced =
        text.length === 0
          ? document.execCommand('delete')
          : document.execCommand('insertText', false, text);
    } catch (_) {
      replaced = false;
    }

    if (!replaced) {
      // execCommand 가 막힌 편집기 대비 폴백. 이벤트는 직접 쏜다.
      element.textContent = text;
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        }),
      );
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      success: true,
      message: `Filled contenteditable element (previous length: ${previousLength})`,
      elementInfo: {
        ...elementInfo,
        contentEditable: true,
        textLength: (element.textContent || '').length,
      },
    };
  }

  async function fillElement(selector, value, ref = null, waitForElementMs = 0) {
    try {
      // Find the element
      let element = null;
      if (ref && typeof ref === 'string') {
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          element = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }
        if (!element || !(element instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }
      } else {
        // auto-chrome-mcp fork(A1): 아직 렌더되지 않았을 수 있으므로 짧게 기다린다.
        element = await __acmWaitForSelectorElement(selector, waitForElementMs);
      }
      if (!element) {
        return {
          error: selector
            ? `Element with selector "${selector}" not found`
            : `Element for ref not found`,
          waitedMs: selector && waitForElementMs > 0 ? waitForElementMs : 0,
        };
      }

      // Get element information
      const rect = element.getBoundingClientRect();
      const elementInfo = {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        type: element.type || null,
        isVisible: isElementVisible(element),
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
      };

      // Check if element is visible
      if (!elementInfo.isVisible) {
        return {
          error: `${describeTarget(selector, ref)} is not visible`,
          elementInfo,
        };
      }

      // Check if element is an input, textarea, or select
      const validTags = ['INPUT', 'TEXTAREA', 'SELECT'];
      // Keep a permissive list to allow type-specific branches below to handle behavior
      const validInputTypes = [
        'text',
        'email',
        'password',
        'number',
        'search',
        'tel',
        'url',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
        'color',
        'checkbox',
        'radio',
        'range',
      ];

      // contenteditable 은 INPUT/TEXTAREA/SELECT 가 아니지만 텍스트를 넣을 수 있다.
      // 최신 편집기(Google Flow·Gemini·ChatGPT·노션 등)가 전부 이 형태다.
      if (!validTags.includes(element.tagName) && element.isContentEditable) {
        return fillContentEditable(element, value, elementInfo);
      }

      if (!validTags.includes(element.tagName)) {
        // If the element is a custom element with open shadow root, try to find a fillable inner control
        try {
          const anyEl = /** @type {any} */ (element);
          const sr = anyEl && anyEl.shadowRoot ? anyEl.shadowRoot : null;
          if (sr) {
            // Search common fillable targets inside shadow root (breadth-first)
            const queue = Array.from(sr.children || []);
            const isFillable = (el) =>
              !!el &&
              (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
            while (queue.length) {
              const cur = queue.shift();
              if (!cur) continue;
              if (isFillable(cur)) {
                element = cur;
                break;
              }
              try {
                const children = cur.children || [];
                for (let i = 0; i < children.length; i++) queue.push(children[i]);
                const innerSr = /** @type {any} */ (cur).shadowRoot;
                if (innerSr && innerSr.children) {
                  for (let i = 0; i < innerSr.children.length; i++) queue.push(innerSr.children[i]);
                }
              } catch (_) {}
            }
            if (!validTags.includes(element.tagName)) {
              return {
                error:
                  `${describeTarget(selector, ref)} is not fillable (<${element.tagName.toLowerCase()}>). ` +
                  `chrome_fill_or_select supports INPUT, TEXTAREA, SELECT and contenteditable. ` +
                  `For anything else use chrome_click_element or chrome_keyboard.`,
                elementInfo,
              };
            }
          } else {
            return {
              error:
                `${describeTarget(selector, ref)} is not fillable (<${element.tagName.toLowerCase()}>). ` +
                `chrome_fill_or_select supports INPUT, TEXTAREA, SELECT and contenteditable. ` +
                `For anything else use chrome_click_element or chrome_keyboard.`,
              elementInfo,
            };
          }
        } catch (_) {
          return {
            error:
              `${describeTarget(selector, ref)} is not fillable (<${element.tagName.toLowerCase()}>). ` +
              `chrome_fill_or_select supports INPUT, TEXTAREA, SELECT and contenteditable. ` +
              `For anything else use chrome_click_element or chrome_keyboard.`,
            elementInfo,
          };
        }
      }

      // For input elements, check if the type is valid (allow type-specific branches below)
      if (
        element.tagName === 'INPUT' &&
        !validInputTypes.includes(element.type) &&
        element.type !== null
      ) {
        return {
          error: `${describeTarget(selector, ref)} is an input of type "${element.type}", which is not fillable`,
          elementInfo,
        };
      }

      // Scroll element into view
      element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Focus the element
      element.focus();

      // Type-specific handling for tricky inputs first
      if (element.tagName === 'INPUT' && element.type === 'checkbox') {
        // Accept boolean or string-like boolean
        let checkedVal;
        if (typeof value === 'boolean') {
          checkedVal = value;
        } else if (typeof value === 'string') {
          const v = value.trim().toLowerCase();
          if (['true', '1', 'yes', 'on'].includes(v)) checkedVal = true;
          else if (['false', '0', 'no', 'off'].includes(v)) checkedVal = false;
        }
        if (typeof checkedVal !== 'boolean') {
          return {
            error:
              'Checkbox requires a boolean (true/false) or a boolean-like string ("true"/"false"/"on"/"off").',
            elementInfo,
          };
        }
        const previous = element.checked;
        element.checked = checkedVal;
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Checkbox set to ${element.checked}`,
          elementInfo: { ...elementInfo, checked: element.checked, previousChecked: previous },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'radio') {
        // For radios, the selector/ref should target the specific input to select
        const previous = element.checked;
        element.checked = true;
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: 'Radio selected',
          elementInfo: {
            ...elementInfo,
            checked: element.checked,
            previousChecked: previous,
            name: element.name || null,
          },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'range') {
        const numericValue = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(numericValue)) {
          return { error: 'Range input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        element.value = String(numericValue);
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set range to ${element.value} (min: ${element.min}, max: ${element.max})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'number') {
        if (value !== '' && value !== null && value !== undefined && Number.isNaN(Number(value))) {
          return { error: 'Number input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        element.value = String(value ?? '');
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set number input to ${element.value} (previous: ${previous})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      // Fill the element based on its type
      if (element.tagName === 'SELECT') {
        // For select elements, find the option with matching value or text
        let optionFound = false;
        for (const option of element.options) {
          if (option.value === value || option.text === value) {
            element.value = option.value;
            optionFound = true;
            break;
          }
        }

        if (!optionFound) {
          return {
            error: `No option with value or text "${value}" found in select element`,
            elementInfo,
          };
        }

        // Trigger change event
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For input and textarea elements
        // Clear the current value then set new value
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));

        element.value = String(value);

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Blur the element
      element.blur();

      return {
        success: true,
        message: 'Element filled successfully',
        elementInfo: {
          ...elementInfo,
          value: element.value, // Include the final value in the response
        },
      };
    } catch (error) {
      return {
        error: `Error filling element: ${error.message}`,
      };
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

    // Check if element is within viewport
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    // Check if element is actually visible at its center point
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
    if (request.action === 'fillElement') {
      fillElement(request.selector, request.value, request.ref, request.waitForElementMs)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_fill_or_select_ping') {
      sendResponse({ status: 'pong' });
      return false;
    } else if (request.action === 'chrome_fill_or_select_probe_selector') {
      // auto-chrome-mcp fork: iframe 대상 프레임 탐색용 probe (조회 전용)
      sendResponse(probeTarget(request.selector, request.ref, request.isXPath));
      return false;
    }
  });
}
