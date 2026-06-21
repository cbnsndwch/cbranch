// The full top-menu structure for the desktop shell, transcribed from
// docs/design/menu-hierarchy.md (the authoritative forward-design spec). Per its
// implementation notes the full chrome renders from day one — all nine menus and every
// item — with unwired items disabled (greyed), driven by a capability + phase flag rather
// than ad-hoc conditionals. This model is the single source of truth; the revision-grid
// context menu (later) reuses the same command ids.

import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Crosshair,
  GitMerge,
  Hash,
  type LucideIcon,
  Search,
} from "lucide-react";

/** Delivery phase for a command (menu-hierarchy.md §"Phase tags"). `shell` = always-on. */
export type Phase = "P1" | "P2" | "P3" | "P4" | "P5" | "shell" | "later";

/** A leaf command. `id` is stable across the menu + context menu + action registry. */
export interface MenuCommand {
  readonly kind: "command";
  readonly id: string;
  readonly label: string;
  readonly phase: Phase;
  /** Accelerator hint, right-aligned (shown even before the command is live). */
  readonly accelerator?: string;
  /** Optional icon rendered in the menu's left rail (the column shared with checkmarks). */
  readonly icon?: LucideIcon;
}

/** A togglable command bound to a piece of UI state (rendered as a checkbox item). */
export interface MenuCheckbox {
  readonly kind: "checkbox";
  readonly id: string;
  readonly label: string;
  readonly phase: Phase;
  readonly accelerator?: string;
}

/** A nested submenu. `dynamic` marks runtime-populated lists (recent/favorite repos). */
export interface MenuSubmenu {
  readonly kind: "submenu";
  readonly id: string;
  readonly label: string;
  readonly phase: Phase;
  readonly items: ReadonlyArray<MenuEntry>;
  readonly dynamic?: "recent" | "favorites";
}

export interface MenuSeparator {
  readonly kind: "separator";
}

export type MenuEntry =
  | MenuCommand
  | MenuCheckbox
  | MenuSubmenu
  | MenuSeparator;

export interface TopMenu {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<MenuEntry>;
}

const sep: MenuSeparator = { kind: "separator" };

