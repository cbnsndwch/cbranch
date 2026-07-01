// Aggregate repository state (docs/spec/05 §2.1/§2.2; DM-070 / 14 §8; P1-OPEN-3,
// P1-STAT-1/3/4).
//
// Builds `RepoState` from three machine-readable sources (never localized text):
//   • `git status --porcelain=v2 -z --branch` header lines → current branch / HEAD oid
//     / detached (non-bare); bare repos fall back to `rev-parse` + `symbolic-ref`,
//   • `git rev-parse --quiet --verify HEAD` exit status → empty/unborn (P1-STAT-3),
//   • presence of operation-state marker files in the git dir → `inProgress`
//     (P1-OPEN-3): MERGE_HEAD→merge, CHERRY_PICK_HEAD→cherryPick, REVERT_HEAD→revert,
//     rebase-merge//rebase-apply/→rebase, rebase-apply/applying→am, BISECT_LOG→bisect.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type GitError, type Oid } from '@cbranch/rpc-contract';
import { Oid as OidBrand, RepoState } from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { decodeUtf8, runGit } from '../git/run-git';
import { type ResolvedRepo, repoCwd } from './resolve';

type InProgress = RepoState['inProgress'];

export const detectInProgress = (gitDir: string): InProgress => {
    const has = (...segments: string[]): boolean =>
        existsSync(join(gitDir, ...segments));
    // Precedence mirrors git's own `wt_status_get_state` ordering.
    if (has('rebase-merge')) return 'rebase';
    if (has('rebase-apply'))
        return has('rebase-apply', 'applying') ? 'am' : 'rebase';
    if (has('CHERRY_PICK_HEAD')) return 'cherryPick';
    if (has('REVERT_HEAD')) return 'revert';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('BISECT_LOG')) return 'bisect';
    return 'none';
};

export const readRepoState = (
    repo: ResolvedRepo,
): Effect.Effect<RepoState, GitError> =>
    Effect.gen(function* () {
        const cwd = repoCwd(repo);

        // Emptiness: a non-zero exit on `--verify HEAD` means an unborn branch (DATA).
        const headProbe = yield* runGit({
            cwd,
            args: ['rev-parse', '--quiet', '--verify', 'HEAD'],
        });
        const isEmpty = headProbe.exitCode !== 0;
        const verifiedHead = decodeUtf8(headProbe.stdout).trim();

        let headOid: Oid | undefined =
            verifiedHead === '' ? undefined : OidBrand.make(verifiedHead);
        let currentBranch: string | undefined;
        let isDetached = false;

        if (repo.isBare) {
            const sym = yield* runGit({
                cwd,
                args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
            });
            if (sym.exitCode === 0)
                currentBranch = decodeUtf8(sym.stdout).trim() || undefined;
            else isDetached = headOid !== undefined;
        } else {
            const status = yield* runGit({
                cwd,
                args: ['status', '--porcelain=v2', '-z', '--branch'],
            });
            const header = parseBranchHeader(status.stdout);
            if (header.head === '(detached)') {
                isDetached = true;
            } else if (header.head !== undefined) {
                currentBranch = header.head;
            }
            if (header.oid !== undefined && header.oid !== '(initial)')
                headOid = OidBrand.make(header.oid);
        }

        return new RepoState({
            headOid,
            currentBranch,
            isDetached,
            inProgress: detectInProgress(repo.gitDir),
            isBare: repo.isBare,
            isEmpty,
            repoRoot: repo.root,
            gitDir: repo.gitDir,
        });
    });

/** Parse the `# branch.oid` / `# branch.head` NUL-terminated header records. */
export const parseBranchHeader = (
    stdout: Buffer,
): { oid?: string; head?: string } => {
    const records = decodeUtf8(stdout).split('\0');
    const out: { oid?: string; head?: string } = {};
    for (const record of records) {
        if (record.startsWith('# branch.oid '))
            out.oid = record.slice('# branch.oid '.length).trim();
        else if (record.startsWith('# branch.head '))
            out.head = record.slice('# branch.head '.length).trim();
    }
    return out;
};
