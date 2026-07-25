import { describe, expect, test } from 'vitest';

import { parseGoalPlanMarkdown } from './goal-plan.js';
import {
    goalLaunchCommandId,
    TUI_BRIDGE_PROTOCOL,
    TuiBridgeFailureResponseSchema,
    TuiBridgeRequestSchema,
    TuiBridgeResponseSchema,
} from './tui-protocol.js';

const markdown = (pretty = false): string =>
    [
        '```goal-plan',
        JSON.stringify(
            {
                ...(pretty ? { authoredBy: 'planner' } : {}),
                objective: 'Implement the bridge',
                units: [
                    {
                        id: 'implement',
                        title: 'Implement',
                        instructions: 'Implement and verify the bridge.',
                        dependencyIds: [],
                        acceptanceCriteria: ['The bridge is verified'],
                        verificationRequirements: [],
                    },
                ],
                ...(!pretty ? { authoredBy: 'planner' } : {}),
            },
            null,
            pretty ? 4 : undefined,
        ),
        '```',
    ].join('\n');

describe('TUI bridge protocol', () => {
    test('accepts only strict operation-specific requests', () => {
        expect(
            TuiBridgeRequestSchema.parse({
                protocol: TUI_BRIDGE_PROTOCOL,
                operation: 'init',
                workspace: '/workspace',
            }),
        ).toEqual({
            protocol: TUI_BRIDGE_PROTOCOL,
            operation: 'init',
            workspace: '/workspace',
        });

        for (const field of [
            'unknown',
            'authToken',
            'internalTransportAuthToken',
            'controlToken',
            'commandId',
            'transport',
        ]) {
            expect(
                TuiBridgeRequestSchema.safeParse({
                    protocol: TUI_BRIDGE_PROTOCOL,
                    operation: 'list',
                    workspace: '/workspace',
                    [field]: 'forbidden',
                }).success,
            ).toBe(false);
        }
    });

    test('keeps success and failure responses strict', () => {
        expect(
            TuiBridgeResponseSchema.safeParse({
                protocol: TUI_BRIDGE_PROTOCOL,
                ok: true,
                operation: 'launch',
                goal: { id: 'goal-1', state: 'achieved' },
            }).success,
        ).toBe(true);
        expect(
            TuiBridgeResponseSchema.safeParse({
                protocol: TUI_BRIDGE_PROTOCOL,
                ok: true,
                operation: 'launch',
                goal: {
                    id: 'goal-1',
                    state: 'executing',
                    plan: 'must-not-leak',
                },
            }).success,
        ).toBe(false);
        expect(
            TuiBridgeResponseSchema.safeParse({
                protocol: TUI_BRIDGE_PROTOCOL,
                ok: true,
                operation: 'launch',
                goal: { id: 'goal-1', state: 'finished' },
            }).success,
        ).toBe(false);
        expect(
            TuiBridgeFailureResponseSchema.safeParse({
                protocol: TUI_BRIDGE_PROTOCOL,
                ok: false,
                error: {
                    code: 'operation-failed',
                    message: 'Launch failed.',
                },
            }).success,
        ).toBe(true);
    });

    test('derives launch IDs from normalized plans, workspace, path, and actor', () => {
        const compact = parseGoalPlanMarkdown(markdown());
        const formatted = parseGoalPlanMarkdown(markdown(true));
        const base = goalLaunchCommandId(
            '/workspace',
            '/workspace/goal.md',
            compact,
            'operator',
        );

        expect(
            goalLaunchCommandId(
                '/workspace',
                '/workspace/goal.md',
                formatted,
                'operator',
            ),
        ).toBe(base);
        expect(
            goalLaunchCommandId(
                '/workspace',
                '/workspace/other.md',
                compact,
                'operator',
            ),
        ).not.toBe(base);
        expect(
            goalLaunchCommandId(
                '/workspace',
                '/workspace/goal.md',
                compact,
                'other',
            ),
        ).not.toBe(base);
    });
});
