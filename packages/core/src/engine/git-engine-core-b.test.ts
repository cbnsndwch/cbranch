// core-B engine tests: history (log.stream), commit.detail, commit.diff,
// diff.workingFile, file.contentAtRev, and the repo.subscribe invalidation bus —
// exercised end-to-end through the live `GitEngine` against the fixture harness
// (NF-TEST-2/3/4; NF-TEST-10).

import { join } from 'node:path';

import {
    type CommitSummary,
    type DiffFile,
    type RepoId,
} from '@cbranch/rpc-contract';
import { DiffSpec, LogQuery, Oid as OidBrand } from '@cbranch/rpc-contract';
import { Effect, Fiber, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { nextLogCursor } from '../git/history';
import { type GitEngineApi, makeGitEngine } from '../index';
import { runScoped } from '../testing/effect-run';
import {
    createFixtureWorkspace,
    DEFAULT_IDENTITY,
    type FixtureWorkspace,
    fixtureDate,
} from '../testing/fixtures';

let ws: FixtureWorkspace;
let cfgSeq = 0;
const newCfg = (): string => join(ws.root, `coreb-config-${cfgSeq++}.json`);

const withEngine = <A, E>(
    configPath: string,
    f: (engine: GitEngineApi) => Effect.Effect<A, E>,
): Promise<A> => runScoped(Effect.flatMap(makeGitEngine({ configPath }), f));

const logQuery = (
    over: Partial<ConstructorParameters<typeof LogQuery>[0]> & {
        repoId: RepoId;
    },
): LogQuery => new LogQuery({ limit: 100, ...over });

const diffSpec = (
    over: Partial<ConstructorParameters<typeof DiffSpec>[0]> & {
        repoId: RepoId;
        target: string;
    },
): DiffSpec =>
    new DiffSpec({
        cached: false,
        whitespace: 'show',
        context: 3,
        renames: true,
        combined: false,
        ...over,
    });

const byNewPath = (
    files: ReadonlyArray<DiffFile>,
    p: string,
): DiffFile | undefined => files.find(f => f.newPath === p);

beforeAll(async () => {
    ws = await createFixtureWorkspace();
});
afterAll(async () => {
    await ws.cleanup();
});

describe('log.stream', () => {
    test('an empty (unborn) repo completes with zero rows, not an error', async () => {
        const repo = await ws.createRepo('log-empty');
        const cfg = newCfg();
        const rows = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                return yield* Stream.runCollect(
                    e.logStream(logQuery({ repoId: h.repoId, limit: 10 })),
                );
            }),
        );
        expect(rows).toEqual([]);
    });

    test('linear history streams newest-first in topo+date order', async () => {
        const repo = await ws.createRepo('log-linear');
        const a = await repo.commit({
            message: 'a',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        const b = await repo.commit({
            message: 'b',
            files: { 'b.txt': 'b\n' },
            date: fixtureDate(2),
        });
        const c = await repo.commit({
            message: 'c',
            files: { 'c.txt': 'c\n' },
            date: fixtureDate(3),
        });
        const cfg = newCfg();
        const oids = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const rows = yield* Stream.runCollect(
                    e.logStream(logQuery({ repoId: h.repoId })),
                );
                return rows.map((r: CommitSummary) => r.oid);
            }),
        );
        expect(oids).toEqual([c, b, a]);
    });

    test('a merge commit exposes its ordered parents', async () => {
        const repo = await ws.createRepo('log-merge');
        await repo.commit({
            message: 'base',
            files: { 'base.txt': '0\n' },
            date: fixtureDate(1),
        });
        await repo.branch('feature');
        const mainWork = await repo.commit({
            message: 'main',
            files: { 'm.txt': 'm\n' },
            date: fixtureDate(2),
        });
        await repo.checkout('feature');
        const featWork = await repo.commit({
            message: 'feat',
            files: { 'f.txt': 'f\n' },
            date: fixtureDate(3),
        });
        await repo.checkout('main');
        await repo.merge('feature', {
            noFastForward: true,
            message: 'merge feature',
        });
        const mergeOid = await repo.revParse('HEAD');
        const cfg = newCfg();

        const merge = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const rows = yield* Stream.runCollect(
                    e.logStream(
                        logQuery({ repoId: h.repoId, refScope: 'all' }),
                    ),
                );
                return rows.find((r: CommitSummary) => r.oid === mergeOid);
            }),
        );
        expect(merge).toBeDefined();
        expect(merge!.parents).toHaveLength(2);
        expect([...merge!.parents]).toEqual([mainWork, featWork]);
    });

    test('a grep filter narrows the result set (AC-8 mapping)', async () => {
        const repo = await ws.createRepo('log-filter');
        await repo.commit({
            message: 'alpha change',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        await repo.commit({
            message: 'beta change',
            files: { 'b.txt': 'b\n' },
            date: fixtureDate(2),
        });
        await repo.commit({
            message: 'alpha again',
            files: { 'c.txt': 'c\n' },
            date: fixtureDate(3),
        });
        const cfg = newCfg();
        const subjects = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const rows = yield* Stream.runCollect(
                    e.logStream(logQuery({ repoId: h.repoId, grep: 'alpha' })),
                );
                return rows.map((r: CommitSummary) => r.subject);
            }),
        );
        expect(subjects).toEqual(['alpha again', 'alpha change']);
    });

    test('cursor continuation resumes the same traversal across windows', async () => {
        const repo = await ws.createRepo('log-cursor');
        // Sequential (each commit builds on the prior HEAD) via a promise chain.
        const oids = await [1, 2, 3, 4, 5].reduce<Promise<string[]>>(
            async (accP, i) => {
                const acc = await accP;
                acc.push(
                    await repo.commit({
                        message: `c${i}`,
                        files: { [`f${i}.txt`]: `${i}\n` },
                        date: fixtureDate(i),
                    }),
                );
                return acc;
            },
            Promise.resolve([]),
        );
        const expected = oids.toReversed(); // newest-first
        const cfg = newCfg();

        const all = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const q1 = logQuery({ repoId: h.repoId, limit: 2 });
                const page1 = yield* Stream.runCollect(e.logStream(q1));
                const q2 = logQuery({
                    repoId: h.repoId,
                    limit: 2,
                    cursor: nextLogCursor(q1, page1) ?? undefined,
                });
                const page2 = yield* Stream.runCollect(e.logStream(q2));
                const q3 = logQuery({
                    repoId: h.repoId,
                    limit: 2,
                    cursor: nextLogCursor(q2, page2) ?? undefined,
                });
                const page3 = yield* Stream.runCollect(e.logStream(q3));
                return [...page1, ...page2, ...page3].map(
                    (r: CommitSummary) => r.oid,
                );
            }),
        );
        expect(all).toEqual(expected);
    });
});

