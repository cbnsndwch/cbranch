// GitHub metadata through the host `gh` CLI. The repository slug is derived from the
// on-disk origin remote, every invocation uses an argument array with prompting disabled,
// and credentials remain entirely inside gh's host credential store.

import { execFile } from 'node:child_process';

import {
    ForgeRateLimit,
    type GitError,
    GitHubPullRequestCreated,
    GitHubPullRequest,
    GitHubPullRequestList,
    GitHubPullRequestPreview,
    Oid as OidBrand,
    PullRequestPreviewCommit,
    PullRequestCheckSummary,
    type PullRequestListState,
    type PullRequestReviewDecision,
    type PullRequestState,
    type RepoId,
} from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { gitError, scrubSecrets } from '../git/errors';
import { decodeUtf8, runGit, runGitOk } from '../git/run-git';

export interface GitHubRepository {
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly url: string;
}

const safeSegment = (value: string): boolean =>
    value !== '' && value !== '.' && value !== '..' && !value.includes('/');

/** Parse the common HTTPS, SSH URL, and SCP-like GitHub remote forms. */
export const parseGitHubRemote = (remote: string): GitHubRepository | null => {
    const trimmed = remote.trim();
    let path: string | undefined;
    const scp = /^(?:[^@\s]+@)?github\.com:(.+)$/i.exec(trimmed);
    if (scp) path = scp[1];
    else {
        try {
            const url = new URL(trimmed);
            if (url.hostname.toLowerCase() !== 'github.com') return null;
            path = url.pathname;
        } catch {
            return null;
        }
    }
    const parts = (path ?? '')
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0]!;
    const name = parts[1]!.replace(/\.git$/i, '');
    if (!safeSegment(owner) || !safeSegment(name)) return null;
    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        url: `https://github.com/${owner}/${name}`,
    };
};

interface GhFailure {
    readonly cause: {
        readonly code?: string | number;
        readonly message?: string;
    };
    readonly stderr: string;
}

type GhRunner = (
    args: ReadonlyArray<string>,
    cwd: string,
    env?: NodeJS.ProcessEnv,
) => Effect.Effect<string, GitError>;

const classifyGhFailure = (failure: GhFailure): GitError => {
    if (failure.cause.code === 'ENOENT')
        return gitError(
            'forgeUnavailable',
            'GitHub CLI (gh) is not installed on the host',
        );
    const stderr = scrubSecrets(failure.stderr).trim();
    if (/auth|log in|login|token|credential/i.test(stderr))
        return gitError(
            'authRequired',
            'GitHub authentication is required on the host; run gh auth login',
        );
    if (
        /network|connect|resolve|timeout|timed out|tls|certificate/i.test(
            stderr,
        )
    )
        return gitError(
            'networkError',
            stderr || 'GitHub could not be reached from the host',
        );
    return gitError(
        'forgeUnavailable',
        stderr || 'GitHub CLI could not complete the request',
    );
};

/** Bounded, no-shell gh runner with all interactive behavior disabled. */
export const runGh: GhRunner = (args, cwd, extraEnv) =>
    Effect.tryPromise({
        try: () =>
            new Promise<string>((resolve, reject) => {
                execFile(
                    'gh',
                    [...args],
                    {
                        cwd,
                        env: {
                            ...process.env,
                            ...extraEnv,
                            GH_PROMPT_DISABLED: '1',
                            GH_PAGER: 'cat',
                            NO_COLOR: '1',
                        },
                        maxBuffer: 2 * 1024 * 1024,
                        windowsHide: true,
                    },
                    (error, stdout, stderr) => {
                        if (error)
                            reject({
                                cause: error,
                                stderr: String(stderr),
                            } satisfies GhFailure);
                        else resolve(String(stdout));
                    },
                );
            }),
        catch: error => classifyGhFailure(error as GhFailure),
    });

const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};

const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';

const reviewDecision = (value: unknown): PullRequestReviewDecision => {
    switch (text(value).toUpperCase()) {
        case 'APPROVED':
            return 'approved';
        case 'CHANGES_REQUESTED':
            return 'changesRequested';
        case 'REVIEW_REQUIRED':
            return 'reviewRequired';
        default:
            return 'none';
    }
};

