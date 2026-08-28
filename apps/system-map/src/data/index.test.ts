import { describe, expect, test } from 'vitest';

import { scenes, SOURCE_SNAPSHOT } from '.';

describe('system map data', () => {
    test('pins every scene to the reviewed HEAD snapshot', () => {
        expect(SOURCE_SNAPSHOT).toEqual({
            revision: 'be09896',
            label: 'HEAD be09896',
            reviewedAt: '2026-08-15',
        });
        expect(new Set(scenes.map(scene => scene.id)).size).toBe(scenes.length);
    });

    test.each(scenes)('$label has a complete and navigable graph', scene => {
        const nodeIds = new Set(scene.nodes.map(node => node.id));
        const edgeIds = new Set(scene.edges.map(edge => edge.id));

        expect(nodeIds.size).toBe(scene.nodes.length);
        expect(edgeIds.size).toBe(scene.edges.length);
        expect(nodeIds.has(scene.defaultNodeId)).toBe(true);
        expect(scene.nodes.length).toBeGreaterThan(0);
        expect(scene.edges.length).toBeGreaterThan(0);
        expect(scene.flows.length).toBeGreaterThan(0);

        for (const node of scene.nodes) {
            expect(node.citations.length).toBeGreaterThan(0);
            expect(node.responsibilities.length).toBeGreaterThan(0);
            expect(node.builtWith.length).toBeGreaterThan(0);
            for (const source of node.citations) {
                expect(source.path).not.toHaveLength(0);
                expect(source.line).toBeGreaterThan(0);
                expect(source.label).not.toHaveLength(0);
            }
        }

        for (const edge of scene.edges) {
            expect(nodeIds.has(edge.from), `${edge.id} source`).toBe(true);
            expect(nodeIds.has(edge.to), `${edge.id} target`).toBe(true);
        }

        for (const flow of scene.flows) {
            expect(flow.steps.length).toBeGreaterThan(0);
            let previousEnd: string | undefined;
            for (const [index, step] of flow.steps.entries()) {
                expect(
                    edgeIds.has(step.edgeId),
                    `${flow.id}:${step.edgeId}`,
                ).toBe(true);
                expect(step.payload).not.toHaveLength(0);
                expect(step.citations.length).toBeGreaterThan(0);
                expect([
                    'implementation-derived',
                    'schema-derived',
                    'test-derived',
                ]).toContain(step.evidence);

                const edge = scene.edges.find(
                    candidate => candidate.id === step.edgeId,
                );
                expect(edge).toBeDefined();
                if (edge === undefined) continue;
                const start =
                    step.direction === 'reverse' ? edge.to : edge.from;
                const end = step.direction === 'reverse' ? edge.from : edge.to;
                const discontinuous =
                    previousEnd !== undefined && previousEnd !== start;
                if (discontinuous) {
                    expect(
                        step.phaseBreak,
                        `${flow.id} hop ${index + 1} resets ${previousEnd} → ${start}`,
                    ).toBeTruthy();
                } else {
                    expect(
                        step.phaseBreak,
                        `${flow.id} hop ${index + 1} is already continuous`,
                    ).toBeUndefined();
                }
                previousEnd = end;
            }
        }
    });

    test('all semantic drill-down targets resolve', () => {
        const sceneIds = new Set(scenes.map(scene => scene.id));
        const destinations = scenes.flatMap(scene =>
            scene.nodes.flatMap(node =>
                node.childSceneId === undefined ? [] : [node.childSceneId],
            ),
        );

        expect(new Set(destinations)).toEqual(
            new Set(['clients', 'git-runtime', 'plugins', 'supervisor']),
        );
        for (const destination of destinations)
            expect(sceneIds.has(destination)).toBe(true);
    });
});
