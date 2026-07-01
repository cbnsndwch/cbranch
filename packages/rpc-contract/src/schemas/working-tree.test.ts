// Contract round-trip tests for the P2 working-tree Schemas (P2-PLAN §6; NF-TEST-5).
//
// Each named record encodes to a plain JSON-safe value and decodes back to an
// equivalent instance (no `undefined`-only distinctions — DM-003), and a malformed
// payload is rejected as a typed failure rather than a throw. Representative instances
// exercise both the all-required and the optional-present field shapes.

import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { Oid, RepoId } from './primitives';
import {
    CommitCreated,
    CommitInput,
    CommitMessage,
    HunkSelection,
    PatchSelection,
    StatusBranch,
    StatusEntry,
    WorkingTreeStatus,
} from './working-tree';

const repoId = RepoId.make('a'.repeat(64));
const oid = Oid.make('1'.repeat(40));

const statusEntry = new StatusEntry({
    path: 'src/app.ts',
    origPath: 'src/old.ts',
    staged: 'renamed',
    unstaged: 'modified',
    isConflicted: false,
    isUntracked: false,
    isIgnored: false,
    similarity: 87,
    isSubmodule: false,
    stagedMode: '100644',
    worktreeMode: '100644',
});

const statusBranch = new StatusBranch({
    head: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    oid,
});

const workingTreeStatus = new WorkingTreeStatus({
    entries: [statusEntry],
    branch: statusBranch,
    hasConflicts: false,
});

const patchSelection = new PatchSelection({
    repoId,
    path: 'src/app.ts',
    hunks: [
        new HunkSelection({
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            selectedLines: [2, 3],
        }),
    ],
});

const commitInput = new CommitInput({
    repoId,
    subject: 'feat: add thing',
    body: 'the body',
    amend: false,
    signoff: true,
    sign: { format: 'ssh', keyId: 'key-1' },
    authorOverride: { name: 'Ada', email: 'ada@example.io' },
    allowEmpty: false,
    noVerify: false,
});

const commitCreated = new CommitCreated({
    oid,
    shortOid: '1111111',
    subject: 'feat: add thing',
});
const commitMessage = new CommitMessage({
    subject: 'feat: add thing',
    body: 'the body',
    raw: 'feat: add thing\n\nthe body',
});

const cases: ReadonlyArray<
    readonly [string, Schema.Codec<unknown, unknown>, unknown]
> = [
    ['StatusEntry', StatusEntry, statusEntry],
    ['StatusBranch', StatusBranch, statusBranch],
    ['WorkingTreeStatus', WorkingTreeStatus, workingTreeStatus],
    ['PatchSelection', PatchSelection, patchSelection],
    ['CommitInput', CommitInput, commitInput],
    ['CommitCreated', CommitCreated, commitCreated],
    ['CommitMessage', CommitMessage, commitMessage],
];

describe('working-tree Schemas round-trip (encode → decode)', () => {
    test.each(cases)(
        '%s encodes JSON-safe and decodes back unchanged',
        (_name, schema, instance) => {
            const encoded = Schema.encodeUnknownSync(schema)(instance);
            expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
            expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(instance);
        },
    );

    test('optional fields may be absent (minimal instances decode)', () => {
        const minimal = new StatusEntry({
            path: 'untracked.txt',
            staged: 'unmodified',
            unstaged: 'untracked',
            isConflicted: false,
            isUntracked: true,
            isIgnored: false,
            isSubmodule: false,
        });
        const encoded = Schema.encodeUnknownSync(StatusEntry)(minimal);
        expect(Schema.decodeUnknownSync(StatusEntry)(encoded)).toEqual(minimal);
        expect('origPath' in (encoded as object)).toBe(false);
    });

    test('a malformed WorkingTreeStatus is a typed failure, not a throw', () => {
        const exit = Schema.decodeUnknownExit(WorkingTreeStatus)({
            entries: 'nope',
            hasConflicts: 1,
        });
        expect(exit._tag).toBe('Failure');
    });
});
