// Dev-mode watcher: esbuild rebuilds dist/main.js on source changes; the Node process
// is killed and restarted after each successful build. No extra dependencies — esbuild
// is already a devDependency and child_process is built-in.
//
// Usage: node dev.mjs   (or via `pnpm dev` in this package)
// The UI dev server (Vite) runs separately on :5173 and proxies /rpc + /sidechannel to :7420.
import { spawn } from "node:child_process";

import * as esbuild from "esbuild";

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
