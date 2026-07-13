// Host invalidation bus — `repo.subscribe` (docs/spec/15 §3; NF-WATCH-1/2/3;
// NF-TEST-10).
//
// One SHARED watcher set per `repoId` covers the common git dir
// (`rev-parse --git-common-dir`) + worktree. Changed paths are mapped to the closed
// `Domain` set EXACTLY per 15 §3. Git objects/locks and high-volume generated worktree
// trees are ignored; a burst within ~300 ms is coalesced into ONE `InvalidationEvent`
// whose `domains` is the union. Subscribers are ref-counted; the watcher is torn down
// when the last one leaves (NF-WATCH-2). No echo suppression: an external terminal
// `git` change MUST still emit (NF-WATCH-3).

import { relative } from 'node:path';

import { type Domain, type RepoId } from '@cbranch/rpc-contract';
import { InvalidationEvent } from '@cbranch/rpc-contract';
import { type FSWatcher, watch } from 'chokidar';

// 300 ms: git commits on Windows NTFS can write index then refs/heads/* with a gap
// exceeding 150 ms under load; the wider window reliably coalesces both into one event.
export const COALESCE_MS = 300;

/** The watched-repo facts the registry needs (a subset of `ResolvedRepo`). */
export interface WatchTarget {
    readonly repoId: RepoId;
    readonly commonDir: string;
    readonly root: string;
    readonly isBare: boolean;
}

/** Forward-slash path of `p` relative to `base`, or `null` when `p` is not under `base`. */
const relativeUnder = (base: string, p: string): string | null => {
    const rel = relative(base, p).replace(/\\/g, '/');
    if (
        rel === '' ||
        rel.startsWith('../') ||
        rel === '..' ||
        /^[a-zA-Z]:\//.test(rel)
    )
        return null;
    return rel;
};

/**
 * Map a changed path to its invalidation {@link Domain}s per the 15 §3 table. Paths under
 * the common git dir are classified by their git-relative name; any other (worktree)
 * change is `status`. Unmapped git-dir files (e.g. `logs/HEAD`, `COMMIT_EDITMSG`) yield
 * `[]` and are dropped.
 */
export const classifyChange = (
    commonDir: string,
    changedPath: string,
): ReadonlyArray<Domain> => {
    const rel = relativeUnder(commonDir, changedPath);
    if (rel === null) return ['status']; // worktree file add/modify/delete

    if (rel === 'HEAD') return ['refs', 'commits', 'inProgress'];
    if (rel.startsWith('refs/heads/') || rel.startsWith('refs/remotes/'))
        return ['refs', 'commits', 'inProgress'];
    if (rel === 'packed-refs') return ['refs', 'commits', 'inProgress'];
    if (rel.startsWith('refs/tags/')) return ['tags', 'commits'];
    if (rel === 'refs/stash' || rel === 'logs/refs/stash') return ['stash'];
    if (rel === 'index') return ['status'];
    if (rel === 'worktrees' || rel.startsWith('worktrees/'))
        return ['worktrees'];
    if (
        rel === 'MERGE_HEAD' ||
        rel === 'CHERRY_PICK_HEAD' ||
        rel === 'REVERT_HEAD' ||
        rel === 'BISECT_LOG'
    ) {
        return ['inProgress', 'refs'];
    }
    if (
        rel.startsWith('rebase-merge/') ||
        rel.startsWith('rebase-apply/') ||
        rel.startsWith('sequencer/')
    ) {
        return ['inProgress', 'refs'];
    }
    if (rel.endsWith('_HEAD')) return ['inProgress', 'refs']; // ORIG_HEAD, FETCH_HEAD, …
    if (rel === 'config') return ['config'];
    return [];
};

const WORKTREE_IGNORED_DIRS = new Set([
    '.cache',
    '.next',
    '.nuxt',
    '.parcel-cache',
    '.svelte-kit',
    '.turbo',
    '.vite',
    'bower_components',
    'coverage',
    'node_modules',
]);

const isSameOrUnder = (base: string, p: string): boolean =>
    relative(base, p).replace(/\\/g, '/') === '' ||
    relativeUnder(base, p) !== null;

