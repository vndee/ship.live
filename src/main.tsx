import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/dm-sans";
import "./styles.css";
import "./leaderboard.css";
import "./dashboard-pulse.css";
import {
  applyTheme,
  loadTheme,
  themeColor,
  THEME_STORAGE_KEY,
} from "./lib/theme";

const initialTheme = loadTheme(
  () => window.localStorage.getItem(THEME_STORAGE_KEY),
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);
applyTheme(initialTheme, document.documentElement);
document
  .querySelector('meta[name="theme-color"]')
  ?.setAttribute("content", themeColor(initialTheme));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
