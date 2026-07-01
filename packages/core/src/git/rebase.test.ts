import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Oid, RebaseStep } from '@cbranch/rpc-contract';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { run } from '../testing/effect-run';
import {
    createFixtureWorkspace,
    type FixtureRepo,
    type FixtureWorkspace,
} from '../testing/fixtures';
import {
    buildRebasePlanArgs,
    buildRebaseTodo,
    cleanupRebaseSidecar,
    defaultShimPath,
    parseRebaseTodoCommits,
    rebasePlan,
    rebaseStart,
    rebaseStatus,
    shellSingleQuote,
    validateRebasePlan,
} from './rebase';

const FS = '\x1f';
const oid = (c: string) => Oid.make(c.repeat(40));
const step = (action: RebaseStep['action'], c: string, message?: string) =>
    new RebaseStep({ oid: oid(c), action, message });
const rs = (action: RebaseStep['action'], fullOid: string, message?: string) =>
    new RebaseStep({ oid: Oid.make(fullOid), action, message });

// ── pure: shell quoting + plan parsing ───────────────────────────────────────────

describe('rebase pure helpers', () => {
    test('shellSingleQuote wraps and escapes embedded single quotes', () => {
        expect(shellSingleQuote('/a/b')).toBe("'/a/b'");
        expect(shellSingleQuote("/a'b/c")).toBe("'/a'\\''b/c'");
    });

    test('buildRebasePlanArgs builds an oldest-first topo-ordered no-merges range', () => {
        expect(buildRebasePlanArgs('abc123')).toEqual([
            'log',
            '-z',
            '--topo-order',
            '--reverse',
            '--no-merges',
            `--format=${['%H', '%an', '%ae', '%aI', '%s', '%b'].join(FS)}`,
            'abc123..HEAD',
        ]);
    });

    test('parseRebaseTodoCommits splits NUL records and rejoins a body with FS', () => {
        const a = 'a'.repeat(40);
        const b = 'b'.repeat(40);
        const rec = (o: string, subject: string, body: string) =>
            [
                o,
                'Ada',
                'ada@x.io',
                '2023-11-14T22:13:20-05:00',
                subject,
                body,
            ].join(FS);
        const stdout = Buffer.from(
            `${rec(a, 'first', 'body' + FS + 'text')}\0${rec(b, 'second', '')}\0`,
            'utf8',
        );
        const rows = parseRebaseTodoCommits(stdout);
        expect(rows.map(r => r.subject)).toEqual(['first', 'second']);
        expect(rows[0]?.body).toBe(`body${FS}text`); // FS inside the body survives
        expect(rows[1]?.body).toBe('');
        expect(rows[0]?.oid).toBe(a);
    });
});

// ── pure: todo rewrite ───────────────────────────────────────────────────────────

const msgPath = (k: number) => `/sidecar/msg-${k}`;

