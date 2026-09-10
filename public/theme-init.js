(function () {
  var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var storedTheme = null;

  try {
    storedTheme = window.localStorage.getItem("ship-live-theme");
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }

  var theme =
    storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : prefersDark
        ? "dark"
        : "light";
  var root = document.documentElement;

  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#090c10" : "#f5f7f6");
})();
