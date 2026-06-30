# cbranch — Dependency License Manifest

`cbranch` is released under the **MIT License**. Every dependency that is
**bundled** (compiled into, shipped with, or otherwise distributed as part of the
`cbranch` artifacts) must carry a permissive license
(MIT / ISC / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / 0BSD / Unlicense) and must
**not** be copyleft (GPL / LGPL / AGPL / MPL / SSPL).

License fields below were verified against the public npm registry
(`https://registry.npmjs.org/<package>/latest`). The version column records the
release whose metadata was inspected; license terms are stable across the minor
and patch range used by `cbranch`.

---

## VERDICT

**All bundled dependencies are permissive and MIT-compatible. No copyleft
(GPL / LGPL / AGPL / MPL / SSPL) dependency was found.** No replacements are
required. Two dependencies (TypeScript and class-variance-authority) are
Apache-2.0 rather than MIT/ISC; Apache-2.0 is permissive and MIT-compatible, and
TypeScript is in any case a build-time-only dependency that is not shipped.

---

## Bundled dependencies

| Package | SPDX license | Permissive? | MIT-compatible? | Attribution / NOTICE required? | Source URL |
|---|---|---|---|---|---|
| react (19.2.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/facebook/react |
| react-dom (19.2.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/facebook/react |
| react-diff-view (3.3.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/otakustay/react-diff-view |
| codemirror (6.0.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/codemirror/dev |
| @codemirror/merge (6.12.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/codemirror/merge |
| @codemirror/view (6.43.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/codemirror/view |
| @codemirror/state (6.6.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/codemirror/state |
| shiki (4.2.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/shikijs/shiki |
| @tanstack/react-virtual (3.14.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/TanStack/virtual |
| @tanstack/react-query (5.101.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/TanStack/query |
| zustand (5.0.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/pmndrs/zustand |
| tailwindcss (4.3.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/tailwindlabs/tailwindcss |
| @tailwindcss/vite (4.3.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/tailwindlabs/tailwindcss |
| lucide-react (latest) | ISC | Yes | Yes | Yes — retain copyright + ISC text | https://github.com/lucide-icons/lucide |
| cmdk (1.1.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/pacocoursey/cmdk |
| effect (4.0.0-beta.92, pinned; provides `@effect/rpc`, http, socket under `effect/unstable/*`) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/Effect-TS/effect |
| @shikijs/codemirror (latest) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/shikijs/shiki |
| chokidar (4.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/paulmillr/chokidar |
| ws (8.21.x; the Node WebSocket impl used by Effect's socket layer) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/websockets/ws |
| vite (build-time) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/vitejs/vite |
| typescript (build-time) | Apache-2.0 | Yes | Yes | Yes — retain LICENSE + NOTICE if present | https://github.com/microsoft/TypeScript |
| oxlint (build-time) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/oxc-project/oxc |
| oxfmt (build-time, beta) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/oxc-project/oxc |

### shadcn/ui component approach (and its runtime dependencies)

shadcn/ui is **not** an installed/bundled runtime package. Its components are
distributed as source that is copied into `packages/ui` and owned by `cbranch`
(the `base-lyra` style on the **Base UI** base). The upstream component source is
published under the **MIT License** (https://github.com/shadcn-ui/ui), so copied
components may be relicensed/owned freely under cbranch's MIT license. What *does*
get bundled are the small runtime libraries those components import:

| Package | SPDX license | Permissive? | MIT-compatible? | Attribution / NOTICE required? | Source URL |
|---|---|---|---|---|---|
| @base-ui-components/react (Base UI v1, 1.x) | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/mui/base-ui |
| class-variance-authority (0.7.x) | Apache-2.0 | Yes | Yes | Yes — retain LICENSE + NOTICE if present | https://github.com/joe-bell/cva |
| clsx | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/lukeed/clsx |
| tailwind-merge | MIT | Yes | Yes | Yes — retain copyright + MIT text | https://github.com/dcastil/tailwind-merge |

> Compliance note: MIT/ISC/BSD require that the original copyright notice and
> license text travel with redistributed copies — ship a `THIRD-PARTY-NOTICES`
> bundle aggregating each license. Apache-2.0 additionally requires preserving any
> upstream `NOTICE` file contents when one is provided.

### Build-time tooling note — `lightningcss` (MPL-2.0)

The Tailwind v4 Vite plugin (`@tailwindcss/vite`, mandated by REQ-STACK-013) and
Vite both pull in **`lightningcss`** transitively, which is **MPL-2.0** (weak,
file-level copyleft). `lightningcss` is a **build-time-only** CSS transformer: it
runs during `vite build` and is **not** linked into, embedded in, or emitted as
part of the shipped browser bundle. MPL-2.0's file-level copyleft therefore does
not reach cbranch's MIT-licensed artifacts (no MPL-covered source is modified or
redistributed). It is consequently treated as an allowed **dev/build** license
(REQ-STACK-033), not a bundled one — the bundled-dependency verdict above is
unaffected. The license-audit gate (`scripts/license-audit.mjs`) enforces this
split: the strict permissive allow-list applies to the **production** tree, while
the **dev** allow-list adds only MPL-2.0 for this build-time tool. Strong copyleft
(GPL/LGPL/AGPL/SSPL) is rejected everywhere.

### Test-time tooling note — `MIT-0` (jsdom transitive CSS deps)

The component-test environment (`jsdom`, a **devDependency** used only by Vitest)
pulls in `@csstools/color-helpers` and `@csstools/css-syntax-patches-for-csstree`
transitively, both licensed **`MIT-0`** ("MIT No Attribution" — an OSI-approved
permissive license, strictly *more* permissive than MIT: it waives even the
attribution requirement). These run only in the test runner and are never bundled
into the shipped browser artifact. `MIT-0` is added to the permissive allow-list in
`scripts/license-audit.mjs` (it is non-copyleft and MIT-compatible); the bundled
verdict above is unaffected.

### Build-time tooling note — `caniuse-lite` (CC-BY-4.0)

The Vite / react-router dev tooling pulls in **`browserslist`** transitively, which
in turn depends on **`caniuse-lite`** — a browser-compatibility **data table**
licensed **CC-BY-4.0**. `caniuse-lite` is **build-time-only**: it is consulted
during `vite build` to resolve browser targets and is **not** linked into, embedded
in, or emitted as part of the shipped browser bundle. CC-BY-4.0's attribution terms
therefore do not reach cbranch's MIT-licensed artifacts. It is treated as an allowed
**dev/build** license (REQ-STACK-033), not a bundled one — the bundled-dependency
verdict above is unaffected. The license-audit gate (`scripts/license-audit.mjs`)
adds `CC-BY-4.0` to the **dev** allow-list only.

---

## External processes (arm's-length, NOT bundled)

`cbranch` invokes certain tools as **separate, independent command-line
processes** over the operating system's normal process boundary (spawning a child
process, passing arguments, reading stdout/stderr, and inspecting the exit code).
These tools are expected to be **already installed on the host** by the operator;
`cbranch` does **not** bundle, embed, statically or dynamically link, copy, fork,
or redistribute them, and does **not** incorporate any of their source code.

- **The host `git` binary (GPLv2).** Used for **all** Git operations — local
  read/index/commit/graph, network sync (fetch / pull / push), and everything
  else cbranch routes to the host tool (rebase including interactive, revert,
  cherry-pick, worktrees, blame, submodules, reflog, gc/maintenance, merges, and
  launching external merge tools). cbranch communicates with it only through git's
  documented command-line interface and documented output formats. (`clone` is out
  of scope; repositories are opened by existing on-disk path.)
- **kdiff3 or another external merge/diff tool (e.g. GPL-licensed).** Optionally
  launched by the user as an external merge tool. cbranch only starts the process
  and waits for it to finish; it ships no part of the tool.

**Why this does not impose copyleft on cbranch.** GPLv2/GPLv3 copyleft obligations
attach to *distributing a derivative work* of the covered program — for example
linking against it or shipping a modified copy. Running a separate, unmodified
program as an independent process and exchanging data with it across the
established command-line / process boundary is **mere aggregation / arm's-length
use**, not the creation or distribution of a derivative work. Because cbranch
neither distributes these tools nor links to their code, their GPL terms do not
extend to cbranch, and cbranch remains licensable under MIT. (cbranch should,
however, document that these external tools are separately licensed and are the
responsibility of the host operator to install.)

---

## How to regenerate this manifest

1. From a clean install, enumerate the production dependency tree
   (e.g. `pnpm licenses list --prod`).
2. For each package, read the `license` field from
   `https://registry.npmjs.org/<package>/latest`.
3. Confirm each is in the allowed set
   (MIT / ISC / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / 0BSD / Unlicense).
4. Fail the build if any production dependency reports a copyleft license
   (GPL / LGPL / AGPL / MPL / SSPL) or an unrecognized/`UNLICENSED` value.
