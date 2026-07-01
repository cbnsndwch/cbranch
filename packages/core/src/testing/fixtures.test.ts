import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
    createFixtureWorkspace,
    type FixtureWorkspace,
    fixtureDate,
    seedConflict,
    seedLinear,
} from './fixtures';

let ws: FixtureWorkspace;
beforeAll(async () => {
    ws = await createFixtureWorkspace();
});
afterAll(async () => {
    await ws.cleanup();
});

describe('deterministic fixtures (NF-TEST-4)', () => {
    test('identical declarative seeds produce identical commit hashes', async () => {
        const r1 = await ws.createRepo('det1');
        const r2 = await ws.createRepo('det2');
        const a = await seedLinear(r1);
        const b = await seedLinear(r2);
        expect(a).toEqual(b);
    });

    test('the first deterministic commit has a known stable hash', async () => {
        const repo = await ws.createRepo('known');
        const oid = await repo.commit({
            message: 'a',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        expect(oid).toBe('a4a762c87406a42d608f743b470bfd175e1a5829');
    });
});

describe('harness capabilities (NF-TEST-3)', () => {
    test('branches, tags (lightweight + annotated), and detached HEAD', async () => {
        const repo = await ws.createRepo('caps');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        await repo.branch('feature');
        await repo.tag('v1');
        await repo.tag('v2', { message: 'release 2' });
        await repo.commit({ message: 'second', files: { 'b.txt': 'b\n' } });

        const branches = (
            await repo.git(['branch', '--format=%(refname:short)'])
        ).stdout
            .split('\n')
            .filter(Boolean);
        expect(branches).toContain('feature');
        const tags = (await repo.git(['tag'])).stdout
            .split('\n')
            .filter(Boolean);
        expect(tags).toEqual(['v1', 'v2']);
        const v2Type = (await repo.git(['cat-file', '-t', 'v2'])).stdout.trim();
        expect(v2Type).toBe('tag'); // annotated

        await repo.checkout('HEAD', { detach: true });
        const sym = await repo.git(['symbolic-ref', '--quiet', 'HEAD'], {
            allowFailure: true,
        });
        expect(sym.code).not.toBe(0); // detached
    });

    test('merge commits + divergent history produce a 2-parent commit', async () => {
        const repo = await ws.createRepo('merge');
        await repo.commit({ message: 'base', files: { 'a.txt': 'a\n' } });
        await repo.branch('topic');
        await repo.commit({ message: 'main-side', files: { 'm.txt': 'm\n' } });
        await repo.checkout('topic');
        await repo.commit({ message: 'topic-side', files: { 't.txt': 't\n' } });
        await repo.checkout('main');
        const result = await repo.merge('topic', { noFastForward: true });
        expect(result.conflict).toBe(false);
        const parents = (
            await repo.git(['rev-list', '--parents', '-n', '1', 'HEAD'])
        ).stdout
            .trim()
            .split(' ');
        expect(parents).toHaveLength(3); // commit + 2 parents
    });

    test('conflicted index is produced by seedConflict', async () => {
        const repo = await ws.createRepo('conflict');
        await seedConflict(repo);
        const status = (await repo.git(['status', '--porcelain=v2', '-z']))
            .stdout;
        expect(status.split('\0').some(r => r.startsWith('u '))).toBe(true); // unmerged entry
    });

    test('a second on-disk repo serves as a local remote for fetch', async () => {
        const remote = await ws.createRepo('remote.git', { bare: true });
        const local = await ws.createRepo('local');
        await local.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        await local.addRemote('origin', remote.dir);
        await local.git(['push', '-q', 'origin', 'main']);
        await local.setUpstream('main', 'origin/main');
        await local.fetch('origin');
        const upstream = (
            await local.git(['rev-parse', '--abbrev-ref', 'main@{upstream}'])
        ).stdout.trim();
        expect(upstream).toBe('origin/main');
    });

    test('staged + dirty working tree are observable in status', async () => {
        const repo = await ws.createRepo('dirty');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        await repo.writeFile('a.txt', 'changed\n'); // unstaged
        await repo.writeFile('staged.txt', 's\n');
        await repo.stage('staged.txt'); // staged add
        const status = (
            await repo.git(['status', '--porcelain=v2', '-z'])
        ).stdout
            .split('\0')
            .filter(Boolean);
        expect(status.length).toBeGreaterThanOrEqual(2);
    });
});
