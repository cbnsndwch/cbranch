import { describe, expect, test, vi } from 'vitest';

import {
    InferenceEnrichmentRequest,
    normalizeEnrichmentWithOneRepair,
} from './normalization';

const request = InferenceEnrichmentRequest.parse({
    profileId: 'local-codex',
    model: 'configured-model',
    evidence: [
        {
            id: 'repo-a:source:src/api.ts:10-20',
            content: 'router.get("/users", handler);',
        },
    ],
    promptSchemaVersion: 'workspace-intelligence.enrichment@1',
});

const valid = {
    schemaVersion: 1,
    inferredEdges: [
        {
            from: 'repo-a:component:api',
            to: 'repo-a:contract:http:users',
            kind: 'exposes-contract',
            confidence: 0.9,
            evidenceIds: ['repo-a:source:src/api.ts:10-20'],
            rationale: 'The selected handler registers the route.',
        },
    ],
    timing: { durationMs: 120 },
};

describe('normalizeEnrichmentWithOneRepair', () => {
    test('accepts a fully evidenced normalized envelope', async () => {
        const run = vi.fn(async () => valid);

        await expect(
            normalizeEnrichmentWithOneRepair({ run }, request),
        ).resolves.toEqual({ ok: true, value: valid, repairAttempted: false });
        expect(run).toHaveBeenCalledTimes(1);
    });

    test('repairs invalid output once with validation diagnostics', async () => {
        const invalid = { schemaVersion: 1, inferredEdges: [{ from: 'api' }] };
        const run = vi
            .fn()
            .mockResolvedValueOnce(invalid)
            .mockResolvedValueOnce(valid);

        await expect(
            normalizeEnrichmentWithOneRepair({ run }, request),
        ).resolves.toEqual({ ok: true, value: valid, repairAttempted: true });
        expect(run).toHaveBeenNthCalledWith(2, {
            request,
            repair: expect.objectContaining({
                invalidOutput: invalid,
                validationErrors: expect.any(Array),
            }),
        });
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('repairs an edge that cites evidence outside the selected set', async () => {
        const run = vi
            .fn()
            .mockResolvedValueOnce({
                ...valid,
                inferredEdges: [
                    {
                        ...valid.inferredEdges[0],
                        evidenceIds: ['unselected-evidence'],
                    },
                ],
            })
            .mockResolvedValueOnce(valid);

        await expect(
            normalizeEnrichmentWithOneRepair({ run }, request),
        ).resolves.toMatchObject({ ok: true, repairAttempted: true });
        expect(run).toHaveBeenNthCalledWith(2, {
            request,
            repair: expect.objectContaining({
                validationErrors: [
                    expect.stringContaining('was not selected evidence'),
                ],
            }),
        });
    });

    test('rejects malformed repaired output without leaking a partial edge', async () => {
        const run = vi.fn(async () => ({
            schemaVersion: 1,
            inferredEdges: [
                {
                    from: 'api',
                    to: 'contract',
                    kind: 'uses',
                    confidence: 3,
                    evidenceIds: [],
                    rationale: '',
                },
            ],
        }));

        await expect(
            normalizeEnrichmentWithOneRepair({ run }, request),
        ).resolves.toMatchObject({
            ok: false,
            failure: {
                code: 'invalidStructuredOutput',
                repairAttempted: true,
            },
        });
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('does not attempt repair after a provider failure', async () => {
        const run = vi.fn(async () => {
            throw new Error('profile unavailable');
        });

        await expect(
            normalizeEnrichmentWithOneRepair({ run }, request),
        ).resolves.toEqual({
            ok: false,
            failure: {
                code: 'providerFailure',
                message: 'profile unavailable',
                repairAttempted: false,
            },
        });
        expect(run).toHaveBeenCalledTimes(1);
    });
});
