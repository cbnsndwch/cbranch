// Streaming commit history — `log.stream` (docs/spec/05 §2.4; 10-commit-graph;
// 14 §6; NF-LIMIT-5 / NF-GIT-2).
//
// The single history feed. A formatted `git log` traversal whose ordering is FIXED at
// `--topo-order --date-order` (DECISIONS D9 — every parent sorts below its child, which
// the graph layout and the streaming model both depend on). The format emits one
// machine record per commit using NUL record separators (`-z`) and a unit-separator
// (`\x1f`) between fields, so arbitrary commit subjects can never break parsing
// (NF-GIT-2). Dates are kept as the raw git ISO strings (CommitSummary dates are
// `Schema.String`); they are NOT converted to a host instant. A window is bounded by
// `limit` (server-capped at 500, NF-LIMIT-5); deep scroll resumes via an opaque
// `cursor` that encodes the traversal skip + boundary oid.

import {
    type CommitSummary as CommitSummaryType,
    type GitError,
    type LogQuery,
} from '@cbranch/rpc-contract';
import { CommitSummary, Oid as OidBrand } from '@cbranch/rpc-contract';
import { Effect, Stream } from 'effect';

import { classifyExit } from './errors';
import { decodeUtf8, runGit } from './run-git';

/** Server cap on a single history window regardless of a larger client `limit` (NF-LIMIT-5). */
export const LOG_WINDOW_CAP = 500;

const FS = '\x1f'; // unit separator between fields (never present in any field)

/**
 * The `git log --format` token list (05 §2.4): full oid, ALL ordered parents (`%P`),
 * author name/email, author + committer raw ISO dates, decorations (`%D`), subject.
 * Fields are `\x1f`-separated; `-z` terminates each commit record with NUL.
 */
export const LOG_FORMAT = [
    '%H',
    '%P',
    '%an',
    '%ae',
    '%aI',
    '%cI',
    '%D',
    '%s',
].join(FS);

/** An opaque, resumable history cursor: the consumed `skip` count + the boundary oid. */
export interface LogCursor {
    readonly skip: number;
    readonly oid: string;
}

/** Encode a {@link LogCursor} to an opaque base64url token (clients treat it as opaque). */
export const encodeLogCursor = (skip: number, oid: string): string =>
    Buffer.from(JSON.stringify({ v: 1, s: skip, o: oid }), 'utf8').toString(
        'base64url',
    );

/** Decode an opaque history cursor; `null` if absent/malformed (⇒ start from the top). */
export const decodeLogCursor = (
    cursor: string | undefined,
): LogCursor | null => {
    if (cursor === undefined || cursor === '') return null;
    try {
        const parsed = JSON.parse(
            Buffer.from(cursor, 'base64url').toString('utf8'),
        ) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return null;
        const obj = parsed as { s?: unknown; o?: unknown };
        if (typeof obj.s !== 'number' || typeof obj.o !== 'string') return null;
        return { skip: obj.s, oid: obj.o };
    } catch {
        return null;
    }
};

/**
 * Mint the continuation cursor after a window of `rows` was emitted for `query`. In the
 * live system the server attaches this to the stream; it is exported so a consumer (or
 * a test) can resume the SAME traversal — `skip` is simply how many rows it has seen.
 */
export const nextLogCursor = (
    query: LogQuery,
    rows: ReadonlyArray<CommitSummaryType>,
): string | null => {
    if (rows.length === 0) return null;
    const prev = decodeLogCursor(query.cursor)?.skip ?? 0;
    const last = rows[rows.length - 1] as CommitSummaryType;
    return encodeLogCursor(prev + rows.length, last.oid);
};

/** Apply the server window cap to a client-requested `limit` (defaulting non-positives). */
export const cappedLimit = (limit: number): number =>
    Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), LOG_WINDOW_CAP)
        : LOG_WINDOW_CAP;

