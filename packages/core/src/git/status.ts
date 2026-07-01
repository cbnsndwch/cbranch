import {
    type GitError,
    Oid as OidBrand,
    StatusBranch,
    StatusEntry,
    WorkingTreeStatus,
} from '@cbranch/rpc-contract';
import { type ChangeCode } from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { decodeUtf8, runGitOk } from './run-git';

const mapXY = (c: string): ChangeCode => {
    switch (c) {
        case 'M':
            return 'modified';
        case 'A':
            return 'added';
        case 'D':
            return 'deleted';
        case 'R':
            return 'renamed';
        case 'C':
            return 'copied';
        case 'T':
            return 'typeChanged';
        case 'U':
            return 'updatedButUnmerged';
        default:
            return 'unmodified';
    }
};

const modeOrUndefined = (s: string | undefined): string | undefined =>
    s === undefined || s === '000000' || s === '0' ? undefined : s;

export const parseStatusOutput = (buf: Buffer): WorkingTreeStatus => {
    const tokens = decodeUtf8(buf).split(String.fromCharCode(0));
    const entries: StatusEntry[] = [];

    let branchHead: string | undefined;
    let branchOid: ReturnType<typeof OidBrand.make> | undefined;
    let branchUpstream: string | undefined;
    let branchAhead: number | undefined;
    let branchBehind: number | undefined;
    let seenHeader = false;

    let i = 0;
    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok === undefined || tok.length === 0) {
            i++;
            continue;
        }
        const first = tok.charAt(0);

        if (first === '#') {
            seenHeader = true;
            const inner = tok.slice(2);
            const sp = inner.indexOf(' ');
            const key = sp === -1 ? inner : inner.slice(0, sp);
            const val = sp === -1 ? '' : inner.slice(sp + 1);

            if (key === 'branch.oid') {
                branchOid =
                    val === '(initial)' ? undefined : OidBrand.make(val);
            } else if (key === 'branch.head') {
                branchHead = val === '(detached)' ? undefined : val;
            } else if (key === 'branch.upstream') {
                branchUpstream = val;
            } else if (key === 'branch.ab') {
                const ab = val.split(' ');
                const a = ab[0];
                const b = ab[1];
                branchAhead =
                    a !== undefined ? parseInt(a.slice(1), 10) : undefined;
                branchBehind =
                    b !== undefined ? parseInt(b.slice(1), 10) : undefined;
            }
            i++;
        } else if (first === '1') {
            const parts = tok.split(' ');
            const xy = parts[1] ?? '..';
            const sub = parts[2] ?? 'N...';
            const mI = parts[4];
            const mW = parts[5];
            const path = parts.slice(8).join(' ');

            entries.push(
                new StatusEntry({
                    path,
                    staged: mapXY(xy.charAt(0)),
                    unstaged: mapXY(xy.charAt(1)),
                    isConflicted: false,
                    isUntracked: false,
                    isIgnored: false,
                    isSubmodule: sub.charAt(0) === 'S',
                    stagedMode: modeOrUndefined(mI),
                    worktreeMode: modeOrUndefined(mW),
                }),
            );
            i++;
        } else if (first === '2') {
            const parts = tok.split(' ');
            const xy = parts[1] ?? '..';
            const sub = parts[2] ?? 'N...';
            const mI = parts[4];
            const mW = parts[5];
            const score = parts[8] ?? '';
            const path = parts.slice(9).join(' ');
            const origPath = tokens[i + 1] ?? '';

            const simNum = parseInt(score.slice(1), 10);

            entries.push(
                new StatusEntry({
                    path,
                    origPath: origPath.length > 0 ? origPath : undefined,
                    staged: mapXY(xy.charAt(0)),
                    unstaged: mapXY(xy.charAt(1)),
                    isConflicted: false,
                    isUntracked: false,
                    isIgnored: false,
                    similarity: isNaN(simNum) ? undefined : simNum,
                    isSubmodule: sub.charAt(0) === 'S',
                    stagedMode: modeOrUndefined(mI),
                    worktreeMode: modeOrUndefined(mW),
                }),
            );
            i += 2;
        } else if (first === 'u') {
            const parts = tok.split(' ');
            const xy = parts[1] ?? 'UU';
            const path = parts.slice(11).join(' ');

            entries.push(
                new StatusEntry({
                    path,
                    staged: mapXY(xy.charAt(0)),
                    unstaged: mapXY(xy.charAt(1)),
                    isConflicted: true,
                    isUntracked: false,
                    isIgnored: false,
                    isSubmodule: false,
                }),
            );
            i++;
        } else if (first === '?') {
            entries.push(
                new StatusEntry({
                    path: tok.slice(2),
                    staged: 'unmodified',
                    unstaged: 'untracked',
                    isConflicted: false,
                    isUntracked: true,
                    isIgnored: false,
                    isSubmodule: false,
                }),
            );
            i++;
        } else if (first === '!') {
            entries.push(
                new StatusEntry({
                    path: tok.slice(2),
                    staged: 'unmodified',
                    unstaged: 'ignored',
                    isConflicted: false,
                    isUntracked: false,
                    isIgnored: true,
                    isSubmodule: false,
                }),
            );
            i++;
        } else {
            i++;
        }
    }

    const branch = seenHeader
        ? new StatusBranch({
              head: branchHead,
              oid: branchOid,
              upstream: branchUpstream,
              ahead: branchAhead,
              behind: branchBehind,
          })
        : undefined;

    return new WorkingTreeStatus({
        entries,
        branch,
        hasConflicts: entries.some(e => e.isConflicted),
    });
};

export const statusGet = (
    cwd: string,
    includeIgnored?: boolean,
): Effect.Effect<WorkingTreeStatus, GitError> => {
    const args: string[] = ['status', '--porcelain=v2', '-z', '--branch'];
    if (includeIgnored === true) args.push('--ignored=matching');
    return Effect.map(runGitOk({ cwd, args }), r =>
        parseStatusOutput(r.stdout),
    );
};