const prState = (value: unknown): PullRequestState => {
    switch (text(value).toUpperCase()) {
        case 'MERGED':
            return 'merged';
        case 'CLOSED':
            return 'closed';
        default:
            return 'open';
    }
};

const summarizeChecks = (value: unknown): PullRequestCheckSummary => {
    const checks = Array.isArray(value) ? value.map(record) : [];
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const check of checks) {
        const state = text(
            check.conclusion || check.state || check.status,
        ).toUpperCase();
        if (state === 'SUCCESS' || state === 'NEUTRAL' || state === 'SKIPPED')
            passed += 1;
        else if (
            state === 'FAILURE' ||
            state === 'ERROR' ||
            state === 'CANCELLED' ||
            state === 'TIMED_OUT' ||
            state === 'ACTION_REQUIRED' ||
            state === 'STARTUP_FAILURE' ||
            state === 'STALE'
        )
            failed += 1;
        else pending += 1;
    }
    return new PullRequestCheckSummary({
        total: checks.length,
        passed,
        failed,
        pending,
    });
};

/** Normalize gh's JSON union into the stable wire model. */
export const parseGitHubPullRequests = (
    json: string,
    repoId: RepoId,
    repository: string,
): ReadonlyArray<GitHubPullRequest> => {
    const decoded: unknown = JSON.parse(json);
    if (!Array.isArray(decoded))
        throw new TypeError('gh pull-request response is not an array');
    return decoded.map(item => {
        const pr = record(item);
        const author = record(pr.author);
        const reviewerLogins = Array.isArray(pr.reviewRequests)
            ? [
                  ...new Set(
                      pr.reviewRequests
                          .map(request => text(record(request).login))
                          .filter(Boolean),
                  ),
              ]
            : [];
        const headRefOid = text(pr.headRefOid);
        const number =
            typeof pr.number === 'number' && Number.isFinite(pr.number)
                ? pr.number
                : 0;
        return new GitHubPullRequest({
            repoId,
            repository,
            number,
            title: text(pr.title),
            url: text(pr.url),
            state: prState(pr.state),
            isDraft: pr.isDraft === true,
            headRefName: text(pr.headRefName),
            headRefOid:
                headRefOid === '' ? undefined : OidBrand.make(headRefOid),
            baseRefName: text(pr.baseRefName),
            authorLogin: text(author.login),
            authorName: text(author.name) || undefined,
            reviewerLogins,
            reviewDecision: reviewDecision(pr.reviewDecision),
            checks: summarizeChecks(pr.statusCheckRollup),
            updatedAt: text(pr.updatedAt),
        });
    });
};

export const parseRateLimit = (value: string): ForgeRateLimit | undefined => {
    const [remainingText, resetText] = value.trim().split(/\s+/);
    const remaining = Number(remainingText);
    const resetAt = Number(resetText);
    return Number.isFinite(remaining) && Number.isFinite(resetAt)
        ? new ForgeRateLimit({ remaining, resetAt })
        : undefined;
};

export const listGitHubPullRequests = (
    cwd: string,
    repoId: RepoId,
    state: PullRequestListState = 'open',
    env?: NodeJS.ProcessEnv,
    gh: GhRunner = runGh,
): Effect.Effect<GitHubPullRequestList, GitError> =>
    Effect.gen(function* () {
        const origin = yield* runGitOk({
            cwd,
            args: ['remote', 'get-url', 'origin'],
            env,
        });
        const repository = parseGitHubRemote(decodeUtf8(origin.stdout));
        if (!repository)
            return yield* Effect.fail(
                gitError(
                    'forgeUnavailable',
                    'origin is not a supported github.com repository',
                ),
            );
        const json = yield* gh(
            [
                'pr',
                'list',
                '--repo',
                repository.fullName,
                '--state',
                state,
                '--limit',
                '100',
                '--json',
                'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,author,reviewRequests,reviewDecision,statusCheckRollup,updatedAt',
            ],
            cwd,
            env,
        );
        const parsePullRequests: Effect.Effect<
            ReadonlyArray<GitHubPullRequest>,
            GitError
        > = Effect.try({
            try: () =>
                parseGitHubPullRequests(json, repoId, repository.fullName),
            catch: () =>
                gitError(
                    'forgeUnavailable',
                    'GitHub CLI returned malformed pull-request data',
                ),
        });
        const pullRequests = yield* parsePullRequests;
        const rateLimit = yield* gh(
            [
                'api',
                'rate_limit',
                '--jq',
                '.resources.graphql | [.remaining, .reset] | @tsv',
            ],
            cwd,
            env,
        ).pipe(
            Effect.map(parseRateLimit),
            Effect.catch(() => Effect.succeed(undefined)),
        );
        return new GitHubPullRequestList({
            repoId,
            repository: repository.fullName,
            repositoryUrl: repository.url,
            pullRequests,
            rateLimit,
        });
    });

