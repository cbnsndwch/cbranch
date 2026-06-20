# cbranch Web UI — Desktop-Style Layout Spec

This document specifies the **desktop-style history layout** cbranch should adopt for its primary
"browse history" screen. It is written as a forward design target for the coding agent: implement this
layout directly. No external screenshots or reference apps are required — every needed dimension, color,
and structural relationship is described here.

## Design intent

cbranch's primary screen is a **dense, productivity-focused git history UI** modeled on the ergonomics of
a native desktop git client, not a modern SaaS dashboard. The feel we want: compact controls, thin
borders, dense rows, small icons, pale grays, and very little wasted space. Information density is a
feature — power users scan large histories quickly and expect a lot on screen at once.

The screen is divided into four major zones:

1. **Top application chrome** (title strip, menu bar, toolbar)
2. **Left repository tree / sidebar**
3. **Main commit history table**
4. **Bottom details panel** for the selected commit

The current in-progress web layout is closer to a generic split-pane git log. The changes below move it
toward the dense, paneled, desktop feel.

---

## 1. Overall shell

The app fills the entire viewport. A fixed-height top chrome area sits above a two-column body:

```txt
┌──────────────────────────────────────────────────────────────┐
│ Title / menu / toolbar / path / filter chrome                │
├───────────────┬──────────────────────────────────────────────┤
│ Left sidebar  │ Main area                                    │
│ repo tree     │ ┌──────────────────────────────────────────┐ │
│               │ │ Commit history table                     │ │
│               │ ├──────────────────────────────────────────┤ │
│               │ │ Selected commit detail panel             │ │
│               │ └──────────────────────────────────────────┘ │
└───────────────┴──────────────────────────────────────────────┘
```

Approximate proportions:

```css
--top-chrome-height: 82px;
--left-sidebar-width: 265px;
--commit-list-height: 520px; /* flexible; roughly the top 55% of the remaining area */
--details-height: remaining;
```

At 1920px wide, the left sidebar is about **260px**; the main content begins around x=270.

---

## 2. Top application chrome

Three compact horizontal bands.

### 2.1 Title strip

Very top, native-window style. Show the active repo and branch, then the product name:

```txt
feat/p0-p1-walking-skeleton — cbranch
```

Height: about 26px. White/off-white background. Small black left-aligned text. If you are rendering inside
a browser tab (not faking native window chrome), you may omit OS window controls.

### 2.2 Menu bar

Directly under the title strip. A suggested top-level menu taxonomy for a git GUI:

```txt
Start | Repository | Navigate | View | Commands | GitHub | Plugins | Tools | Help
```

Height: about 24px. Small black text. Tight horizontal spacing, ~18–24px per item, no large padding. Most
of these can be inert placeholders initially; the taxonomy establishes the desktop feel.

### 2.3 Toolbar / repo path / branch controls

A dense toolbar row below the menu bar.

Left side: a cluster of small square icon buttons, then a repo-path selector:

```txt
D:\path\to\repo\
```

Then the current-branch selector:

```txt
feat/p0-p1-walking-skeleton
```

Then more icon buttons and a commit-pending button:

```txt
Commit (0)
```

Then, toward the right, the history filter controls:

```txt
All branches ▼
Branches: [          ▼]
Filter:   [          ▼]
```

Controls are small (~22px tall) with thin gray borders and compact, desktop-style select boxes; icon
buttons are ~20×20px. The current web app's top bar is much simpler — add this menu+toolbar area above the
existing content, even if many buttons are inert at first.

---

## 3. Left sidebar: repository tree

A persistent left sidebar runs from below the toolbar to the bottom of the window.

Width: ~**265px**. Background: very light gray / near white. A vertical 1px border separates it from the
main content.

It contains:

### 3.1 Small icon toolbar

A narrow row of small square buttons at the top of the sidebar. Height: ~28px.

### 3.2 Search box

A small filter input with a magnifying-glass icon, below or beside the icon row.

### 3.3 Tree view

A classic expandable tree control. Top-level sections:

```txt
Branches
  main
  feat
    p0-p1-walking-skeleton

Remotes

Tags

Submodules
  <submodule> (<branch>)

Stashes
```

Styling:

- 12px text.
- Indentation per level: ~16px.
- Expand/collapse chevrons; small folder/branch icons.
- Selected item is **bold black text**, not a large colored pill.
- The current branch has a small branch/check-style icon.
- Tree rows are compact, ~18–20px tall.