describe('buildRebaseTodo', () => {
    test('pure picks produce no exec and no message files', () => {
        const { todo, msgFiles } = buildRebaseTodo(
            [step('pick', 'a'), step('pick', 'b')],
            msgPath,
        );
        expect(todo).toBe(`pick ${oid('a')}\npick ${oid('b')}\n`);
        expect(msgFiles).toEqual([]);
    });

    test('reword becomes pick + amend-exec; the message lives in a sidecar file', () => {
        const { todo, msgFiles } = buildRebaseTodo(
            [step('pick', 'a'), step('reword', 'b', 'new subject\n')],
            msgPath,
        );
        expect(todo).toBe(
            `pick ${oid('a')}\npick ${oid('b')}\n` +
                `exec git commit --amend -F '/sidecar/msg-0'\n`,
        );
        expect(msgFiles).toEqual([
            { path: '/sidecar/msg-0', content: 'new subject\n' },
        ]);
        expect(todo).not.toContain('new subject'); // bytes never inline the todo line
    });

    test('a squash group is pick + fixup(s) + one combined amend-exec', () => {
        const { todo, msgFiles } = buildRebaseTodo(
            [
                step('pick', 'a'),
                step('fixup', 'b'),
                step('squash', 'c', 'combined'),
            ],
            msgPath,
        );
        expect(todo).toBe(
            `pick ${oid('a')}\nfixup ${oid('b')}\nfixup ${oid('c')}\n` +
                `exec git commit --amend -F '/sidecar/msg-0'\n`,
        );
        expect(msgFiles).toEqual([
            { path: '/sidecar/msg-0', content: 'combined' },
        ]);
        expect(todo).not.toContain('combined');
    });

    test('fixup-only group has no exec (the base message is kept)', () => {
        const { todo, msgFiles } = buildRebaseTodo(
            [step('pick', 'a'), step('fixup', 'b')],
            msgPath,
        );
        expect(todo).toBe(`pick ${oid('a')}\nfixup ${oid('b')}\n`);
        expect(msgFiles).toEqual([]);
    });

    test('drop is omitted and the displayed order is the replay order', () => {
        const { todo } = buildRebaseTodo(
            [step('pick', 'c'), step('drop', 'b'), step('pick', 'a')],
            msgPath,
        );
        expect(todo).toBe(`pick ${oid('c')}\npick ${oid('a')}\n`);
    });

    test('edit becomes an edit line; multiple groups get independent msg files', () => {
        const { todo, msgFiles } = buildRebaseTodo(
            [
                step('reword', 'a', 'ra'),
                step('fixup', 'b'),
                step('edit', 'c'),
                step('pick', 'd'),
                step('squash', 'e', 'se'),
            ],
            msgPath,
        );
        expect(todo).toBe(
            `pick ${oid('a')}\nfixup ${oid('b')}\n` +
                `exec git commit --amend -F '/sidecar/msg-0'\n` +
                `edit ${oid('c')}\n` +
                `pick ${oid('d')}\nfixup ${oid('e')}\n` +
                `exec git commit --amend -F '/sidecar/msg-1'\n`,
        );
        expect(msgFiles).toEqual([
            { path: '/sidecar/msg-0', content: 'ra' },
            { path: '/sidecar/msg-1', content: 'se' },
        ]);
    });

    test('the exec line single-quote-escapes the message path', () => {
        const { todo } = buildRebaseTodo(
            [step('pick', 'a'), step('reword', 'b', 'x')],
            k => `/we'rd/msg-${k}`,
        );
        expect(todo).toContain(
            "exec git commit --amend -F '/we'\\''rd/msg-0'\n",
        );
    });

    test("a reword base folded into a squash yields one combined message (the squash's)", () => {
        const { todo, msgFiles } = buildRebaseTodo(
            [step('reword', 'a', 'REWORD'), step('squash', 'b', 'COMBINED')],
            msgPath,
        );
        expect(todo).toBe(
            `pick ${oid('a')}\nfixup ${oid('b')}\n` +
                `exec git commit --amend -F '/sidecar/msg-0'\n`,
        );
        expect(msgFiles).toEqual([
            { path: '/sidecar/msg-0', content: 'COMBINED' },
        ]);
        expect(todo).not.toContain('REWORD');
    });

    test("a multi-squash group bakes only the last squash's message", () => {
        const { msgFiles } = buildRebaseTodo(
            [
                step('pick', 'a'),
                step('squash', 'b', 'MID'),
                step('squash', 'c', 'LAST'),
            ],
            msgPath,
        );
        expect(msgFiles).toEqual([{ path: '/sidecar/msg-0', content: 'LAST' }]);
    });
});

// ── pure: validation ─────────────────────────────────────────────────────────────