describe('commit.detail', () => {
    test('returns structured signatures, split/raw message, and stats', async () => {
        const repo = await ws.createRepo('detail');
        await repo.commit({
            message: 'init',
            files: { 'a.txt': 'x\n' },
            date: fixtureDate(1),
        });
        const oid = await repo.commit({
            message: 'feat: do thing\n\nThis is the body.\nSecond line.',
            files: { 'a.txt': 'x\ny\n' },
            date: fixtureDate(2),
        });
        const cfg = newCfg();

        const detail = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                return yield* e.commitDetail(h.repoId, OidBrand.make(oid));
            }),
        );
        expect(detail.oid).toBe(oid);
        expect(detail.parents).toHaveLength(1);
        expect(detail.subject).toBe('feat: do thing');
        expect(detail.body).toBe('This is the body.\nSecond line.');
        expect(detail.messageRaw).toBe(
            'feat: do thing\n\nThis is the body.\nSecond line.',
        );
        expect(detail.author.name).toBe(DEFAULT_IDENTITY.name);
        expect(detail.author.email).toBe(DEFAULT_IDENTITY.email);
        expect(detail.author.when.tzOffsetMinutes).toBe(0); // fixtureDate is UTC (…Z)
        expect(typeof detail.author.when.epochSeconds).toBe('number');
        expect(detail.committer.name).toBe(DEFAULT_IDENTITY.name);
        expect(detail.tree).toMatch(/^[0-9a-f]+$/);
        expect(detail.stats.filesChanged).toBe(1);
        expect(detail.stats.additions).toBe(1);
        expect(detail.stats.deletions).toBe(0);
    });

    test('a root commit diffs against the empty tree for its stats', async () => {
        const repo = await ws.createRepo('detail-root');
        const root = await repo.commit({
            message: 'root',
            files: { 'a.txt': '1\n2\n', 'b.txt': 'x\n' },
            date: fixtureDate(1),
        });
        const cfg = newCfg();
        const detail = await withEngine(cfg, e =>
            Effect.flatMap(e.open(repo.dir), h =>
                e.commitDetail(h.repoId, OidBrand.make(root)),
            ),
        );
        expect(detail.parents).toEqual([]);
        expect(detail.stats.filesChanged).toBe(2);
        expect(detail.stats.additions).toBe(3);
        expect(detail.stats.deletions).toBe(0);
    });
});