Current web app gap: there is no left repository tree. Add this sidebar.

---

## 4. Main content: commit history area

The main area starts to the right of the sidebar and below the toolbar. A thin strip sits above the table.

### 4.1 History state strip

At the top-left of the commit list, two compact status labels near the graph column:

```txt
Working directory   [green status icon]
Commit index        [green status icon]
```

These read as small gray tab/pill labels, stacked or aligned to the graph column. Height: ~46px. Commit
rows begin below this.

---

## 5. Commit history table

The dominant visual area. Height: ~500px at the reference resolution. There is no heavy header row — it
reads as a dense list with implicit columns.

### 5.1 Columns

Left to right:

```txt
Graph lane | Commit message | status/avatar icon | author | relative time | short hash
```

Approximate widths:

```txt
Graph lane:       32px
Message:          flexible, takes most width
Icon/avatar:      26px
Author:           120px
Relative time:    110px
Short hash:       80px
```

The web app's commit list already has a graph lane and rows; evolve it toward this denser, multi-column
form: wider message area, right-side author/time/hash columns, a small square avatar/icon column before
author, denser rows, and a full-width selected row.

### 5.2 Graph lane

A commit graph on the left of the table:

- Vertical green line running down the list.
- Green circular commit dots, one per row.
- The selected commit uses a blue square/outlined node instead of a plain dot.
- The lane sits on a pale background.
- Line ~2px wide; dots ~9px diameter.
- The graph column aligns precisely with row centers.

### 5.3 Row style

Compact rows, ~**25–28px** tall.

Default row:

- White background, very subtle bottom separator.
- Message text black; secondary/description text gray.
- Author slightly bold black; time black/gray; hash in monospace or compact sans.

Selected row:

- Full-row blue background (~`#0078d7`, a standard desktop selection blue).
- Text turns white across the row, including author/time/hash cells.
- Commit message stays readable; any green ref label stays green.

### 5.4 Commit message content

Each row combines a bold-ish summary and a lighter description on the same line. Example:

```txt
feat/p0-p1-walking-skeleton  docs: record ui-C + ui-D completion and resume checkpoint
```

A ref label appears as a green pill at the start of the row:

```txt
feat/p0-p1-walking-skeleton
```

Pill styling: bright green background, black text, small padding, height ~16px, border-radius ≤2px, inline
before the message.

Regular rows:

```txt
feat(ui): view file at revision (CodeMirror 6) Add a read-only "view file at revision" mode...
feat(ui): rendered diff (react-diff-view + Shiki) and toasts Render read-only diffs...
feat(ui): binary / submodule / large-diff placeholder cards Render distinct...
```

The leading summary is darker/bolder; the trailing description is gray and truncated with an ellipsis.

### 5.5 Avatar/icon column

Each row has a small green square icon with white initials (e.g. `Cb`), ~22×22px, sitting just before the
author column on the right side of the table — not next to the graph.

### 5.6 Author / time / hash columns

Each row ends with:

```txt
cbnsndwch | 8 hours ago | d9dd303
```

Author is bold; time and hash are right-side metadata. On the selected row these render white-on-blue.

---

## 6. Splitter between history and details

A thin horizontal splitter (~4–6px tall, gray border) separates the history table from the bottom panel.
Make it resizable eventually; it may be visually static at first.

---

## 7. Bottom details panel

Below the commit list: a tab strip and the selected commit's details.

### 7.1 Detail tabs

```txt
Commit | Diff | File tree | GPG | Console | Output
```

Each tab has a small icon. Height: ~28px. **Default active tab: `Commit`.**

Active tab styling: white/very pale background, thin gray border, top-aligned, compact padding. Inactive
tabs are light gray.

Note: the current web app always shows diff controls + a diff view in the bottom half. For this layout,
the default selected tab for a commit should be **Commit**, with the diff UI living under the **Diff** tab.

### 7.2 Commit summary card

Below the tabs, the left side shows a large green square avatar with initials (e.g. `Cb`), ~**78×78px**.

To its right, a metadata block:

```txt
Author:       cbnsndwch <8313760+cbnsndwch@users.noreply.github.com>
Date:         8 hours ago (6/19/2026 3:38:41 PM)
Commit hash:  d9dd303d537260a079f22dc38de6d72329483a9a
Child:        Commit index
Parent:       95db1e2e
```

