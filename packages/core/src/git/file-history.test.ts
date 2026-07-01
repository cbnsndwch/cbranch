import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { run } from '../testing/effect-run';
import {
    createFixtureWorkspace,
    DEFAULT_IDENTITY,
    type FixtureRepo,
    type FixtureWorkspace,
    fixtureDate,
} from '../testing/fixtures';
import { fileHistory, parseFileHistory } from './file-history';

let ws: FixtureWorkspace;
beforeAll(async () => {
    ws = await createFixtureWorkspace();
});
afterAll(async () => {
    await ws.cleanup();
});

const commitEnv = (seq: number): NodeJS.ProcessEnv => ({
    GIT_AUTHOR_NAME: DEFAULT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: DEFAULT_IDENTITY.email,
    GIT_AUTHOR_DATE: fixtureDate(seq),
    GIT_COMMITTER_NAME: DEFAULT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: DEFAULT_IDENTITY.email,
    GIT_COMMITTER_DATE: fixtureDate(seq),
});

const hist = (
    repo: FixtureRepo,
    path: string,
    opts: { limit: number; cursor?: string; startRev?: string },
) => run(fileHistory(repo.dir, path, opts));

describe('parseFileHistory', () => {
    test('parses interleaved records, stripping the status newline and renames', () => {
        const REC = '\x01';
        const FSEP = '\x1f';
        const NUL = '\0';
        const oid1 = '1'.repeat(40);
        const oid2 = '2'.repeat(40);
        const sample =
            `${REC}${oid1}${FSEP}Ada${FSEP}ada@example.io${FSEP}2026-01-02${FSEP}edit${NUL}` +
            `\nM${NUL}new.txt${NUL}` +
            `${REC}${oid2}${FSEP}Bob${FSEP}bob@example.io${FSEP}2026-01-01${FSEP}rename${NUL}` +
            `\nR100${NUL}old.txt${NUL}new.txt${NUL}`;

        const entries = parseFileHistory(Buffer.from(sample, 'utf8'));
        expect(entries).toHaveLength(2);
        expect(entries[0]?.oid).toBe(oid1);
        expect(entries[0]?.status).toBe('modified');
        expect(entries[0]?.path).toBe('new.txt');
        expect(entries[0]?.authorEmail).toBe('ada@example.io');
        expect(entries[1]?.status).toBe('renamed');
        expect(entries[1]?.oldPath).toBe('old.txt');
        expect(entries[1]?.path).toBe('new.txt');
        expect(entries[1]?.renameScore).toBe(100);
    });
});

describe('fileHistory (REQ-FH-001..005; AC-13(08))', () => {
    test("lists a path's revisions newest-first with status", async () => {
        const repo = await ws.createRepo('fh-basic');
        await repo.commit({
            message: 'base',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        await repo.commit({
            message: 'add f',
            files: { 'f.txt': 'v1\n' },
            date: fixtureDate(2),
        });
        await repo.commit({
            message: 'modify f',
            files: { 'f.txt': 'v2\n' },
            date: fixtureDate(3),
        });

        const page = await hist(repo, 'f.txt', { limit: 50 });
        expect(page.entries).toHaveLength(2);
        expect(page.entries[0]?.subject).toBe('modify f');
        expect(page.entries[0]?.status).toBe('modified');
        expect(page.entries[1]?.subject).toBe('add f');
        expect(page.entries[1]?.status).toBe('added');
        expect(page.nextCursor).toBeUndefined();
    });

    test('follows a rename: includes pre-rename revisions + the prior path (AC-13)', async () => {
        const repo = await ws.createRepo('fh-rename');
        await repo.commit({
            message: 'base',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        await repo.commit({
            message: 'add old',
            files: { 'old.txt': 'orig\n' },
            date: fixtureDate(2),
        });
        await repo.git(['mv', 'old.txt', 'new.txt']);
        await repo.git(['commit', '-q', '-m', 'rename'], { env: commitEnv(3) });
        await repo.commit({
            message: 'edit new',
            files: { 'new.txt': 'orig\nmore\n' },
            date: fixtureDate(4),
        });

        const page = await hist(repo, 'new.txt', { limit: 50 });
        const subjects = page.entries.map(e => e.subject);
        expect(subjects).toEqual(['edit new', 'rename', 'add old']);
        const rename = page.entries.find(e => e.subject === 'rename');
        expect(rename?.status).toBe('renamed');
        expect(rename?.oldPath).toBe('old.txt');
        expect(rename?.path).toBe('new.txt');
        const intro = page.entries.find(e => e.subject === 'add old');
        expect(intro?.status).toBe('added');
        expect(intro?.path).toBe('old.txt');
    });

    test('paginates via the cursor', async () => {
        const repo = await ws.createRepo('fh-paginate');
        await repo.commit({
            message: 'base',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        for (let n = 1; n <= 5; n++) {
            // eslint-disable-next-line no-await-in-loop -- commits must be created in order (each builds on the prior).
            await repo.commit({
                message: `edit ${n}`,
                files: { 'f.txt': `v${n}\n` },
                date: fixtureDate(n + 1),
            });
        }

        const first = await hist(repo, 'f.txt', { limit: 2 });
        expect(first.entries).toHaveLength(2);
        expect(first.entries[0]?.subject).toBe('edit 5');
        expect(first.nextCursor).toBeDefined();

        const second = await hist(repo, 'f.txt', {
            limit: 2,
            cursor: first.nextCursor,
        });
        expect(second.entries).toHaveLength(2);
        expect(second.entries[0]?.subject).toBe('edit 3');
        expect(second.entries[0]?.oid).not.toBe(first.entries[0]?.oid);
    });

    test('an unborn HEAD yields an empty page', async () => {
        const repo = await ws.createRepo('fh-empty');
        const page = await hist(repo, 'anything.txt', { limit: 10 });
        expect(page.entries).toHaveLength(0);
        expect(page.nextCursor).toBeUndefined();
    });
});
