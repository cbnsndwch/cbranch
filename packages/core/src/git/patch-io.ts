// Patch interchange (docs/spec/17 REQ-P6-PATCH-001..006). Export a commit range as a
// `format-patch` bundle (streamed over the side-channel), dry-run a patch, and apply it to
// the working tree / index / as commits (`git am`). All operations are non-interactive:
// `format-patch --stdout` avoids per-file writes, `git apply` reads the patch from stdin,
// and `git am` runs with a scripted editor so a conflict stops in a well-defined in-progress
// state (routed to the Phase 4 flow) rather than opening an editor.

import {
    type GitError,
    type PatchApplyMode,
    PatchApplyReport,
    PatchApplyResult,
    PatchBundleDescriptor,
} from '@cbranch/rpc-contract';
import { Effect, Stream } from 'effect';

import { detectInProgress } from '../repo/state';
import { gitError } from './errors';
import { decodeUtf8, runGit, type GitResult, streamGitBytes } from './run-git';

/** Reject an empty range or one that could be read as an option (leading dash). */
const safeRange = (range: string): boolean =>
    range.trim() !== '' && !range.trim().startsWith('-');

/** Validate a range and count its commits (0 = nothing to export). REQ-P6-PATCH-001. */
export const patchFormatPrepare = (
    cwd: string,
    range: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<PatchBundleDescriptor, GitError> => {
    const trimmed = range.trim();
    if (!safeRange(trimmed)) {
        return Effect.fail(gitError('gitFailed', 'invalid patch range'));
    }
    return Effect.flatMap(
        runGit({ cwd, args: ['rev-list', '--count', trimmed, '--'], env }),
        result => {
            if (result.exitCode !== 0) {
                return Effect.fail(
                    gitError(
                        'gitFailed',
                        'invalid range: ' +
                            decodeUtf8(result.stderr).slice(0, 200),
                    ),
                );
            }
            const count = Number.parseInt(decodeUtf8(result.stdout).trim(), 10);
            return Effect.succeed(
                new PatchBundleDescriptor({
                    range: trimmed,
                    count: Number.isNaN(count) ? 0 : count,
                    filename: 'cbranch.patch',
                }),
            );
        },
    );
};

/** Stream the `format-patch --stdout` mbox bytes for the range (the side-channel body). */
export const patchFormatStream = (
    cwd: string,
    range: string,
    includeCover: boolean,
    env?: NodeJS.ProcessEnv,
): Stream.Stream<Uint8Array, GitError> => {
    if (!safeRange(range)) {
        return Stream.fail(gitError('gitFailed', 'invalid patch range'));
    }
    const args = ['format-patch', range.trim(), '--stdout'];
    if (includeCover) args.push('--cover-letter');
    return streamGitBytes({ cwd, args, read: false, env });
};

/** Apply-mode flags for `git apply` (working = default, index = --cached). */
const applyModeArgs = (mode: PatchApplyMode): string[] =>
    mode === 'index' ? ['--cached'] : [];

/** Parse `git apply --numstat` output into the touched file paths. */
const numstatFiles = (stdout: string): string[] =>
    stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .map(line => line.split('\t')[2])
        .filter((p): p is string => p !== undefined && p !== '');

/**
 * Dry-run a patch (REQ-P6-PATCH-003): `git apply --check` reports whether it applies
 * cleanly without touching anything; `--numstat` lists the files it would touch. For the
 * `am` mode the same `git apply` probe stands in (format-patch output is apply-checkable).
 */
export const patchInspect = (
    cwd: string,
    patch: string,
    mode: PatchApplyMode,
    threeWay: boolean,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<PatchApplyReport, GitError> => {
    const stdin = Buffer.from(patch, 'utf8');
    const checkArgs = [
        'apply',
        '--check',
        '--recount',
        ...(mode === 'index' ? ['--cached'] : []),
        ...(threeWay ? ['--3way'] : []),
        '-',
    ];
    return Effect.gen(function* () {
        const check = yield* runGit({
            cwd,
            args: checkArgs,
            read: false,
            stdin,
            env,
        });
        const clean = check.exitCode === 0;
        // --numstat parses the patch headers even when it would not apply, so we always get
        // the file list; ignore its exit code.
        const stat = yield* runGit({
            cwd,
            args: ['apply', '--numstat', '--recount', '-'],
            read: false,
            stdin,
            env,
        });
        return new PatchApplyReport({
            clean,
            files: numstatFiles(decodeUtf8(stat.stdout)),
        });
    });
};

const applyResult = (
    result: GitResult,
    okMessage: string,
): Effect.Effect<PatchApplyResult, GitError> =>
    result.exitCode === 0
        ? Effect.succeed(
              new PatchApplyResult({ applied: true, message: okMessage }),
          )
        : Effect.fail(
              gitError(
                  'patchDoesNotApply',
                  decodeUtf8(result.stderr).slice(0, 300) ||
                      'the patch did not apply',
              ),
          );

/**
 * Apply a patch (REQ-P6-PATCH-002/003/004). working/index run `git apply` with a `--check`
 * pre-flight so a failure applies nothing; `am` runs `git am`, and a conflict leaves a
 * well-defined in-progress state (`inProgress: 'am'`) for the Phase 4 continue/skip/abort
 * flow rather than partially applying.
 */
export const patchApply = (
    cwd: string,
    gitDir: string,
    patch: string,
    mode: PatchApplyMode,
    threeWay: boolean,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<PatchApplyResult, GitError> => {
    const stdin = Buffer.from(patch, 'utf8');
    const threeWayArg = threeWay ? ['--3way'] : [];

    if (mode === 'working' || mode === 'index') {
        const args = [
            'apply',
            '--recount',
            ...applyModeArgs(mode),
            ...threeWayArg,
            '-',
        ];
        return Effect.gen(function* () {
            // Pre-flight check so a non-applying patch changes nothing (no partial apply).
            const check = yield* runGit({
                cwd,
                args: [
                    'apply',
                    '--check',
                    '--recount',
                    ...applyModeArgs(mode),
                    ...threeWayArg,
                    '-',
                ],
                read: false,
                stdin,
                env,
            });
            if (check.exitCode !== 0) {
                return yield* Effect.fail(
                    gitError(
                        'patchDoesNotApply',
                        decodeUtf8(check.stderr).slice(0, 300) ||
                            'the patch did not apply',
                    ),
                );
            }
            const applied = yield* runGit({
                cwd,
                args,
                read: false,
                stdin,
                env,
            });
            return yield* applyResult(applied, 'Patch applied.');
        });
    }

    // mode === 'am': apply as commits; a conflict stops in-progress for the Phase 4 flow.
    const amEnv: NodeJS.ProcessEnv = { ...env, GIT_EDITOR: 'true' };
    return Effect.map(
        runGit({
            cwd,
            args: ['am', ...threeWayArg],
            read: false,
            stdin,
            env: amEnv,
        }),
        result => {
            if (result.exitCode === 0) {
                return new PatchApplyResult({
                    applied: true,
                    message: 'Patch applied as commit(s).',
                });
            }
            // A stopped `git am` leaves a rebase-apply state; route it to the Phase 4 flow.
            const inProgress = detectInProgress(gitDir) === 'am';
            return new PatchApplyResult({
                applied: false,
                inProgress: inProgress ? 'am' : undefined,
                message: decodeUtf8(result.stderr).slice(0, 300),
            });
        },
    );
};
