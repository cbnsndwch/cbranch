# cbranch — Branding & Identity Guide

## Product name & positioning

**cbranch**

> A cross-platform, browser-based Git GUI for developers working on remote Linux and macOS hosts — visually manage one repository at a time, over an SSH tunnel, with the speed of a native client.

Style rules for the name:
- Always lowercase: `cbranch`. Do not capitalize as "Cbranch" or "CBranch" in body text.
- At the start of a sentence or in a title, "cbranch" may stay lowercase by design; if a context forces an initial capital, prefer rephrasing so the name stays lowercase.
- Never split or hyphenate ("c-branch", "c branch").
- The name is a noun referring to the product. Avoid using it as a verb in marketing copy.

---

## Package & namespace naming

All published packages live under the `@cbranch` npm scope. The monorepo (pnpm workspaces) uses these identifiers consistently:

| Workspace path             | Package name              | Role                                                            |
| -------------------------- | ------------------------- | --------------------------------------------------------------- |
| `packages/core`            | `@cbranch/core`           | Transport-agnostic Git orchestration (the `GitEngine`).         |
| `packages/rpc-contract`    | `@cbranch/rpc-contract`   | Typed RPC definitions + the transport interface.                |
| `packages/ui`              | `@cbranch/ui`             | React 19 + shadcn/ui + Tailwind v4 component library and views. |
| `apps/web-server`          | `@cbranch/web-server`     | Node host service (Effect platform HTTP/WebSocket), runs on the host.     |
| `apps/vscode-ext`          | `@cbranch/vscode-ext`     | VSCode webview extension (later track).                         |

Naming conventions:
- npm scope: `@cbranch/*` (reserve the scope early).
- Internal-only packages that are never published set `"private": true` and still use the `@cbranch/` scope for import consistency.
- Public-facing identifiers below are distinct from package names:
  - **Web app id** (used for the served app, session storage keys, and the document/window title): `cbranch` (display title: `cbranch`). Suggested config/storage key prefix: `cbranch.` (e.g. `cbranch.ui.theme`).
  - **VSCode extension id**: publisher + name → `cbranch.cbranch-vscode` (marketplace name `cbranch-vscode`, displayed as **cbranch**). Extension contribution command prefix: `cbranch.*` (e.g. `cbranch.openRepository`, `cbranch.switchRepository`). View container id: `cbranch`.
- CLI/launcher binary (if/when one ships to start the web server): `cbranch`.
- Default local bind for the web server: `127.0.0.1` on a configurable port; the served origin is treated as the app's canonical origin for Origin checks.

---

## Icon strategy

Two distinct layers, kept strictly separate:

### 1. UI glyphs — Lucide (already in the stack)
- Use the **Lucide** icon set (ISC-licensed, already a stack dependency) for all in-product glyphs: toolbar actions, status indicators, file-tree nodes, menu items, branch/commit/tag/stash markers, sync arrows, conflict markers, etc.
- Prefer Lucide's existing Git-adjacent glyphs (branch, merge, commit/dot, arrows for ahead/behind, etc.) so the visual language stays consistent and license-clean.
- Do not embed or trace icon art from any other Git GUI. If a needed glyph is missing from Lucide, either compose it from Lucide primitives or commission an original SVG that matches Lucide's stroke style (2px stroke, rounded joins, 24×24 grid) and license it permissively.
- Keep icons monochrome and driven by `currentColor` so they inherit theme colors automatically.

### 2. Product logo — original, commissioned
cbranch needs its **own original logo**. It must not reuse, trace, or adapt any predecessor product's logo or mark. Direction (open to the designer):

- **Concept**: a "branch" motif built from the letter **c** — e.g. an open, rounded `c` whose terminal opens into two diverging strokes (a fork/branch point), reading simultaneously as the letter and as a version-control branch.
- **Construction**: single-weight rounded strokes that echo the Lucide line aesthetic so the mark and the in-app glyphs feel related without being identical.
- **Forms to deliver**:
  - Full lockup: mark + lowercase wordmark `cbranch`.
  - Mark-only (square) for favicons, app/extension icon, and the VSCode activity-bar entry.
  - Monochrome variant (single color, works on light and dark).
- **Formats**: master as SVG (vector); export PNG raster at 16, 32, 48, 128, 256, 512 px; provide an `.ico`/multi-size set for favicon and a 128×128 PNG for the VSCode Marketplace icon.
- **Clear space & min size**: maintain clear space equal to the height of the `c` bowl around the mark; minimum legible mark size 16px.
- **Don'ts**: no gradients-as-identity (a single accent color should carry the brand), no drop shadows in the canonical mark, no skeuomorphic Git "tree" clip-art.

The logo is a brand asset; store the source under a dedicated `assets/brand/` (or similar) location and treat it as not-for-modification by third parties beyond the rights granted by the project license.

---

## Color & theme (shadcn CSS variables)

cbranch uses **shadcn/ui (`base-lyra` on Base UI)** tokens over **Tailwind v4**. Theme is expressed entirely as CSS custom properties so the same components serve web and the VSCode webview.

### Token model
Define the standard shadcn semantic variables for both light and dark, plus one brand accent. Recommended approach:

- Light is the default at `:root`; dark is applied via a `.dark` class on the root element.
- One **brand accent** drives the primary action color and selection highlights. Pick a single distinctive hue for cbranch (e.g. a teal/green family that reads as "branch/growth") and define it as the `--primary` source; derive hover/active and ring tones from it. The exact hex is a design decision — define it once as a brand token and map `--primary`/`--ring` to it so it can be retuned in one place.

Variables to define (light + dark): `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`, `--radius`, and chart/sidebar tokens as needed.

