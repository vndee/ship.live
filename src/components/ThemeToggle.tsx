import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import {
  applyTheme,
  loadTheme,
  nextTheme,
  saveTheme,
  themeColor,
  THEME_STORAGE_KEY,
  type Theme,
} from "../lib/theme";

function browserTheme(): Theme {
  return loadTheme(
    () => window.localStorage.getItem(THEME_STORAGE_KEY),
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(browserTheme);
  const destination = nextTheme(theme);

  function toggle() {
    applyTheme(destination, document.documentElement);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", themeColor(destination));
    saveTheme(destination, (key, value) =>
      window.localStorage.setItem(key, value),
    );
    setTheme(destination);
  }

  return (
    <button
      className="icon-button theme-toggle"
      aria-label={`Switch to ${destination} theme`}
      title={`Switch to ${destination} theme`}
      onClick={toggle}
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