describe('commit.diff', () => {
    test('classifies add / modify / delete / rename / binary against a base', async () => {
        const repo = await ws.createRepo('diff-mix');
        const c1 = await repo.commit({
            message: 'c1',
            files: {
                'a.txt': 'l1\nl2\nl3\n',
                'del.txt': 'bye\n',
                'mv.txt': 'move me\n',
            },
            date: fixtureDate(1),
        });
        // modify a.txt; delete del.txt; rename mv.txt -> moved.txt; add new.txt; add binary bin.dat
        await repo.writeFile('a.txt', 'l1\nCHANGED\nl3\nl4\n');
        await repo.writeFile('moved.txt', 'move me\n');
        await repo.writeFile('new.txt', 'new\n');
        await repo.writeFile('bin.dat', 'BIN\x00\x01\x00data');
        await repo.git(['rm', '-q', 'del.txt', 'mv.txt']);
        await repo.git(['add', '-A']);
        const c2 = await repo.commit({ message: 'c2', date: fixtureDate(2) });
        const cfg = newCfg();

        const files = await withEngine(cfg, e =>
            Effect.flatMap(e.open(repo.dir), h =>
                e.commitDiff(
                    diffSpec({ repoId: h.repoId, target: c2, base: c1 }),
                ),
            ),
        );
        const a = byNewPath(files, 'a.txt')!;
        expect(a.status).toBe('modified');
        expect(a.additions).toBe(2);
        expect(a.deletions).toBe(1);
        expect(a.hunks.length).toBeGreaterThan(0);

        expect(byNewPath(files, 'del.txt')!.status).toBe('deleted');
        expect(byNewPath(files, 'new.txt')!.status).toBe('added');

        const moved = byNewPath(files, 'moved.txt')!;
        expect(moved.status).toBe('renamed');
        expect(moved.oldPath).toBe('mv.txt');

        const bin = byNewPath(files, 'bin.dat')!;
        expect(bin.isBinary).toBe(true);
        expect(bin.additions).toBeNull();
        expect(bin.deletions).toBeNull();
        expect(bin.hunks).toHaveLength(0);
    });

    test('a root commit diffs against the empty tree (all files added)', async () => {
        const repo = await ws.createRepo('diff-root');
        const root = await repo.commit({
            message: 'root',
            files: { 'a.txt': '1\n', 'b.txt': '2\n' },
            date: fixtureDate(1),
        });
        const cfg = newCfg();
        const files = await withEngine(cfg, e =>
            Effect.flatMap(e.open(repo.dir), h =>
                e.commitDiff(diffSpec({ repoId: h.repoId, target: root })),
            ),
        );
        expect(files.map(f => f.status)).toEqual(['added', 'added']);
    });

    test('context and whitespace controls change the patch', async () => {
        const repo = await ws.createRepo('diff-ctl');
        const c1 = await repo.commit({
            message: 'c1',
            files: {
                'ctx.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n',
                'ws.txt': 'alpha\nbeta\ngamma\n',
            },
            date: fixtureDate(1),
        });
        const c2 = await repo.commit({
            message: 'c2',
            files: {
                'ctx.txt': '1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10\n',
                'ws.txt': 'alpha\nbeta \ngamma\n',
            },
            date: fixtureDate(2),
        });
        const cfg = newCfg();

        const out = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const ctx0 = yield* e.commitDiff(
                    diffSpec({
                        repoId: h.repoId,
                        target: c2,
                        base: c1,
                        context: 0,
                        paths: ['ctx.txt'],
                    }),
                );
                const ctx3 = yield* e.commitDiff(
                    diffSpec({
                        repoId: h.repoId,
                        target: c2,
                        base: c1,
                        context: 3,
                        paths: ['ctx.txt'],
                    }),
                );
                const wsShow = yield* e.commitDiff(
                    diffSpec({
                        repoId: h.repoId,
                        target: c2,
                        base: c1,
                        paths: ['ws.txt'],
                    }),
                );
                const wsIgnore = yield* e.commitDiff(
                    diffSpec({
                        repoId: h.repoId,
                        target: c2,
                        base: c1,
                        whitespace: 'ignore-all',
                        paths: ['ws.txt'],
                    }),
                );
                return {
                    ctx0Lines: ctx0[0]!.hunks[0]!.lines.length,
                    ctx3Lines: ctx3[0]!.hunks[0]!.lines.length,
                    wsShow: wsShow.length,
                    wsIgnore: wsIgnore.length,
                };
            }),
        );
        expect(out.ctx3Lines).toBeGreaterThan(out.ctx0Lines); // more context lines
        expect(out.wsShow).toBe(1); // whitespace-only change is visible
        expect(out.wsIgnore).toBe(0); // …and suppressed when ignored
    });
});

