// Diff request/presentation helpers (P1-DIFF-*; spec 05 §2.5, DiffSpec wire fields).
//
// The diff controls (whitespace, context lines, merge-parent base, combined) map to a
// server `DiffSpec`; the server recomputes the patch, so these are not client-side
// transforms. Submodule/binary/large-diff classification and the changed-file tree are
// pure derivations over the returned `DiffFile[]`.

import { type DiffFile, DiffSpec, type RepoId } from "@cbranch/rpc-contract";

export type Whitespace = "show" | "ignore-all" | "ignore-change";

/** Inline (unified) vs side-by-side (split) presentation, a persisted preference (P1-DIFF-3). */
export type DiffView = "inline" | "split";

const DIFF_VIEW_KEY = "cbranch.ui.diffView";

/** Read the persisted inline/split preference; defaults to `"inline"` (P1-DIFF-3). */
export const readDiffView = (): DiffView => {
  try {
    if (typeof localStorage === "undefined") return "inline";
    return localStorage.getItem(DIFF_VIEW_KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
};

/** Persist the inline/split preference. No-op when storage is unavailable (NF-CFG-3). */
export const writeDiffView = (view: DiffView): void => {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(DIFF_VIEW_KEY, view);
  } catch {
    // ignore unavailable/blocked storage
  }
};

/** Default size above which a single file's diff is deferred (P1-DIFF-9); configurable. */
export const DEFAULT_LARGE_DIFF_LINES = 2000;

/** Ephemeral per-selection diff options (reset when the selected commit changes). */
export interface DiffOptions {
  readonly whitespace: Whitespace;
  /** Context lines around each change (`-U<n>`, P1-DIFF-5). */
  readonly context: number;
  /** Explicit comparison base (a chosen merge parent); absent = first parent (P1-DET-3). */
  readonly base?: string;
  /** Combined merge diff (`--cc`, P1-DET-3). */
  readonly combined: boolean;
}

export const defaultDiffOptions: DiffOptions = {
  whitespace: "show",
  context: 3,
  combined: false,
};

/** Build the server `DiffSpec` for a target commit and the active options. */
export const buildDiffSpec = (
  repoId: RepoId,
  target: string,
  options: DiffOptions,
): DiffSpec =>
  new DiffSpec({
    repoId,
    target,
    base: options.combined ? undefined : options.base,
    cached: false,
    whitespace: options.whitespace,
    context: options.context,
    renames: true,
    combined: options.combined,
  });

/** A gitlink (submodule) entry is recognized by its `160000` mode (P1-DIFF-10). */
export const isSubmodule = (file: DiffFile): boolean =>
  file.oldMode === "160000" || file.newMode === "160000";

/** Changed-line count for a file (numstat sum, falling back to hunk lines for binaries). */
export const changedLineCount = (file: DiffFile): number => {
  if (file.additions !== null || file.deletions !== null)
    return (file.additions ?? 0) + (file.deletions ?? 0);
  return file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((l) => l.kind !== "context").length,
    0,
  );
};

/** Whether a file's diff should be deferred behind a "load anyway" gate (P1-DIFF-9). */
export const isLargeDiff = (
  file: DiffFile,
  threshold = DEFAULT_LARGE_DIFF_LINES,
): boolean =>
  !file.isBinary && !isSubmodule(file) && changedLineCount(file) > threshold;

/** Aggregate totals for the changed-file list header (P1-UI-DIFF-1). */
export const diffTotals = (
  files: ReadonlyArray<DiffFile>,
): { files: number; additions: number; deletions: number } => ({
  files: files.length,
  additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
  deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
});

/** The display path for a file (new path, falling back to the old path for deletions). */
export const filePath = (file: DiffFile): string =>
  file.newPath || file.oldPath;

// --- Directory-tree view (P1-DIFF-2) ----------------------------------------------------

export interface TreeFileNode {
  readonly type: "file";
  readonly name: string;
  readonly path: string;
  readonly file: DiffFile;
}

export interface TreeDirNode {
  readonly type: "dir";
  readonly name: string;
  readonly path: string;
  readonly children: ReadonlyArray<TreeNode>;
}

export type TreeNode = TreeFileNode | TreeDirNode;

interface MutableDir {
  readonly dirs: Map<string, MutableDir>;
  readonly files: TreeFileNode[];
}

const emptyDir = (): MutableDir => ({ dirs: new Map(), files: [] });

/** Build a directory tree from the flat changed-file list, dirs before files, both sorted. */
export const buildFileTree = (
  files: ReadonlyArray<DiffFile>,
): ReadonlyArray<TreeNode> => {
  const root = emptyDir();
  for (const file of files) {
    const path = filePath(file);
    const segments = path.split("/");
    let dir = root;
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]!;
      prefix = prefix === "" ? name : `${prefix}/${name}`;
      let next = dir.dirs.get(name);
      if (!next) {
        next = emptyDir();
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push({
      type: "file",
      name: segments[segments.length - 1]!,
      path,
      file,
    });
  }

  const toNodes = (dir: MutableDir, prefix: string): TreeNode[] => {
    const dirNodes: TreeDirNode[] = [...dir.dirs.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        return {
          type: "dir",
          name,
          path,
          children: toNodes(child, path),
        };
      });
    const fileNodes = dir.files.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    return [...dirNodes, ...fileNodes];
  };
  return toNodes(root, "");
};

/** A flattened, virtualization-friendly row of the changed-file list (flat or tree). */
export interface FileListRow {
  readonly kind: "dir" | "file";
  readonly depth: number;
  readonly name: string;
  readonly path: string;
  /** The diff file for `kind: "file"` rows. */
  readonly file?: DiffFile;
}

/** Flat-mode rows: one per file, no nesting. */
export const flatRows = (
  files: ReadonlyArray<DiffFile>,
): ReadonlyArray<FileListRow> =>
  [...files]
    .toSorted((a, b) => filePath(a).localeCompare(filePath(b)))
    .map((file) => ({
      kind: "file",
      depth: 0,
      name: filePath(file),
      path: filePath(file),
      file,
    }));

/** Tree-mode rows: a DFS of the tree honoring `expanded` (collapsed dirs hide their subtree). */
export const treeRows = (
  nodes: ReadonlyArray<TreeNode>,
  expanded: ReadonlySet<string>,
  depth = 0,
): ReadonlyArray<FileListRow> => {
  const rows: FileListRow[] = [];
  for (const node of nodes) {
    if (node.type === "dir") {
      rows.push({ kind: "dir", depth, name: node.name, path: node.path });
      if (expanded.has(node.path))
        rows.push(...treeRows(node.children, expanded, depth + 1));
    } else {
      rows.push({
        kind: "file",
        depth,
        name: node.name,
        path: node.path,
        file: node.file,
      });
    }
  }
  return rows;
};

/** All directory paths in a tree, for the default fully-expanded state. */
export const allDirPaths = (
  nodes: ReadonlyArray<TreeNode>,
): ReadonlyArray<string> => {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "dir") {
      paths.push(node.path);
      paths.push(...allDirPaths(node.children));
    }
  }
  return paths;
};
