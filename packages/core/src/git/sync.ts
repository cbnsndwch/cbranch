// Streaming sync: fetch, pull, push, and push-delete (docs/spec/07 REQ-P3-SY-*).
//
// Each sync operation runs git as a child process and emits SyncEvent items in REAL
// TIME via {@link streamGit}: progress and ref-update events surface AS git produces
// output, and the operation is cancelable (interrupting the stream SIGKILLs the host
// process — REQ-P3-XC-004). Error classification keys off the git exit status plus
// STABLE machine output (push `--porcelain` flag chars; the literal `CONFLICT` /
// "Not possible to fast-forward" tokens git emits under LC_ALL=C), never localized
// prose (NF-ERR-1 / NF-GIT-3).

import {
    type GitError,
    SyncProgressEvent,
    SyncRefUpdate,
} from '@cbranch/rpc-contract';
import { type SyncEvent } from '@cbranch/rpc-contract';
import { Effect, Stream } from 'effect';

import { classifyExit, gitError } from './errors';
import {
    assertNoLeadingDash,
    type GitLine,
    runGitOk,
    streamGit,
} from './run-git';

// ─── line parsers ───────────────────────────────────────────────────────────
// fetch/pull ref-update lines (on stderr), e.g.
//   " * [new branch]      main -> origin/main"
//   "   a1b2c3..e5f6g7  feat -> origin/feat"
// NOTE: the gap between the summary and the local ref is a SINGLE `\s+`, not
// `\s{2,}`: git pads the summary to a fixed column, so a long summary (e.g. a
// `abc...def` forced-update range, one char wider than a `abc..def` range) can
// leave only one space before the ref. The wide alignment padding sits between
// the local ref and `->`, which the later `\s+` absorbs.
const REF_UPDATE_RE =
    /^\s*(?:[+ *t!=-])\s+(.+?)\s+([\w./-]+)\s+->\s+([\w./-]+)\s*(?:\((.*?)\))?$/;
// A sha range in a summary: "abc1234..def5678" (fast-forward, two dots) or
// "abc1234...def5678" (forced update / forced push, three dots).
const OID_RANGE_RE = /^([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})$/;
// push `--porcelain` status line: "<flag>\t<from>:<to>\t<summary>".
const PORCELAIN_RE = /^([ +\-*!=])\t([^\t]+)\t(.*)$/;

const refUpdateFrom = (
    summary: string,
    localRef: string,
    remoteRef: string,
    status?: string,
): SyncRefUpdate => {
    const range = OID_RANGE_RE.exec(summary);
    return new SyncRefUpdate({
        _tag: 'refUpdate',
        summary,
        localRef,
        remoteRef,
        // git abbreviates the range hashes (7–40 hex); surface them as-is, NOT as a
        // full `Oid` (SY-026).
        fromAbbrev: range ? range[1] : undefined,
        toAbbrev: range ? range[2] : undefined,
        status,
    });
};

/** Classify a single fetch/pull line into 0-or-1 SyncEvent. */
const classifyFetchPullLine = (line: GitLine): SyncEvent[] => {
    const text = line.text;
    const m = REF_UPDATE_RE.exec(text);
    if (m) {
        const status = (m[4] ?? '').trim();
        return [
            refUpdateFrom(
                (m[1] ?? '').trim(),
                m[2] ?? '',
                m[3] ?? '',
                status === '' ? undefined : status,
            ),
        ];
    }
    // Skip git header lines like "From <url>" / "To <url>".
    if (/^(?:From|To)\s+\S/.test(text)) return [];
    return [new SyncProgressEvent({ _tag: 'progress', text })];
};

/** Classify a single push line. Ref status comes from `--porcelain` stdout. */
const classifyPushLine = (line: GitLine): SyncEvent[] => {
    if (line.source === 'stdout') {
        const m = PORCELAIN_RE.exec(line.text);
        if (m) {
            const flag = m[1] ?? '';
            // A rejected ref ("!") drives the terminal failure (classifyPushFailure); it
            // is not a successful update, so emit no refUpdate for it.
            if (flag === '!') return [];
            const fromTo = m[2] ?? '';
            const rawSummary = m[3] ?? '';
            const colon = fromTo.indexOf(':');
            const from = colon >= 0 ? fromTo.slice(0, colon) : fromTo;
            const to = colon >= 0 ? fromTo.slice(colon + 1) : fromTo;
            // git appends a trailing " (forced update)" / "(non-fast-forward)" to the
            // porcelain summary; split it off so the range still parses (SY-026) and
            // the status surfaces, mirroring the fetch/pull path.
            const paren = rawSummary.match(/\s*\(([^)]*)\)\s*$/);
            const status = paren?.[1];
            const summary =
                paren?.index !== undefined
                    ? rawSummary.slice(0, paren.index).trim()
                    : rawSummary.trim();
            return [refUpdateFrom(summary, from, to, status)];
        }
        // "To <url>" / "Done" porcelain headers carry no event.
        if (/^(?:To\s+\S|Done$)/.test(line.text)) return [];
        return [new SyncProgressEvent({ _tag: 'progress', text: line.text })];
    }
    // Progress (Counting/Compressing/Writing objects …) arrives on stderr.
    return [new SyncProgressEvent({ _tag: 'progress', text: line.text })];
};