describe('diff.workingFile', () => {
    test('distinguishes staged from unstaged changes', async () => {
        const repo = await ws.createRepo('workingfile');
        await repo.commit({
            message: 'init',
            files: { 'a.txt': 'orig\n', 's.txt': 's0\n' },
            date: fixtureDate(1),
        });
        await repo.writeFile('a.txt', 'orig\nunstaged\n'); // unstaged
        await repo.writeFile('s.txt', 's0\nstaged\n');
        await repo.git(['add', 's.txt']); // staged
        const cfg = newCfg();

        const out = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const unstaged = yield* e.diffWorkingFile(
                    h.repoId,
                    'a.txt',
                    false,
                );
                const staged = yield* e.diffWorkingFile(
                    h.repoId,
                    's.txt',
                    true,
                );
                const sUnstaged = yield* e.diffWorkingFile(
                    h.repoId,
                    's.txt',
                    false,
                );
                return { unstaged, staged, sUnstaged };
            }),
        );
        expect(out.unstaged.status).toBe('modified');
        expect(out.unstaged.additions).toBe(1);
        expect(out.staged.status).toBe('modified');
        expect(out.staged.additions).toBe(1);
        expect(out.sUnstaged.status).toBe('unmodified'); // staged change is not in the worktree-vs-index diff
    });
});

describe('file.contentAtRev', () => {
    test('text returns inline utf8; binary returns inline base64', async () => {
        const repo = await ws.createRepo('content');
        await repo.commit({
            message: 'init',
            files: { 'hello.txt': 'hello\nworld\n', 'bin.dat': 'ab\x00cd' },
            date: fixtureDate(1),
        });
        const cfg = newCfg();

        const out = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const text = yield* e.fileContentAtRev(
                    h.repoId,
                    'hello.txt',
                    'HEAD',
                );
                const bin = yield* e.fileContentAtRev(
                    h.repoId,
                    'bin.dat',
                    'HEAD',
                );
                return { text, bin };
            }),
        );
        expect('encoding' in out.text && out.text.encoding).toBe('utf8');
        expect('content' in out.text && out.text.content).toBe(
            'hello\nworld\n',
        );
        expect('isBinary' in out.bin && out.bin.isBinary).toBe(true);
        expect('encoding' in out.bin && out.bin.encoding).toBe('base64');
        expect(
            'content' in out.bin &&
                Buffer.from(out.bin.content, 'base64').toString('latin1'),
        ).toBe('ab\x00cd');
    });

    test('content over the 10 MB inline cap returns a side-channel DownloadDescriptor', async () => {
        const repo = await ws.createRepo('content-big');
        const big = 'x'.repeat(11 * 1024 * 1024); // > NF-LIMIT-3 (10 MB)
        await repo.commit({
            message: 'big',
            files: { 'big.bin': big },
            date: fixtureDate(1),
        });
        const cfg = newCfg();

        const { result, repoId } = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const r = yield* e.fileContentAtRev(
                    h.repoId,
                    'big.bin',
                    'HEAD',
                );
                return { result: r, repoId: h.repoId as string };
            }),
        );
        expect('url' in result).toBe(true);
        if ('url' in result) {
            expect(result.url).toBe(
                `/sidechannel/blob?repoId=${repoId}&rev=HEAD&path=big.bin`,
            );
            expect(result.size).toBe(big.length);
            expect(result.filename).toBe('big.bin');
        }
    });
});

describe('repo.subscribe (NF-TEST-10 invalidation bus)', () => {
    test('an EXTERNAL git commit emits an InvalidationEvent and a subsequent read is not stale', async () => {
        const repo = await ws.createRepo('subscribe');
        await repo.commit({
            message: 'init',
            files: { 'a.txt': 'a\n' },
            date: fixtureDate(1),
        });
        const cfg = newCfg();

        const out = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const repoId = h.repoId;
                const fiber = yield* Effect.forkChild(
                    Stream.runCollect(Stream.take(e.subscribe(repoId), 1)),
                );
                yield* Effect.sleep('900 millis'); // let chokidar settle (ignoreInitial)
                // EXTERNAL mutation: a separate `git` process, exactly like a terminal commit.
                const external = yield* Effect.promise(() =>
                    repo.commit({
                        message: 'external',
                        files: { 'b.txt': 'b\n' },
                        date: fixtureDate(2),
                    }),
                );
                const events = yield* Fiber.join(fiber).pipe(
                    Effect.timeout('8 seconds'),
                );
                // A fresh read MUST reflect the external change (no stale pre-mutation data).
                const rows = yield* Stream.runCollect(
                    e.logStream(logQuery({ repoId, limit: 10 })),
                );
                return {
                    events,
                    oids: rows.map((r: CommitSummary) => r.oid),
                    external,
                };
            }),
        );

        expect(out.events).toHaveLength(1);
        const domains = [...out.events[0]!.domains];
        expect(domains).toContain('commits');
        expect(domains).toContain('refs');
        expect(out.oids).toContain(out.external);
    });
});
