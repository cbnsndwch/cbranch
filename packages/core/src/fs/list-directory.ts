// Host-bounded filesystem discovery for repository and folder pickers. This is the
// deliberate pre-repository exception to per-repo containment: roots are chosen by
// the host (home, recent-repository parents, and CBRANCH_FS_ROOTS), never by the UI.

import type { Dirent } from 'node:fs';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
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

/** Git resolution is comparatively expensive, so directory import scans use a lower cap. */
export const ENGAGEMENT_DIRECTORY_SCAN_LIMIT = 100;

const DIRECTORY_ENTRY_ENRICHMENT_CONCURRENCY = 8;

type RootCandidate = {
    readonly label: string;
    readonly path: string;
};

type ResolvedRoot = RootCandidate & { readonly path: string };

export interface FilesystemDirectoryScanEntry {
    readonly name: string;
    readonly path: string;
}

export interface FilesystemDirectoryScan {
    readonly path: string;
    readonly entries: ReadonlyArray<FilesystemDirectoryScanEntry>;
    readonly truncated: boolean;
}

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

const readDirectoryEntries = async (
    path: string,
    include: (entry: Dirent) => boolean,
    limit: number,
): Promise<{
    readonly entries: ReadonlyArray<Dirent>;
    readonly truncated: boolean;
}> => {
    const directory = await opendir(path);
    const entries: Dirent[] = [];
    try {
        while (true) {
            // eslint-disable-next-line no-await-in-loop -- Dir.read advances one shared cursor.
            const entry = await directory.read();
            if (entry === null) return { entries, truncated: false };
            if (!include(entry)) continue;
            if (entries.length === limit) return { entries, truncated: true };
            entries.push(entry);
        }
    } finally {
        await directory.close();
    }
};

const enrichDirectoryEntries = async <Result>(
    entries: ReadonlyArray<Dirent>,
    enrich: (entry: Dirent) => Promise<Result>,
): Promise<ReadonlyArray<Result>> => {
    const results: Result[] = [];
    results.length = entries.length;
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (nextIndex < entries.length) {
            const index = nextIndex++;
            // eslint-disable-next-line no-await-in-loop -- each worker processes one entry at a time.
            results[index] = await enrich(entries[index]!);
        }
    };
    await Promise.all(
        Array.from(
            {
                length: Math.min(
                    DIRECTORY_ENTRY_ENRICHMENT_CONCURRENCY,
                    entries.length,
                ),
            },
            worker,
        ),
    );
    return results;
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

const resolveFilesystemDirectory = async (
    requested: string | undefined,
    candidates: ReadonlyArray<RootCandidate>,
): Promise<{
    readonly path: string;
    readonly roots: ReadonlyArray<ResolvedRoot>;
}> => {
    const roots = await resolveRoots(candidates);
    if (roots.length === 0)
        throw gitError(
            'fsError',
            'no usable filesystem picker roots are available',
        );
    const requestedPath = requested ?? roots[0]!.path;
    if (!isAbsolute(requestedPath))
        throw gitError('fsError', 'filesystem picker paths must be absolute');
    const path = await realpath(requestedPath);
    const info = await stat(path);
    if (!info.isDirectory())
        throw gitError(
            'fsError',
            'filesystem picker paths must name a directory',
        );
    if (!roots.some(candidate => isContainedBy(path, candidate.path)))
        throw gitError(
            'permissionDenied',
            'directory is outside the allowed roots',
        );
    if (isDangerousRoot(path))
        throw gitError(
            'permissionDenied',
            'directory is outside the allowed roots',
        );
    return { path, roots };
};

const listDirectory = async (
    input: { readonly path?: string; readonly showHidden?: boolean },
    candidates: ReadonlyArray<RootCandidate>,
): Promise<FilesystemDirectoryListing> => {
    const { path, roots } = await resolveFilesystemDirectory(
        input.path,
        candidates,
    );
    const root = roots.find(candidate => isContainedBy(path, candidate.path));
    if (!root)
        throw gitError(
            'permissionDenied',
            'directory is outside the allowed roots',
        );

    const { entries: rawEntries, truncated } = await readDirectoryEntries(
        path,
        entry => input.showHidden || !entry.name.startsWith('.'),
        FILESYSTEM_LIST_LIMIT,
    );
    const entries = await enrichDirectoryEntries(rawEntries, async raw => {
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
            isRepository: kind === 'dir' && (await hasGitDirectory(entryPath)),
            navigable: kind === 'dir',
        });
    });
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
        truncated,
    });
};

const scanDirectory = async (
    path: string,
    candidates: ReadonlyArray<RootCandidate>,
): Promise<FilesystemDirectoryScan> => {
    const resolved = await resolveFilesystemDirectory(path, candidates);
    const { entries, truncated } = await readDirectoryEntries(
        resolved.path,
        entry =>
            !entry.name.startsWith('.') &&
            !entry.isSymbolicLink() &&
            entry.isDirectory(),
        ENGAGEMENT_DIRECTORY_SCAN_LIMIT,
    );
    const sortedEntries = entries.toSorted((left, right) =>
        left.name.localeCompare(right.name),
    );
    return {
        path: resolved.path,
        entries: sortedEntries.map(entry => ({
            name: entry.name,
            path: join(resolved.path, entry.name),
        })),
        truncated,
    };
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

/** List immediate, non-hidden real directories for bounded workspace import discovery. */
export const scanFilesystemDirectory = (
    path: string,
    candidates: ReadonlyArray<RootCandidate>,
): Effect.Effect<FilesystemDirectoryScan, GitError> =>
    Effect.tryPromise({
        try: () => scanDirectory(path, candidates),
        catch: filesystemError,
    });