Small text (~12px). Labels in a narrow left-aligned column; values may include blue links.

### 7.3 Commit message block

Below the metadata card, a full-width pale-gray strip with the selected commit subject:

```txt
docs: record ui-C + ui-D completion and resume checkpoint
```

Height: ~34px.

### 7.4 Branch/tag containment info

Below that, plain text sections:

```txt
Contained in branches:
feat/p0-p1-walking-skeleton

Contained in no tag

Derives from no tag
```

Branch names are blue links. The remainder of the panel is mostly empty white space.

---

## 8. Migration from the current web layout

The current React layout is closer to a modern split-pane git log. To reach the target:

### Keep

- Left commit list with a vertical graph line.
- Row-based history list.
- Commit detail area.
- Diff viewer mechanics.
- Top-right `Open / switch` button and settings icon, if that is the product shell.

### Change / add

1. Add the **left repository tree sidebar**.
2. Add the **desktop-style menu + toolbar** chrome.
3. Move branch/history controls into the top chrome, restyled as compact desktop toolbar controls.
4. Make commit rows denser; extend the selected row across all columns.
5. Add right-side commit-row columns: `avatar/icon | author | time | hash`.
6. Add the bottom **Commit / Diff / File tree / GPG / Console / Output** tab bar.
7. Make **Commit** the default bottom panel for a selected commit.
8. Keep the diff UI under the **Diff** tab instead of always showing it.
9. Reduce modern whitespace — the target is dense and information-heavy.
10. Use thinner borders, smaller fonts, smaller controls, and pale-gray panel backgrounds.

---

## 9. Suggested React layout skeleton

```tsx
<AppShell>
  <TitleBar />

  <MenuBar
    items={[
      "Start",
      "Repository",
      "Navigate",
      "View",
      "Commands",
      "GitHub",
      "Plugins",
      "Tools",
      "Help",
    ]}
  />

  <Toolbar>
    <IconButtonGroup />
    <RepoPathSelect />
    <BranchSelect />
    <IconButtonGroup />
    <CommitButton count={0} />
    <Spacer />
    <AllBranchesSelect />
    <BranchesFilter />
    <TextFilter />
  </Toolbar>

  <MainSplit>
    <RepositorySidebar />

    <HistoryAndDetails>
      <HistoryStatusStrip />

      <CommitTable>
        <GraphColumn />
        <CommitRows />
      </CommitTable>

      <HorizontalSplitter />

      <CommitDetailsTabs />

      <CommitDetailsPanel />
    </HistoryAndDetails>
  </MainSplit>
</AppShell>
```

---

## 10. CSS direction

A compact desktop UI scale (use a cross-platform system-ui font stack):

```css
body {
  margin: 0;
  font-family: system-ui, "Segoe UI", Tahoma, Arial, sans-serif;
  font-size: 12px;
  color: #111;
  background: #f4f4f4;
}

.app-shell {
  height: 100vh;
  display: grid;
  grid-template-rows: 26px 24px 32px 1fr;
}

.main-split {
  display: grid;
  grid-template-columns: 265px 1fr;
  min-height: 0;
}

.repository-sidebar {
  border-right: 1px solid #cfcfcf;
  background: #f7f7f7;
  overflow: auto;
}

.history-and-details {
  display: grid;
  grid-template-rows: auto minmax(300px, 55%) 6px 28px 1fr;
  min-width: 0;
  min-height: 0;
}

.commit-row {
  height: 26px;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 28px 120px 110px 80px;
  align-items: center;
  border-bottom: 1px solid #e8e8e8;
  white-space: nowrap;
}

.commit-row.selected {
  background: #0078d7;
  color: white;
}

.commit-message {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ref-pill {
  display: inline-block;
  background: #00b050;
  color: #000;
  padding: 1px 4px;
  margin-right: 6px;
  border-radius: 2px;
  font-weight: 600;
}

.avatar-cell {
  width: 22px;
  height: 22px;
  background: #6a9b22;
  color: white;
  display: grid;
  place-items: center;
  font-weight: 600;
}
```

The goal is dense, paneled, and native-feeling. The current web app already has the raw primitives; it
needs the surrounding desktop chrome, repository sidebar, bottom tabbed detail panel, and richer
commit-row columns to read as a desktop-grade history view.

> Note for the implementer: map any color values here onto the cbranch `base-lyra` token palette rather
> than hardcoding hex — the specific hex values are dimensional guidance, not brand requirements.
