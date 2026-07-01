import { join } from 'node:path';

import { type GitError, type RepoId } from '@cbranch/rpc-contract';
import { Oid as OidBrand, RepoId as RepoIdBrand } from '@cbranch/rpc-contract';
import { Effect, Exit } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runGit } from '../git/run-git';
import { type GitEngineApi, makeGitEngine } from '../index';
import { runScoped } from '../testing/effect-run';
import {
    createFixtureWorkspace,
    type FixtureWorkspace,
} from '../testing/fixtures';

let ws: FixtureWorkspace;
let cfgSeq = 0;
const newCfg = (): string => join(ws.root, `engine-config-${cfgSeq++}.json`);

const withEngine = <A, E>(
    configPath: string,
    f: (engine: GitEngineApi) => Effect.Effect<A, E>,
): Promise<A> => runScoped(Effect.flatMap(makeGitEngine({ configPath }), f));

// Collapse an op to a comparable label — "ok" on success, else the GitError.code —
// so two concurrently-raced ops can be compared without digging into Exit causes.
const outcome = <A>(eff: Effect.Effect<A, GitError>): Effect.Effect<string> =>
    Effect.match(eff, { onSuccess: () => 'ok', onFailure: err => err.code });

beforeAll(async () => {
    ws = await createFixtureWorkspace();
});
afterAll(async () => {
    await ws.cleanup();
});

describe('GitEngine repo.* (P1, core-A)', () => {
    test('open returns identity + state and records the repo in the recent list (AC-1)', async () => {
        const repo = await ws.createRepo('openme');
        const oid = await repo.commit({
            message: 'init',
            files: { 'a.txt': 'a\n' },
        });
        const cfg = newCfg();

        const { handle, recents } = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const list = yield* e.recentList();
                return { handle: h, recents: list };
            }),
        );

        expect(handle.repoId).toMatch(/^[0-9a-f]{64}$/);
        expect(handle.state.headOid).toBe(oid);
        expect(handle.state.currentBranch).toBe('main');
        expect(recents).toHaveLength(1);
        expect(recents[0]?.repoId).toBe(handle.repoId);
        expect(recents[0]?.name).toBe('openme');
    });

    test('recent list orders most-recent-first and dedupes; remove drops it (AC-3)', async () => {
        const a = await ws.createRepo('repoA');
        const b = await ws.createRepo('repoB');
        await a.commit({ message: 'a' });
        await b.commit({ message: 'b' });
        const cfg = newCfg();

        const order = await withEngine(cfg, e =>
            Effect.gen(function* () {
                yield* e.open(a.dir);
                yield* e.open(b.dir);
                yield* e.open(a.dir); // re-open A → back to the top
                const recents = yield* e.recentList();
                return recents.map(r => r.name);
            }),
        );
        expect(order).toEqual(['repoA', 'repoB']);

        // Removal persists to the shared config; a fresh engine sees it gone.
        const bId = await withEngine(cfg, e =>
            Effect.map(
                e.recentList(),
                r => r.find(x => x.name === 'repoB')?.repoId,
            ),
        );
        const after = await withEngine(cfg, e =>
            Effect.gen(function* () {
                yield* e.recentRemove(bId as RepoId);
                return yield* e.recentList();
            }),
        );
        expect(after.map(r => r.name)).toEqual(['repoA']);
    });

    test('a failed open does not modify the recent list (AC-2)', async () => {
        const good = await ws.createRepo('good');
        await good.commit({ message: 'init' });
        const plain = await ws.createPlainDir('notarepo');
        const cfg = newCfg();

        const { failed, recents } = await withEngine(cfg, e =>
            Effect.gen(function* () {
                yield* e.open(good.dir);
                const exit = yield* Effect.exit(e.open(plain));
                const list = yield* e.recentList();
                return { failed: Exit.isFailure(exit), recents: list };
            }),
        );
        expect(failed).toBe(true);
        expect(recents).toHaveLength(1);
        expect(recents[0]?.name).toBe('good');
    });

    test('state(repoId) resolves an opened repo and rejects an unknown one', async () => {
        const repo = await ws.createRepo('statey');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();

        const { state, unknownErr } = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const handle = yield* e.open(repo.dir);
                const st = yield* e.state(handle.repoId);
                const errUnknown = yield* Effect.flip(
                    e.state(RepoIdBrand.make('f'.repeat(64))),
                );
                return { state: st, unknownErr: errUnknown };
            }),
        );
        expect(state.currentBranch).toBe('main');
        expect(unknownErr.code).toBe('repoUnavailable');
    });

    test('a restarted engine answers state(repoId) via the recent-list fallback', async () => {
        const repo = await ws.createRepo('restart');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();

        const repoId = await withEngine(cfg, e =>
            Effect.map(e.open(repo.dir), h => h.repoId),
        );
        // Fresh engine, same config — never called open, must resolve via recent list.
        const state = await withEngine(cfg, e => e.state(repoId));
        expect(state.currentBranch).toBe('main');
        expect(state.isEmpty).toBe(false);
    });

    test('object-read infra works through the engine (for core-B)', async () => {
        const repo = await ws.createRepo('objread');
        await repo.commit({ message: 'init', files: { 'a.txt': 'hello\n' } });
        const cfg = newCfg();

        const blob = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const handle = yield* e.open(repo.dir);
                return yield* e.readObject(handle.repoId, 'HEAD:a.txt');
            }),
        );
        expect(blob?.data.toString('utf8')).toBe('hello\n');
    });
});

