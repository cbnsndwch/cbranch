import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import { afterEach, describe, expect, test } from 'vitest';

import { initWorkspaceControl } from './control.js';
import openCodeGoalSupervisor from './opencode.js';
import { GoalStore } from './store.js';

const directories: string[] = [];
const disposals: (() => Promise<void>)[] = [];

const makeWorkspace = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-opencode-'));
    directories.push(directory);
    return directory;
};

afterEach(async () => {
    await Promise.all(disposals.splice(0).map(dispose => dispose()));
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const loadPlugin = async (directory: string): Promise<Hooks> => {
    const fakeClient = {};
    const hooks = await openCodeGoalSupervisor({
        directory,
        client: fakeClient,
    } as PluginInput);
    if (hooks.dispose) disposals.push(hooks.dispose);
    return hooks;
};

const execute = async (
    hooks: Hooks,
    name: string,
    input: Record<string, unknown>,
): Promise<string> => {
    const definition = hooks.tool?.[name];
    if (!definition) throw new Error(`Missing tool ${name}.`);
    const result = await definition.execute(input, {} as never);
    return typeof result === 'string' ? result : result.output;
};

const plan = {
    authoredBy: 'planner',
    units: [
        {
            id: 'plugin-unit',
            title: 'Plugin event fixture',
            instructions: 'Wait for normalized OpenCode observations.',
            dependencyIds: [],
            acceptanceCriteria: ['Must preserve daemon-owned scheduling'],
            verificationRequirements: [],
            required: true,
            destructive: false,
        },
    ],
    finalVerificationRequirements: [],
};

describe('OpenCode goal supervisor plugin', () => {
    test('exposes authenticated tools, closes deterministically, and restarts existing state', async () => {
        const directory = await makeWorkspace();
        const first = await loadPlugin(directory);

        expect(Object.keys(first.tool ?? {})).toEqual(
            expect.arrayContaining([
                'goal_create',
                'goal_list',
                'goal_plan',
                'goal_start',
                'goal_status',
                'goal_pause',
                'goal_resume',
                'goal_cancel',
                'goal_approve',
                'goal_inspect',
                'goal_recover',
            ]),
        );
        expect(await execute(first, 'goal_list', {})).toBe(
            'No supervised goals in this workspace.',
        );
        expect(
            await execute(first, 'goal_create', {
                objective: 'Persist across plugin restart',
                commandId: 'plugin-create',
            }),
        ).toContain('Created goal');
        const firstList = await execute(first, 'goal_list', {});
        expect(firstList).toContain('Persist across plugin restart');

        const firstDispose = first.dispose!;
        disposals.splice(disposals.indexOf(firstDispose), 1);
        await firstDispose();
        await expect(execute(first, 'goal_list', {})).rejects.toThrow();

        const restarted = await loadPlugin(directory);
        expect(await execute(restarted, 'goal_list', {})).toBe(firstList);
        const store = new GoalStore(
            join(directory, '.opencode', 'goal-supervisor', 'goal.db'),
        );
        expect(store.list(directory)).toHaveLength(1);
        expect(store.listWorkUnits(store.list(directory)[0]!.id)).toHaveLength(
            0,
        );
        store.close();
    });

    test('removes terminal control sequences from goal list output', async () => {
        const directory = await makeWorkspace();
        const hooks = await loadPlugin(directory);

        await execute(hooks, 'goal_create', {
            objective:
                'Visible\u001b]8;;https://example.invalid\u0007label\u009b31m',
        });
        const output = await execute(hooks, 'goal_list', {});

        expect(output).toContain('Visible');
        expect(output).toContain('label 31m');
        expect(
            Array.from(output).every(character => {
                const code = character.charCodeAt(0);
                return code > 0x1f && (code < 0x7f || code > 0x9f);
            }),
        ).toBe(true);
    });

    test('renders operator approval commands without mutating approval state', async () => {
        const directory = await makeWorkspace();
        const initialized = await initWorkspaceControl(directory);
        await initialized.control.close();
        const databasePath = join(
            directory,
            '.opencode',
            'goal-supervisor',
            'goal.db',
        );
        const seed = new GoalStore(databasePath);
        const goal = seed.create(directory, 'Keep model approval advisory');
        const proposed = seed.proposePlan(goal.id, {
            ...plan,
            units: [{ ...plan.units[0], destructive: true }],
        });
        seed.approvePlan(goal.id, proposed.id, 'operator');
        const unit = seed.listWorkUnits(goal.id)[0]!;
        const destructive = seed.issueApproval(
            goal.id,
            { type: 'work-unit', workUnitId: unit.id },
            'operator',
            'Operator-issued destructive approval',
            60_000,
        );
        seed.close();

        const hooks = await loadPlugin(directory);
        const approvalTool = hooks.tool?.goal_approve;
        expect(approvalTool).toBeDefined();
        expect('actor' in (approvalTool!.args as object)).toBe(false);
        expect('approvalToken' in (approvalTool!.args as object)).toBe(false);
        const created = await execute(hooks, 'goal_create', {
            objective: 'Keep plugin plan proposed',
        });
        const modelGoalId = /Created goal ([^ ]+)/u.exec(created)?.[1];
        expect(modelGoalId).toBeTypeOf('string');
        const proposedByModel = await execute(hooks, 'goal_plan', {
            goalId: modelGoalId,
            plan,
        });
        const modelPlanId = /Proposed plan ([^,]+)/u.exec(proposedByModel)?.[1];
        expect(modelPlanId).toBeTypeOf('string');
        expect(
            await execute(hooks, 'goal_approve', {
                action: 'approve-plan',
                goalId: modelGoalId,
                planId: modelPlanId,
                actor: 'operator',
            }),
        ).toContain('Operator approval is required');
        expect(
            JSON.parse(
                await execute(hooks, 'goal_inspect', {
                    goalId: modelGoalId,
                }),
            ),
        ).toMatchObject({
            goal: { state: 'draft' },
            plans: [{ id: modelPlanId }],
            approvals: [],
        });
        expect(
            await execute(hooks, 'goal_approve', {
                action: 'approve-destructive',
                goalId: goal.id,
                workUnitId: unit.id,
                actor: 'operator',
                approvalToken: destructive.token,
            }),
        ).toContain('Operator approval is required');

        const inspection = JSON.parse(
            await execute(hooks, 'goal_inspect', { goalId: goal.id }),
        ) as {
            approvals: { id: string; consumedAt?: string }[];
        };
        expect(inspection.approvals).toHaveLength(1);
        expect(inspection.approvals[0]).toMatchObject({
            id: destructive.approval.id,
        });
        expect(inspection.approvals[0]?.consumedAt).toBeUndefined();
        await expect(
            execute(hooks, 'goal_approve', {
                action: 'issue-start',
                goalId: 'goal-1; touch injected',
            }),
        ).rejects.toThrow();
        expect(
            await execute(hooks, 'goal_approve', {
                action: 'approve-plan',
                goalId: modelGoalId,
            }),
        ).not.toContain('cbranch-goal-supervisor');
    });

    test('records only supervisor session events without scheduling or changing permission decisions', async () => {
        const directory = await makeWorkspace();
        const initialized = await initWorkspaceControl(directory);
        await initialized.control.close();
        const databasePath = join(
            directory,
            '.opencode',
            'goal-supervisor',
            'goal.db',
        );
        const seed = new GoalStore(databasePath);
        const goal = seed.create(directory, 'Bridge supervisor session events');
        const proposed = seed.proposePlan(goal.id, plan);
        seed.approvePlan(goal.id, proposed.id, 'operator');
        const start = seed.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'unattended-start' },
            'operator',
            'Start event fixture',
            60_000,
        );
        seed.startGoal(goal.id, start.token);
        const attempt = seed.claimNextWork('worker', 60_000, directory)!;
        seed.recordSessionReference(
            attempt.id,
            'dispatch',
            'opencode-session:session-1',
        );
        seed.close();

        let hooks = await loadPlugin(directory);
        await hooks.event?.({
            event: {
                type: 'session.idle',
                properties: { sessionID: 'unrelated-session' },
            } as never,
        });
        await hooks.event?.({
            event: {
                type: 'session.idle',
                properties: { sessionID: 'session-1' },
            } as never,
        });
        await hooks.event?.({
            event: {
                type: 'permission.updated',
                properties: {
                    id: 'permission-1',
                    type: 'bash',
                    sessionID: 'session-1',
                    messageID: 'message-1',
                    title: 'Run a command',
                    metadata: {},
                    time: { created: Date.now() },
                },
            } as never,
        });
        const beforeReplyDispose = hooks.dispose!;
        disposals.splice(disposals.indexOf(beforeReplyDispose), 1);
        await beforeReplyDispose();
        hooks = await loadPlugin(directory);
        await hooks.event?.({
            event: {
                type: 'permission.replied',
                properties: {
                    sessionID: 'session-1',
                    permissionID: 'permission-1',
                    response: 'once',
                },
            } as never,
        });
        const hostDecision = { status: 'ask' as const };
        await hooks['permission.ask']?.(
            {
                id: 'permission-2',
                type: 'edit',
                sessionID: 'session-1',
                messageID: 'message-2',
                title: 'Edit a file',
                metadata: {},
                time: { created: Date.now() },
            },
            hostDecision,
        );
        expect(hostDecision.status).toBe('ask');

        const dispose = hooks.dispose!;
        disposals.splice(disposals.indexOf(dispose), 1);
        await dispose();
        const stored = new GoalStore(databasePath);
        expect(stored.status(goal.id, directory).goal.state).toBe('executing');
        expect(stored.listWorkUnits(goal.id)).toHaveLength(1);
        expect(stored.listActiveAttempts(goal.id)).toEqual([attempt]);
        expect(
            stored
                .events(goal.id)
                .filter(event => event.type === 'observation.recorded'),
        ).toHaveLength(4);
        expect(stored.listApprovals(goal.id)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    decision: 'approved',
                    scope: {
                        type: 'permission',
                        sessionId: 'session-1',
                        permissionId: 'permission-1',
                        permissionType: 'bash',
                    },
                }),
            ]),
        );
        stored.close();

        const restarted = await loadPlugin(directory);
        const verifyRestart = new GoalStore(databasePath);
        expect(verifyRestart.list(directory)).toHaveLength(1);
        expect(verifyRestart.listWorkUnits(goal.id)).toHaveLength(1);
        expect(verifyRestart.listActiveAttempts(goal.id)).toHaveLength(1);
        verifyRestart.close();
        expect(restarted.event).toBeTypeOf('function');
    });
});
