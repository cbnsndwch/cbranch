import { describe, expect, test } from 'vitest';

import {
    MAX_GOAL_PLAN_MARKDOWN_BYTES,
    parseGoalPlanMarkdown,
} from './goal-plan.js';

const validPlan = () => ({
    objective: 'Ship the reviewed change',
    units: [
        {
            id: 'implement',
            title: 'Implement',
            instructions: 'Implement and verify the change.',
            dependencyIds: [],
            acceptanceCriteria: ['The requested change works'],
            verificationRequirements: [],
        },
    ],
    authoredBy: 'planner',
});

const markdown = (value: unknown): string =>
    `# Proposed goal\n\nThe operator should review this plan.\n\n\`\`\`goal-plan\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\nExecution notes follow.`;

describe('parseGoalPlanMarkdown', () => {
    test('accepts one strict goal-plan block surrounded by Markdown', () => {
        const document = [
            '# Plan',
            '',
            '~~~text',
            '```goal-plan',
            'This is an inert example inside another fence.',
            '~~~',
            '',
            '```goal-plan',
            JSON.stringify(validPlan()),
            '```',
            '',
            'Reviewed explanatory text.',
        ].join('\n');

        expect(parseGoalPlanMarkdown(document)).toEqual({
            ...validPlan(),
            units: [
                {
                    ...validPlan().units[0],
                    required: true,
                    destructive: false,
                },
            ],
            finalVerificationRequirements: [],
        });
    });

    test('rejects missing, repeated, malformed, and unclosed fences', () => {
        expect(() => parseGoalPlanMarkdown('# No structured plan')).toThrow(
            'exactly one',
        );
        expect(() =>
            parseGoalPlanMarkdown(
                `${markdown(validPlan())}\n\n~~~goal-plan\n${JSON.stringify(validPlan())}\n~~~`,
            ),
        ).toThrow('exactly one');
        expect(() =>
            parseGoalPlanMarkdown(
                `\`\`\`goal-plan json\n${JSON.stringify(validPlan())}\n\`\`\``,
            ),
        ).toThrow("info string must be exactly 'goal-plan'");
        expect(() =>
            parseGoalPlanMarkdown(
                `\`\`\`goal-plan\n${JSON.stringify(validPlan())}`,
            ),
        ).toThrow('unclosed');
        expect(() =>
            parseGoalPlanMarkdown(`${markdown(validPlan())}\n\n~~~text`),
        ).toThrow('Markdown code fence is unclosed');
    });

    test('rejects malformed JSON and duplicate keys at any object depth', () => {
        expect(() =>
            parseGoalPlanMarkdown('```goal-plan\n{"objective":\n```'),
        ).toThrow('Invalid goal-plan JSON');

        const duplicateTopLevel = JSON.stringify(validPlan()).replace(
            '"objective":"Ship the reviewed change"',
            '"objective":"First","objective":"Second"',
        );
        expect(() =>
            parseGoalPlanMarkdown(
                `\`\`\`goal-plan\n${duplicateTopLevel}\n\`\`\``,
            ),
        ).toThrow('duplicate object key "objective"');

        const duplicateNested = JSON.stringify(validPlan()).replace(
            '"id":"implement"',
            '"id":"implement","id":"duplicate"',
        );
        expect(() =>
            parseGoalPlanMarkdown(
                `\`\`\`goal-plan\n${duplicateNested}\n\`\`\``,
            ),
        ).toThrow('duplicate object key "id"');
    });

    test('rejects transport fields and unknown nested fields', () => {
        expect(() =>
            parseGoalPlanMarkdown(
                markdown({
                    ...validPlan(),
                    authToken: 'must-not-be-plan-data',
                    commandId: 'transport-command',
                }),
            ),
        ).toThrow('Unrecognized keys');
        expect(() =>
            parseGoalPlanMarkdown(
                markdown({
                    ...validPlan(),
                    units: [
                        {
                            ...validPlan().units[0],
                            approvalToken: 'must-not-be-plan-data',
                        },
                    ],
                }),
            ),
        ).toThrow('Unrecognized key');
    });

    test('requires an objective and rejects invalid or cyclic plans', () => {
        const { objective: _objective, ...withoutObjective } = validPlan();
        expect(() => parseGoalPlanMarkdown(markdown(withoutObjective))).toThrow(
            'objective',
        );

        expect(() =>
            parseGoalPlanMarkdown(
                markdown({
                    ...validPlan(),
                    units: [
                        {
                            ...validPlan().units[0],
                            dependencyIds: ['verify'],
                        },
                        {
                            ...validPlan().units[0],
                            id: 'verify',
                            title: 'Verify',
                            dependencyIds: ['implement'],
                        },
                    ],
                }),
            ),
        ).toThrow('cycle');
    });

    test('enforces the exported UTF-8 document limit before parsing', () => {
        expect(() =>
            parseGoalPlanMarkdown('x'.repeat(MAX_GOAL_PLAN_MARKDOWN_BYTES + 1)),
        ).toThrow(`${MAX_GOAL_PLAN_MARKDOWN_BYTES}-byte limit`);
    });
});
