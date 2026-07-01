import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runExit } from '../testing/effect-run';
import {
    createFixtureWorkspace,
    type FixtureWorkspace,
} from '../testing/fixtures';
import { mergeCreate, mergeAbort } from './merge';

describe('mergeCreate / mergeAbort', () => {
    let ws: FixtureWorkspace;

    beforeAll(async () => {
        ws = await createFixtureWorkspace();
    });

    afterAll(async () => {
        await ws.cleanup();
    });

    test('ff mode — fast-forward moves HEAD, returns fastForward + newTipOid', async () => {
        const repo = await ws.createRepo('merge-ff');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('feat');
        await repo.git(['switch', 'feat']);
        await repo.commit({ message: 'feat commit', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);

        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'feat', 'ff'),
        );

        expect(result.mode).toBe('fastForward');
        expect(result.newTipOid).toMatch(/^[0-9a-f]{40}$/);
    });

    test('ff mode — already up to date returns alreadyUpToDate', async () => {
        const repo = await ws.createRepo('merge-ff-uptodate');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('same');

        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'same', 'ff'),
        );

        expect(result.mode).toBe('alreadyUpToDate');
    });

    test('no-ff mode — creates a merge commit, returns commitOid', async () => {
        const repo = await ws.createRepo('merge-noff');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('noff-feat');
        await repo.git(['switch', 'noff-feat']);
        await repo.commit({ message: 'feat', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);
        // Add a commit on main so it diverges (forces a real merge, not a FF)
        await repo.commit({
            message: 'main progress',
            files: { 'c.txt': 'c' },
        });

        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'noff-feat', 'no-ff'),
        );

        expect(result.mode).toBe('merge');
        expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/);
    });

    test('squash mode — stages changes, no commit, returns staged=true', async () => {
        const repo = await ws.createRepo('merge-squash');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('sq-feat');
        await repo.git(['switch', 'sq-feat']);
        await repo.commit({ message: 'feat', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);

        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'sq-feat', 'squash'),
        );

        expect(result.mode).toBe('squash');
        expect(result.staged).toBe(true);
    });

    test('ff mode — divergent branches create a merge commit, reported as merge (MG-002)', async () => {
        const repo = await ws.createRepo('merge-ff-divergent');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('ff-feat');
        await repo.git(['switch', 'ff-feat']);
        await repo.commit({ message: 'feat', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);
        // Diverge: a non-conflicting commit on main forces a real merge commit.
        await repo.commit({
            message: 'main progress',
            files: { 'c.txt': 'c' },
        });

        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'ff-feat', 'ff'),
        );

        // The merge commit must NOT be mislabeled as a fast-forward.
        expect(result.mode).toBe('merge');
        expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/);
        expect(result.newTipOid).toBeUndefined();
    });

    test('ff-only mode — fast-forwards when possible', async () => {
        const repo = await ws.createRepo('merge-ffonly');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('ffo-feat');
        await repo.git(['switch', 'ffo-feat']);
        await repo.commit({ message: 'feat', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);

        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'ffo-feat', 'ff-only'),
        );

        expect(result.mode).toBe('fastForward');
        expect(result.newTipOid).toMatch(/^[0-9a-f]{40}$/);
    });

    test('ff-only mode — divergent branch fails with nonFastForward (MG-006)', async () => {
        const repo = await ws.createRepo('merge-ffonly-diverge');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('ffo-div');
        await repo.git(['switch', 'ffo-div']);
        await repo.commit({ message: 'feat', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);
        await repo.commit({
            message: 'main progress',
            files: { 'c.txt': 'c' },
        });

        const err = await Effect.runPromise(
            Effect.flip(mergeCreate(repo.dir, 'ffo-div', 'ff-only')),
        );
        expect(err.code).toBe('nonFastForward');

        // A failed --ff-only must NOT leave an in-progress merge.
        const merging = await repo.git(
            ['rev-parse', '--verify', 'MERGE_HEAD'],
            {
                allowFailure: true,
            },
        );
        expect(merging.code).not.toBe(0);
    });

    test('no-ff mode — uses an explicit, editable commit message (MG-003)', async () => {
        const repo = await ws.createRepo('merge-noff-msg');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        await repo.branch('msg-feat');
        await repo.git(['switch', 'msg-feat']);
        await repo.commit({ message: 'feat', files: { 'b.txt': 'b' } });
        await repo.git(['switch', 'main']);

        const message = 'Custom merge subject line';
        const result = await Effect.runPromise(
            mergeCreate(repo.dir, 'msg-feat', 'no-ff', message),
        );
        expect(result.mode).toBe('merge');

        const body = await repo.git(['log', '-1', '--format=%B']);
        expect(body.stdout).toContain(message);
    });

    test('ff mode — a conflicting merge is classified as mergeConflict (MG-005)', async () => {
        const repo = await ws.createRepo('merge-conflict');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a1\n' } });
        await repo.branch('cf-feat');
        await repo.git(['switch', 'cf-feat']);
        await repo.commit({
            message: 'feat',
            files: { 'a.txt': 'feat-change\n' },
        });
        await repo.git(['switch', 'main']);
        await repo.commit({
            message: 'main',
            files: { 'a.txt': 'main-change\n' },
        });

        const err = await Effect.runPromise(
            Effect.flip(mergeCreate(repo.dir, 'cf-feat', 'ff')),
        );
        expect(err.code).toBe('mergeConflict');

        await Effect.runPromise(mergeAbort(repo.dir));
    });

    test('mergeAbort — aborts an in-progress merge', async () => {
        const repo = await ws.createRepo('merge-abort');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a1' } });
        await repo.branch('conflict-feat');
        await repo.git(['switch', 'conflict-feat']);
        await repo.commit({
            message: 'feat',
            files: { 'a.txt': 'feat-change' },
        });
        await repo.git(['switch', 'main']);
        await repo.commit({
            message: 'main',
            files: { 'a.txt': 'main-change' },
        });

        // Trigger a conflicting merge (will fail with conflicts)
        await runExit(mergeCreate(repo.dir, 'conflict-feat', 'ff'));

        // Now abort
        await Effect.runPromise(mergeAbort(repo.dir));

        // After abort, git should have no MERGE_HEAD
        const raw = await repo.git(['rev-parse', '--verify', 'MERGE_HEAD'], {
            allowFailure: true,
        });
        expect(raw.code).not.toBe(0);
    });
});
