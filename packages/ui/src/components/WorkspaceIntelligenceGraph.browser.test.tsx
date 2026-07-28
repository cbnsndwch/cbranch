import type { WorkspaceIntelligenceGraphNeighborhood } from '@cbranch/rpc-contract';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { WorkspaceIntelligenceGraph } from './WorkspaceIntelligenceGraph';

test('mounts the complete bounded target-scale neighborhood in Chromium', async () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => ({
        id: `node:${index}`,
        kind: 'component',
        label: `Node ${index}`,
        repoId: 'repo-a',
        evidence: [],
    }));
    const edges = Array.from({ length: 1_999 }, (_, index) => ({
        from: `node:${index}`,
        to: `node:${index + 1}`,
        kind: 'depends-on',
        evidence: [],
    }));

    const view = await render(
        <div style={{ height: 800, width: 1200 }}>
            <WorkspaceIntelligenceGraph
                neighborhood={
                    {
                        nodes,
                        edges,
                    } as WorkspaceIntelligenceGraphNeighborhood
                }
            />
        </div>,
    );

    expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(
        2_000,
    );
    expect(view.container.querySelectorAll('.react-flow__edge')).toHaveLength(
        1_999,
    );
});
