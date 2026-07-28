import { describe, expect, test } from 'vitest';

import {
    workspaceIntelligenceArchiveWithPreferredEnrichment,
    workspaceIntelligenceTar,
} from './workspace-intelligence-archive-channel';

describe('workspaceIntelligenceTar', () => {
    test('creates a deterministic ustar payload with a terminating zero block', () => {
        const archive = workspaceIntelligenceTar([
            { path: 'run/report.md', text: '# Report\n' },
            { path: 'archive-manifest.json', text: '{"schemaVersion":1}\n' },
        ]);
        const decoder = new TextDecoder();

        expect(decoder.decode(archive.slice(0, 100)).replaceAll('\0', '')).toBe(
            'workspace-intelligence/archive-manifest.json',
        );
        expect(archive.slice(-1024).every(byte => byte === 0)).toBe(true);
        expect(
            workspaceIntelligenceTar([{ path: 'run/a', text: 'a' }]),
        ).toEqual(workspaceIntelligenceTar([{ path: 'run/a', text: 'a' }]));
    });

    test('adds only normalized preferred enrichment to an archive', () => {
        const entries = workspaceIntelligenceArchiveWithPreferredEnrichment(
            [{ path: 'archive-manifest.json', text: '{"schemaVersion":1}\n' }],
            {
                id: 'attempt-1',
                runId: 'run-1',
                profileId: 'hosted',
                modelId: 'example-model',
                promptSchemaVersion: 'workspace-intelligence.enrichment@1',
                createdAt: 1,
                completedAt: 2,
                evidenceIds: ['component:api'],
                state: 'completed',
                repairAttempted: false,
                inferredEdges: [],
            },
        );

        expect(entries).toHaveLength(3);
        const enrichment = entries.find(
            entry => entry.path === 'enrichment/preferred-attempt.json',
        );
        expect(enrichment?.text).toContain('preferred-enrichment');
        expect(enrichment?.text).not.toMatch(/raw prompt|api key/i);
        const markdown = entries.find(
            entry => entry.path === 'enrichment/preferred-attempt.md',
        );
        expect(markdown?.text).toContain(
            '# Optional Workspace Intelligence Enrichment',
        );
        expect(markdown?.text).toContain(
            'deterministic run report and graph remain authoritative',
        );
        expect(markdown?.text).not.toMatch(/raw prompt|api key/i);
    });
});