export const MENUS: ReadonlyArray<TopMenu> = [
  {
    id: "start",
    label: "Start",
    items: [
      {
        kind: "command",
        id: "start.create",
        label: "Create new repository…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "start.open",
        label: "Open…",
        phase: "P1",
        accelerator: "Ctrl+O",
      },
      {
        kind: "submenu",
        id: "start.favorites",
        label: "Favorite repositories",
        phase: "shell",
        dynamic: "favorites",
        items: [],
      },
      {
        kind: "submenu",
        id: "start.recent",
        label: "Recent repositories",
        phase: "shell",
        dynamic: "recent",
        items: [],
      },
      sep,
      {
        kind: "command",
        id: "start.clone",
        label: "Clone repository…",
        phase: "later",
      },
      sep,
      { kind: "command", id: "start.exit", label: "Exit", phase: "shell" },
    ],
  },
  {
    id: "repository",
    label: "Repository",
    items: [
      {
        kind: "command",
        id: "repository.refresh",
        label: "Refresh",
        phase: "P1",
        accelerator: "F5",
      },
      // {
      //   kind: "command",
      //   id: "repository.fileExplorer",
      //   label: "File Explorer",
      //   phase: "shell",
      // },
      sep,
      {
        kind: "command",
        id: "repository.remotes",
        label: "Remote repositories…",
        phase: "P3",
      },
      sep,
      {
        kind: "command",
        id: "repository.submodulesManage",
        label: "Manage submodules…",
        phase: "later",
      },
      {
        kind: "command",
        id: "repository.submodulesUpdateAll",
        label: "Update all submodules",
        phase: "later",
      },
      {
        kind: "command",
        id: "repository.submodulesSyncAll",
        label: "Synchronize all submodules",
        phase: "later",
      },
      sep,
      {
        kind: "command",
        id: "repository.worktrees",
        label: "Manage worktrees…",
        phase: "P3",
      },
      sep,
      {
        kind: "command",
        id: "repository.editGitignore",
        label: "Edit .gitignore",
        phase: "later",
      },
      {
        kind: "command",
        id: "repository.editExclude",
        label: "Edit info/exclude",
        phase: "later",
      },
      {
        kind: "command",
        id: "repository.editAttributes",
        label: "Edit .gitattributes",
        phase: "later",
      },
      {
        kind: "command",
        id: "repository.editMailmap",
        label: "Edit .mailmap",
        phase: "later",
      },
      {
        kind: "command",
        id: "repository.sparse",
        label: "Sparse working copy",
        phase: "later",
      },
      sep,
      {
        kind: "submenu",
        id: "repository.maintenance",
        label: "Maintenance",
        phase: "P3",
        items: [
          {
            kind: "command",
            id: "repository.maintenance.compress",
            label: "Compress git database",
            phase: "P3",
          },
          {
            kind: "command",
            id: "repository.maintenance.recover",
            label: "Recover lost objects…",
            phase: "P5",
          },
          {
            kind: "command",
            id: "repository.maintenance.deleteIndexLock",
            label: "Delete index.lock",
            phase: "shell",
          },
          {
            kind: "command",
            id: "repository.maintenance.editConfig",
            label: "Edit config",
            phase: "P3",
          },
        ],
      },
      {
        kind: "command",
        id: "repository.settings",
        label: "Repository settings…",
        phase: "P3",
      },
      sep,
      {
        kind: "command",
        id: "repository.close",
        label: "Close (go to Dashboard)",
        phase: "shell",
      },
    ],
  },
  {
    id: "navigate",
    label: "Navigate",
    items: [
      {
        kind: "command",
        id: "navigate.toggleArtificial",
        label: "Toggle artificial / HEAD commits",
        phase: "P2",
      },
      {
        kind: "command",
        id: "navigate.goToCurrent",
        label: "Go to current revision",
        phase: "P1",
        icon: Crosshair,
      },
      {
        kind: "command",
        id: "navigate.goToCommit",
        label: "Go to commit…",
        phase: "P1",
        accelerator: "Ctrl+G",
        icon: Hash,
      },
      {
        kind: "command",
        id: "navigate.goToChild",
        label: "Go to child commit",
        phase: "P1",
        icon: ChevronDown,
      },
      {
        kind: "command",
        id: "navigate.goToParent",
        label: "Go to parent commit",
        phase: "P1",
        icon: ChevronUp,
      },
      {
        kind: "command",
        id: "navigate.goToFirstParent",
        label: "Go to first parent commit",
        phase: "P1",
        icon: ChevronsUp,
      },
      {
        kind: "command",
        id: "navigate.goToLastParent",
        label: "Go to last parent commit",
        phase: "P1",
        icon: ChevronsDown,
      },
      {
        kind: "command",
        id: "navigate.goToMergeBase",
        label: "Go to common ancestor (merge base)",
        phase: "P1",
        icon: GitMerge,
      },
      sep,
      {
        kind: "command",
        id: "navigate.back",
        label: "Navigate backward",
        phase: "P1",
        accelerator: "Alt+Left",
        icon: ArrowLeft,
      },
      {
        kind: "command",
        id: "navigate.forward",
        label: "Navigate forward",
        phase: "P1",
        accelerator: "Alt+Right",
        icon: ArrowRight,
      },
      sep,
      {
        kind: "command",
        id: "navigate.quickSearch",
        label: "Quick search",
        phase: "P1",
        accelerator: "Ctrl+F",
        icon: Search,
      },
      {
        kind: "command",
        id: "navigate.quickSearchPrev",
        label: "Quick search previous",
        phase: "P1",
        accelerator: "Shift+F3",
      },
      {
        kind: "command",
        id: "navigate.quickSearchNext",
        label: "Quick search next",
        phase: "P1",
        accelerator: "F3",
      },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      {
        kind: "command",
        id: "view.showAllBranches",
        label: "Show all branches",
        phase: "P1",
      },
      {
        kind: "command",
        id: "view.showCurrentBranch",
        label: "Show current branch only",
        phase: "P1",
      },
      {
        kind: "command",
        id: "view.showFilteredBranches",
        label: "Show filtered branches",
        phase: "P1",
      },
      {
        kind: "command",
        id: "view.showReflog",
        label: "Show reflog references",
        phase: "P5",
      },
      sep,
      {
        kind: "command",
        id: "view.advancedFilter",
        label: "Advanced filter…",
        phase: "P1",
      },
      sep,
      {
        kind: "checkbox",
        id: "view.drawNonRelativesGray",
        label: "Draw non-relatives gray",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.highlightSelectedBranch",
        label: "Highlight selected branch",
        phase: "P1",
      },
      sep,
      {
        kind: "checkbox",
        id: "view.showArtificial",
        label: "Show artificial commits",
        phase: "P2",
      },
      {
        kind: "checkbox",
        id: "view.showStashes",
        label: "Show stashes",
        phase: "P3",
      },
      {
        kind: "checkbox",
        id: "view.showNotes",
        label: "Show git notes",
        phase: "later",
      },
      sep,
      {
        kind: "checkbox",
        id: "view.showRemoteBranches",
        label: "Show remote branches",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showTags",
        label: "Show tags",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showSuperprojectTags",
        label: "Show superproject tags",
        phase: "later",
      },
      {
        kind: "checkbox",
        id: "view.showSuperprojectBranches",
        label: "Show superproject branches",
        phase: "later",
      },
      sep,
      {
        kind: "checkbox",
        id: "view.showMessageBody",
        label: "Show commit-message body",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showAuthorDate",
        label: "Show author date",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showRelativeDate",
        label: "Show relative date",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showBuildStatusIcon",
        label: "Show build status icon",
        phase: "later",
      },
      {
        kind: "checkbox",
        id: "view.showBuildStatusText",
        label: "Show build status text",
        phase: "later",
      },
      sep,
      {
        kind: "checkbox",
        id: "view.showGraphColumn",
        label: "Show revision graph column",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showAvatarColumn",
        label: "Show author avatar column",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showAuthorColumn",
        label: "Show author name column",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showDateColumn",
        label: "Show date column",
        phase: "P1",
      },
      {
        kind: "checkbox",
        id: "view.showShaColumn",
        label: "Show SHA column",
        phase: "P1",
      },
      sep,
      {
        kind: "command",
        id: "view.sortByAuthorDate",
        label: "Sort commits by author date",
        phase: "P1",
      },
      {
        kind: "command",
        id: "view.arrangeTopo",
        label: "Arrange by topo order",
        phase: "P1",
      },
      sep,
      {
        kind: "command",
        id: "view.saveAsDefault",
        label: "Save current view as default",
        phase: "P1",
      },
    ],
  },
  {
    id: "commands",
    label: "Commands",
    items: [
      {
        kind: "command",
        id: "commands.stageAll",
        label: "Stage all changes",
        phase: "P2",
      },
      {
        kind: "command",
        id: "commands.unstageAll",
        label: "Unstage all changes",
        phase: "P2",
      },
      sep,
      {
        kind: "command",
        id: "commands.commit",
        label: "Commit…",
        phase: "P2",
        // Opens the commit dialog (commit-surface.md §6); Ctrl+Enter commits *within* it.
        accelerator: "Ctrl+Shift+Enter",
      },
      {
        kind: "command",
        id: "commands.undoLastCommit",
        label: "Undo last commit…",
        phase: "P2",
      },
      {
        kind: "command",
        id: "commands.pull",
        label: "Pull / Fetch…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.push",
        label: "Push…",
        phase: "P3",
        accelerator: "Ctrl+Shift+P",
      },
      sep,
      {
        kind: "command",
        id: "commands.stashes",
        label: "Manage stashes…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.reset",
        label: "Reset changes…",
        phase: "P2",
      },
      {
        kind: "command",
        id: "commands.clean",
        label: "Clean working directory…",
        phase: "P2",
      },
      sep,
      {
        kind: "command",
        id: "commands.createBranch",
        label: "Create branch…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.deleteBranch",
        label: "Delete branch…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.checkoutBranch",
        label: "Checkout branch…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.merge",
        label: "Merge branches…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.rebase",
        label: "Rebase…",
        phase: "P5",
      },
      {
        kind: "command",
        id: "commands.solveConflicts",
        label: "Solve merge conflicts…",
        phase: "P4",
      },
      sep,
      {
        kind: "command",
        id: "commands.createTag",
        label: "Create tag…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.deleteTag",
        label: "Delete tag…",
        phase: "P3",
      },
      sep,
      {
        kind: "command",
        id: "commands.cherryPick",
        label: "Cherry pick…",
        phase: "P4",
      },
      {
        kind: "command",
        id: "commands.revert",
        label: "Revert commit…",
        phase: "P4",
      },
      {
        kind: "command",
        id: "commands.archive",
        label: "Archive revision…",
        phase: "later",
      },
      {
        kind: "command",
        id: "commands.checkoutRevision",
        label: "Checkout revision…",
        phase: "P3",
      },
      {
        kind: "command",
        id: "commands.bisect",
        label: "Bisect…",
        phase: "P5",
      },
      {
        kind: "command",
        id: "commands.reflog",
        label: "Show reflog…",
        phase: "P5",
      },
      sep,
      {
        kind: "command",
        id: "commands.formatPatch",
        label: "Format patch…",
        phase: "later",
      },
      {
        kind: "command",
        id: "commands.applyPatch",
        label: "Apply patch…",
        phase: "later",
      },
      {
        kind: "command",
        id: "commands.viewPatch",
        label: "View patch file…",
        phase: "later",
      },
    ],
  },
  {
    id: "github",
    label: "GitHub",
    items: [
      {
        kind: "command",
        id: "github.forkClone",
        label: "Fork / Clone repository…",
        phase: "later",
      },
      {
        kind: "command",
        id: "github.viewPrs",
        label: "View pull requests…",
        phase: "later",
      },
      {
        kind: "command",
        id: "github.createPr",
        label: "Create pull request…",
        phase: "later",
      },
      {
        kind: "command",
        id: "github.addUpstream",
        label: "Add upstream remote",
        phase: "later",
      },
    ],
  },
  {
    id: "plugins",
    label: "Plugins",
    items: [
      {
        kind: "command",
        id: "plugins.none",
        label: "(no plugins loaded)",
        phase: "later",
      },
      sep,
      {
        kind: "command",
        id: "plugins.settings",
        label: "Plugin settings…",
        phase: "later",
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      {
        kind: "command",
        id: "tools.terminal",
        label: "Open terminal here",
        phase: "later",
      },
      sep,
      {
        kind: "command",
        id: "tools.commandLog",
        label: "Git command log",
        phase: "shell",
      },
      sep,
      {
        kind: "command",
        id: "tools.settings",
        label: "Settings…",
        phase: "shell",
      },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      {
        kind: "command",
        id: "help.manual",
        label: "User manual",
        phase: "shell",
      },
      {
        kind: "command",
        id: "help.changelog",
        label: "Changelog",
        phase: "shell",
      },
      sep,
      {
        kind: "command",
        id: "help.translate",
        label: "Translate",
        phase: "later",
      },
      sep,
      {
        kind: "command",
        id: "help.reportIssue",
        label: "Report an issue",
        phase: "shell",
      },
      {
        kind: "command",
        id: "help.checkUpdates",
        label: "Check for updates",
        phase: "later",
      },
      {
        kind: "command",
        id: "help.about",
        label: "About",
        phase: "shell",
      },
    ],
  },
];
