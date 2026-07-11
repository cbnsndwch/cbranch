import { GitError, RepoId } from '@cbranch/rpc-contract';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
    createFixtureWorkspace,
    type FixtureWorkspace,
} from '../testing/fixtures';
import { run } from '../testing/effect-run';
import {
    createGitHubPullRequest,
    listGitHubPullRequests,
    parseGitHubPullRequests,
    parseGitHubRemote,
    parseRateLimit,
    previewGitHubPullRequest,
    runGh,
} from './github';

const repoId = RepoId.make('github-repo');

describe('GitHub remote parsing', () => {
    test.each([
        'https://github.com/acme/widgets.git',
        'git@github.com:acme/widgets.git',
        'ssh://git@github.com/acme/widgets.git',
        'git://github.com/acme/widgets.git',
    ])('normalizes %s', remote => {
        expect(parseGitHubRemote(remote)).toEqual({
            owner: 'acme',
            name: 'widgets',
            fullName: 'acme/widgets',
            url: 'https://github.com/acme/widgets',
        });
    });

    test.each([
        'https://gitlab.com/acme/widgets.git',
        'file:///srv/widgets',
        'https://github.com/acme/widgets/extra',
        'not a url',
    ])('rejects non-GitHub or malformed remote %s', remote => {
        expect(parseGitHubRemote(remote)).toBeNull();
    });
});

describe('GitHub PR normalization', () => {
    test('normalizes review state and mixed check rollups', () => {
        const pulls = parseGitHubPullRequests(
            JSON.stringify([
                {
                    number: 42,
                    title: 'Coordinate release',
                    url: 'https://github.com/acme/widgets/pull/42',
                    state: 'OPEN',
                    isDraft: false,
                    headRefName: 'feature/release',
                    headRefOid: 'a'.repeat(40),
                    baseRefName: 'main',
                    author: { login: 'ada', name: 'Ada' },
                    reviewRequests: [
                        { login: 'grace' },
                        { login: 'grace' },
                        { login: 'linus' },
                    ],
                    reviewDecision: 'CHANGES_REQUESTED',
                    statusCheckRollup: [
                        { conclusion: 'SUCCESS' },
                        { conclusion: 'FAILURE' },
                        { status: 'IN_PROGRESS' },
                    ],
                    updatedAt: '2026-07-10T12:00:00Z',
                },
            ]),
            repoId,
            'acme/widgets',
        );
        expect(pulls[0]).toMatchObject({
            number: 42,
            repository: 'acme/widgets',
            state: 'open',
            headRefOid: 'a'.repeat(40),
            reviewerLogins: ['grace', 'linus'],
            reviewDecision: 'changesRequested',
            checks: { total: 3, passed: 1, failed: 1, pending: 1 },
        });
    });

    test('covers merged/closed states, every review outcome, and absent author data', () => {
        const pulls = parseGitHubPullRequests(
            JSON.stringify([
                {
                    number: 1,
                    state: 'MERGED',
                    reviewDecision: 'APPROVED',
                    author: { login: 'ada' },
                    statusCheckRollup: [{ conclusion: 'NEUTRAL' }],
                },
                {
                    number: 2,
                    state: 'CLOSED',
                    reviewDecision: 'REVIEW_REQUIRED',
                    author: { login: 'grace', name: 'Grace' },
                    statusCheckRollup: [{ conclusion: 'CANCELLED' }],
                },
                {
                    number: 'malformed',
                    state: 'unexpected',
                    reviewDecision: '',
                    isDraft: true,
                    statusCheckRollup: [{ conclusion: 'SKIPPED' }],
                },
            ]),
            repoId,
            'acme/widgets',
        );

        expect(pulls.map(pull => pull.state)).toEqual([
            'merged',
            'closed',
            'open',
        ]);
        expect(pulls.map(pull => pull.reviewDecision)).toEqual([
            'approved',
            'reviewRequired',
            'none',
        ]);
        expect(pulls[2]).toMatchObject({
            number: 0,
            isDraft: true,
            authorLogin: '',
            checks: { passed: 1 },
        });
    });

    test('parses bounded rate-limit metadata', () => {
        expect(parseRateLimit('4361\t1783700419')).toMatchObject({
            remaining: 4361,
            resetAt: 1_783_700_419,
        });
        expect(parseRateLimit('bad data')).toBeUndefined();
    });
});