In addition, define **domain tokens** for Git-specific UI so diffs, the graph, and status colors are themeable and not hardcoded:
- Diff: `--diff-add`, `--diff-add-foreground`, `--diff-remove`, `--diff-remove-foreground`, `--diff-context`, `--diff-word-add`, `--diff-word-remove`.
- Status/sync: `--status-ahead`, `--status-behind`, `--status-conflict`, `--status-staged`, `--status-unstaged`, `--status-untracked`, `--status-ignored`.
- Graph: a small ordered palette (`--graph-1` … `--graph-n`) for branch lanes, chosen to stay distinguishable in both light and dark and to be color-vision-deficiency friendly.

```css
/* illustrative shape only — exact values are a design decision */
:root {
  --radius: 0.5rem;
  --brand: oklch(...);            /* single source of truth for the accent */
  --background: oklch(...);
  --foreground: oklch(...);
  --primary: var(--brand);
  --primary-foreground: oklch(...);
  --ring: var(--brand);
  /* …remaining shadcn tokens… */
  --diff-add: oklch(...);
  --diff-remove: oklch(...);
  --status-ahead: oklch(...);
  --status-behind: oklch(...);
  --graph-1: oklch(...);
  --graph-2: oklch(...);
}
.dark {
  --background: oklch(...);
  --foreground: oklch(...);
  /* …dark overrides for every token above… */
}
```

### Mapping to the editor theme in the extension
When running as a VSCode webview, cbranch must feel native to the user's chosen editor theme. The webview exposes the editor's theme variables (the `--vscode-*` CSS custom properties injected into the webview, plus the `vscode-light` / `vscode-dark` / `vscode-high-contrast` body class). Map shadcn tokens onto editor tokens so the UI follows the active editor theme automatically:

- Detect light/dark/high-contrast from the body class and set/remove the `.dark` class accordingly.
- Map core tokens to editor equivalents, for example:
  - `--background` ← editor background; `--foreground` ← editor foreground.
  - `--card`/`--popover` ← elevated/widget surfaces; `--border` ← widget/panel border.
  - `--primary` ← either the cbranch brand accent (keep brand identity) **or** the editor accent (full theme fidelity) — choose one policy and apply it consistently; default to the editor accent for buttons/links so the webview blends in, while reserving the cbranch brand accent for the logo and empty-state art.
  - `--muted-foreground` ← editor description/disabled foreground.
  - Diff tokens ← the editor's diff insert/remove colors so diffs match the editor's own diff view.
  - `--destructive` ← editor error foreground.
- React to live theme changes (the webview is re-themed without reload) by re-reading the mapping when the editor theme changes.
- In the standalone web app there are no `--vscode-*` variables, so the shadcn light/dark tokens defined above are authoritative; the user toggles light/dark (and may follow OS `prefers-color-scheme`).

---

## About box & attribution (MIT release)

cbranch is released under the **MIT License**. The application must surface license and attribution information from an **About** panel (web) and an equivalent **About cbranch** command/view (extension).

The About panel must display:
1. **Product identity**: `cbranch`, the logo/mark, the version string, and the git build/commit if available.
2. **cbranch's own MIT notice**: the full MIT copyright line and permission text for the cbranch project.
3. **Bundled third-party notices**: a complete, generated list of bundled runtime dependencies with each dependency's name, version, license identifier (SPDX), and full license text. This must include:
   - Permissive licenses that require notice retention (MIT, ISC, BSD-2/3-Clause) — reproduce their copyright + permission text.
   - **Apache-2.0 dependencies** — reproduce the Apache-2.0 license text **and** any bundled `NOTICE` file contents verbatim (Apache-2.0 §4(d) requires preserving NOTICE attributions).
   - The **Lucide** icon set license (ISC) and any other asset licenses.
4. **Links**: project homepage/repository and the license page.

Operational requirements:
- Generate the third-party notices automatically at build time from the dependency tree (a license-aggregation step in CI), producing a `THIRD-PARTY-NOTICES` artifact that the About panel renders. Do not hand-maintain the list.
- Ship the aggregated notices file alongside distributed builds (web bundle and the `.vsix`), and include `LICENSE` (MIT) at the repo root.
- The About content must be present in both the web app and the extension; the extension may also contribute its license to the standard VSCode extension details page, but the in-app About panel remains the canonical attribution surface.
- Keep attribution copy free of any claim of affiliation with, or endorsement by, the authors of any bundled dependency.

---

## DO NOT REUSE

cbranch is an original product with **no predecessor**. The following are strictly prohibited in any cbranch artifact (source, assets, UI, docs, store listings, marketing):

- **Predecessor/competitor product names** — do not name, reference, imply continuity with, or compare cbranch to any other Git GUI or VCS client. No "like X", "successor to X", "X-compatible" claims.
- **Logos and marks** — do not reuse, trace, recolor, or adapt any other product's logo, app icon, or brand mark. The cbranch logo must be original (see Icon strategy).
- **Icon art** — do not copy icon artwork from any other Git GUI. UI glyphs come only from Lucide (or original, permissively-licensed SVGs in Lucide's style).
- **Translation / string resources** — do not copy localized strings, message catalogs, `.po`/`.resx`/`.json` translation files, or wording lifted from another product's UI. Author all user-facing strings fresh; localize from cbranch's own source strings.
- **Distinctive visual assets** — do not reuse another product's color schemes presented as their brand identity, splash/empty-state illustrations, screenshots, animations, sound assets, or layout art that functions as that product's trade dress.
- **Distinctive copy & taglines** — do not copy another product's slogans, About text, help text, or onboarding wording.

When in doubt, create it originally or source it from a clearly permissive license whose terms are satisfied in the About attribution. Everything shipped must trace to either original work or a license cbranch complies with.
