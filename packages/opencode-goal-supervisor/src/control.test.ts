import {
    access,
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
    authenticateControlToken,
    formatGoalStatus,
    initWorkspaceControl,
    openWorkspaceControl,
    type GoalControlService,
} from './control.js';
import { DEFAULT_GOAL_BUDGET, GoalStore } from './store.js';

const directories: string[] = [];
const controls: GoalControlService[] = [];
const stores: GoalStore[] = [];

const workspace = async (prefix = 'goal-control-'): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), prefix));
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

const openControl = async (directory: string, store?: GoalStore) => {
    const initialized = await initWorkspaceControl(directory, {
        store,
        closeStore: !store,
    });
    controls.push(initialized.control);
    return initialized;
};

const plan = (destructive = false) => ({
    authoredBy: 'planner',
    units: [
        {
            id: 'unit-1',
            title: 'Implement the change',
            instructions: 'Implement and verify the requested change.',
            dependencyIds: [],
            acceptanceCriteria: ['Must pass the declared check'],
            verificationRequirements: [
                {
                    id: 'check-1',
                    type: 'command' as const,
                    executable: 'pnpm',
                    args: ['test'],
                    timeoutMs: 60_000,
                    outputCapBytes: 8_192,
                    expectedExitCode: 0,
                    required: true,
                },
            ],
            required: true,
            destructive,
        },
    ],
    finalVerificationRequirements: [],
});