// ─── terminal failure classifiers (deterministic; exit status + stable tokens) ─

/** A push rejected as non-fast-forward → `nonFastForward`; else generic. */
const classifyPushFailure = (
    exitCode: number | null,
    stdout: string,
    stderr: string,
): GitError => {
    for (const raw of stdout.split('\n')) {
        if (
            raw.startsWith('!') &&
            (raw.includes('(non-fast-forward)') ||
                raw.includes('(fetch first)'))
        ) {
            return gitError(
                'nonFastForward',
                'push rejected: the remote has commits the local branch lacks (non-fast-forward)',
            );
        }
    }
    return classifyExit(exitCode, stderr);
};

/** Pull failures: conflicts → `mergeConflict`; ff-only divergence → `nonFastForward`. */
const classifyPullFailure =
    (mode: 'ff-only' | 'rebase' | 'merge') =>
    (exitCode: number | null, stdout: string, stderr: string): GitError => {
        const combined = stdout + stderr;
        // SY-013: merge/rebase conflicts — mirror the stash/merge CONFLICT-token style,
        // leaving the in-progress state for the Phase-4 conflict flow (no auto-abort).
        if (combined.includes('CONFLICT')) {
            return gitError('mergeConflict', 'pull produced conflicts');
        }
        // SY-012: an --ff-only pull that cannot fast-forward (divergence). git prints
        // the stable "Not possible to fast-forward" under LC_ALL=C.
        if (
            mode === 'ff-only' &&
            combined.includes('Not possible to fast-forward')
        ) {
            return gitError(
                'nonFastForward',
                'cannot fast-forward: the branch has diverged from its upstream',
            );
        }
        return classifyExit(exitCode, stderr);
    };

// ─── streams ──────────────────────────────────────────────────────────────────

// REQ-P3-SY-001/002/003
export const fetchStream = (
    cwd: string,
    remote?: string,
    all?: boolean,
    prune?: boolean,
    tags?: boolean,
    env?: NodeJS.ProcessEnv,
): Stream.Stream<SyncEvent, GitError> =>
    Stream.unwrap(
        Effect.gen(function* () {
            const args: string[] = ['fetch', '--progress'];
            if (all) {
                args.push('--all');
            } else if (remote) {
                const safeRemote = yield* assertNoLeadingDash(remote, 'remote');
                args.push(safeRemote);
            }
            if (prune) args.push('--prune');
            if (tags) args.push('--tags');

            return streamGit({ cwd, args, env, read: false }).pipe(
                Stream.map(classifyFetchPullLine),
                Stream.flattenIterable,
            );
        }),
    );

// REQ-P3-SY-010/011/012/013
export const pullStream = (
    cwd: string,
    mode: 'ff-only' | 'rebase' | 'merge',
    autostash?: boolean,
    env?: NodeJS.ProcessEnv,
): Stream.Stream<SyncEvent, GitError> => {
    const args: string[] = ['pull', '--progress'];
    if (mode === 'ff-only') args.push('--ff-only');
    else if (mode === 'rebase') args.push('--rebase');
    else args.push('--no-rebase');
    if (autostash) args.push('--autostash');

    return streamGit({
        cwd,
        args,
        env,
        read: false,
        classifyFailure: classifyPullFailure(mode),
    }).pipe(Stream.map(classifyFetchPullLine), Stream.flattenIterable);
};

// REQ-P3-SY-020/021/022/023/025/026
export const pushStream = (
    cwd: string,
    remote: string,
    branch?: string,
    setUpstream?: boolean,
    forceWithLease?: boolean,
    tags?: boolean,
    env?: NodeJS.ProcessEnv,
): Stream.Stream<SyncEvent, GitError> =>
    Stream.unwrap(
        Effect.gen(function* () {
            const safeRemote = yield* assertNoLeadingDash(remote, 'remote');
            // `--porcelain` gives a STABLE, machine-readable per-ref status (flag + range)
            // so non-fast-forward detection never depends on localized prose (SY-025/026).
            const args: string[] = [
                'push',
                '--porcelain',
                '--progress',
                safeRemote,
            ];
            if (branch) {
                const safeBranch = yield* assertNoLeadingDash(branch, 'branch');
                args.push(safeBranch);
            }
            if (setUpstream) args.push('--set-upstream');
            if (forceWithLease) args.push('--force-with-lease');
            if (tags) args.push('--tags');

            return streamGit({
                cwd,
                args,
                env,
                read: false,
                classifyFailure: classifyPushFailure,
            }).pipe(Stream.map(classifyPushLine), Stream.flattenIterable);
        }),
    );

// REQ-P3-SY-024
export const pushDeleteRemoteRef = (
    cwd: string,
    remote: string,
    ref: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
    Effect.gen(function* () {
        const safeRemote = yield* assertNoLeadingDash(remote, 'remote');
        const safeRef = yield* assertNoLeadingDash(ref, 'ref');
        yield* runGitOk({
            cwd,
            args: ['push', safeRemote, '--delete', safeRef],
            env,
            read: false,
        });
    });
