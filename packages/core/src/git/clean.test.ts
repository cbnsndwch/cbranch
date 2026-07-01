import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { run } from '../testing/effect-run';
import {
    createFixtureWorkspace,
    type FixtureWorkspace,
} from '../testing/fixtures';
import {
    clean,
    cleanArgs,
    cleanPreview,
    cleanPreviewArgs,
    countRemoved,
    parseCleanPreview,
} from './clean';

describe('clean argv builders (pure)', () => {
    test('preview toggles -d / -x', () => {
        expect(cleanPreviewArgs(false, false)).toEqual(['clean', '-n']);
        expect(cleanPreviewArgs(true, false)).toEqual(['clean', '-n', '-d']);
        expect(cleanPreviewArgs(true, true)).toEqual([
            'clean',
            '-n',
            '-d',
            '-x',
        ]);
    });

    test('destructive run is force + path-explicit after --', () => {
        expect(cleanArgs(['a.txt', 'dist/'], true, false)).toEqual([
            'clean',
            '-f',
            '-d',
            '--',
            'a.txt',
            'dist/',
        ]);
        expect(cleanArgs(['x'], false, true)).toEqual([
            'clean',
            '-f',
            '-x',
            '--',
            'x',
        ]);
    });
});

describe('parseCleanPreview', () => {
    test("files vs directories; drops non-'Would remove' lines", () => {
        const entries = parseCleanPreview(
            [
                'Would remove build.log',
                'Would remove dist/',
                'Skipping repository nested/',
                '',
            ].join('\n'),
        );
        expect(entries).toEqual([
            { path: 'build.log', isDirectory: false },
            { path: 'dist/', isDirectory: true },
        ]);
    });

    test('spaces and unicode are raw; control bytes are C-unquoted', () => {
        const entries = parseCleanPreview(
            [
                'Would remove my file.txt',
                'Would remove café.txt',
                'Would remove "a\\tb.txt"',
                'Would remove "weird\\ndir/"',
            ].join('\n'),
        );
        expect(entries.map(e => e.path)).toEqual([
            'my file.txt',
            'café.txt',
            'a\tb.txt',
            'weird\ndir/',
        ]);
        expect(entries[3]?.isDirectory).toBe(true);
    });

    test('octal escapes are unquoted (control bytes under core.quotePath=false)', () => {
        // Even with core.quotePath=false, git C-quotes control bytes octally (e.g. \001),
        // so the parser must decode 1–3 digit octal escapes back to their byte.
        const entries = parseCleanPreview(
            [
                'Would remove "\\001ctrl.txt"',
                'Would remove "tab\\011sep.txt"',
            ].join('\n'),
        );
        expect(entries.map(e => e.path)).toEqual([
            String.fromCharCode(1) + 'ctrl.txt',
            'tab\tsep.txt',
        ]);
    });
});

describe('countRemoved', () => {
    test("counts only the 'Removing ' lines git actually printed", () => {
        expect(
            countRemoved(
                [
                    'Removing a.txt',
                    'Removing sub/',
                    'Skipping repository nested/',
                    '',
                ].join('\n'),
            ),
        ).toBe(2);
        expect(countRemoved('')).toBe(0);
    });
});

describe('clean git operations', () => {
    let ws: FixtureWorkspace;
    beforeAll(async () => {
        ws = await createFixtureWorkspace();
    });
    afterAll(async () => {
        await ws.cleanup();
    });

    test('preview lists untracked files and directories (with -d)', async () => {
        const repo = await ws.createRepo('clean-preview');
        await repo.commit({ message: 'init', files: { 'tracked.txt': 't\n' } });
        await repo.writeFile('untracked.txt', 'u\n');
        await repo.writeFile('sub/inner.txt', 'i\n');

        const preview = await run(cleanPreview(repo.dir, true, false));
        const paths = preview.entries.map(e => e.path);

        expect(paths).toContain('untracked.txt');
        expect(paths).toContain('sub/');
        expect(preview.entries.find(e => e.path === 'sub/')?.isDirectory).toBe(
            true,
        );
        // The tracked file is never previewed for removal (REQ-P5-CL-004).
        expect(paths).not.toContain('tracked.txt');
    });

    test('clean removes exactly the previewed paths and reports the count', async () => {
        const repo = await ws.createRepo('clean-run');
        await repo.commit({ message: 'init', files: { 'tracked.txt': 't\n' } });
        await repo.writeFile('a.txt', 'a\n');
        await repo.writeFile('sub/inner.txt', 'i\n');

        const result = await run(
            clean(repo.dir, ['a.txt', 'sub/'], true, false),
        );

        expect(result.removed).toBe(2);
        expect(existsSync(join(repo.dir, 'a.txt'))).toBe(false);
        expect(existsSync(join(repo.dir, 'sub'))).toBe(false);
        // Tracked content is untouched.
        expect(existsSync(join(repo.dir, 'tracked.txt'))).toBe(true);
    });

    test("removed count is git's actual output, not the requested count", async () => {
        const repo = await ws.createRepo('clean-toctou');
        await repo.commit({ message: 'init', files: { 'tracked.txt': 't\n' } });
        await repo.writeFile('real.txt', 'r\n');

        // Request two paths but only one exists (a previewed path can vanish before the
        // run — TOCTOU). git removes just `real.txt`, so `removed` must be 1, not 2.
        const result = await run(
            clean(repo.dir, ['real.txt', 'gone.txt'], false, false),
        );

        expect(result.removed).toBe(1);
        expect(existsSync(join(repo.dir, 'real.txt'))).toBe(false);
    });

    test('empty paths is a no-op: removed:0, no git invoked (worktree untouched)', async () => {
        const repo = await ws.createRepo('clean-empty');
        await repo.commit({ message: 'init', files: { 'tracked.txt': 't\n' } });
        await repo.writeFile('keep.txt', 'k\n');

        const result = await run(clean(repo.dir, [], true, false));

        expect(result.removed).toBe(0);
        // The empty-pathspec guard ran NO git, so the untracked file survives.
        expect(existsSync(join(repo.dir, 'keep.txt'))).toBe(true);
    });

    test('empty paths is a no-op even outside a repository (proves no git ran)', async () => {
        const plain = await ws.createPlainDir('clean-empty-nonrepo');
        const result = await run(clean(plain, [], false, false));
        expect(result.removed).toBe(0);
    });

    test('preview / clean outside a repository fail as gitFailed', async () => {
        const plain = await ws.createPlainDir('clean-nonrepo');

        const previewErr = await Effect.runPromise(
            Effect.flip(cleanPreview(plain, false, false)),
        );
        const cleanErr = await Effect.runPromise(
            Effect.flip(clean(plain, ['x.txt'], false, false)),
        );

        expect(previewErr.code).toBe('gitFailed');
        expect(cleanErr.code).toBe('gitFailed');
    });
});
