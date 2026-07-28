import { describe, expect, test } from 'vitest';

import { workspaceIntelligenceReportPreview } from './workspace-intelligence-report';

describe('workspaceIntelligenceReportPreview', () => {
    test('turns the stable report findings and bounded Mermaid sketch into UI data', () => {
        const preview = workspaceIntelligenceReportPreview(`
# Workspace Intelligence

## Architecture integrity

- **warning** \`architecture.cycle\`: Verified dependency cycle involving 3 graph nodes.
- **info** \`architecture.convention\`: Uses a stable contract boundary.

## Architecture sketch

\`\`\`mermaid
flowchart LR
N1["API"]
N2["Web"]
N1 -->|depends-on| N2
TRUNCATED["Architecture sketch is bounded; inspect graph artifacts for all records."]
\`\`\`
`);

        expect(preview.findings).toEqual([
            {
                severity: 'warning',
                kind: 'architecture.cycle',
                message: 'Verified dependency cycle involving 3 graph nodes.',
            },
            {
                severity: 'info',
                kind: 'architecture.convention',
                message: 'Uses a stable contract boundary.',
            },
        ]);
        expect(preview.graph).toEqual({
            labels: ['API', 'Web'],
            edgeCount: 1,
            isBounded: true,
        });
    });

    test('handles a legacy or otherwise sparse report without raw-source leakage', () => {
        expect(workspaceIntelligenceReportPreview('# Report')).toEqual({
            findings: [],
            graph: { labels: [], edgeCount: 0, isBounded: false },
        });
    });
});
