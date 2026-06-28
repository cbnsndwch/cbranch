import { Monitor, Moon, Sun } from "lucide-react";

import { useUiStore } from "../state/store";
import { type ThemePref } from "../theme/theme";

const CYCLE: ReadonlyArray<ThemePref> = ["system", "light", "dark"];

// Light/dark/system cycle (NF-THEME-2 + NF-UX-6). Persisted via the store/theme module.
export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const next = () =>
    setTheme(CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length]!);
  return (
    <button
      type="button"
      onClick={next}
      aria-label={`Theme: ${theme}`}
      title={`Theme: ${theme}`}
      className="border-0 p-1.5"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
