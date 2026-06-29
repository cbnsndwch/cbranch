// Dev-mode watcher: esbuild rebuilds dist/main.js on source changes; the Node process
// is killed and restarted after each successful build. No extra dependencies — esbuild
// is already a devDependency and child_process is built-in.
//
// Usage: node dev.mjs   (or via `pnpm dev` in this package)
// The UI dev server (Vite) runs separately on :5173 and proxies /rpc + /sidechannel to :7420.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

// Copy the interactive-rebase sequence-editor shim next to the bundle on every build
// (esbuild won't bundle a `.mjs` asset resolved via `import.meta.url`). Kept in lockstep
// with `build.mjs` and `defaultShimPath()` in packages/core (S8; REQ-P5-IR-008).
const copyRebaseShim = () => {
  const src = fileURLToPath(
    new URL(
      "../../packages/core/src/git/shims/rebase-seq-editor.mjs",
      import.meta.url,
    ),
  );
  const dest = fileURLToPath(
    new URL("./dist/shims/rebase-seq-editor.mjs", import.meta.url),
  );
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  writeFileSync(fileURLToPath(new URL("./dist/.bundled", import.meta.url)), "");
};

let server = null;

const restart = () => {
  if (server) {
    server.kill("SIGTERM");
    server = null;
  }
  server = spawn(process.execPath, ["dist/main.js"], {
    stdio: "inherit",
    env: process.env,
  });
  server.on("exit", (code, signal) => {
    if (signal !== "SIGTERM" && signal !== "SIGKILL") {
      console.error(`[web-server] process exited (code ${code})`);
    }
  });
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // Keep the same externals as build.mjs — effect ships Node-ready ESM; inline workspace pkgs.
  external: [
    "effect",
    "effect/*",
    "@effect/platform-node",
    "@effect/platform-node/*",
  ],
  plugins: [
    {
      name: "restart-on-build",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            copyRebaseShim();
            console.log("[web-server] rebuilt — restarting…");
            restart();
          }
        });
      },
    },
  ],
});

await ctx.watch();
console.log("[web-server] watching src/**  (Ctrl-C to stop)");

const shutdown = () => {
  ctx.dispose().catch(() => {});
  if (server) server.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
