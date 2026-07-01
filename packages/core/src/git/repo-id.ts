// Repository identity (docs/spec/14 §3.5 / DECISIONS D2).
//
// `repoId` = SHA-256 hex of the UTF-8 bytes of the repository's resolved, absolute,
// normalized COMMON git dir (`git rev-parse --git-common-dir`). Keying on the common
// dir makes sibling worktrees of one repository collapse to a SINGLE `repoId` (and
// therefore one mutation lock and one set of synced collections).

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { type RepoId } from '@cbranch/rpc-contract';
import { RepoId as RepoIdBrand } from '@cbranch/rpc-contract';

/**
 * Resolve a possibly-relative path to an absolute, canonical, normalized form. Uses
 * the OS canonical path when the target exists (so symlinked / differently-cased
 * paths to one git dir hash identically); falls back to `resolve` otherwise.
 */
export const normalizeAbsolute = (base: string, p: string): string => {
    const absolute = isAbsolute(p) ? p : resolve(base, p);
    try {
        return realpathSync.native(absolute);
    } catch {
        return resolve(absolute);
    }
};

/** Compute the branded {@link RepoId} from a normalized absolute common-dir path. */
export const computeRepoId = (normalizedCommonDir: string): RepoId =>
    RepoIdBrand.make(
        createHash('sha256')
            .update(Buffer.from(normalizedCommonDir, 'utf8'))
            .digest('hex'),
    );

/** A repoId is a 64-char lowercase SHA-256 hex string. */
export const isRepoId = (value: string): boolean =>
    /^[0-9a-f]{64}$/.test(value);
