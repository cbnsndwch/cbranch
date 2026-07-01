// Git notes (docs/spec/17 REQ-P6-NOTE-001..005). View / add / edit / remove notes on the
// default `commits` notes ref (a selectable ref is supported). Editing rewrites the notes
// ref, never the commit — the commit's hash is unchanged. Absence of a note is an ordinary
// `present:false` result, not an error. All commands are non-interactive: the note body is
// supplied on stdin (`-F -`), never through a terminal editor.

import { type GitError, NoteContent, NotedObject } from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { gitError } from './errors';
import { decodeUtf8, runGit, runGitOk } from './run-git';

/** `--ref <ref>` for a non-default notes ref; the default (`commits`) needs no flag. */
const refArgs = (ref: string | undefined): string[] =>
    ref === undefined || ref === '' || ref === 'commits' ? [] : ['--ref', ref];

/** List the commits that carry a note. `git notes list` prints `<note> <annotated>` lines. */
export const notesList = (
    cwd: string,
    ref: string | undefined,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<ReadonlyArray<NotedObject>, GitError> =>
    Effect.map(
        runGit({ cwd, args: ['notes', ...refArgs(ref), 'list'], env }),
        result => {
            // A missing notes ref yields empty output (exit 0); non-zero here is a genuine
            // failure, but `list` on an absent ref is not — treat empty output as "no notes".
            if (result.exitCode !== 0) return [];
            return decodeUtf8(result.stdout)
                .split('\n')
                .map(line => line.trim())
                .filter(line => line !== '')
                .map(line => line.split(/\s+/)[1])
                .filter((oid): oid is string => oid !== undefined)
                .map(
                    oid => new NotedObject({ oid: oid as NotedObject['oid'] }),
                );
        },
    );

/** Read the note on a commit; a missing note is `present:false`, not an error. */
export const notesGet = (
    cwd: string,
    oid: string,
    ref: string | undefined,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<NoteContent, GitError> =>
    Effect.flatMap(
        runGit({ cwd, args: ['notes', ...refArgs(ref), 'show', oid], env }),
        result => {
            if (result.exitCode === 0) {
                return Effect.succeed(
                    new NoteContent({
                        present: true,
                        text: decodeUtf8(result.stdout),
                    }),
                );
            }
            const stderr = decodeUtf8(result.stderr);
            if (/no note found/i.test(stderr)) {
                return Effect.succeed(
                    new NoteContent({ present: false, text: '' }),
                );
            }
            return Effect.fail(
                gitError(
                    'gitFailed',
                    'notes show failed: ' + stderr.slice(0, 200),
                ),
            );
        },
    );

/** Add or edit a commit's note; the body is read from stdin (never an editor). */
export const notesSet = (
    cwd: string,
    oid: string,
    text: string,
    ref: string | undefined,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
    Effect.asVoid(
        runGitOk({
            cwd,
            args: ['notes', ...refArgs(ref), 'add', '-f', '-F', '-', oid],
            stdin: Buffer.from(text, 'utf8'),
            read: false,
            env,
        }),
    );

/** Remove a commit's note. */
export const notesRemove = (
    cwd: string,
    oid: string,
    ref: string | undefined,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
    Effect.asVoid(
        runGitOk({
            cwd,
            args: ['notes', ...refArgs(ref), 'remove', oid],
            read: false,
            env,
        }),
    );
