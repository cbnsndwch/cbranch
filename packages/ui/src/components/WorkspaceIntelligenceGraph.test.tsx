import type { WorkspaceIntelligenceGraphNeighborhood } from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { workspaceIntelligenceFlow } from './WorkspaceIntelligenceGraph';

describe('workspaceIntelligenceFlow', () => {
    test('lays out only the bounded neighborhood and omits dangling edges', () => {
        const graph = workspaceIntelligenceFlow({
            nodes: [
                {
                    id: 'component:api',
                    kind: 'component',
                    label: 'API',
                    repoId: 'repo-a',
                    evidence: [],
                },
                {
                    id: 'contract:users',
                    kind: 'contract.http.route',
                    label: 'GET /users',
                    repoId: 'repo-a',
                    evidence: [],
                },
            ],
            edges: [
                {
                    from: 'component:api',
                    to: 'contract:users',
                    kind: 'exposes-contract',
                    evidence: [],
                },
                {
                    from: 'component:api',
                    to: 'missing',
                    kind: 'references',
                    evidence: [],
                },
            ],
        } as WorkspaceIntelligenceGraphNeighborhood);

        expect(graph.nodes).toEqual([
            expect.objectContaining({
                id: 'component:api',
                position: { x: 0, y: 0 },
                data: { label: 'API\ncomponent' },
            }),
            expect.objectContaining({
                id: 'contract:users',
                position: { x: 230, y: 0 },
            }),
        ]);
        expect(graph.edges).toEqual([
            expect.objectContaining({
                source: 'component:api',
                target: 'contract:users',
                label: 'exposes-contract',
            }),
        ]);
    });

    test('preserves the target-scale host-bounded neighborhood shape', () => {
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

        const graph = workspaceIntelligenceFlow({
            nodes,
            edges,
        } as WorkspaceIntelligenceGraphNeighborhood);

        expect(graph.nodes).toHaveLength(2_000);
        expect(graph.edges).toHaveLength(1_999);
        expect(graph.nodes.at(-1)).toMatchObject({
            id: 'node:1999',
            position: { x: 920, y: 47880 },
        });
    });
});
