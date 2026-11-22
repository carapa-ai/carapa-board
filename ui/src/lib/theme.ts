import { useEffect, useState } from 'react';

/**
 * The single place that reads, writes and applies the appearance preference.
 * The preference is stored per device in localStorage (not in the server
 * account preferences) so it can be applied before the first paint — the
 * blocking inline script in ui/index.html mirrors this logic and runs before
 * the bundle loads, so there is no flash of the wrong theme.
 */

/** Stored preference. `system` follows the OS setting live. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** The theme actually painted: the preference with `system` resolved. */
export type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'carapa-theme';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function getThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(saved) ? saved : 'system';
  } catch {
    // localStorage can be unavailable (private mode, blocked storage)
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_SCHEME_QUERY).matches
  );
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemPrefersDark() ? 'dark' : 'light';
}

/**
 * Paint a preference: set the `dark`/`light` class and `color-scheme` on
 * <html> (the token palettes in global.css key off those classes). Returns
 * the resolved theme.
 */
function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
  return resolved;
}

type ThemeListener = () => void;
const listeners = new Set<ThemeListener>();
let mediaListenerInstalled = false;

function emitThemeChange(): void {
  for (const listener of listeners) listener();
}

// In `system` mode the app follows OS theme changes live.
function installMediaListener(): void {
  if (
    mediaListenerInstalled ||
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return;
  }
  mediaListenerInstalled = true;
  window.matchMedia(DARK_SCHEME_QUERY).addEventListener('change', () => {
    if (getThemePreference() !== 'system') return;
    applyTheme('system');
    emitThemeChange();
  });
}

/** Apply the stored preference and start following OS changes in system mode. */
export function initTheme(): void {
  applyTheme(getThemePreference());
  installMediaListener();
}

/** Persist the preference for this device and apply it immediately. */
function setThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable: still apply for this session.
  }
  applyTheme(preference);
  emitThemeChange();
}

/** React hook for components that need the preference or the resolved theme. */
export function useTheme(): {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    getThemePreference(),
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(getThemePreference()),
  );

  useEffect(() => {
    installMediaListener();
    const onChange = () => {
      const next = getThemePreference();
      setPreferenceState(next);
      setResolvedTheme(applyTheme(next));
    };
    listeners.add(onChange);
    onChange();
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return { preference, resolvedTheme, setPreference: setThemePreference };
}
