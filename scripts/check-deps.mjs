#!/usr/bin/env node
// Dependency-direction gate (REQ-ARCH-007 / DECISIONS D10).
//
// Fails if:
//   1. any workspace package declares an internal (@cbranch/*) dependency outside
//      its allowed set (acyclic, layered direction), OR
//   2. any package OTHER THAN @cbranch/web-server declares a server/socket library
//      (the web-server is the only package allowed to open a listening socket).
//
// This inspects DIRECT declarations in each package.json (dependencies,
// devDependencies, peerDependencies). It does not walk transitive deps — the
// architectural contract is about what a package *declares* it depends on.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Allowed internal edges, keyed by package name.
// rpc-contract -> nothing; core -> rpc-contract (types only); ui -> rpc-contract;
// web-server -> core + rpc-contract; vscode-ext -> ui + rpc-contract + core.
const ALLOWED_INTERNAL = {
  "@cbranch/rpc-contract": new Set([]),
  "@cbranch/core": new Set(["@cbranch/rpc-contract"]),
  "@cbranch/ui": new Set(["@cbranch/rpc-contract"]),
  "@cbranch/web-server": new Set(["@cbranch/core", "@cbranch/rpc-contract"]),
  "@cbranch/vscode-ext": new Set(["@cbranch/ui", "@cbranch/rpc-contract", "@cbranch/core"]),
};

// Server / listening-socket libraries. Only @cbranch/web-server may declare these.
const SERVER_SOCKET_LIBS = new Set([
  "ws",
  "uWebSockets.js",
  "socket.io",
  "engine.io",
  "sockjs",
  "fastify",
  "express",
  "koa",
  "@koa/router",
  "hapi",
  "@hapi/hapi",
  "restify",
  "polka",
  "connect",
  "micro",
  "http-server",
  "serve",
  "h3",
  "node-http-server",
]);

const WORKSPACE_GLOBS = ["packages", "apps"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectPackages() {
  const out = [];
  for (const top of WORKSPACE_GLOBS) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(base, entry.name, "package.json");
      if (existsSync(pkgPath)) out.push({ dir: `${top}/${entry.name}`, pkg: readJson(pkgPath) });
    }
  }
  return out;
}

function depNames(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

const violations = [];
const packages = collectPackages();

for (const { dir, pkg } of packages) {
  const name = pkg.name;
  const all = depNames(pkg);

  // (1) internal direction
  const allowed = ALLOWED_INTERNAL[name];
  if (!allowed) {
    violations.push(`${dir}: unknown workspace package name "${name}" (not in the allowed-direction map).`);
  } else {
    for (const dep of all) {
      if (dep.startsWith("@cbranch/") && dep !== name && !allowed.has(dep)) {
        violations.push(
          `${dir} (${name}): forbidden internal dependency "${dep}". Allowed: [${[...allowed].join(", ") || "none"}].`,
        );
      }
    }
  }

  // (2) server/socket libraries restricted to web-server
  if (name !== "@cbranch/web-server") {
    for (const dep of all) {
      if (SERVER_SOCKET_LIBS.has(dep)) {
        violations.push(
          `${dir} (${name}): declares server/socket library "${dep}". Only @cbranch/web-server may open a listening socket (REQ-ARCH-005/007).`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Dependency-direction check FAILED:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("");
  process.exit(1);
}

console.log(`Dependency-direction check passed (${packages.length} workspace packages).`);
