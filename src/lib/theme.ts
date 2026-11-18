// The colour theme is the `dark` class on <html>. It follows the system's
// prefers-color-scheme until the user picks one with the toggle.
import { create } from "zustand";

export type Theme = "light" | "dark";

interface ThemeState {
  /** What the user picked; null while the system decides. */
  chosen: Theme | null;
  /** The theme in effect. */
  theme: Theme;
}

const query = "(prefers-color-scheme: dark)";
const system = (): Theme => (window.matchMedia(query).matches ? "dark" : "light");

export const useTheme = create<ThemeState>(() => ({ chosen: null, theme: "light" }));

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  useTheme.setState({ theme });
}

export function followSystemTheme(): () => void {
  const media = window.matchMedia(query);
  const onChange = () => {
    if (useTheme.getState().chosen === null) apply(system());
  };
  onChange();
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Switches to the other theme, and stops following the system. */
export function toggleTheme(): void {
  const next: Theme = useTheme.getState().theme === "dark" ? "light" : "dark";
  useTheme.setState({ chosen: next });
  apply(next);
}
