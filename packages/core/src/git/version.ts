// Host-`git` version gate (docs/spec/02 REQ-ARCH-025; NF-PKG-5).
//
// Run `git --version` ONCE at engine startup. Absent → `hostGitMissing`; below the
// 2.37 floor → `hostGitTooOld`. The detected version is then used to gate
// version-dependent flags so we never pass a flag the host git lacks (NF-PKG-5).

import { type GitError } from '@cbranch/rpc-contract';
import { GitError as GitErrorClass } from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { gitError } from './errors';
import { decodeUtf8, runGit } from './run-git';

/** Mandated minimum host Git version (NF-PKG-5: floor set by `--since-as-filter`). */
export const MIN_GIT_MAJOR = 2;
export const MIN_GIT_MINOR = 37;

export interface GitVersion {
    readonly raw: string;
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}

/** True when `v` is at least `major.minor` — for gating individual flags (NF-PKG-5). */
export const atLeast = (v: GitVersion, major: number, minor: number): boolean =>
    v.major > major || (v.major === major && v.minor >= minor);

/**
 * Detect + gate the host git version. The probe runs with `read: false` (no read
 * flags) because at this point we have not yet established that git works at all; a
 * spawn `ENOENT` is mapped to `hostGitMissing` by {@link runGit}'s classifier.
 */
export const detectGitVersion = (
    cwd: string,
): Effect.Effect<GitVersion, GitError> =>
    Effect.flatMap(
        runGit({ cwd, args: ['--version'], read: false }),
        result => {
            const classified = classifyVersionOutput(
                result.exitCode,
                decodeUtf8(result.stdout),
            );
            return classified instanceof GitErrorClass
                ? Effect.fail(classified)
                : Effect.succeed(classified);
        },
    );

/**
 * Pure version gate: interpret a `git --version` exit code + stdout into a
 * {@link GitVersion} or the appropriate `GitError`. Extracted from the spawn so the
 * missing/unparseable/too-old branches are unit-testable without a fake binary.
 */
export const classifyVersionOutput = (
    exitCode: number | null,
    stdout: string,
): GitVersion | GitError => {
    if (exitCode !== 0)
        return gitError('hostGitMissing', '`git --version` did not succeed');
    const parsed = parseGitVersion(stdout);
    if (parsed === null)
        return gitError(
            'hostGitMissing',
            'could not parse `git --version` output',
        );
    if (!atLeast(parsed, MIN_GIT_MAJOR, MIN_GIT_MINOR)) {
        return gitError(
            'hostGitTooOld',
            `host git ${parsed.raw} is below the required ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}`,
            {
                detected: parsed.raw,
                required: `${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}`,
            },
        );
    }
    return parsed;
};

/** Parse `git version 2.54.0.windows.1` → structured version (locale-independent). */
export const parseGitVersion = (output: string): GitVersion | null => {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
    if (match === null) return null;
    return {
        raw: output.trim(),
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: match[3] === undefined ? 0 : Number(match[3]),
    };
};