/** True for high-volume Git churn: `*.lock` and `objects/**` (NF-WATCH-1). */
export const isIgnoredGitPath = (commonDir: string, p: string): boolean => {
    if (p.endsWith('.lock')) return true;
    const rel = relativeUnder(commonDir, p);
    return rel !== null && (rel === 'objects' || rel.startsWith('objects/'));
};

/**
 * True for paths the worktree watcher should not recurse into. The common Git dir has
 * its own watcher, which prevents duplicate administration watches in normal repos.
 */
export const isIgnoredWorktreePath = (
    commonDir: string,
    root: string,
    p: string,
): boolean => {
    if (isIgnoredGitPath(commonDir, p) || isSameOrUnder(commonDir, p))
        return true;
    const rel = relativeUnder(root, p);
    return (
        rel !== null &&
        rel.split('/').some(segment => WORKTREE_IGNORED_DIRS.has(segment))
    );
};

type Listener = (event: InvalidationEvent) => void;

interface Entry {
    readonly watchers: ReadonlyArray<FSWatcher>;
    readonly listeners: Set<Listener>;
    readonly pending: Set<Domain>;
    timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A registry of shared per-`repoId` watchers. `addListener` lazily creates the watcher on
 * the first subscriber and returns a disposer that tears it down on the last (NF-WATCH-2).
 */
export class WatcherRegistry {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly debounceMs: number = COALESCE_MS) {}

    addListener(target: WatchTarget, listener: Listener): () => void {
        let entry = this.entries.get(target.repoId);
        if (entry === undefined) entry = this.createEntry(target);
        entry.listeners.add(listener);
        let disposed = false;
        return () => {
            if (disposed) return;
            disposed = true;
            this.removeListener(target.repoId, listener);
        };
    }

    /** Tear down every watcher (engine scope teardown — REQ-ARCH-042). */
    closeAll(): void {
        for (const [repoId, entry] of this.entries)
            this.teardown(repoId, entry);
    }

    private createEntry(target: WatchTarget): Entry {
        const gitWatcher = watch(target.commonDir, {
            ignoreInitial: true,
            persistent: true,
            ignored: p => isIgnoredGitPath(target.commonDir, p),
        });
        const watchers = target.isBare
            ? [gitWatcher]
            : [
                  gitWatcher,
                  watch(target.root, {
                      ignoreInitial: true,
                      persistent: true,
                      ignored: p =>
                          isIgnoredWorktreePath(
                              target.commonDir,
                              target.root,
                              p,
                          ),
                  }),
              ];
        const entry: Entry = {
            watchers,
            listeners: new Set(),
            pending: new Set(),
            timer: null,
        };
        for (const watcher of watchers) {
            watcher.on('all', (_event, changedPath) =>
                this.onChange(target, entry, changedPath),
            );
            watcher.on('error', () => {
                // A watcher error MUST NOT crash the service; subscribers simply stop receiving.
            });
        }
        this.entries.set(target.repoId, entry);
        return entry;
    }

    private onChange(
        target: WatchTarget,
        entry: Entry,
        changedPath: string,
    ): void {
        const domains = classifyChange(target.commonDir, changedPath);
        if (domains.length === 0) return;
        for (const d of domains) entry.pending.add(d);
        if (entry.timer !== null) return; // fixed window from the first change ⇒ coalesce the burst
        entry.timer = setTimeout(
            () => this.flush(target, entry),
            this.debounceMs,
        );
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
    }

    private flush(target: WatchTarget, entry: Entry): void {
        entry.timer = null;
        if (entry.pending.size === 0) return;
        const domains = [...entry.pending];
        entry.pending.clear();
        const event = new InvalidationEvent({ repoId: target.repoId, domains });
        for (const listener of entry.listeners) listener(event);
    }

    private removeListener(repoId: string, listener: Listener): void {
        const entry = this.entries.get(repoId);
        if (entry === undefined) return;
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) this.teardown(repoId, entry);
    }

    private teardown(repoId: string, entry: Entry): void {
        if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        for (const watcher of entry.watchers) void watcher.close();
        this.entries.delete(repoId);
    }
}
