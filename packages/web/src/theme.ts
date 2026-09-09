export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "pico-theme";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

export function readBootstrappedTheme(): Theme {
  for (const className of document.documentElement.classList) {
    if (isTheme(className)) {
      return className;
    }
  }

  try {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {}

  return "light";
}

export function applyThemePreference(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}