describe('GitEngine worktree.switch (P3, WT-006)', () => {
    test("switches the active context so views reflect the worktree's HEAD", async () => {
        const repo = await ws.createRepo('wt-switch');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        const wtPath = join(ws.root, 'wt-switch-linked');
        const cfg = newCfg();

        const [before, after] = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const handle = yield* e.open(repo.dir);
                // A linked worktree checked out on a brand-new branch.
                yield* e.worktreeAdd(
                    handle.repoId,
                    wtPath,
                    undefined,
                    'wt-branch',
                    undefined,
                );
                const main = yield* e.state(handle.repoId);
                yield* e.worktreeSwitch(handle.repoId, wtPath);
                const linked = yield* e.state(handle.repoId);
                return [main.currentBranch, linked.currentBranch] as const;
            }),
        );

        expect(before).toBe('main');
        expect(after).toBe('wt-branch');
    });

    test('rejects a path that is not a worktree of this repository', async () => {
        const repo = await ws.createRepo('wt-switch-guard');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a' } });
        const other = await ws.createRepo('wt-switch-other');
        await other.commit({ message: 'init', files: { 'b.txt': 'b' } });
        const cfg = newCfg();

        const err = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const handle = yield* e.open(repo.dir);
                return yield* Effect.flip(
                    e.worktreeSwitch(handle.repoId, other.dir),
                );
            }),
        );

        expect(err.code).toBe('repoUnavailable');
    });
});

describe('GitEngine repo-lock wiring (P5 mutations serialize; reads stay lockless)', () => {
    // Lock acquisition is a synchronous test-and-set and only yields at the git child
    // spawn, so racing two ops on one repoId is deterministic: the first acquires the
    // permit and the second finds it busy. `config.set`/`reflog.list` stand in for the
    // P5 ✎/READ handlers — a handler that dropped `withRepoLock` would let both writes
    // through (the whole suite would otherwise still pass).
    test('two concurrent P5 mutations on one repoId fail-fast: the loser is rejected (repoLocked)', async () => {
        const repo = await ws.createRepo('lock-mutations');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();

        const labels = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const { repoId } = yield* e.open(repo.dir);
                return yield* Effect.all(
                    [
                        outcome(
                            e.configSet(
                                repoId,
                                'cbranch.locktest',
                                'a',
                                'local',
                            ),
                        ),
                        outcome(
                            e.configSet(
                                repoId,
                                'cbranch.locktest',
                                'b',
                                'local',
                            ),
                        ),
                    ],
                    { concurrency: 'unbounded' },
                );
            }),
        );

        // Exactly one ran; the other was rejected by the LOCK (not a git-level error).
        expect(labels.filter(l => l === 'ok')).toHaveLength(1);
        expect(labels.filter(l => l === 'repoLocked')).toHaveLength(1);
    });

    test('a read proceeds concurrently with a held mutation (reads never take the lock)', async () => {
        const repo = await ws.createRepo('lock-read');
        await repo.commit({ message: 'init', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();

        const labels = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const { repoId } = yield* e.open(repo.dir);
                // The mutation (listed first) acquires the permit; the read fires while it is
                // held and must still succeed rather than be rejected with `repoLocked`.
                return yield* Effect.all(
                    [
                        outcome(
                            e.configSet(
                                repoId,
                                'cbranch.locktest',
                                'x',
                                'local',
                            ),
                        ),
                        outcome(e.reflogList(repoId, 50)),
                    ],
                    { concurrency: 'unbounded' },
                );
            }),
        );

        expect(labels).toEqual(['ok', 'ok']);
    });
});

