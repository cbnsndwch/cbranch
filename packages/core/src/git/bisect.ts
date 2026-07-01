// Bisect (docs/spec/09 REQ-P5-BS-001..007; DECISIONS D18).
//
// Its own RPC quartet (start/mark/reset/status), NOT folded into the P4 continuation
// (P4 excluded bisect). Status is **machine-derived** — `git rev-list --bisect-vars`
// shell-vars + `refs/bisect/*` + HEAD — never the localized `Bisecting:` line (bisect's
// conclusion is NOT signalled by exit code). The ONE sanctioned prose read is the
// ambiguous "could be any of:" candidate block (skips can't isolate → `unbisectable`),
// for which git provides no machine form, parsed under the pinned `LC_ALL=C`. Mutations
// hold the repo lock; status is a lockless read. `concluded`/`unbisectable` are DATA
// states, not errors.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    type BisectMark,
    BisectStatus,
    type CommitSummary,
    type GitError,
    Oid,
} from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { detectInProgress } from '../repo/state';
import { classifyExit, gitError } from './errors';
import { LOG_FORMAT, parseCommitSummaries } from './history';
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from './run-git';

const FS = '\x1f';
const BAD_TERM = 'bad';
const GOOD_TERM = 'good';
// Full object id, hex — 40 (SHA-1) or 64 (SHA-256) chars (the "could be any of" block).
const HEX_OID = /^[0-9a-f]{40,64}$/;

const idle = (): BisectStatus =>
    new BisectStatus({
        state: 'inactive',
        badTerm: BAD_TERM,
        goodTerm: GOOD_TERM,
    });

/** Read the original HEAD bisect restores to (REQ-P5-BS-005); undefined if absent. */
const readStartPoint = (gitDir: string): string | undefined => {
    const file = join(gitDir, 'BISECT_START');
    if (!existsSync(file)) return undefined;
    const value = readFileSync(file, 'utf8').trim();
    return value === '' ? undefined : value;
};

/** Parse `refs/bisect/*` (`refname\x1foid` rows) into the bad oid + good oids. */
export const parseBisectRefs = (
    stdout: string,
): { bad?: string; goods: ReadonlyArray<string> } => {
    let bad: string | undefined;
    const goods: string[] = [];
    for (const line of stdout.split('\n')) {
        if (line === '') continue;
        const [refname, oid] = line.split(FS);
        if (refname === undefined || oid === undefined) continue;
        if (refname === 'refs/bisect/bad') bad = oid;
        else if (refname.startsWith('refs/bisect/good-')) goods.push(oid);
    }
    return { bad, goods };
};