const resolveGitHubRepository = (
    cwd: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<GitHubRepository, GitError> =>
    Effect.gen(function* () {
        const origin = yield* runGitOk({
            cwd,
            args: ['remote', 'get-url', 'origin'],
            env,
        });
        const repository = parseGitHubRemote(decodeUtf8(origin.stdout));
        if (repository) return repository;
        return yield* Effect.fail(
            gitError(
                'forgeUnavailable',
                'origin is not a supported github.com repository',
            ),
        );
    });

const checkedBranchName = (
    cwd: string,
    value: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitError> =>
    Effect.gen(function* () {
        const name = value.trim();
        if (name === '' || name.startsWith('-'))
            return yield* Effect.fail(
                gitError(
                    'invalidRefName',
                    `'${name}' is not a valid branch name`,
                ),
            );
        const checked = yield* runGit({
            cwd,
            args: ['check-ref-format', `refs/heads/${name}`],
            env,
        });
        if (checked.exitCode !== 0)
            return yield* Effect.fail(
                gitError(
                    'invalidRefName',
                    `'${name}' is not a valid branch name`,
                ),
            );
        return name;
    });

const resolveBaseOid = (
    cwd: string,
    baseRefName: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitError> =>
    Effect.gen(function* () {
        for (const ref of [
            `refs/remotes/origin/${baseRefName}`,
            `refs/heads/${baseRefName}`,
        ]) {
            const resolved = yield* runGit({
                cwd,
                args: ['rev-parse', '--verify', ref],
                env,
            });
            if (resolved.exitCode === 0)
                return decodeUtf8(resolved.stdout).trim();
        }
        return yield* Effect.fail(
            gitError(
                'forgeUnavailable',
                `base branch '${baseRefName}' is not available locally; fetch origin first`,
            ),
        );
    });

/** Parse the NUL-delimited commit preview emitted by the bounded git log command. */
export const parsePreviewCommits = (
    value: Buffer,
): ReadonlyArray<PullRequestPreviewCommit> => {
    const fields = decodeUtf8(value).split('\0');
    while (fields.at(-1) === '') fields.pop();
    const commits: PullRequestPreviewCommit[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
        commits.push(
            new PullRequestPreviewCommit({
                oid: OidBrand.make(fields[index]!),
                subject: fields[index + 1]!,
                authorName: fields[index + 2]!,
                authoredAt: fields[index + 3]!,
            }),
        );
    }
    return commits;
};

/** Compute the exact focused-repository PR range without creating or publishing it. */
export const previewGitHubPullRequest = (
    cwd: string,
    repoId: RepoId,
    requestedBase?: string,
    env?: NodeJS.ProcessEnv,
    gh: GhRunner = runGh,
): Effect.Effect<GitHubPullRequestPreview, GitError> =>
    Effect.gen(function* () {
        const repository = yield* resolveGitHubRepository(cwd, env);
        const branchResult = yield* runGit({
            cwd,
            args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
            env,
        });
        if (branchResult.exitCode !== 0)
            return yield* Effect.fail(
                gitError(
                    'detachedHead',
                    'switch to a local branch before creating a pull request',
                ),
            );
        const headRefName = decodeUtf8(branchResult.stdout).trim();
        const defaultBase =
            requestedBase?.trim() ||
            (yield* gh(
                [
                    'repo',
                    'view',
                    repository.fullName,
                    '--json',
                    'defaultBranchRef',
                    '--jq',
                    '.defaultBranchRef.name',
                ],
                cwd,
                env,
            )).trim();
        const baseRefName = yield* checkedBranchName(cwd, defaultBase, env);
        const head = yield* runGitOk({
            cwd,
            args: ['rev-parse', '--verify', 'HEAD'],
            env,
        });
        const headOid = decodeUtf8(head.stdout).trim();
        const baseOid = yield* resolveBaseOid(cwd, baseRefName, env);
        const mergeBase = yield* runGitOk({
            cwd,
            args: ['merge-base', baseOid, headOid],
            env,
        });
        const mergeBaseOid = decodeUtf8(mergeBase.stdout).trim();
        const log = yield* runGitOk({
            cwd,
            args: [
                'log',
                '--reverse',
                '-z',
                '--format=%H%x00%s%x00%an%x00%aI',
                `${mergeBaseOid}..${headOid}`,
            ],
            env,
        });
        const publishedHeadOid = yield* gh(
            [
                'api',
                `repos/${repository.fullName}/git/ref/heads/${encodeURIComponent(headRefName)}`,
                '--jq',
                '.object.sha',
            ],
            cwd,
            env,
        ).pipe(
            Effect.map(value => value.trim() || undefined),
            Effect.catch(error =>
                /(?:http\s*)?404|not found/i.test(error.message)
                    ? Effect.succeed(undefined)
                    : Effect.fail(error),
            ),
        );
        return new GitHubPullRequestPreview({
            repoId,
            repository: repository.fullName,
            repositoryUrl: repository.url,
            headRefName,
            headOid: OidBrand.make(headOid),
            baseRefName,
            baseOid: OidBrand.make(baseOid),
            mergeBaseOid: OidBrand.make(mergeBaseOid),
            publishedHeadOid:
                publishedHeadOid === undefined || publishedHeadOid === ''
                    ? undefined
                    : OidBrand.make(publishedHeadOid),
            headPublished: publishedHeadOid === headOid,
            commits: parsePreviewCommits(log.stdout),
        });
    });

/** Revalidate the preview, then create through the host's authenticated gh CLI. */
export const createGitHubPullRequest = (
    cwd: string,
    repoId: RepoId,
    input: {
        readonly title: string;
        readonly body: string;
        readonly baseRefName: string;
        readonly draft: boolean;
    },
    env?: NodeJS.ProcessEnv,
    gh: GhRunner = runGh,
): Effect.Effect<GitHubPullRequestCreated, GitError> =>
    Effect.gen(function* () {
        const title = input.title.trim();
        if (title === '')
            return yield* Effect.fail(
                gitError('gitFailed', 'pull request title cannot be empty'),
            );
        const preview = yield* previewGitHubPullRequest(
            cwd,
            repoId,
            input.baseRefName,
            env,
            gh,
        );
        if (preview.commits.length === 0)
            return yield* Effect.fail(
                gitError(
                    'forgeUnavailable',
                    'the pull request range contains no commits',
                ),
            );
        if (!preview.headPublished)
            return yield* Effect.fail(
                gitError(
                    'forgeUnavailable',
                    'push the current branch before creating a pull request',
                ),
            );
        const args = [
            'pr',
            'create',
            '--repo',
            preview.repository,
            '--head',
            preview.headRefName,
            '--base',
            preview.baseRefName,
            '--title',
            title,
            '--body',
            input.body,
        ];
        if (input.draft) args.push('--draft');
        const output = yield* gh(args, cwd, env);
        const matches = output.match(
            /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/g,
        );
        const url = matches?.at(-1);
        const number = url ? Number(url.slice(url.lastIndexOf('/') + 1)) : NaN;
        if (!url || !Number.isFinite(number))
            return yield* Effect.fail(
                gitError(
                    'forgeUnavailable',
                    'GitHub CLI did not return a pull request URL',
                ),
            );
        return new GitHubPullRequestCreated({
            repoId,
            repository: preview.repository,
            number,
            url,
        });
    });