describe('listGitHubPullRequests host adapter', () => {
    let workspace: FixtureWorkspace;
    beforeAll(async () => {
        workspace = await createFixtureWorkspace();
    });
    afterAll(async () => {
        await workspace.cleanup();
    });

    test('derives the repository from origin and invokes gh without credentials', async () => {
        const repo = await workspace.createRepo('github-list');
        await repo.addRemote('origin', 'git@github.com:acme/widgets.git');
        const calls: ReadonlyArray<string>[] = [];
        const gh = vi.fn((args: ReadonlyArray<string>) => {
            calls.push(args);
            return Effect.succeed(args[0] === 'pr' ? '[]' : '99\t1783700419');
        });

        const result = await run(
            listGitHubPullRequests(repo.dir, repoId, 'open', undefined, gh),
        );

        expect(result.repository).toBe('acme/widgets');
        expect(result.repositoryUrl).toBe('https://github.com/acme/widgets');
        expect(result.rateLimit?.remaining).toBe(99);
        expect(calls[0]).toContain('acme/widgets');
        expect(calls.flat().join(' ')).not.toMatch(/token|gho_|ghp_/i);
    });

    test('rejects a non-GitHub origin before invoking gh', async () => {
        const repo = await workspace.createRepo('gitlab-list');
        await repo.addRemote('origin', 'https://gitlab.com/acme/widgets.git');
        const gh = vi.fn(() => Effect.succeed('[]'));

        await expect(
            run(
                listGitHubPullRequests(repo.dir, repoId, 'open', undefined, gh),
            ),
        ).rejects.toMatchObject({ code: 'forgeUnavailable' });
        expect(gh).not.toHaveBeenCalled();
    });

    test('keeps a successful PR list when the advisory rate-limit read fails', async () => {
        const repo = await workspace.createRepo('rate-list');
        await repo.addRemote('origin', 'https://github.com/acme/widgets.git');
        const gh = vi.fn((args: ReadonlyArray<string>) =>
            args[0] === 'pr'
                ? Effect.succeed('[]')
                : Effect.fail(
                      new GitError({
                          code: 'networkError',
                          message: 'rate endpoint unavailable',
                      }),
                  ),
        );

        const result = await run(
            listGitHubPullRequests(repo.dir, repoId, 'all', undefined, gh),
        );
        expect(result.pullRequests).toEqual([]);
        expect(result.rateLimit).toBeUndefined();
    });

    test('maps a missing host gh executable to forgeUnavailable', async () => {
        await expect(
            run(runGh(['--version'], workspace.root, { PATH: '' })),
        ).rejects.toMatchObject({ code: 'forgeUnavailable' });
    });

    test('previews the exact local range and published head', async () => {
        const repo = await workspace.createRepo('github-preview');
        await repo.commit({ message: 'base', files: { 'base.txt': 'base' } });
        await repo.checkout('feature/release', { create: true });
        const headOid = await repo.commit({
            message: 'Coordinate release',
            files: { 'release.txt': 'release' },
        });
        await repo.addRemote('origin', 'https://github.com/acme/widgets.git');
        const gh = vi.fn((args: ReadonlyArray<string>) =>
            Effect.succeed(args[0] === 'repo' ? 'main\n' : `${headOid}\n`),
        );

        const preview = await run(
            previewGitHubPullRequest(
                repo.dir,
                repoId,
                undefined,
                undefined,
                gh,
            ),
        );

        expect(preview).toMatchObject({
            repository: 'acme/widgets',
            headRefName: 'feature/release',
            headOid,
            baseRefName: 'main',
            headPublished: true,
        });
        expect(preview.commits.map(commit => commit.subject)).toEqual([
            'Coordinate release',
        ]);
    });

    test('revalidates and creates a draft PR with explicit fields', async () => {
        const repo = await workspace.createRepo('github-create');
        await repo.commit({ message: 'base', files: { 'base.txt': 'base' } });
        await repo.checkout('feature/create', { create: true });
        const headOid = await repo.commit({ message: 'Create change' });
        await repo.addRemote('origin', 'git@github.com:acme/widgets.git');
        const calls: ReadonlyArray<string>[] = [];
        const gh = vi.fn((args: ReadonlyArray<string>) => {
            calls.push(args);
            if (args[0] === 'repo') return Effect.succeed('main');
            if (args[0] === 'api') return Effect.succeed(headOid);
            return Effect.succeed('https://github.com/acme/widgets/pull/73\n');
        });

        const result = await run(
            createGitHubPullRequest(
                repo.dir,
                repoId,
                {
                    title: 'Create change',
                    body: 'Exact body',
                    baseRefName: 'main',
                    draft: true,
                },
                undefined,
                gh,
            ),
        );

        expect(result.number).toBe(73);
        const createArgs = calls.find(args => args[0] === 'pr')!;
        expect(createArgs).toContain('--draft');
        expect(createArgs).toContain('feature/create');
        expect(createArgs).toContain('Exact body');
    });

    test('does not create when the current head is not published', async () => {
        const repo = await workspace.createRepo('github-unpublished');
        await repo.commit({ message: 'base' });
        await repo.checkout('feature/local', { create: true });
        await repo.commit({ message: 'Local only' });
        await repo.addRemote('origin', 'https://github.com/acme/widgets.git');
        const gh = vi.fn((args: ReadonlyArray<string>) =>
            args[0] === 'api'
                ? Effect.fail(
                      new GitError({
                          code: 'forgeUnavailable',
                          message: 'HTTP 404: Not Found',
                      }),
                  )
                : Effect.succeed('main'),
        );

        await expect(
            run(
                createGitHubPullRequest(
                    repo.dir,
                    repoId,
                    {
                        title: 'Local only',
                        body: '',
                        baseRefName: 'main',
                        draft: false,
                    },
                    undefined,
                    gh,
                ),
            ),
        ).rejects.toMatchObject({
            code: 'forgeUnavailable',
            message: expect.stringContaining('push'),
        });
        expect(gh.mock.calls.some(([args]) => args[0] === 'pr')).toBe(false);
    });

    test('rejects an empty PR title before touching git or gh', async () => {
        const gh = vi.fn(() => Effect.succeed('unused'));
        await expect(
            run(
                createGitHubPullRequest(
                    workspace.root,
                    repoId,
                    {
                        title: '   ',
                        body: '',
                        baseRefName: 'main',
                        draft: false,
                    },
                    undefined,
                    gh,
                ),
            ),
        ).rejects.toMatchObject({ code: 'gitFailed' });
        expect(gh).not.toHaveBeenCalled();
    });

    test('rejects a PR range with no commits', async () => {
        const repo = await workspace.createRepo('github-empty-range');
        const headOid = await repo.commit({ message: 'base' });
        await repo.checkout('feature/empty', { create: true });
        await repo.addRemote('origin', 'https://github.com/acme/widgets.git');
        const gh = vi.fn(() => Effect.succeed(headOid));

        await expect(
            run(
                createGitHubPullRequest(
                    repo.dir,
                    repoId,
                    {
                        title: 'Empty range',
                        body: '',
                        baseRefName: 'main',
                        draft: false,
                    },
                    undefined,
                    gh,
                ),
            ),
        ).rejects.toMatchObject({
            code: 'forgeUnavailable',
            message: expect.stringContaining('no commits'),
        });
    });

    test('rejects malformed create output without guessing a PR URL', async () => {
        const repo = await workspace.createRepo('github-malformed-create');
        await repo.commit({ message: 'base' });
        await repo.checkout('feature/malformed', { create: true });
        const headOid = await repo.commit({ message: 'change' });
        await repo.addRemote('origin', 'https://github.com/acme/widgets.git');
        const gh = vi.fn((args: ReadonlyArray<string>) =>
            Effect.succeed(args[0] === 'api' ? headOid : 'created'),
        );

        await expect(
            run(
                createGitHubPullRequest(
                    repo.dir,
                    repoId,
                    {
                        title: 'Malformed output',
                        body: '',
                        baseRefName: 'main',
                        draft: false,
                    },
                    undefined,
                    gh,
                ),
            ),
        ).rejects.toMatchObject({ code: 'forgeUnavailable' });
    });

    test('requires a local branch instead of a detached head', async () => {
        const repo = await workspace.createRepo('github-detached-preview');
        await repo.commit({ message: 'base' });
        await repo.checkout('HEAD', { detach: true });
        await repo.addRemote('origin', 'https://github.com/acme/widgets.git');
        const gh = vi.fn(() => Effect.succeed('main'));

        await expect(
            run(
                previewGitHubPullRequest(
                    repo.dir,
                    repoId,
                    undefined,
                    undefined,
                    gh,
                ),
            ),
        ).rejects.toMatchObject({ code: 'detachedHead' });
        expect(gh).not.toHaveBeenCalled();
    });
});
