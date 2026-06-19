import { version as contractVersion } from "@cbranch/rpc-contract";

import { Button } from "./components/ui/button";

// P0 placeholder shell. Imports @cbranch/rpc-contract at runtime to exercise the
// ui -> rpc-contract dependency edge end to end (resolution + bundling). The real
// Resizable layout, cmdk palette, history/graph, and diff surfaces land in P1.
export function App() {
  return (
    <main className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">cbranch</h1>
      <p className="text-muted-foreground text-sm">rpc-contract {contractVersion}</p>
      <Button>Open repository</Button>
    </main>
  );
}
