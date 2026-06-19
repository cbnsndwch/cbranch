import { useUiStore } from "./state/store";

// ui-A shell placeholder: providers (React Query + host API + theme) are wired in
// `main.tsx`; this renders a minimal themed surface to confirm the data/theme infra is
// live. The real Resizable layout, cmdk switcher, history/graph, details, and diff
// surfaces land in the ui-B/C/D milestones.
export function App() {
  const theme = useUiStore((s) => s.theme);
  return (
    <main className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-3">
      <h1 className="text-2xl font-semibold">cbranch</h1>
      <p className="text-muted-foreground text-sm">Connecting to the host service…</p>
      <p className="text-muted-foreground text-xs">theme: {theme}</p>
    </main>
  );
}