describe('GoalControlService transport authentication', () => {
    test('creates an owner-only token, canonicalizes real paths, and rejects bad auth', async () => {
        const directory = await workspace();
        const alias = `${directory}-alias`;
        await symlink(directory, alias);
        directories.push(alias);
        const initialized = await openControl(alias);

        expect(initialized.workspace).toBe(directory);
        expect((await stat(initialized.tokenPath)).mode & 0o777).toBe(0o600);
        expect(
            (await stat(join(directory, '.opencode', 'goal-supervisor'))).mode &
                0o777,
        ).toBe(0o700);
        expect(
            initialized.internalTransportAuthToken.length,
        ).toBeGreaterThanOrEqual(43);
        expect(() =>
            initialized.control.list({ authToken: 'not-the-token' }),
        ).toThrow('authentication failed');
        expect(() =>
            initialized.control.list({ authToken: 'not-the-token' }),
        ).not.toThrow(initialized.internalTransportAuthToken);
        expect(
            authenticateControlToken(
                initialized.internalTransportAuthToken,
                initialized.internalTransportAuthToken,
            ),
        ).toBe(true);
        expect(
            authenticateControlToken(
                initialized.internalTransportAuthToken,
                'different-token',
            ),
        ).toBe(false);
    });

    test.runIf(process.platform !== 'win32')(
        'refuses to load a token with group or world permissions',
        async () => {
            const directory = await workspace();
            const initialized = await openControl(directory);
            await initialized.control.close();
            controls.splice(controls.indexOf(initialized.control), 1);
            await chmod(initialized.tokenPath, 0o644);

            await expect(initWorkspaceControl(directory)).rejects.toThrow(
                'owner-only permissions',
            );
        },
    );

    test('opens only existing initialized control state', async () => {
        const directory = await workspace();
        await expect(openWorkspaceControl(directory)).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await expect(
            access(join(directory, '.opencode')),
        ).rejects.toMatchObject({ code: 'ENOENT' });

        const initialized = await openControl(directory);
        await initialized.control.close();
        controls.splice(controls.indexOf(initialized.control), 1);
        const reopened = await openWorkspaceControl(directory);
        controls.push(reopened.control);
        expect(reopened.workspace).toBe(directory);
        expect(
            reopened.control.doctor({
                authToken: reopened.internalTransportAuthToken,
            }),
        ).toMatchObject({ integrity: { ok: true } });
    });

    test.runIf(process.platform !== 'win32')(
        'rejects a default database symlink outside the workspace',
        async () => {
            const directory = await workspace();
            const outside = await workspace('goal-control-outside-');
            const outsideDatabase = join(outside, 'outside.db');
            await writeFile(outsideDatabase, 'outside sentinel');
            const controlDirectory = join(
                directory,
                '.opencode',
                'goal-supervisor',
            );
            await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
            await chmod(controlDirectory, 0o700);
            const databasePath = join(controlDirectory, 'goal.db');
            await symlink(outsideDatabase, databasePath);

            await expect(initWorkspaceControl(directory)).rejects.toThrow(
                'may not be a symbolic link',
            );
            expect((await lstat(databasePath)).isSymbolicLink()).toBe(true);
            expect(await readFile(outsideDatabase, 'utf8')).toBe(
                'outside sentinel',
            );
            await expect(
                access(join(controlDirectory, 'control.token')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        },
    );
});

describe('GoalControlService semantics', () => {
    test('fences workspaces and deduplicates mutations by command ID', async () => {
        const firstWorkspace = await workspace('goal-control-a-');
        const secondWorkspace = await workspace('goal-control-b-');
        const databaseDirectory = await workspace('goal-control-db-');
        const store = new GoalStore(join(databaseDirectory, 'shared.db'));
        stores.push(store);
        const first = await openControl(firstWorkspace, store);
        const second = await openControl(secondWorkspace, store);
        const createRequest = {
            authToken: first.internalTransportAuthToken,
            commandId: 'create-once',
            objective: 'Ship the shared control plane',
        };

        const created = first.control.create(createRequest);
        expect(first.control.create(createRequest)).toEqual(created);
        expect(
            first.control.list({
                authToken: first.internalTransportAuthToken,
                commandId: 'list-first',
            }),
        ).toHaveLength(1);
        expect(() =>
            first.control.create({
                ...createRequest,
                objective: 'Reuse the command for another request',
            }),
        ).toThrow('reused with a different request');
        expect(() =>
            second.control.status({
                authToken: second.internalTransportAuthToken,
                goalId: created.id,
            }),
        ).toThrow('does not belong to workspace');
    });

    test('validates plans and requires every scoped action token', async () => {
        const directory = await workspace();
        const initialized = await openControl(directory);
        const authToken = initialized.internalTransportAuthToken;
        const control = initialized.control;
        const goal = control.create({
            authToken,
            commandId: 'create-goal',
            objective: 'Exercise every operator control',
        });

        expect(() =>
            control.plan({
                authToken,
                commandId: 'invalid-plan',
                goalId: goal.id,
                plan: {
                    ...plan(),
                    units: [
                        {
                            ...plan().units[0],
                            acceptanceCriteria: [],
                        },
                    ],
                },
            }),
        ).toThrow('acceptanceCriteria');

        const proposed = control.plan({
            authToken,
            commandId: 'propose-plan',
            goalId: goal.id,
            plan: plan(true),
        });
        expect(
            control.approvePlan({
                authToken,
                commandId: 'approve-plan',
                goalId: goal.id,
                planId: proposed.id,
                actor: 'operator',
            }).state,
        ).toBe('ready');
        const unit = control.inspect({ authToken, goalId: goal.id })
            .workUnits[0]!;

        const destructive = control.issueScopedApproval({
            authToken,
            commandId: 'issue-destructive',
            goalId: goal.id,
            scope: { type: 'work-unit', workUnitId: unit.id },
            actor: 'operator',
            reason: 'Allow the declared destructive unit',
            ttlMs: 60_000,
        });
        expect(destructive.actionToken).toBeTypeOf('string');
        const replayedDestructive = control.issueScopedApproval({
            authToken,
            commandId: 'issue-destructive',
            goalId: goal.id,
            scope: { type: 'work-unit', workUnitId: unit.id },
            actor: 'operator',
            reason: 'Allow the declared destructive unit',
            ttlMs: 60_000,
        });
        expect(replayedDestructive).toMatchObject({ replayed: true });
        expect('actionToken' in replayedDestructive).toBe(false);
        expect(() =>
            control.approveDestructiveUnit({
                authToken,
                commandId: 'bad-destructive-token',
                goalId: goal.id,
                workUnitId: unit.id,
                approvalToken: 'x'.repeat(32),
            }),
        ).toThrow('invalid for this goal');
        control.approveDestructiveUnit({
            authToken,
            commandId: 'approve-destructive',
            goalId: goal.id,
            workUnitId: unit.id,
            approvalToken: destructive.actionToken!,
        });

        const budgetApproval = control.issueScopedApproval({
            authToken,
            commandId: 'issue-budget',
            goalId: goal.id,
            scope: { type: 'goal-action', action: 'raise-budget' },
            actor: 'operator',
            reason: 'Raise all limits',
            ttlMs: 60_000,
        });
        const raisedBudget = {
            maxAttempts: DEFAULT_GOAL_BUDGET.maxAttempts + 1,
            maxWallClockMs: DEFAULT_GOAL_BUDGET.maxWallClockMs + 1,
            maxVerificationMs: DEFAULT_GOAL_BUDGET.maxVerificationMs + 1,
            maxTokens: DEFAULT_GOAL_BUDGET.maxTokens + 1,
        };
        expect(
            control.raiseBudget({
                authToken,
                commandId: 'raise-budget',
                goalId: goal.id,
                budget: raisedBudget,
                approvalToken: budgetApproval.actionToken!,
            }),
        ).toEqual(raisedBudget);

        const startApproval = control.issueScopedApproval({
            authToken,
            commandId: 'issue-start',
            goalId: goal.id,
            scope: { type: 'goal-action', action: 'unattended-start' },
            actor: 'operator',
            reason: 'Start unattended execution',
            ttlMs: 60_000,
        });
        expect(
            control.start({
                authToken,
                commandId: 'start',
                goalId: goal.id,
                approvalToken: startApproval.actionToken!,
            }).state,
        ).toBe('executing');
        expect(
            control.pause({
                authToken,
                commandId: 'pause',
                goalId: goal.id,
                reason: 'Operator pause',
            }).state,
        ).toBe('paused');
        expect(
            formatGoalStatus(control.status({ authToken, goalId: goal.id })),
        ).toContain('PAUSED');

        const resumeApproval = control.issueScopedApproval({
            authToken,
            commandId: 'issue-resume',
            goalId: goal.id,
            scope: { type: 'goal-action', action: 'resume' },
            actor: 'operator',
            reason: 'Resume paused execution',
            ttlMs: 60_000,
        });
        expect(
            control.resume({
                authToken,
                commandId: 'resume',
                goalId: goal.id,
                approvalToken: resumeApproval.actionToken!,
            }).state,
        ).toBe('executing');
        expect(
            control.cancel({
                authToken,
                commandId: 'cancel',
                goalId: goal.id,
                reason: 'Operator cancellation',
            }).state,
        ).toBe('cancelled');
        expect(
            formatGoalStatus(control.status({ authToken, goalId: goal.id })),
        ).toContain('TERMINAL');
        expect(
            control
                .inspect({ authToken, goalId: goal.id })
                .approvals.every(approval => !('tokenHash' in approval)),
        ).toBe(true);
    });

    test('recovers unknown outcomes only with an explicit scoped decision', async () => {
        const directory = await workspace();
        const store = new GoalStore(join(directory, 'shared.db'));
        stores.push(store);
        const initialized = await openControl(directory, store);
        const { control, internalTransportAuthToken: authToken } = initialized;
        const goal = control.create({
            authToken,
            commandId: 'create-recovery-goal',
            objective: 'Recover an ambiguous external dispatch',
        });
        const proposed = control.plan({
            authToken,
            commandId: 'plan-recovery-goal',
            goalId: goal.id,
            plan: plan(),
        });
        control.approvePlan({
            authToken,
            commandId: 'approve-recovery-plan',
            goalId: goal.id,
            planId: proposed.id,
            actor: 'operator',
        });
        const start = control.issueScopedApproval({
            authToken,
            commandId: 'issue-recovery-start',
            goalId: goal.id,
            scope: { type: 'goal-action', action: 'unattended-start' },
            actor: 'operator',
            reason: 'Start recovery fixture',
            ttlMs: 60_000,
        });
        control.start({
            authToken,
            commandId: 'start-recovery-goal',
            goalId: goal.id,
            approvalToken: start.actionToken!,
        });
        store.claimNextWork('worker', 60_000, directory);
        const message = store.claimOutbox(1, 60_000, 'dispatcher')[0]!;
        store.markDispatchStarted(message.id, message.leaseToken);
        store.markUnknownOutcome(
            message.id,
            message.leaseToken,
            'The external result is ambiguous',
        );
        expect(
            formatGoalStatus(control.status({ authToken, goalId: goal.id })),
        ).toContain('UNKNOWN OUTCOME');

        const recovery = control.issueScopedApproval({
            authToken,
            commandId: 'issue-recovery',
            goalId: goal.id,
            scope: {
                type: 'goal-action',
                action: 'recover-unknown-outcome',
            },
            actor: 'operator',
            reason: 'Choose a safe paused state',
            ttlMs: 60_000,
        });
        expect(
            control.recover({
                authToken,
                commandId: 'recover',
                goalId: goal.id,
                approvalToken: recovery.actionToken!,
                targetState: 'paused',
                decision:
                    'The operator confirmed no external change completed.',
            }).state,
        ).toBe('paused');
        expect(control.doctor({ authToken })).toMatchObject({
            workspace: directory,
            goalCount: 1,
            integrity: { ok: true },
            projections: { ok: true },
        });
    });

    test('removes terminal control sequences from human status output', async () => {
        const directory = await workspace();
        const initialized = await openControl(directory);
        const authToken = initialized.internalTransportAuthToken;
        const goal = initialized.control.create({
            authToken,
            commandId: 'create-control-character-goal',
            objective:
                'Safe\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007\u009b31m',
        });

        const output = formatGoalStatus(
            initialized.control.status({ authToken, goalId: goal.id }),
        );
        expect(output).toContain('Safe ]8;;https://example.test link ]8;; 31m');
        expect(
            Array.from(output).some(character => {
                const code = character.charCodeAt(0);
                return (
                    (code <= 0x1f && character !== '\n') ||
                    (code >= 0x7f && code <= 0x9f)
                );
            }),
        ).toBe(false);
    });
});
