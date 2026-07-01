// `git init` argv builder + the create-then-init effect (docs/spec/17 REQ-P6-INIT-*).
// The repo is initialized with cwd = the destination directory, so no path argument is
// passed. `--initial-branch` is `=`-joined so the value can never be mistaken for a
// separate flag; git validates the ref name itself. When the destination does not exist,
// exactly one leaf directory is created (never a deep path — a missing parent is a clear
// `fsError`, REQ-P6-INIT-004).

import { mkdir } from 'node:fs/promises';

import { type GitError } from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { classifyNodeError } from './errors';
import { runGitOk } from './run-git';

export interface InitOptions {
    readonly bare?: boolean;
    readonly defaultBranch?: string;
}

export const initArgs = (opts: InitOptions): string[] => {
    const args = ['init'];
    if (opts.bare) args.push('--bare');
    const branch = opts.defaultBranch?.trim();
    if (branch !== undefined && branch !== '') {
        args.push(`--initial-branch=${branch}`);
    }
    return args;
};

/**
 * Create the leaf directory if it does not exist (single level, no `recursive`), then run
 * `git init` inside it. `existed` is true when the destination already exists as a
 * (non-repository) directory, so the mkdir is skipped. A missing parent surfaces as
 * `fsError`, a non-writable parent as `permissionDenied` (via {@link classifyNodeError}).
 */
export const initRepo = (
    path: string,
    opts: InitOptions,
    existed: boolean,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
    Effect.gen(function* () {
        if (!existed) {
            yield* Effect.tryPromise({
                try: () => mkdir(path),
                catch: classifyNodeError,
            });
        }
        yield* runGitOk({ cwd: path, args: initArgs(opts), read: false, env });
    });
