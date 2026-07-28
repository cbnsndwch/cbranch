import type { WorkspaceIntelligenceGraphNeighborhood } from '@cbranch/rpc-contract';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { WorkspaceIntelligenceGraph } from './WorkspaceIntelligenceGraph';

const TARGET_NODE_COUNT = 2_000;
const TARGET_EDGE_COUNT = TARGET_NODE_COUNT - 1;
const PAINT_WAIT_LIMIT_MS = 10_000;

const targetNeighborhood = {
    nodes: Array.from({ length: TARGET_NODE_COUNT }, (_, index) => ({
        id: `node:${index}`,
        kind: 'component',
        label: `Node ${index}`,
        repoId: 'repo-a',
        evidence: [],
    })),
    edges: Array.from({ length: TARGET_EDGE_COUNT }, (_, index) => ({
        from: `node:${index}`,
        to: `node:${index + 1}`,
        kind: 'depends-on',
        evidence: [],
    })),
} as WorkspaceIntelligenceGraphNeighborhood;

const settleAfterPaint = () =>
    new Promise<void>(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });

test('compares the target-scale React Flow path with the Sigma import path', async () => {
    const reactFlowStartedAt = performance.now();
    const reactFlowView = await render(
        <div style={{ height: 384, width: 1200 }}>
            <WorkspaceIntelligenceGraph neighborhood={targetNeighborhood} />
        </div>,
    );

    try {
        expect(
            reactFlowView.container.querySelectorAll('.react-flow__node'),
        ).toHaveLength(TARGET_NODE_COUNT);
        expect(
            reactFlowView.container.querySelectorAll('.react-flow__edge'),
        ).toHaveLength(TARGET_EDGE_COUNT);
        await settleAfterPaint();

        const reactFlowDurationMs = performance.now() - reactFlowStartedAt;
        expect(reactFlowDurationMs).toBeLessThan(PAINT_WAIT_LIMIT_MS);

        const sigmaImport = await import('@react-sigma/core').then(
            () => null,
            error => error,
        );

        // graphology 0.26 declares a class method named `import`, which current
        // Chromium rejects while parsing the Sigma peer-dependency graph. Keep
        // the rejected import as executable compatibility evidence instead of
        // adopting an unrenderable WebGL dependency stack.
        expect(sigmaImport).toBeInstanceOf(SyntaxError);
        expect((sigmaImport as SyntaxError).message).toContain(
            'Unexpected token',
        );
    } finally {
        await reactFlowView.unmount();
    }
});
