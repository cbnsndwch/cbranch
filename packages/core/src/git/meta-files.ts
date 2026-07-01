// Repository metadata-file editors (docs/spec/17 REQ-P6-META-001..004). A CLOSED,
// enumerated set of files — the root `.gitignore`/`.gitattributes`/`.mailmap` and the
// private `.git/info/exclude` — is read and atomically written on the host. The targets
// are hard-coded relative to the repository root (or the common git dir for info/exclude),
// so this can never become an arbitrary-file primitive; a defensive containment check
// rejects any resolution that would escape the base (NF-SEC-5/6).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import {
    type GitError,
    type MetaFile,
    MetaFileContent,
} from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { classifyNodeError, gitError } from './errors';
import { type ResolvedRepo } from '../repo/resolve';

/** The base directory the target must stay within: the git dir for exclude, else the root. */
const baseFor = (repo: ResolvedRepo, file: MetaFile): string =>
    file === 'info-exclude' ? repo.commonDir : repo.root;

/** The hard-coded relative path for each enumerated file. */
const relFor = (file: MetaFile): string => {
    switch (file) {
        case 'gitignore':
            return '.gitignore';
        case 'gitattributes':
            return '.gitattributes';
        case 'mailmap':
            return '.mailmap';
        case 'info-exclude':
            return join('info', 'exclude');
    }
};

/** Resolve + assert containment; the hard-coded relatives can't escape, but verify anyway. */
const metaFilePath = (
    repo: ResolvedRepo,
    file: MetaFile,
): Effect.Effect<string, GitError> => {
    const base = baseFor(repo, file);
    const path = resolve(base, relFor(file));
    if (path !== base && !path.startsWith(base + sep)) {
        return Effect.fail(
            gitError('fsError', 'metadata path escapes the repository'),
        );
    }
    return Effect.succeed(path);
};

/** Read a metadata file; a missing file is `exists:false` with empty text, not an error. */
export const readMetaFile = (
    repo: ResolvedRepo,
    file: MetaFile,
): Effect.Effect<MetaFileContent, GitError> =>
    Effect.flatMap(metaFilePath(repo, file), path =>
        Effect.tryPromise({
            try: async () => {
                try {
                    const text = await readFile(path, 'utf8');
                    return new MetaFileContent({ file, exists: true, text });
                } catch (err) {
                    if (
                        typeof err === 'object' &&
                        err !== null &&
                        'code' in err &&
                        (err as { code: unknown }).code === 'ENOENT'
                    ) {
                        return new MetaFileContent({
                            file,
                            exists: false,
                            text: '',
                        });
                    }
                    throw err;
                }
            },
            catch: classifyNodeError,
        }),
    );

/**
 * Atomically write a metadata file: write a sibling temp then rename over the target (a
 * rename is atomic on the same filesystem). The parent dir is created if absent. Writes
 * are serialized per repo by the caller's mutation lock, so a fixed temp name is safe.
 */
export const writeMetaFile = (
    repo: ResolvedRepo,
    file: MetaFile,
    text: string,
): Effect.Effect<void, GitError> =>
    Effect.flatMap(metaFilePath(repo, file), path =>
        Effect.tryPromise({
            try: async () => {
                await mkdir(dirname(path), { recursive: true });
                const tmp = path + '.cbranch.tmp';
                await writeFile(tmp, text, 'utf8');
                await rename(tmp, path);
            },
            catch: classifyNodeError,
        }),
    );
