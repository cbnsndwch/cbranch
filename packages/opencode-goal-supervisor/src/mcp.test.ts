import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { initWorkspaceControl, type GoalControlService } from './control.js';
import {
    McpApprovalRequestSchema,
    McpBudgetRequestSchema,
    McpCreateRequestSchema,
    McpDoctorRequestSchema,
    McpGoalRequestSchema,
    McpListRequestSchema,
    McpPlanRequestSchema,
    McpReasonRequestSchema,
    McpRecoverRequestSchema,
    McpStartRequestSchema,
    goalMcpTools,
} from './mcp.js';
import { GoalStore } from './store.js';

const directories: string[] = [];
const controls: GoalControlService[] = [];
const stores: GoalStore[] = [];

const makeWorkspace = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-mcp-'));
    directories.push(directory);
    return directory;
};

afterEach(async () => {
    await Promise.all(controls.splice(0).map(control => control.close()));
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const structuredPlan = {
    authoredBy: 'planner',
    units: [
        {
            id: 'mcp-unit',
            title: 'MCP unit',
            instructions: 'Exercise the MCP control adapter.',
            dependencyIds: [],
            acceptanceCriteria: ['Must remain under control service policy'],
            verificationRequirements: [],
            required: true,
            destructive: true,
        },
    ],
    finalVerificationRequirements: [],
};

describe('goalMcpTools', () => {
    test('keeps transport auth out of schemas and validates it at setup', async () => {
        const directory = await makeWorkspace();
        const initialized = await initWorkspaceControl(directory);
        controls.push(initialized.control);
        const schemas = [
            McpApprovalRequestSchema,
            McpBudgetRequestSchema,
            McpCreateRequestSchema,
            McpDoctorRequestSchema,
            McpGoalRequestSchema,
            McpListRequestSchema,
            McpPlanRequestSchema,
            McpReasonRequestSchema,
            McpRecoverRequestSchema,
            McpStartRequestSchema,
        ];
        for (const schema of schemas) {
            expect('authToken' in schema.shape).toBe(false);
        }
        expect(() => goalMcpTools(initialized.control, 'wrong')).toThrow(
            'authentication failed',
        );
        expect(() =>
            goalMcpTools(initialized.control, undefined as never),
        ).toThrow();

        const tools = goalMcpTools(
            initialized.control,
            initialized.internalTransportAuthToken,
        );

        expect(Object.keys(tools)).toEqual([
            'goal_create',
            'goal_list',
            'goal_plan',
            'goal_status',
            'goal_start',
            'goal_pause',
            'goal_resume',
            'goal_cancel',
            'goal_approve',
            'goal_inspect',
            'goal_recover',
            'goal_raise_budget',
            'goal_doctor',
        ]);
        expect('goal_transition' in tools).toBe(false);
        expect(tools.goal_list({ authToken: 'model-value' } as never)).toEqual(
            [],
        );
    });

    test('preserves request IDs but leaves approval authority to the CLI', async () => {
        const directory = await makeWorkspace();
        const initialized = await initWorkspaceControl(directory);
        controls.push(initialized.control);
        const authToken = initialized.internalTransportAuthToken;
        const tools = goalMcpTools(initialized.control, authToken);
        const createRequest = {
            commandId: 'mcp-create-once',
            objective: 'Verify MCP idempotency',
        };
        const goal = tools.goal_create(createRequest);

        expect(tools.goal_create(createRequest)).toEqual(goal);
        expect(tools.goal_list({})).toHaveLength(1);
        const proposed = tools.goal_plan({
            commandId: 'mcp-plan',
            goalId: goal.id,
            plan: structuredPlan,
        });
        expect(
            tools.goal_approve({
                commandId: 'mcp-approve-plan',
                action: 'approve-plan',
                goalId: goal.id,
                planId: proposed.id,
            }),
        ).toContain('cbranch-goal-supervisor approve');
        expect(
            tools.goal_approve({
                commandId: 'mcp-issue-start',
                action: 'issue-start',
                goalId: goal.id,
            }),
        ).toContain('Operator approval is required');
        expect(() =>
            tools.goal_approve({
                action: 'approve-plan',
                goalId: goal.id,
                planId: proposed.id,
                actor: 'operator',
            } as never),
        ).toThrow('Invalid approval request');
        expect(tools.goal_inspect({ goalId: goal.id })).toMatchObject({
            goal: { state: 'draft' },
            plans: [{ id: proposed.id }],
            approvals: [],
        });

        initialized.control.approvePlan({
            authToken,
            commandId: 'operator-approve-plan',
            goalId: goal.id,
            planId: proposed.id,
            actor: 'operator',
        });
        const destructiveUnit = tools.goal_inspect({ goalId: goal.id })
            .workUnits[0]!;
        const destructive = initialized.control.issueScopedApproval({
            authToken,
            commandId: 'operator-issue-destructive',
            goalId: goal.id,
            scope: { type: 'work-unit', workUnitId: destructiveUnit.id },
            actor: 'operator',
            reason: 'Allow destructive work',
            ttlMs: 60_000,
        });
        expect(
            tools.goal_approve({
                action: 'approve-destructive',
                goalId: goal.id,
                workUnitId: destructiveUnit.id,
            }),
        ).toContain("--approval-token 'OPERATOR_ISSUED_TOKEN'");
        const persistedDestructive = tools
            .goal_inspect({ goalId: goal.id })
            .approvals.find(
                approval => approval.id === destructive.approval.id,
            );
        expect(persistedDestructive).toMatchObject({
            id: destructive.approval.id,
        });
        expect(persistedDestructive?.consumedAt).toBeUndefined();
        const issued = initialized.control.issueScopedApproval({
            authToken,
            commandId: 'operator-issue-start',
            goalId: goal.id,
            scope: { type: 'goal-action', action: 'unattended-start' },
            actor: 'operator',
            reason: 'Allow start',
            ttlMs: 60_000,
        });
        expect(
            tools.goal_start({
                commandId: 'mcp-start',
                goalId: goal.id,
                approvalToken: issued.actionToken!,
            }),
        ).toMatchObject({ state: 'executing' });
        expect(tools.goal_status({ goalId: goal.id })).toMatchObject({
            goal: { id: goal.id, state: 'executing' },
        });
        expect(tools.goal_doctor({})).toMatchObject({
            integrity: { ok: true },
        });
    });

    test('fences goal IDs from another workspace through the service', async () => {
        const firstWorkspace = await makeWorkspace();
        const secondWorkspace = await makeWorkspace();
        const databaseDirectory = await makeWorkspace();
        const store = new GoalStore(join(databaseDirectory, 'shared.db'));
        stores.push(store);
        const first = await initWorkspaceControl(firstWorkspace, {
            store,
            closeStore: false,
        });
        const second = await initWorkspaceControl(secondWorkspace, {
            store,
            closeStore: false,
        });
        controls.push(first.control, second.control);
        const goal = goalMcpTools(
            first.control,
            first.internalTransportAuthToken,
        ).goal_create({
            commandId: 'workspace-a-create',
            objective: 'Stay in workspace A',
        });

        expect(() =>
            goalMcpTools(
                second.control,
                second.internalTransportAuthToken,
            ).goal_status({ goalId: goal.id }),
        ).toThrow('does not belong to workspace');
    });
});