describe('validateRebasePlan', () => {
    test('a normal plan is valid', () => {
        expect(
            validateRebasePlan([step('pick', 'a'), step('squash', 'b', 'm')]),
        ).toBeNull();
    });

    test('a leading squash or fixup is rejected', () => {
        expect(validateRebasePlan([step('squash', 'a', 'm')])).toMatch(
            /first commit/,
        );
        expect(validateRebasePlan([step('fixup', 'a')])).toMatch(
            /first commit/,
        );
    });

    test('dropping every commit is rejected', () => {
        expect(
            validateRebasePlan([step('drop', 'a'), step('drop', 'b')]),
        ).toMatch(/drops every commit/);
    });

    test('an empty reword/squash message is rejected (no --allow-empty-message)', () => {
        expect(validateRebasePlan([step('reword', 'a', '  ')])).toMatch(
            /reworded commit/,
        );
        expect(validateRebasePlan([step('reword', 'a')])).toMatch(/reworded/);
        expect(
            validateRebasePlan([step('pick', 'a'), step('squash', 'b', '')]),
        ).toMatch(/squashed/);
    });

    test('only the consumed message is required, never a discarded one', () => {
        // A reword absorbed by a following squash: its (unused) message is NOT demanded.
        expect(
            validateRebasePlan([step('reword', 'a'), step('squash', 'b', 'C')]),
        ).toBeNull();
        // ...but the squash's combined message (the one that's applied) still is.
        expect(
            validateRebasePlan([
                step('reword', 'a', 'R'),
                step('squash', 'b', ''),
            ]),
        ).toMatch(/squashed/);
        // A multi-squash group only requires the LAST (consumed) squash message.
        expect(
            validateRebasePlan([
                step('pick', 'a'),
                step('squash', 'b', ''),
                step('squash', 'c', 'LAST'),
            ]),
        ).toBeNull();
    });
});

// ── shim ─────────────────────────────────────────────────────────────────────────

