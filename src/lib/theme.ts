export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "ship-live-theme";

export function resolveTheme(
  stored: string | null,
  prefersDark: boolean,
): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function loadTheme(
  readStoredTheme: () => string | null,
  prefersDark: boolean,
): Theme {
  try {
    return resolveTheme(readStoredTheme(), prefersDark);
  } catch {
    return resolveTheme(null, prefersDark);
  }
}

export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

export function themeColor(theme: Theme): string {
  return theme === "dark" ? "#090c10" : "#f5f7f6";
}

type ThemeRoot = {
  dataset: { theme?: string };
  style: { colorScheme: string };
};

export function applyTheme(theme: Theme, root: ThemeRoot): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function saveTheme(
  theme: Theme,
  writeTheme: (key: string, value: string) => void,
): boolean {
  try {
    writeTheme(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
