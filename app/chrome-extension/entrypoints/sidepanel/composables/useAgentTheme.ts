/**
 * Composable for managing AgentChat theme.
 * Handles theme persistence and application.
 */
import { ref, type Ref } from 'vue';

/**
 * Available theme identifiers.
 *
 * The panel used to ship 7 themes (toss-light, warm-editorial,
 * blueprint-architect, zen-journal, neo-pop, dark-console, swiss-grid).
 * All but toss-light were removed 2026-09-06 - there is no theme picker in
 * the panel, so the other 6 were unreachable dead weight. The type stays
 * narrowed to the one surviving id; nothing outside this file references
 * an old id as a literal (checked via grep across entrypoints and tests),
 * so narrowing it doesn't break any importer.
 */
export type AgentThemeId = 'toss-light';

/** Storage key for persisting theme preference */
const STORAGE_KEY_THEME = 'agentTheme';

/** Default theme when none is set */
const DEFAULT_THEME: AgentThemeId = 'toss-light';

/** Valid theme IDs for validation */
const VALID_THEMES: AgentThemeId[] = ['toss-light'];

/** Theme display names for UI */
export const THEME_LABELS: Record<AgentThemeId, string> = {
  'toss-light': 'Toss',
};

export interface UseAgentTheme {
  /** Current theme ID */
  theme: Ref<AgentThemeId>;
  /** Whether theme has been loaded from storage */
  ready: Ref<boolean>;
  /** Set and persist a new theme */
  setTheme: (id: AgentThemeId) => Promise<void>;
  /** Load theme from storage (call on mount) */
  initTheme: () => Promise<void>;
  /** Apply theme to a DOM element */
  applyTo: (el: HTMLElement) => void;
  /** Get the preloaded theme from document (set by main.ts) */
  getPreloadedTheme: () => AgentThemeId;
}

/**
 * Check if a string is a valid theme ID
 */
function isValidTheme(value: unknown): value is AgentThemeId {
  return typeof value === 'string' && VALID_THEMES.includes(value as AgentThemeId);
}

/**
 * Is this a stored value we should honour?
 *
 * With only `toss-light` left, this is the same check as `isValidTheme` -
 * any value written by an older build (warm-editorial, blueprint-architect,
 * zen-journal, neo-pop, dark-console, swiss-grid) or anything else no
 * longer valid is treated as "never chose one" and falls through to
 * `DEFAULT_THEME` below, same as a fresh install. A person's storage can
 * still literally hold an old id (nothing here deletes it) - it's just
 * never honoured, so the panel always renders toss-light regardless of
 * what chrome.storage.local has.
 */
function isHonouredStoredTheme(value: unknown): value is AgentThemeId {
  return isValidTheme(value);
}

/**
 * Get theme from document element (preloaded by main.ts)
 */
function getThemeFromDocument(): AgentThemeId {
  const value = document.documentElement.dataset.agentTheme;
  return isValidTheme(value) ? value : DEFAULT_THEME;
}

/**
 * Composable for managing AgentChat theme
 */
export function useAgentTheme(): UseAgentTheme {
  // Initialize with preloaded theme (or default)
  const theme = ref<AgentThemeId>(getThemeFromDocument());
  const ready = ref(false);

  /**
   * Load theme from chrome.storage.local
   */
  async function initTheme(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_THEME);
      const stored = result[STORAGE_KEY_THEME];

      if (isHonouredStoredTheme(stored)) {
        theme.value = stored;
      } else {
        // Use preloaded or default
        theme.value = getThemeFromDocument();
      }
    } catch (error) {
      console.error('[useAgentTheme] Failed to load theme:', error);
      theme.value = getThemeFromDocument();
    } finally {
      ready.value = true;
    }
  }

  /**
   * Set and persist a new theme
   */
  async function setTheme(id: AgentThemeId): Promise<void> {
    if (!isValidTheme(id)) {
      console.warn('[useAgentTheme] Invalid theme ID:', id);
      return;
    }

    // Update immediately for responsive UI
    theme.value = id;

    // Also update document element for consistency
    document.documentElement.dataset.agentTheme = id;

    // Persist to storage
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_THEME]: id });
    } catch (error) {
      console.error('[useAgentTheme] Failed to save theme:', error);
    }
  }

  /**
   * Apply theme to a DOM element
   */
  function applyTo(el: HTMLElement): void {
    el.dataset.agentTheme = theme.value;
  }

  /**
   * Get the preloaded theme from document
   */
  function getPreloadedTheme(): AgentThemeId {
    return getThemeFromDocument();
  }

  return {
    theme,
    ready,
    setTheme,
    initTheme,
    applyTo,
    getPreloadedTheme,
  };
}

/**
 * Preload theme before Vue mounts (call in main.ts)
 * This prevents theme flashing on page load.
 */
export async function preloadAgentTheme(): Promise<AgentThemeId> {
  let themeId: AgentThemeId = DEFAULT_THEME;

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_THEME);
    const stored = result[STORAGE_KEY_THEME];

    if (isHonouredStoredTheme(stored)) {
      themeId = stored;
    }
  } catch (error) {
    console.error('[preloadAgentTheme] Failed to load theme:', error);
  }

  // Set on document element for immediate application
  document.documentElement.dataset.agentTheme = themeId;

  return themeId;
}
