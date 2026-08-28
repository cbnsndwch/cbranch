// HTTP side-channel for bounded Workspace Intelligence artifact exports. The RPC
// mints a short-lived opaque token; this route consumes it once and streams only
// the selected immutable run plus a point-in-time override snapshot.

import { randomUUID } from 'node:crypto';

import {
    type EngagementId,
    type WorkspaceIntelligenceRunId,
} from '@cbranch/rpc-contract';
import { Http } from '@cbranch/rpc-contract/effect-rpc-adapter';
import type {
    WorkspaceIntelligenceArchiveEntry,
    WorkspaceIntelligenceEnrichmentAttempt,
} from '@cbranch/workspace-intelligence';
import { Effect } from 'effect';

import { WorkspaceIntelligenceService } from './workspace-intelligence-service';

export const WORKSPACE_INTELLIGENCE_ARCHIVE_CHANNEL_PATH =
    '/sidechannel/workspace-intelligence-archive';

const TOKEN_CAPACITY = 64;
const TOKEN_TTL_MS = 5 * 60 * 1_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

type ArchiveToken = {
    readonly engagementId: EngagementId;
    readonly runId: WorkspaceIntelligenceRunId;
    readonly expiresAt: number;
};

const tokens = new Map<string, ArchiveToken>();

export const mintWorkspaceIntelligenceArchiveToken = (
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
): string => {
    const token = randomUUID();
    tokens.set(token, {
        engagementId,
        runId,
        expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    while (tokens.size > TOKEN_CAPACITY) {
        const oldest = tokens.keys().next().value;
        if (oldest === undefined) break;
        tokens.delete(oldest);
    }
    return token;
};

const takeToken = (token: string): ArchiveToken | undefined => {
    const value = tokens.get(token);
    tokens.delete(token);
    return value === undefined || value.expiresAt < Date.now()
        ? undefined
        : value;
};

const encoder = new TextEncoder();

const markdownInline = (value: string): string =>
    value.replaceAll('`', '\\`').replaceAll(/[\r\n]+/g, ' ');

const markdownQuote = (value: string): string =>
    value
        .split(/\r?\n/)
        .map(line => `> ${line}`)
        .join('\n');

const writeString = (
    target: Uint8Array,
    offset: number,
    length: number,
    value: string,
) => target.set(encoder.encode(value).slice(0, length), offset);

const writeOctal = (
    target: Uint8Array,
    offset: number,
    length: number,
    value: number,
) =>
    writeString(
        target,
        offset,
        length,
        value.toString(8).padStart(length - 1, '0'),
    );

const tarEntry = (path: string, text: string): Uint8Array => {
    const name = `workspace-intelligence/${path}`;
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 100)
        throw new Error('Workspace Intelligence archive path is too long.');
    const contents = encoder.encode(text);
    const padding =
        (TAR_BLOCK_BYTES - (contents.length % TAR_BLOCK_BYTES)) %
        TAR_BLOCK_BYTES;
    const header = new Uint8Array(TAR_BLOCK_BYTES);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeString(header, 257, 6, 'ustar');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    const result = new Uint8Array(TAR_BLOCK_BYTES + contents.length + padding);
    result.set(header);
    result.set(contents, TAR_BLOCK_BYTES);
    return result;
};

/** Creates a deterministic ustar payload without adding a runtime archive dependency. */
export const workspaceIntelligenceTar = (
    entries: ReadonlyArray<WorkspaceIntelligenceArchiveEntry>,
): Uint8Array => {
    const files = entries
        .toSorted((left, right) => left.path.localeCompare(right.path))
        .map(entry => tarEntry(entry.path, entry.text));
    const length = files.reduce(
        (total, file) => total + file.length,
        TAR_BLOCK_BYTES * 2,
    );
    if (length > MAX_ARCHIVE_BYTES)
        throw new Error(
            'Workspace Intelligence archive exceeds its 64 MiB limit.',
        );
    const archive = new Uint8Array(length);
    let offset = 0;
    for (const file of files) {
        archive.set(file, offset);
        offset += file.length;
    }
    return archive;
};

/**
 * Preferred enrichment is exported as a distinct labeled child. It contains
 * only already-normalized metadata and output; provider profile configuration,
 * raw prompts, and provider responses remain host-private.
 */
export const workspaceIntelligenceArchiveWithPreferredEnrichment = (
    entries: ReadonlyArray<WorkspaceIntelligenceArchiveEntry>,
    attempt: WorkspaceIntelligenceEnrichmentAttempt | undefined,
): ReadonlyArray<WorkspaceIntelligenceArchiveEntry> =>
    attempt === undefined
        ? entries
        : [
              ...entries,
              {
                  path: 'enrichment/preferred-attempt.json',
                  text: `${JSON.stringify(
                      {
                          schemaVersion: 1,
                          kind: 'workspace-intelligence-preferred-enrichment',
                          attempt,
                      },
                      null,
                      2,
                  )}\n`,
              },
              {
                  path: 'enrichment/preferred-attempt.md',
                  text: [
                      '# Optional Workspace Intelligence Enrichment',
                      '',
                      '> This provider-derived child is separately labeled. The deterministic run report and graph remain authoritative.',
                      '',
                      `- Attempt: \`${markdownInline(attempt.id)}\``,
                      `- Profile/model: \`${markdownInline(attempt.profileId)}\` / \`${markdownInline(attempt.modelId)}\``,
                      `- Selected evidence IDs: ${attempt.evidenceIds.map(id => `\`${markdownInline(id)}\``).join(', ')}`,
                      '',
                      ...(attempt.summary === undefined
                          ? []
                          : [
                                '## Summary',
                                '',
                                markdownQuote(attempt.summary),
                                '',
                            ]),
                      '## Inferred relationships',
                      '',
                      ...(attempt.inferredEdges.length === 0
                          ? ['No inferred relationships were accepted.']
                          : attempt.inferredEdges.map(
                                edge =>
                                    `- \`${markdownInline(edge.from)}\` — **${markdownInline(edge.kind)}** → \`${markdownInline(edge.to)}\` (${Math.round(edge.confidence * 100)}%, ${edge.confidenceTier}; evidence: ${edge.evidenceIds.map(id => `\`${markdownInline(id)}\``).join(', ')})${edge.rationale === '' ? '' : ` — ${markdownInline(edge.rationale)}`}`,
                            )),
                      '',
                  ].join('\n'),
              },
          ];

export const workspaceIntelligenceArchiveChannelRoute = Http.HttpRouter.add(
    'GET',
    WORKSPACE_INTELLIGENCE_ARCHIVE_CHANNEL_PATH,
    request =>
        Effect.gen(function* () {
            const token = new URL(
                request.url,
                'http://localhost',
            ).searchParams.get('token');
            if (token === null)
                return Http.HttpServerResponse.text('missing archive token', {
                    status: 400,
                });
            const descriptor = takeToken(token);
            if (descriptor === undefined)
                return Http.HttpServerResponse.text(
                    'archive token unavailable',
                    {
                        status: 404,
                    },
                );
            const service = yield* WorkspaceIntelligenceService;
            const entries = yield* Effect.promise(() =>
                service.manager.archiveEntries(
                    descriptor.engagementId,
                    descriptor.runId,
                ),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)));
            if (entries === undefined)
                return Http.HttpServerResponse.text('archive unavailable', {
                    status: 404,
                });
            try {
                const preferred = yield* Effect.promise(() =>
                    service.preferredEnrichment(
                        descriptor.engagementId,
                        descriptor.runId,
                    ),
                ).pipe(Effect.catch(() => Effect.succeed(undefined)));
                const archive = workspaceIntelligenceTar(
                    workspaceIntelligenceArchiveWithPreferredEnrichment(
                        entries,
                        preferred,
                    ),
                );
                return Http.HttpServerResponse.uint8Array(archive, {
                    status: 200,
                    contentType: 'application/x-tar',
                    headers: {
                        'content-disposition': `attachment; filename="workspace-intelligence-${descriptor.runId}.tar"`,
                        'cache-control': 'no-store',
                    },
                });
            } catch {
                return Http.HttpServerResponse.text('archive too large', {
                    status: 413,
                });
            }
        }),
);