describe('GitEngine repo.init (P6-INIT)', () => {
    test('initializes a fresh leaf directory, records it, and can be opened', async () => {
        const dest = join(ws.root, 'init-fresh');
        const cfg = newCfg();
        const { result, recents, state } = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const r = yield* e.init({ path: dest });
                const list = yield* e.recentList();
                const h = yield* e.open(dest);
                return { result: r, recents: list, state: h.state };
            }),
        );
        expect(result.repoId).toMatch(/^[0-9a-f]{64}$/);
        expect(recents.some(x => x.repoId === result.repoId)).toBe(true);
        expect(state.isBare).toBe(false);
        expect(state.isEmpty).toBe(true);
    });

    test('honors the initial branch name', async () => {
        const dest = join(ws.root, 'init-branch');
        const cfg = newCfg();
        await withEngine(cfg, e =>
            e.init({ path: dest, defaultBranch: 'trunk' }),
        );
        const head = await runScoped(
            Effect.map(
                runGit({
                    cwd: dest,
                    args: ['symbolic-ref', '--short', 'HEAD'],
                }),
                r => r.stdout.toString('utf8').trim(),
            ),
        );
        expect(head).toBe('trunk');
    });

    test('creates a bare repository when requested', async () => {
        const dest = join(ws.root, 'init-bare');
        const cfg = newCfg();
        const state = await withEngine(cfg, e =>
            Effect.gen(function* () {
                yield* e.init({ path: dest, bare: true });
                const h = yield* e.open(dest);
                return h.state;
            }),
        );
        expect(state.isBare).toBe(true);
    });

    test('refuses to reinitialize an existing repository (offer open)', async () => {
        const repo = await ws.createRepo('already');
        await repo.commit({ message: 'c', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();
        const code = await withEngine(cfg, e =>
            Effect.match(e.init({ path: repo.dir }), {
                onSuccess: () => 'ok',
                onFailure: err => err.code,
            }),
        );
        expect(code).toBe('repoExists');
    });

    test('does not create deep paths: a missing parent is a clear error', async () => {
        const dest = join(ws.root, 'no-such-parent', 'leaf');
        const cfg = newCfg();
        const code = await withEngine(cfg, e =>
            Effect.match(e.init({ path: dest }), {
                onSuccess: () => 'ok',
                onFailure: err => err.code,
            }),
        );
        expect(code).toBe('fsError');
    });
});

describe('GitEngine metaFile (P6-META)', () => {
    test('reads an absent file as empty, then round-trips a written file', async () => {
        const repo = await ws.createRepo('meta');
        await repo.commit({ message: 'c', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();
        const { before, after } = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const b = yield* e.metaFileRead(h.repoId, 'gitignore');
                yield* e.metaFileWrite(
                    h.repoId,
                    'gitignore',
                    'node_modules\ndist\n',
                );
                const a = yield* e.metaFileRead(h.repoId, 'gitignore');
                return { before: b, after: a };
            }),
        );
        expect(before.exists).toBe(false);
        expect(before.text).toBe('');
        expect(after.exists).toBe(true);
        expect(after.text).toBe('node_modules\ndist\n');
    });

    test('writes the private info/exclude inside the git dir', async () => {
        const repo = await ws.createRepo('meta-exclude');
        await repo.commit({ message: 'c', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();
        const content = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                yield* e.metaFileWrite(h.repoId, 'info-exclude', '*.local\n');
                return yield* e.metaFileRead(h.repoId, 'info-exclude');
            }),
        );
        expect(content.exists).toBe(true);
        expect(content.text).toBe('*.local\n');
    });
});

describe('GitEngine notes (P6-NOTE)', () => {
    test('add, read, list, and remove a note without changing the commit', async () => {
        const repo = await ws.createRepo('noted');
        const oid = OidBrand.make(
            await repo.commit({
                message: 'c',
                files: { 'a.txt': 'a\n' },
            }),
        );
        const cfg = newCfg();
        const result = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                const before = yield* e.notesGet(h.repoId, oid);
                yield* e.notesSet(h.repoId, oid, 'a helpful note\n');
                const after = yield* e.notesGet(h.repoId, oid);
                const list = yield* e.notesList(h.repoId);
                yield* e.notesRemove(h.repoId, oid);
                const removed = yield* e.notesGet(h.repoId, oid);
                // The commit itself is untouched by note edits (REQ-P6-NOTE-004).
                const state = yield* e.state(h.repoId);
                return { before, after, list, removed, headOid: state.headOid };
            }),
        );
        expect(result.before.present).toBe(false);
        expect(result.after.present).toBe(true);
        expect(result.after.text).toBe('a helpful note\n');
        expect(result.list.some(n => n.oid === oid)).toBe(true);
        expect(result.removed.present).toBe(false);
        expect(result.headOid).toBe(oid);
    });
});

describe('GitEngine commandLog (P6-CLOG)', () => {
    test('records host git invocations and filters to the active repository', async () => {
        const repo = await ws.createRepo('logged');
        await repo.commit({ message: 'c', files: { 'a.txt': 'a\n' } });
        const cfg = newCfg();
        const rows = await withEngine(cfg, e =>
            Effect.gen(function* () {
                const h = yield* e.open(repo.dir);
                // Any read runs host git; the invocation must appear in the log.
                yield* e.statusGet(h.repoId, false);
                return yield* e.commandLogList(h.repoId, 100);
            }),
        );
        expect(rows.length).toBeGreaterThan(0);
        // A recorded status read carries the argv and a working directory in the repo.
        expect(rows.some(r => r.argv.some(a => a === 'status'))).toBe(true);
        expect(rows.every(r => r.cwd.startsWith(ws.root))).toBe(true);
    });
});
