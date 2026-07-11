// Host-bounded filesystem discovery for repository and folder pickers. This is the
// deliberate pre-repository exception to per-repo containment: roots are chosen by
// the host (home, recent-repository parents, and CBRANCH_FS_ROOTS), never by the UI.

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
    basename,
    delimiter,
    dirname,
    isAbsolute,
    join,
    relative,
    sep,
} from 'node:path';

import {
    FilesystemBreadcrumb,
    FilesystemDirectoryListing,
    FilesystemEntry,
    type FilesystemEntryKind,
    FilesystemRoot,
    GitError,
    type RecentRepo,
} from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { classifyNodeError, gitError } from '../git/errors';

export const FILESYSTEM_LIST_LIMIT = 500;

type RootCandidate = {
    readonly label: string;
    readonly path: string;
};

type ResolvedRoot = RootCandidate & { readonly path: string };

const isContainedBy = (candidate: string, root: string): boolean => {
    const relation = relative(root, candidate);
    return (
        relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
    );
};

const kindOf = (entry: {
    isDirectory(): boolean;
    isFile(): boolean;
}): FilesystemEntryKind =>
    entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';

const hasGitDirectory = async (path: string): Promise<boolean> => {
    try {
        await lstat(join(path, '.git'));
        return true;
    } catch {
        return false;
    }
};

const isDangerousRoot = (path: string): boolean =>
    process.platform !== 'win32' &&
    ['/proc', '/sys', '/dev'].some(root => isContainedBy(path, root));

const resolveRoots = async (
    candidates: ReadonlyArray<RootCandidate>,
): Promise<ReadonlyArray<ResolvedRoot>> => {
    const resolved = await Promise.all(
        candidates.map(async candidate => {
            try {
                const path = await realpath(candidate.path);
                const info = await stat(path);
                return info.isDirectory() && !isDangerousRoot(path)
                    ? { ...candidate, path }
                    : undefined;
            } catch {
                // A missing recent repository parent or configured root must not make the
                // otherwise usable picker unavailable.
                return undefined;
            }
        }),
    );
    const roots: ResolvedRoot[] = [];
    for (const candidate of resolved) {
        if (
            candidate !== undefined &&
            !roots.some(root => root.path === candidate.path)
        )
            roots.push(candidate);
    }
    return roots;
};

const filesystemError = (error: unknown): GitError =>
    error instanceof GitError ? error : classifyNodeError(error);

const parseConfiguredRoots = (
    env: NodeJS.ProcessEnv | undefined,
): ReadonlyArray<RootCandidate> => {
    const raw = env?.CBRANCH_FS_ROOTS;
    if (!raw) return [];
    return raw
        .split(delimiter)
        .map(path => path.trim())
        .filter(path => path !== '')
        .map(path => ({ label: basename(path) || path, path }));
};

export const filesystemRootCandidates = (
    recentRepos: ReadonlyArray<RecentRepo>,
    env?: NodeJS.ProcessEnv,
): ReadonlyArray<RootCandidate> => [
    { label: 'Home', path: homedir() },
    ...parseConfiguredRoots(env),
    ...recentRepos.map(repo => ({
        label: basename(dirname(repo.path)) || dirname(repo.path),
        path: dirname(repo.path),
    })),
];

const listDirectory = async (
    input: { readonly path?: string; readonly showHidden?: boolean },
    candidates: ReadonlyArray<RootCandidate>,
): Promise<FilesystemDirectoryListing> => {
    const roots = await resolveRoots(candidates);
    if (roots.length === 0)
        throw gitError(
            'fsError',
            'no usable filesystem picker roots are available',
        );
    const requested = input.path ?? roots[0]!.path;
    if (!isAbsolute(requested))
        throw gitError('fsError', 'filesystem picker paths must be absolute');
    const path = await realpath(requested);
    const info = await stat(path);
    if (!info.isDirectory())
        throw gitError(
            'fsError',
            'filesystem picker paths must name a directory',
        );
    const root = roots.find(candidate => isContainedBy(path, candidate.path));
    if (!root || isDangerousRoot(path))
        throw gitError(
            'permissionDenied',
            'directory is outside the allowed roots',
        );

    const rawEntries = await readdir(path, { withFileTypes: true });
    const visibleEntries = rawEntries
        .filter(entry => input.showHidden || !entry.name.startsWith('.'))
        .slice(0, FILESYSTEM_LIST_LIMIT);
    const entries = await Promise.all(
        visibleEntries.map(async raw => {
            const entryPath = join(path, raw.name);
            const hidden = raw.name.startsWith('.');
            if (raw.isSymbolicLink()) {
                let resolvedKind: FilesystemEntryKind | undefined;
                let navigable = false;
                let isRepository = false;
                try {
                    const resolved = await realpath(entryPath);
                    if (isContainedBy(resolved, root.path)) {
                        const target = await stat(resolved);
                        resolvedKind = kindOf(target);
                        navigable = resolvedKind === 'dir';
                        isRepository =
                            resolvedKind === 'dir' &&
                            (await hasGitDirectory(resolved));
                    }
                } catch {
                    // Broken or inaccessible symlinks remain visible but cannot be navigated.
                }
                return new FilesystemEntry({
                    name: raw.name,
                    kind: 'symlink',
                    hidden,
                    isRepository,
                    navigable,
                    resolvedKind,
                });
            }
            const kind = kindOf(raw);
            return new FilesystemEntry({
                name: raw.name,
                kind,
                hidden,
                isRepository:
                    kind === 'dir' && (await hasGitDirectory(entryPath)),
                navigable: kind === 'dir',
            });
        }),
    );
    const sortedEntries = entries.toSorted((left, right) => {
        const leftDirectory = left.navigable ? 0 : 1;
        const rightDirectory = right.navigable ? 0 : 1;
        return (
            leftDirectory - rightDirectory ||
            left.name.localeCompare(right.name)
        );
    });

    const breadcrumbs = [
        new FilesystemBreadcrumb({ label: root.label, path: root.path }),
    ];
    let cursor = root.path;
    for (const segment of relative(root.path, path)
        .split(sep)
        .filter(Boolean)) {
        cursor = join(cursor, segment);
        breadcrumbs.push(
            new FilesystemBreadcrumb({
                label: segment,
                path: cursor,
            }),
        );
    }
    const parentPath = dirname(path);
    return new FilesystemDirectoryListing({
        path,
        parent: path === root.path ? null : parentPath,
        breadcrumbs,
        roots: roots.map(
            candidate =>
                new FilesystemRoot({
                    label: candidate.label,
                    path: candidate.path,
                }),
        ),
        entries: sortedEntries,
        truncated:
            rawEntries.filter(
                entry => input.showHidden || !entry.name.startsWith('.'),
            ).length > sortedEntries.length,
    });
};

/** List one immediate, host-bounded directory for the reusable filesystem picker. */
export const listFilesystemDirectory = (
    input: { readonly path?: string; readonly showHidden?: boolean },
    candidates: ReadonlyArray<RootCandidate>,
): Effect.Effect<FilesystemDirectoryListing, GitError> =>
    Effect.tryPromise({
        try: () => listDirectory(input, candidates),
        catch: filesystemError,
    });
