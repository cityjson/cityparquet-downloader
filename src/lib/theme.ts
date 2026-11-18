// The colour theme is the `dark` class on <html>. Until the user picks one, it follows
// the system's prefers-color-scheme.
const query = "(prefers-color-scheme: dark)";

export function followSystemTheme(): () => void {
  const media = window.matchMedia(query);
  const apply = () => document.documentElement.classList.toggle("dark", media.matches);
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
