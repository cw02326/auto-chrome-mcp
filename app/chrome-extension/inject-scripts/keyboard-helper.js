/* eslint-disable */
// keyboard-helper.js
// This script is injected into the page to handle keyboard event simulation

if (window.__KEYBOARD_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__KEYBOARD_HELPER_INITIALIZED__ = true;

  // A map for special keys to their KeyboardEvent properties
  // Key names should be lowercase for matching
  const SPECIAL_KEY_MAP = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    del: { key: 'Delete', code: 'Delete', keyCode: 46 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
    // Function keys
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `f${i + 1}`,
        { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i },
      ]),
    ),
  };

  const MODIFIER_KEYS = {
    ctrl: 'ctrlKey',
    control: 'ctrlKey',
    alt: 'altKey',
    shift: 'shiftKey',
    meta: 'metaKey',
    command: 'metaKey',
    cmd: 'metaKey',
  };

  /**
   * Parses a key string (e.g., "Ctrl+Shift+A", "Enter") into a main key and modifiers.
   * @param {string} keyString - String representation of a single key press (can include modifiers).
   * @returns { {key: string, code: string, keyCode: number, charCode?: number, modifiers: {ctrlKey:boolean, altKey:boolean, shiftKey:boolean, metaKey:boolean}} | null }
   *          Returns null if the keyString is invalid or represents only modifiers.
   */
  function parseSingleKeyCombination(keyString) {
    const parts = keyString.split('+').map((part) => part.trim().toLowerCase());
    const modifiers = {
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };
    let mainKeyPart = null;

    for (const part of parts) {
      if (MODIFIER_KEYS[part]) {
        modifiers[MODIFIER_KEYS[part]] = true;
      } else if (mainKeyPart === null) {
        // First non-modifier is the main key
        mainKeyPart = part;
      } else {
        // Invalid format: multiple main keys in a single combination (e.g., "Ctrl+A+B")
        console.warn(`Invalid key combination string: ${keyString}. Multiple main keys found.`);
        return null;
      }
    }

    if (!mainKeyPart) {
      // This case could happen if the keyString is something like "Ctrl+" or just "Ctrl"
      // If the intent was to press JUST 'Control', the input should be 'Control' not 'Control+'
      // Let's check if mainKeyPart is actually a modifier name used as a main key
      if (Object.keys(MODIFIER_KEYS).includes(parts[parts.length - 1]) && parts.length === 1) {
        mainKeyPart = parts[parts.length - 1]; // e.g. user wants to press "Control" key itself
        // For "Control" key itself, key: "Control", code: "ControlLeft" (or Right)
        if (mainKeyPart === 'ctrl' || mainKeyPart === 'control')
          return { key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers };
        if (mainKeyPart === 'alt') return { key: 'Alt', code: 'AltLeft', keyCode: 18, modifiers };
        if (mainKeyPart === 'shift')
          return { key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers };
        if (mainKeyPart === 'meta' || mainKeyPart === 'command' || mainKeyPart === 'cmd')
          return { key: 'Meta', code: 'MetaLeft', keyCode: 91, modifiers };
      } else {
        console.warn(`Invalid key combination string: ${keyString}. No main key specified.`);
        return null;
      }
    }

    const specialKey = SPECIAL_KEY_MAP[mainKeyPart];
    if (specialKey) {
      return { ...specialKey, modifiers };
    }

    // For single characters or other unmapped keys
    if (mainKeyPart.length === 1) {
      const charCode = mainKeyPart.charCodeAt(0);
      // If Shift is active and it's a letter, use the uppercase version for 'key'
      // This mimics more closely how keyboards behave.
      let keyChar = mainKeyPart;
      if (modifiers.shiftKey && mainKeyPart.match(/^[a-z]$/i)) {
        keyChar = mainKeyPart.toUpperCase();
      }

      return {
        key: keyChar,
        code: `Key${mainKeyPart.toUpperCase()}`, // 'a' -> KeyA, 'A' -> KeyA
        keyCode: charCode,
        charCode: charCode, // charCode is legacy, but some old systems might use it
        modifiers,
      };
    }

    // 키 이름이 아니면 텍스트 입력일 수 있다. 여기서 로그를 남기지 않고 null 을
    // 돌려주면 호출부(simulateKeyboard)가 리터럴 텍스트로 처리한다.
    return null;
  }

  /**
   * Simulates a single key press (keydown, (keypress), keyup) for a parsed key.
   * @param { {key: string, code: string, keyCode: number, charCode?: number, modifiers: object} } parsedKeyInfo
   * @param {Element} element - Target element.
   * @returns {{success: boolean, error?: string}}
   */
  function dispatchKeyEvents(parsedKeyInfo, element) {
    if (!parsedKeyInfo) return { success: false, error: 'Invalid key info provided for dispatch.' };

    const { key, code, keyCode, charCode, modifiers } = parsedKeyInfo;

    const eventOptions = {
      key: key,
      code: code,
      bubbles: true,
      cancelable: true,
      composed: true, // Important for shadow DOM
      view: window,
      ...modifiers, // ctrlKey, altKey, shiftKey, metaKey
      // keyCode/which are deprecated but often set for compatibility
      keyCode: keyCode || (key.length === 1 ? key.charCodeAt(0) : 0),
      which: keyCode || (key.length === 1 ? key.charCodeAt(0) : 0),
    };

    try {
      const kdRes = element.dispatchEvent(new KeyboardEvent('keydown', eventOptions));

      // keypress is deprecated, but simulate if it's a character key or Enter
      // Only dispatch if keydown was not cancelled and it's a character producing key
      if (kdRes && (key.length === 1 || key === 'Enter' || key === ' ')) {
        const keypressOptions = { ...eventOptions };
        if (charCode) keypressOptions.charCode = charCode;
        element.dispatchEvent(new KeyboardEvent('keypress', keypressOptions));
      }

      element.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
      return { success: true };
    } catch (error) {
      console.error(`Error dispatching key events for "${key}":`, error);
      return {
        success: false,
        error: `Error dispatching key events for "${key}": ${error.message}`,
      };
    }
  }

  // 긴 텍스트에 글자마다 delay 를 그대로 적용하면 도구 타임아웃을 넘긴다.
  // 토큰 하나가 이 예산을 넘지 않도록 글자당 지연을 줄인다.
  const TEXT_TYPING_BUDGET_MS = 3000;

  /**
   * Inserts literal text at the caret, the way typing would.
   * Uses the native value setter so framework-controlled inputs (React 등) see the change.
   * @param {Element} element - Target element.
   * @param {string} text - Text to insert.
   * @returns {boolean} Whether the text could be inserted.
   */
  function insertTextIntoElement(element, text) {
    const tagName = element.tagName;

    if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
      const proto =
        tagName === 'INPUT'
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      const currentValue = element.value == null ? '' : element.value;

      // number/email 등 일부 input 은 selectionStart 접근 자체가 예외를 던진다.
      let start;
      let end;
      try {
        start = element.selectionStart;
        end = element.selectionEnd;
      } catch (_) {
        start = null;
        end = null;
      }
      if (typeof start !== 'number') start = currentValue.length;
      if (typeof end !== 'number') end = currentValue.length;

      const nextValue = currentValue.slice(0, start) + text + currentValue.slice(end);
      if (descriptor && descriptor.set) descriptor.set.call(element, nextValue);
      else element.value = nextValue;

      const caret = start + text.length;
      try {
        element.setSelectionRange(caret, caret);
      } catch (_) {
        // 캐럿 위치를 지원하지 않는 input 타입은 무시한다.
      }
      return true;
    }

    if (element.isContentEditable) {
      if (document.execCommand('insertText', false, text)) return true;
      element.textContent = (element.textContent || '') + text;
      return true;
    }

    return false;
  }

  /**
   * Types literal text one character at a time, dispatching the key and input
   * events a real keystroke would produce.
   * @param {Element} element - Target element.
   * @param {string} text - Text to type.
   * @param {number} delay - Requested delay between keystrokes in ms.
   * @returns {Promise<{success: boolean, error?: string, typed?: number}>}
   */
  async function typeText(element, text, delay = 0) {
    const chars = Array.from(text);
    if (chars.length === 0) return { success: true, typed: 0 };

    const perChar = Math.max(0, Math.min(delay, Math.floor(TEXT_TYPING_BUDGET_MS / chars.length)));
    let typed = 0;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const charCode = ch.charCodeAt(0);
      const eventOptions = {
        key: ch,
        code: /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        keyCode: charCode,
        which: charCode,
      };

      const notCancelled = element.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
      if (notCancelled) {
        element.dispatchEvent(new KeyboardEvent('keypress', { ...eventOptions, charCode }));
        if (insertTextIntoElement(element, ch)) {
          typed++;
          element.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              composed: true,
              inputType: 'insertText',
              data: ch,
            }),
          );
        }
      }
      element.dispatchEvent(new KeyboardEvent('keyup', eventOptions));

      if (perChar > 0 && i < chars.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, perChar));
      }
    }

    if (typed === 0) {
      return {
        success: false,
        error:
          `Cannot type text into <${element.tagName.toLowerCase()}>: it is not an input, ` +
          `textarea, or contenteditable element. Pass a selector for the field, or use ` +
          `chrome_fill_or_select.`,
      };
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, typed };
  }

  /**
   * Simulate keyboard events on an element or document
   * @param {string} keysSequenceString - String representation of key(s) (e.g., "Enter", "Ctrl+C, A, B")
   * @param {Element} targetElement - Element to dispatch events on (optional)
   * @param {number} delay - Delay between key sequences in milliseconds (optional)
   * @returns {Promise<Object>} - Result of the keyboard operation
   */
  async function simulateKeyboard(keysSequenceString, targetElement = null, delay = 0) {
    try {
      const element = targetElement || document.activeElement || document.body;

      if (element !== document.activeElement && typeof element.focus === 'function') {
        element.focus();
        await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay for focus
      }

      const keyCombinations = keysSequenceString
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const operationResults = [];

      // 토큰을 먼저 전부 파싱한다. 하나도 키로 해석되지 않으면 쉼표까지 포함한
      // 원본 문자열 전체가 입력하려는 텍스트다 (예: "Hello, World").
      const parsedTokens = keyCombinations.map((combo) => ({
        combo,
        info: parseSingleKeyCombination(combo),
      }));
      const noTokenIsKey = parsedTokens.length > 0 && parsedTokens.every((t) => t.info === null);

      if (noTokenIsKey) {
        const typeResult = await typeText(element, keysSequenceString, delay);
        operationResults.push({ keyCombination: keysSequenceString, ...typeResult });
      } else {
        for (let i = 0; i < parsedTokens.length; i++) {
          const comboString = parsedTokens[i].combo;
          const parsedKeyInfo = parsedTokens[i].info;

          if (!parsedKeyInfo) {
            // 키 이름이 아닌 토큰은 리터럴 텍스트로 입력한다.
            const typeResult = await typeText(element, comboString, delay);
            operationResults.push({ keyCombination: comboString, ...typeResult });
          } else {
            const dispatchResult = dispatchKeyEvents(parsedKeyInfo, element);
            operationResults.push({
              keyCombination: comboString,
              ...dispatchResult,
            });

            if (dispatchResult.error) {
              console.warn(
                `Failed to simulate key combination "${comboString}": ${dispatchResult.error}`,
              );
            }
          }

          if (delay > 0 && i < parsedTokens.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Check if all individual operations were successful
      const overallSuccess = operationResults.every((r) => r.success);

      return {
        success: overallSuccess,
        message: overallSuccess
          ? `Keyboard events simulated successfully: ${keysSequenceString}`
          : `Some keyboard events failed for: ${keysSequenceString}`,
        results: operationResults, // Detailed results for each key combination
        targetElement: {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          type: element.type, // if applicable e.g. for input
        },
      };
    } catch (error) {
      console.error('Error in simulateKeyboard:', error);
      return {
        success: false,
        error: `Error simulating keyboard events: ${error.message}`,
        results: [],
      };
    }
  }

  // Listener for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'simulateKeyboard') {
      let targetEl = null;
      if (request.selector) {
        targetEl = document.querySelector(request.selector);
        if (!targetEl) {
          sendResponse({
            success: false,
            error: `Element with selector "${request.selector}" not found`,
            results: [],
          });
          return true; // Keep channel open for async response
        }
      }

      simulateKeyboard(request.keys, targetEl, request.delay)
        .then(sendResponse)
        .catch((error) => {
          // This catch is for unexpected errors in simulateKeyboard promise chain itself
          console.error('Unexpected error in simulateKeyboard promise chain:', error);
          sendResponse({
            success: false,
            error: `Unexpected error during keyboard simulation: ${error.message}`,
            results: [],
          });
        });
      return true; // Indicates async response is expected
    } else if (request.action === 'chrome_keyboard_ping') {
      sendResponse({ status: 'pong', initialized: true }); // Respond that it's initialized
      return false; // Synchronous response
    }
    // Not our message, or no async response needed
    return false;
  });
}