describe('rebase-seq-editor shim', () => {
    test("writes the CBRANCH_REBASE_TODO bytes over git's todo path (argv[2])", () => {
        const dir = mkdtempSync(join(tmpdir(), 'cbranch-shim-'));
        const authored = join(dir, 'authored');
        const gitTodo = join(dir, 'git-rebase-todo');
        const bytes = "pick abc\nexec git commit --amend -F 'x'\n";
        writeFileSync(authored, bytes);
        writeFileSync(gitTodo, 'GIT GENERATED — should be overwritten\n');

        execFileSync(process.execPath, [defaultShimPath(), gitTodo], {
            env: { ...process.env, CBRANCH_REBASE_TODO: authored },
        });

        expect(readFileSync(gitTodo, 'utf8')).toBe(bytes);
        // The shim drops a marker so the engine can tell our rebase actually started.
        expect(existsSync(`${authored}.applied`)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('cleanupRebaseSidecar', () => {
    test('removes the scripted-rebase sidecar (and no-ops when absent)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cbranch-sidecar-'));
        const sidecar = join(dir, 'cbranch-rebase');
        mkdirSync(sidecar, { recursive: true });
        writeFileSync(join(sidecar, 'msg-0'), 'secret message');
        cleanupRebaseSidecar(dir);
        expect(existsSync(sidecar)).toBe(false);
        cleanupRebaseSidecar(dir); // idempotent
        rmSync(dir, { recursive: true, force: true });
    });
});

// ── integration: real repos ──────────────────────────────────────────────────────

const iso = (repo: FixtureRepo): NodeJS.ProcessEnv => ({
    GIT_CONFIG_GLOBAL: join(repo.dir, '.no-global-config'),
    GIT_CONFIG_SYSTEM: join(repo.dir, '.no-system-config'),
});

const subjects = async (repo: FixtureRepo, range: string) =>
    (await repo.git(['log', '--format=%s', range])).stdout
        .split('\n')
        .filter(l => l !== '');

describe('rebase git operations', () => {
    let ws: FixtureWorkspace;
    beforeAll(async () => {
        ws = await createFixtureWorkspace();
    });
    afterAll(async () => {
        await ws.cleanup();
    });

    // base c0 then c1..c3, each touching a distinct file (a clean linear replay).
    const seedRange = async (name: string) => {
        const repo = await ws.createRepo(name);
        const oids: string[] = [];
        for (let i = 0; i < 4; i += 1) {
            oids.push(
                // eslint-disable-next-line no-await-in-loop -- commits must be created in order (each builds on the prior).
                await repo.commit({
                    message: `c${i}\n\nbody ${i}`,
                    files: { [`c${i}.txt`]: `${i}\n` },
                }),
            );
        }
        return { repo, gitDir: join(repo.dir, '.git'), oids };
    };

    test('rebasePlan lists the range oldest-first with populated bodies', async () => {
        const { repo, oids } = await seedRange('plan');
        const plan = await run(
            rebasePlan(repo.dir, oids[0], undefined, iso(repo)),
        );
        expect(plan.upstream).toBe(oids[0]);
        expect(plan.commits.map(c => c.subject)).toEqual(['c1', 'c2', 'c3']);
        expect(plan.commits[0]?.body).toContain('body 1');
        expect(plan.commits.map(c => c.oid)).toEqual([
            oids[1],
            oids[2],
            oids[3],
        ]);
    });

    test('rebasePlan on an empty range returns commits:[]', async () => {
        const { repo, oids } = await seedRange('plan-empty');
        const plan = await run(
            rebasePlan(repo.dir, oids[3], undefined, iso(repo)),
        );
        expect(plan.commits).toEqual([]);
    });

    test('reword bakes the UI message via exec-amend (fully scripted, no editor)', async () => {
        const { repo, gitDir, oids } = await seedRange('reword');
        const status = await run(
            rebaseStart(
                repo.dir,
                gitDir,
                oids[0],
                [
                    rs('pick', oids[1]),
                    rs('reword', oids[2], 'reworded subject\n'),
                    rs('pick', oids[3]),
                ],
                undefined,
                iso(repo),
            ),
        );
        expect(status.inProgress).toBe(false);
        expect(status.stopReason).toBe('none');
        expect(await subjects(repo, `${oids[0]}..HEAD`)).toEqual([
            'c3',
            'reworded subject',
            'c1',
        ]);
        // the scripted sidecar is cleaned up on success.
        expect(existsSync(join(gitDir, 'cbranch-rebase'))).toBe(false);
    });

    test('a squash group folds commits and applies the combined message', async () => {
        const { repo, gitDir, oids } = await seedRange('squash');
        const status = await run(
            rebaseStart(
                repo.dir,
                gitDir,
                oids[0],
                [
                    rs('pick', oids[1]),
                    rs('squash', oids[2], 'combined c1+c2'),
                    rs('pick', oids[3]),
                ],
                undefined,
                iso(repo),
            ),
        );
        expect(status.inProgress).toBe(false);
        const subs = await subjects(repo, `${oids[0]}..HEAD`);
        expect(subs).toEqual(['c3', 'combined c1+c2']); // c1 and c2 are one commit
        // both files are still present (squash keeps the trees).
        expect(existsSync(join(repo.dir, 'c1.txt'))).toBe(true);
        expect(existsSync(join(repo.dir, 'c2.txt'))).toBe(true);
    });

    test('drop omits the commit and its tree', async () => {
        const { repo, gitDir, oids } = await seedRange('drop');
        const status = await run(
            rebaseStart(
                repo.dir,
                gitDir,
                oids[0],
                [rs('pick', oids[1]), rs('drop', oids[2]), rs('pick', oids[3])],
                undefined,
                iso(repo),
            ),
        );
        expect(status.inProgress).toBe(false);
        expect(await subjects(repo, `${oids[0]}..HEAD`)).toEqual(['c3', 'c1']);
        expect(existsSync(join(repo.dir, 'c2.txt'))).toBe(false);
    });

    test('an edit stop surfaces inProgress + stopReason:edit + step progress', async () => {
        const { repo, gitDir, oids } = await seedRange('edit-stop');
        const status = await run(
            rebaseStart(
                repo.dir,
                gitDir,
                oids[0],
                [rs('edit', oids[1]), rs('pick', oids[2]), rs('pick', oids[3])],
                undefined,
                iso(repo),
            ),
        );
        expect(status.inProgress).toBe(true);
        expect(status.stopReason).toBe('edit');
        expect(status.progress?.total).toBe(3);
        expect(status.headName).toContain('main');

        // a second start while one is in progress fails fast as repoLocked.
        const err = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    oids[0],
                    [rs('pick', oids[1])],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(err.code).toBe('repoLocked');

        await repo.git(['rebase', '--abort'], { env: iso(repo) });
    });

    test('a conflict stop surfaces stopReason:conflict', async () => {
        const repo = await ws.createRepo('conflict');
        const gitDir = join(repo.dir, '.git');
        await repo.commit({ message: 'base', files: { 'x.txt': '0\n' } });
        await repo.branch('feature', { startPoint: 'HEAD' });
        await repo.checkout('feature');
        const featA = await repo.commit({
            message: 'feat',
            files: { 'x.txt': 'feature\n' },
        });
        await repo.checkout('main');
        await repo.commit({
            message: 'main change',
            files: { 'x.txt': 'main\n' },
        });
        await repo.checkout('feature');

        const status = await run(
            rebaseStart(
                repo.dir,
                gitDir,
                'main',
                [rs('pick', featA)],
                undefined,
                iso(repo),
            ),
        );
        expect(status.inProgress).toBe(true);
        expect(status.stopReason).toBe('conflict');

        await repo.git(['rebase', '--abort'], { env: iso(repo) });
    });

    test('a dirty working tree is refused (never auto-stashed)', async () => {
        const { repo, gitDir, oids } = await seedRange('dirty');
        await repo.writeFile('c1.txt', 'dirty\n');
        const err = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    oids[0],
                    [rs('pick', oids[1])],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(err.code).toBe('dirtyWorkingTree');
    });

    test('a leading-dash upstream is refused as invalidRefName', async () => {
        const { repo, gitDir, oids } = await seedRange('dash');
        const err = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    '-x',
                    [rs('pick', oids[1])],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(err.code).toBe('invalidRefName');
    });

    test('an all-drop plan and an empty reword message fail validation as gitFailed', async () => {
        const { repo, gitDir, oids } = await seedRange('invalid');
        const dropAll = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    oids[0],
                    [
                        rs('drop', oids[1]),
                        rs('drop', oids[2]),
                        rs('drop', oids[3]),
                    ],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(dropAll.code).toBe('gitFailed');

        const emptyMsg = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    oids[0],
                    [rs('pick', oids[1]), rs('reword', oids[2], '   ')],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(emptyMsg.code).toBe('gitFailed');
    });

    test('a step oid that is not a plain hex id is refused (todo exec-injection guard)', async () => {
        const { repo, gitDir, oids } = await seedRange('evil-oid');
        // A branded Oid carries no charset validation, so a crafted value could smuggle a
        // newline + `exec` line into the git-rebase-todo (host RCE). rebaseStart must reject
        // it before authoring the todo, and nothing must run or start.
        const evil = Oid.make(
            `${oids[1]}\nexec touch ${join(repo.dir, 'pwned')}`,
        );
        const err = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    oids[0],
                    [
                        rs('pick', oids[1]),
                        new RebaseStep({ oid: evil, action: 'pick' }),
                    ],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(err.code).toBe('invalidRefName');
        expect(existsSync(join(repo.dir, 'pwned'))).toBe(false);
        expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    });

    test('a post-spawn non-zero exit (invalid upstream) fails as gitFailed and reaps the sidecar', async () => {
        const { repo, gitDir, oids } = await seedRange('nonzero-exit');
        // A valid-hex but non-existent upstream clears every pre-spawn guard, so git itself
        // exits non-zero without ever leaving a rebase in progress — the completed-with-
        // non-zero-exit arm. It must surface as gitFailed and reap the authored sidecar.
        const err = await run(
            Effect.flip(
                rebaseStart(
                    repo.dir,
                    gitDir,
                    'f'.repeat(40),
                    [rs('pick', oids[1])],
                    undefined,
                    iso(repo),
                ),
            ),
        );
        expect(err.code).toBe('gitFailed');
        expect(existsSync(join(gitDir, 'cbranch-rebase'))).toBe(false);
        expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    });
});

// ── rebaseStatus: backend-aware machine-state reading ────────────────────────────

const writeState = (dir: string, files: Record<string, string>): void => {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files))
        writeFileSync(join(dir, name), content);
};