/** Map `refScope` (+ optional pattern) to the `git log` revision arguments (05 §2.4). */
const refScopeArgs = (query: LogQuery): ReadonlyArray<string> => {
    switch (query.refScope) {
        case 'all':
            return ['--all'];
        case 'pattern':
            return query.refPattern !== undefined && query.refPattern !== ''
                ? [`--glob=${query.refPattern}`]
                : ['HEAD'];
        default:
            // "current" (the default scope, P1-FILT-1) ⇒ HEAD.
            return ['HEAD'];
    }
};

/** Build the full `git log` argument vector for a window of `query`. */
export const buildLogArgs = (query: LogQuery): ReadonlyArray<string> => {
    const limit = cappedLimit(query.limit);
    const skip = decodeLogCursor(query.cursor)?.skip ?? 0;
    const wantsIgnoreCase =
        query.author !== undefined || query.grep !== undefined;

    const args: string[] = [
        'log',
        '-z',
        '--parents',
        '--topo-order',
        '--date-order',
        `--format=${LOG_FORMAT}`,
        `--max-count=${limit}`,
    ];
    if (skip > 0) args.push(`--skip=${skip}`);
    if (wantsIgnoreCase) args.push('--regexp-ignore-case');
    if (query.author !== undefined) args.push(`--author=${query.author}`);
    if (query.grep !== undefined) args.push(`--grep=${query.grep}`);
    // `--since`/`--until` (the `--since-as-filter` floor fallback is acceptable, NF-PKG-5).
    if (query.since !== undefined) args.push(`--since=${query.since}`);
    if (query.until !== undefined) args.push(`--until=${query.until}`);
    args.push(...refScopeArgs(query));
    if (query.path !== undefined && query.path !== '')
        args.push('--', query.path);
    return args;
};

/**
 * Parse the NUL-delimited `git log` window into ordered {@link CommitSummary} rows. Each
 * record is `oid \x1f parents \x1f an \x1f ae \x1f aDate \x1f cDate \x1f decorations \x1f subject`.
 */
export const parseCommitSummaries = (
    stdout: Buffer,
): ReadonlyArray<CommitSummary> => {
    const text = decodeUtf8(stdout);
    const rows: CommitSummary[] = [];
    for (const record of text.split('\0')) {
        if (record === '') continue;
        const fields = record.split(FS);
        if (fields.length < 8) continue;
        const [
            oid,
            parentsRaw,
            authorName,
            authorEmail,
            authorDate,
            committerDate,
            decorations,
            subject,
        ] = fields as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
        ];
        const parents =
            parentsRaw === ''
                ? []
                : parentsRaw.split(' ').filter(p => p !== '');
        const refs =
            decorations === ''
                ? []
                : decorations
                      .split(', ')
                      .map(r => r.trim())
                      .filter(r => r !== '');
        rows.push(
            new CommitSummary({
                oid: OidBrand.make(oid),
                parents: parents.map(p => OidBrand.make(p)),
                authorName,
                authorEmail,
                authorDate,
                committerDate,
                subject,
                refs,
            }),
        );
    }
    return rows;
};

/**
 * The `log.stream` window for `query` against `cwd`. An unborn HEAD (empty repo)
 * completes with ZERO rows rather than erroring (05 edge cases). Effect `Stream`
 * provides the backpressure; the window is the unit of pagination (cursor resumes it).
 */
export const makeLogStream = (
    cwd: string,
    query: LogQuery,
    env?: NodeJS.ProcessEnv,
): Stream.Stream<CommitSummary, GitError> =>
    Stream.unwrap(
        Effect.gen(function* () {
            const result = yield* runGit({
                cwd,
                args: buildLogArgs(query),
                env,
            });
            if (result.exitCode === 0) {
                return Stream.fromIterable(parseCommitSummaries(result.stdout));
            }
            // A non-zero exit on an unborn branch (`git log HEAD` with no commits) is an empty
            // history, not a failure — distinguish it from a real error via the HEAD probe.
            const head = yield* runGit({
                cwd,
                args: ['rev-parse', '--quiet', '--verify', 'HEAD'],
                env,
            });
            if (head.exitCode !== 0) return Stream.empty;
            return Stream.fail(
                classifyExit(result.exitCode, decodeUtf8(result.stderr)),
            );
        }),
    );
