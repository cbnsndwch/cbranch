# Repository Guidelines

## Project Structure & Module Organization

cbranch is a browser-based Git GUI: the host service performs Git operations and the UI communicates over typed RPC. Workspace packages live in `packages/` and applications in `apps/`:

- `packages/rpc-contract/`: shared RPC schemas and transport adapter; the wire-contract source.
- `packages/core/`: transport-agnostic `GitEngine` and all host Git orchestration.
- `packages/ui/`: React SPA, components, client state, and browser tests.
- `apps/web-server/`: Node host service and static bundle server.
- `apps/vscode-ext/`: VS Code webview scaffold.

Specifications in `docs/spec/` are authoritative; consult `14-rpc-contract.md` for RPC changes and `02-architecture.md` for cross-cutting design. Keep tests beside source as `*.test.ts` or `*.test.tsx`.

## Build, Test, and Development Commands

Use Node 20+ and pnpm 11 (see `packageManager`). Run commands from the repository root.

```bash
pnpm install           # install the full workspace
pnpm dev               # build libraries and start UI/server development processes
pnpm build             # build all workspace packages
pnpm test              # run the standard Vitest suite
pnpm test:browser      # run browser-mode component tests
pnpm typecheck         # check production and test TypeScript
pnpm lint              # run oxlint
pnpm format            # format with oxfmt
pnpm gate              # run the complete CI-quality gate
```

For focused work, use `pnpm vitest run packages/core/src/git/merge.test.ts` or add `-t "test name"`.

## Coding Style & Naming Conventions

Write TypeScript with 2-space indentation, double quotes, semicolons, trailing commas, and an 80-character print width; `oxfmt` enforces these rules. Do not add ESLint or Prettier. Name source modules in kebab-case (for example, `git-engine.ts`) and tests with the matching `*.test.ts(x)` suffix.

Preserve package boundaries: only `core` runs Git, only `web-server` opens listening sockets, and `rpc-contract` is shared unchanged by client and server. UI server data belongs in React Query; Zustand is only for ephemeral view state.

## Testing Guidelines

Use Vitest. Prefer real temporary repositories from `packages/core/src/testing/fixtures.ts` for Git-engine tests. React tests requiring a DOM declare `// @vitest-environment jsdom`; use browser-mode tests when real DOM behavior matters. Coverage must remain at least 80% for `core` and `rpc-contract`; run `pnpm coverage` when changing either.

## Commit & Pull Request Guidelines

Follow Conventional Commit-style subjects seen in history: `feat(ui): add filters`, `fix(core): handle detached HEAD`, or `docs: update run guide`. Keep commits focused. PRs should describe behavior and tests, link the relevant issue/spec requirement, and include screenshots for visible UI changes. Run `pnpm gate` before requesting review.