/** Parse `key=value` `--bisect-vars` output (values may be quoted). */
export const parseBisectVars = (stdout: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line
            .slice(eq + 1)
            .trim()
            .replace(/^['"]|['"]$/g, '');
        if (key !== '') out[key] = value;
    }
    return out;
};

/** Parse the "could be any of:" full-oid block (skips can't isolate → unbisectable). */
export const parseUnbisectable = (text: string): ReadonlyArray<string> => {
    if (!/could be any of/i.test(text)) return [];
    const out: string[] = [];
    let collecting = false;
    for (const raw of text.split(/\r?\n/)) {
        if (/could be any of/i.test(raw)) {
            collecting = true;
            continue;
        }
        if (!collecting) continue;
        const line = raw.trim();
        if (HEX_OID.test(line)) out.push(line);
        else if (line !== '') break; // end of the sha block (e.g. "We cannot bisect more!")
    }
    return out;
};

const readCommit = (
    cwd: string,
    rev: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<CommitSummary | undefined, GitError> =>
    Effect.map(
        runGit({
            cwd,
            args: ['log', '-1', '-z', `--format=${LOG_FORMAT}`, rev],
            env,
        }),
        r => (r.exitCode === 0 ? parseCommitSummaries(r.stdout)[0] : undefined),
    );

/**
 * Derive the {@link BisectStatus} from on-disk machine state. `markStdout` (a mark
 * command's captured output) is consulted ONLY for the prose-only unbisectable block.
 */
export const computeBisectStatus = (
    cwd: string,
    gitDir: string,
    env?: NodeJS.ProcessEnv,
    markStdout?: string,
): Effect.Effect<BisectStatus, GitError> =>
    Effect.gen(function* () {
        if (!existsSync(join(gitDir, 'BISECT_LOG'))) return idle();
        const startPoint = readStartPoint(gitDir);

        if (markStdout !== undefined) {
            const candidates = parseUnbisectable(markStdout);
            if (candidates.length > 0) {
                return new BisectStatus({
                    state: 'unbisectable',
                    badTerm: BAD_TERM,
                    goodTerm: GOOD_TERM,
                    candidates: candidates.map(c => Oid.make(c)),
                    startPoint,
                });
            }
        }

        const refsResult = yield* runGit({
            cwd,
            args: [
                'for-each-ref',
                `--format=%(refname)${FS}%(objectname)`,
                'refs/bisect/',
            ],
            env,
        });
        const { bad, goods } = parseBisectRefs(decodeUtf8(refsResult.stdout));
        const current = yield* readCommit(cwd, 'HEAD', env);

        // Still seeding (need both a bad and ≥1 good before git checks out a midpoint).
        if (bad === undefined || goods.length === 0) {
            return new BisectStatus({
                state: 'bisecting',
                current,
                badTerm: BAD_TERM,
                goodTerm: GOOD_TERM,
                startPoint,
            });
        }

        const varsResult = yield* runGit({
            cwd,
            args: [
                'rev-list',
                '--bisect-vars',
                'refs/bisect/bad',
                '--not',
                ...goods,
            ],
            env,
        });
        const vars = parseBisectVars(decodeUtf8(varsResult.stdout));
        const rev = vars.bisect_rev;
        const nr = Number.parseInt(vars.bisect_nr ?? '', 10);
        const steps = Number.parseInt(vars.bisect_steps ?? '', 10);

        // Concluded ⟺ the remaining candidate IS the known-bad commit (machine check).
        if (rev !== undefined && rev === bad) {
            const firstBad = yield* readCommit(cwd, bad, env);
            return new BisectStatus({
                state: 'concluded',
                firstBad,
                current,
                badTerm: BAD_TERM,
                goodTerm: GOOD_TERM,
                startPoint,
            });
        }

        return new BisectStatus({
            state: 'bisecting',
            current,
            badTerm: BAD_TERM,
            goodTerm: GOOD_TERM,
            revisionsRemaining: Number.isNaN(nr) ? undefined : nr,
            stepsRemaining: Number.isNaN(steps) ? undefined : steps,
            startPoint,
        });
    });

export const bisectStart = (
    cwd: string,
    gitDir: string,
    bad?: string,
    good?: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<BisectStatus, GitError> =>
    Effect.gen(function* () {
        // Idle precheck: a different in-progress op fails fast (REQ "concurrent mutation").
        if (detectInProgress(gitDir) !== 'none') {
            return yield* Effect.fail(
                gitError('repoLocked', 'another operation is in progress'),
            );
        }
        // Goods seeded without a bad are silently dropped by `git bisect start`'s argv
        // (they would start a misleadingly empty session); fail clearly instead.
        if (bad === undefined && (good?.length ?? 0) > 0) {
            return yield* Effect.fail(
                gitError('gitFailed', 'bisect good seeds require a bad commit'),
            );
        }
        // Option-injection guard on every user-supplied seed (NF-SEC-6).
        const seed: string[] = [];
        if (bad !== undefined) {
            seed.push(yield* assertNoLeadingDash(bad, 'bisect bad'));
            for (const g of good ?? []) {
                seed.push(yield* assertNoLeadingDash(g, 'bisect good'));
            }
        }
        const result = yield* runGit({
            cwd,
            args: ['bisect', 'start', ...seed],
            read: false,
            env,
        });
        if (result.exitCode !== 0) {
            return yield* Effect.fail(
                classifyExit(result.exitCode, decodeUtf8(result.stderr)),
            );
        }
        return yield* computeBisectStatus(cwd, gitDir, env);
    });

export const bisectMark = (
    cwd: string,
    gitDir: string,
    mark: BisectMark,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<BisectStatus, GitError> =>
    Effect.gen(function* () {
        if (detectInProgress(gitDir) !== 'bisect') {
            return yield* Effect.fail(
                gitError('gitFailed', 'no bisect session in progress'),
            );
        }
        // good|bad|skip exit 0 on a normal step OR conclusion; outcome is read from
        // machine state, not the exit code.
        const result = yield* runGit({
            cwd,
            args: ['bisect', mark],
            read: false,
            env,
        });
        const markOut = `${decodeUtf8(result.stdout)}\n${decodeUtf8(result.stderr)}`;
        const status = yield* computeBisectStatus(cwd, gitDir, env, markOut);
        // A non-zero exit that did NOT resolve to a data outcome — git signals the
        // unbisectable (skips can't isolate) case with a non-zero exit, and conclusion
        // is also data — is a genuine mark failure, not a success-shaped status.
        if (
            result.exitCode !== 0 &&
            status.state !== 'unbisectable' &&
            status.state !== 'concluded'
        ) {
            return yield* Effect.fail(
                classifyExit(result.exitCode, decodeUtf8(result.stderr)),
            );
        }
        return status;
    });

export const bisectReset = (
    cwd: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
    Effect.map(
        runGitOk({ cwd, args: ['bisect', 'reset'], read: false, env }),
        () => undefined as void,
    );

export const bisectStatus = (
    cwd: string,
    gitDir: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<BisectStatus, GitError> =>
    computeBisectStatus(cwd, gitDir, env);