describe('rebaseStatus machine-state reader', () => {
    let ws: FixtureWorkspace;
    beforeAll(async () => {
        ws = await createFixtureWorkspace();
    });
    afterAll(async () => {
        await ws.cleanup();
    });

    const seedClean = async (name: string) => {
        const repo = await ws.createRepo(name);
        await repo.commit({ message: 'c0', files: { 'a.txt': 'a\n' } });
        return { repo, gitDir: join(repo.dir, '.git') };
    };

    test('a clean repo with no rebase is inProgress:false / stopReason:none', async () => {
        const { repo, gitDir } = await seedClean('status-none');
        const status = await run(rebaseStatus(repo.dir, gitDir, iso(repo)));
        expect(status.inProgress).toBe(false);
        expect(status.stopReason).toBe('none');
    });

    test('merge backend: reads progress + onto/headName and classifies an edit stop', async () => {
        const { repo, gitDir } = await seedClean('status-edit');
        const sha = 'a'.repeat(40);
        const mergeDir = join(gitDir, 'rebase-merge');
        writeState(mergeDir, {
            msgnum: '2\n',
            end: '5\n',
            onto: `${'b'.repeat(40)}\n`,
            'head-name': 'refs/heads/feature\n',
            'stopped-sha': `${sha}\n`,
            done: `pick ${'c'.repeat(40)}\nedit ${sha}\n`,
        });
        const status = await run(rebaseStatus(repo.dir, gitDir, iso(repo)));
        expect(status.inProgress).toBe(true);
        expect(status.stopReason).toBe('edit');
        expect(status.progress?.current).toBe(2);
        expect(status.progress?.total).toBe(5);
        expect(status.progress?.currentOid).toBe(sha);
        expect(status.onto).toBe('b'.repeat(40));
        expect(status.headName).toBe('refs/heads/feature');
        rmSync(mergeDir, { recursive: true, force: true });
    });

    test('merge backend: a failed exec is execFailed and carries the failing line', async () => {
        const { repo, gitDir } = await seedClean('status-exec');
        const mergeDir = join(gitDir, 'rebase-merge');
        const execLine = "exec git commit --amend -F '/sidecar/msg-0'";
        writeState(mergeDir, {
            msgnum: '3\n',
            end: '3\n',
            done: `pick ${'d'.repeat(40)}\n${execLine}\n`,
        });
        const status = await run(rebaseStatus(repo.dir, gitDir, iso(repo)));
        expect(status.inProgress).toBe(true);
        expect(status.stopReason).toBe('execFailed');
        expect(status.detail).toBe(execLine);
        rmSync(mergeDir, { recursive: true, force: true });
    });

    test('merge backend: a conflict-free `break` pause is none, not execFailed', async () => {
        const { repo, gitDir } = await seedClean('status-break');
        const mergeDir = join(gitDir, 'rebase-merge');
        writeState(mergeDir, {
            msgnum: '2\n',
            end: '4\n',
            done: `pick ${'f'.repeat(40)}\nbreak\n`,
        });
        const status = await run(rebaseStatus(repo.dir, gitDir, iso(repo)));
        expect(status.inProgress).toBe(true);
        expect(status.stopReason).toBe('none'); // resumable via plain Continue
        expect(status.detail).toBeUndefined();
        rmSync(mergeDir, { recursive: true, force: true });
    });

    test('apply backend: reads next/last/onto/head-name (without an `applying` marker)', async () => {
        const { repo, gitDir } = await seedClean('status-apply');
        const applyDir = join(gitDir, 'rebase-apply');
        writeState(applyDir, {
            next: '1\n',
            last: '3\n',
            onto: `${'e'.repeat(40)}\n`,
            'head-name': 'refs/heads/topic\n',
        });
        const status = await run(rebaseStatus(repo.dir, gitDir, iso(repo)));
        expect(status.inProgress).toBe(true);
        // The apply backend has no exec/edit step, so a conflict-free stop is none (not execFailed).
        expect(status.stopReason).toBe('none');
        expect(status.progress?.current).toBe(1);
        expect(status.progress?.total).toBe(3);
        expect(status.onto).toBe('e'.repeat(40));
        expect(status.headName).toBe('refs/heads/topic');
        rmSync(applyDir, { recursive: true, force: true });
    });
});
