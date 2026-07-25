import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION, type GoalBudget } from './domain.js';
import { GoalStore, type GoalStoreOptions, type PlanInput } from './store.js';

const digest = (character = 'a'): `sha256:${string}` =>
    `sha256:${character.repeat(64)}`;

const directories: string[] = [];
const stores: GoalStore[] = [];

const storeFor = async (
    options?: GoalStoreOptions,
): Promise<{ readonly store: GoalStore; readonly path: string }> => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-supervisor-'));
    directories.push(directory);
    const path = join(directory, 'goal.db');
    const store = new GoalStore(path, options);
    stores.push(store);
    return { store, path };
};

afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const requirement = (id: string) => ({
    id,
    type: 'command' as const,
    executable: 'pnpm',
    args: ['test'],
    timeoutMs: 60_000,
    outputCapBytes: 8_192,
    required: true,
});

const planInput = (
    units: PlanInput['units'],
    finalVerificationRequirements: PlanInput['finalVerificationRequirements'] = [],
): PlanInput => ({
    authoredBy: 'planner',
    units,
    finalVerificationRequirements,
});

const approveAndStart = (
    store: GoalStore,
    goalId: string,
    input: PlanInput,
): void => {
    const plan = store.proposePlan(goalId, input);
    store.approvePlan(goalId, plan.id, 'operator');
    const { token } = store.issueApproval(
        goalId,
        { type: 'goal-action', action: 'unattended-start' },
        'operator',
        'Run the approved plan',
        60_000,
    );
    store.startGoal(goalId, token);
};

describe('GoalStore durability', () => {
    test.runIf(process.platform !== 'win32')(
        'rejects a symlink at the default workspace database path',
        async () => {
            const directory = await mkdtemp(
                join(tmpdir(), 'goal-supervisor-default-path-'),
            );
            directories.push(directory);
            const controlDirectory = join(
                directory,
                '.opencode',
                'goal-supervisor',
            );
            await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
            const outside = join(directory, 'outside.db');
            await writeFile(outside, 'outside sentinel');
            const databasePath = join(controlDirectory, 'goal.db');
            await symlink(outside, databasePath);

            expect(() => new GoalStore(databasePath)).toThrow(
                'may not be a symbolic link',
            );
            expect(await readFile(outside, 'utf8')).toBe('outside sentinel');
        },
    );

    test('migrates fresh storage, orders events, rebuilds projections, and backs up', async () => {
        const { store, path } = await storeFor();
        const goal = store.create('/workspace', 'Verify releases');
        const proposed = store.proposePlan(
            goal.id,
            planInput([
                {
                    id: 'verify',
                    title: 'Verify',
                    instructions: 'Verify the release.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must pass release checks'],
                },
            ]),
        );

        const events = store.events(goal.id);
        expect(events.map(event => event.sequence)).toEqual(
            events
                .map(event => event.sequence)
                .toSorted((left, right) => left - right),
        );
        expect(new Set(events.map(event => event.sequence)).size).toBe(
            events.length,
        );
        expect(events.at(-1)?.payload.goal).toMatchObject({
            id: goal.id,
            workspace: '/workspace',
        });

        const raw = new Database(path);
        raw.prepare(
            "UPDATE goals SET objective = 'corrupted projection' WHERE id = ?",
        ).run(goal.id);
        raw.prepare(
            `INSERT INTO goals(
                id, workspace, objective, state, version, created_at,
                updated_at, schema_version
             ) VALUES ('rogue', '/workspace', 'No event', 'draft', 0,
                       '2026-01-01T00:00:00.000Z',
                       '2026-01-01T00:00:00.000Z', 1)`,
        ).run();
        raw.close();
        expect(store.get(goal.id)?.objective).toBe('corrupted projection');
        expect(store.verifyProjections().ok).toBe(false);
        expect(store.rebuildProjections()).toBe(1);
        expect(store.get(goal.id)?.objective).toBe('Verify releases');
        expect(store.get('rogue')).toBeUndefined();
        expect(store.verifyProjections()).toEqual({
            ok: true,
            mismatchedGoalIds: [],
        });
        expect(store.getPlan(proposed.id)).toEqual(proposed);

        const integrity = store.integrityCheck();
        expect(integrity).toMatchObject({
            ok: true,
            schemaVersion: 3,
            latestSchemaVersion: 3,
            journalMode: 'wal',
        });
        const backupPath = join(path, '..', 'backup', 'goal.db');
        await store.backup(backupPath);
        const backup = new GoalStore(backupPath);
        stores.push(backup);
        expect(backup.get(goal.id)?.objective).toBe('Verify releases');
        expect(backup.integrityCheck().ok).toBe(true);
        store.close();
        store.close();
    });

    test('infers and upgrades the prototype v1 schema without duplicate columns', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'goal-supervisor-v1-'));
        directories.push(directory);
        const path = join(directory, 'goal.db');
        const database = new Database(path);
        database.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE goal_events (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE work_units (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), kind TEXT NOT NULL,
        input_json TEXT NOT NULL, state TEXT NOT NULL, active_attempt_id TEXT,
        next_attempt_number INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE work_attempts (
        id TEXT PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
        number INTEGER NOT NULL, lease_token TEXT NOT NULL, lease_owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(work_unit_id, number)
      );
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
        idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
        state TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT,
        delivered_at TEXT, created_at TEXT NOT NULL
      );
    `);
        const createdAt = '2026-01-01T00:00:00.000Z';
        database
            .prepare('INSERT INTO goals VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(
                'legacy',
                '/legacy',
                'Legacy objective',
                'draft',
                0,
                createdAt,
                createdAt,
            );
        database
            .prepare('INSERT INTO goal_events VALUES (?, ?, ?, ?, ?)')
            .run('legacy-event', 'legacy', 'goal.created', '{}', createdAt);
        database.close();

        const store = new GoalStore(path);
        stores.push(store);
        expect(store.get('legacy')).toMatchObject({
            schemaVersion: SCHEMA_VERSION,
            workspace: '/legacy',
            objective: 'Legacy objective',
        });
        expect(store.events('legacy').map(event => event.type)).toEqual([
            'goal.created',
            'goal.migrated',
        ]);
        expect(store.integrityCheck()).toMatchObject({
            ok: true,
            schemaVersion: 3,
        });
    });

    test('persists idempotent command results and rolls back failed handlers', async () => {
        const { store } = await storeFor();
        let calls = 0;
        const first = store.executeIdempotent(
            'command-1',
            '/workspace',
            { objective: 'A' },
            () => {
                calls += 1;
                return store.create('/workspace', 'A');
            },
        );
        const replay = store.executeIdempotent(
            'command-1',
            '/workspace',
            { objective: 'A' },
            () => {
                calls += 1;
                return store.create('/workspace', 'duplicate');
            },
        );
        expect(replay).toEqual(first);
        expect(calls).toBe(1);
        expect(store.events(first.id)[0]?.commandId).toBe('command-1');
        expect(() =>
            store.executeIdempotent(
                'command-1',
                '/workspace',
                { objective: 'different' },
                () => null,
            ),
        ).toThrow('different request');

        expect(() =>
            store.executeIdempotent('command-failed', '/workspace', {}, () => {
                store.create('/workspace', 'Rolled back');
                throw new Error('handler failed with token=secret-value');
            }),
        ).toThrow('handler failed');
        expect(store.list('/workspace')).toHaveLength(1);
        expect(() =>
            store.executeIdempotent(
                'command-failed',
                '/workspace',
                {},
                () => null,
            ),
        ).toThrow('token=[REDACTED]');

        expect(() =>
            store.executeIdempotent(
                'command-reentrant',
                '/workspace',
                {},
                () => {
                    store.create('/workspace', 'Must roll back');
                    return store.executeIdempotent(
                        'command-reentrant',
                        '/workspace',
                        {},
                        () => null,
                    );
                },
            ),
        ).toThrow('already in progress');
        expect(store.list('/workspace')).toHaveLength(1);
        expect(() =>
            store.executeIdempotent(
                'command-reentrant',
                '/workspace',
                {},
                () => null,
            ),
        ).toThrow('already in progress');

        expect(() =>
            store.executeIdempotent(
                'command-invalid-result',
                '/workspace',
                {},
                () => {
                    store.create('/workspace', 'Also rolls back');
                    return undefined;
                },
            ),
        ).toThrow('JSON-compatible');
        expect(store.list('/workspace')).toHaveLength(1);
        expect(() =>
            store.executeIdempotent(
                'command-invalid-result',
                '/workspace',
                {},
                () => null,
            ),
        ).toThrow('JSON-compatible');
    });

    test('replays an idempotent command after the database is reopened', async () => {
        const { store, path } = await storeFor();
        const first = store.executeIdempotent(
            'command-across-restart',
            '/workspace',
            { objective: 'Persist the command result' },
            () => store.create('/workspace', 'Persist the command result'),
        );
        store.close();

        const reopened = new GoalStore(path);
        stores.push(reopened);
        const replay = reopened.executeIdempotent(
            'command-across-restart',
            '/workspace',
            { objective: 'Persist the command result' },
            () => {
                throw new Error('The replay handler must not run.');
            },
        );

        expect(replay).toEqual(first);
        expect(reopened.list('/workspace')).toEqual([first]);
    });

    test('upgrades migration 2 verification records conservatively', async () => {
        const { store, path } = await storeFor();
        const goal = store.create('/workspace', 'Upgrade plan verification');
        approveAndStart(
            store,
            goal.id,
            planInput(
                [
                    {
                        id: 'implement',
                        title: 'Implement',
                        instructions: 'Implement before migration.',
                        dependencyIds: [],
                        acceptanceCriteria: ['Must be implemented'],
                    },
                ],
                [requirement('final-check')],
            ),
        );
        const planId = store.get(goal.id)!.activePlanId!;
        const attempt = store.claimNextWork('worker', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            status: 'completed',
            summary: 'Implemented before migration.',
            evidenceRefs: [{ ref: 'artifact:before-v3', digest: digest('9') }],
            verificationRefs: [],
        });
        store.recordFinalVerificationResult(goal.id, planId, {
            id: 'v2-final-result',
            requirementId: 'final-check',
            status: 'passed',
            summary: 'Legacy final check passed.',
            evidenceRefs: [],
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
        });
        store.close();

        const migration2 = new Database(path);
        migration2.exec(`
          DROP INDEX final_verification_plan_requirement;
          ALTER TABLE verification_results DROP COLUMN plan_id;
          ALTER TABLE verification_results DROP COLUMN runtime_status;
          ALTER TABLE verification_results DROP COLUMN exit_code;
          ALTER TABLE cancellation_requests DROP COLUMN last_error;
          ALTER TABLE cancellation_requests DROP COLUMN observed_at;
          DELETE FROM schema_migrations WHERE version = 3;
        `);
        migration2.close();

        const upgraded = new GoalStore(path);
        stores.push(upgraded);
        expect(upgraded.integrityCheck()).toMatchObject({
            ok: true,
            schemaVersion: 3,
            latestSchemaVersion: 3,
        });
        expect(() => upgraded.finalizeGoal(goal.id)).toThrow(
            'final verification',
        );
        upgraded.recordFinalVerificationResult(goal.id, planId, {
            requirementId: 'final-check',
            status: 'passed',
            summary: 'Active-plan final check passed after migration.',
            evidenceRefs: [],
            startedAt: '2026-01-01T00:00:02.000Z',
            completedAt: '2026-01-01T00:00:03.000Z',
        });
        expect(upgraded.finalizeGoal(goal.id).state).toBe('achieved');

        const inspected = new Database(path, { readonly: true });
        expect(
            inspected
                .prepare(
                    'SELECT plan_id FROM verification_results WHERE id = ?',
                )
                .get('v2-final-result'),
        ).toEqual({ plan_id: null });
        inspected.close();
    });
});

describe('GoalStore planning and policy', () => {
    test('rejects invalid DAGs and preserves immutable plan revisions', async () => {
        const { store } = await storeFor();
        const goal = store.create('/workspace', 'Ship safely');
        expect(() =>
            store.proposePlan(
                goal.id,
                planInput([
                    {
                        id: 'a',
                        title: 'A',
                        instructions: 'Run A.',
                        dependencyIds: ['b'],
                        acceptanceCriteria: ['Must complete A'],
                    },
                    {
                        id: 'b',
                        title: 'B',
                        instructions: 'Run B.',
                        dependencyIds: ['a'],
                        acceptanceCriteria: ['Must complete B'],
                    },
                ]),
            ),
        ).toThrow('cycle');

        const first = store.proposePlan(
            goal.id,
            planInput([
                {
                    id: 'first',
                    title: 'First',
                    instructions: 'Try the first approach.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must work'],
                },
            ]),
        );
        store.approvePlan(goal.id, first.id, 'operator');
        const start = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'unattended-start' },
            'operator',
            'Start',
            60_000,
        );
        store.startGoal(goal.id, start.token);
        const attempt = store.claimNextWork('worker', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            status: 'needs-replan',
            summary: 'The approach cannot satisfy the criteria.',
            evidenceRefs: [],
            verificationRefs: [],
            issueClassification: 'contradictory-criteria',
        });
        const immutableFirst = store.getPlan(first.id);
        const second = store.proposePlan(
            goal.id,
            planInput([
                {
                    id: 'second',
                    title: 'Second',
                    instructions: 'Use the revised approach.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must use the revised approach'],
                },
            ]),
        );
        expect(second).toMatchObject({ revision: 2, parentPlanId: first.id });
        expect(() =>
            store.approvePlan(goal.id, first.id, 'operator'),
        ).toThrow();
        store.approvePlan(goal.id, second.id, 'operator');
        expect(store.getPlan(first.id)).toEqual(immutableFirst);
        expect(store.get(goal.id)).toMatchObject({
            state: 'ready',
            activePlanId: second.id,
            activePlanRevision: 2,
        });
    });

    test('gates dependencies and acceptance on same-attempt verification evidence', async () => {
        const { store } = await storeFor();
        const goal = store.create('/workspace', 'Verify dependencies');
        approveAndStart(
            store,
            goal.id,
            planInput([
                {
                    id: 'build',
                    title: 'Build',
                    instructions: 'Build the artifact.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must build'],
                    verificationRequirements: [requirement('build-check')],
                },
                {
                    id: 'publish',
                    title: 'Publish',
                    instructions: 'Publish the artifact.',
                    dependencyIds: ['build'],
                    acceptanceCriteria: ['Must publish'],
                },
            ]),
        );
        const build = store.claimNextWork('worker-a', 60_000)!;
        expect(store.claimNextWork('worker-b', 60_000)).toBeUndefined();
        expect(() =>
            store.reportOutcome({
                schemaVersion: SCHEMA_VERSION,
                attemptId: build.id,
                leaseToken: build.leaseToken,
                status: 'completed',
                summary: 'Built.',
                evidenceRefs: [{ ref: 'artifact://build', digest: digest() }],
                verificationRefs: [],
            }),
        ).toThrow('has not passed');

        const verification = store.recordVerificationResult(build.id, {
            requirementId: 'build-check',
            status: 'passed',
            summary: 'Build checks passed.',
            evidenceRefs: [{ ref: 'log://build-check', digest: digest('b') }],
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
            outputDigest: digest('c'),
            output: 'all checks passed',
        });
        expect(() =>
            store.reportOutcome({
                schemaVersion: SCHEMA_VERSION,
                attemptId: build.id,
                leaseToken: build.leaseToken,
                status: 'completed',
                summary: 'Built.',
                evidenceRefs: [{ ref: 'artifact://build', digest: digest() }],
                verificationRefs: ['wrong-result'],
            }),
        ).toThrow('not referenced');
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: build.id,
            leaseToken: build.leaseToken,
            status: 'completed',
            summary: 'Built and verified.',
            evidenceRefs: [{ ref: 'artifact://build', digest: digest() }],
            verificationRefs: [verification.id],
            transcriptRef: 'transcript://build',
        });

        const publish = store.claimNextWork('worker-b', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: publish.id,
            leaseToken: publish.leaseToken,
            status: 'completed',
            summary: 'Published.',
            evidenceRefs: [
                { ref: 'artifact://published', digest: digest('d') },
            ],
            verificationRefs: [],
        });
        expect(store.finalizeGoal(goal.id).state).toBe('achieved');
    });

    test('enforces approval scope, expiry, single use, destructive work, and budgets', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        let id = 0;
        let token = 0;
        const { store } = await storeFor({
            clock: () => new Date(now),
            idFactory: () => `id-${++id}`,
            tokenFactory: () => `approval-${String(++token).padStart(32, '0')}`,
        });
        const goal = store.create('/workspace', 'Run destructive work');
        const plan = store.proposePlan(
            goal.id,
            planInput([
                {
                    id: 'destroy',
                    title: 'Destroy',
                    instructions: 'Perform approved destructive work.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must be explicitly approved'],
                    destructive: true,
                },
            ]),
        );
        store.approvePlan(goal.id, plan.id, 'operator');
        const expired = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'unattended-start' },
            'operator',
            'Short approval',
            1_000,
        );
        now += 1_001;
        expect(() => store.startGoal(goal.id, expired.token)).toThrow(
            'expired',
        );
        const start = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'unattended-start' },
            'operator',
            'Start',
            60_000,
        );
        store.startGoal(goal.id, start.token);
        expect(() => store.startGoal(goal.id, start.token)).toThrow(
            'already been used',
        );
        expect(store.claimNextWork('worker', 60_000)).toBeUndefined();

        const unit = store.listWorkUnits(goal.id, true)[0]!;
        const destructive = store.issueApproval(
            goal.id,
            { type: 'work-unit', workUnitId: unit.id },
            'operator',
            'Approve destructive unit',
            60_000,
        );
        store.approveDestructiveUnit(goal.id, unit.id, destructive.token);
        expect(store.claimNextWork('worker', 60_000)).toBeDefined();

        const budgetApproval = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'raise-budget' },
            'operator',
            'Raise budget',
            60_000,
        );
        const budget: GoalBudget = {
            maxAttempts: 30,
            maxWallClockMs: 100_000_000,
            maxVerificationMs: 10_000_000,
            maxTokens: 2_000_000,
        };
        expect(
            store.raiseBudget(goal.id, budget, budgetApproval.token),
        ).toEqual(budget);
        expect(() =>
            store.setBudget(goal.id, budget, budgetApproval.token),
        ).toThrow('already been used');
        expect(() => store.transition(goal.id, 'achieved')).toThrow(
            'Direct goal transitions',
        );
        expect(store.status(goal.id).workspace).toBe('/workspace');
        expect(() => store.assertWorkspace(goal.id, '/other')).toThrow(
            'does not belong',
        );
    });

    test('enforces monotonic budgets inside the immediate write transaction', async () => {
        const { store, path } = await storeFor();
        const goal = store.create('/workspace', 'Raise only');
        const firstApproval = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'raise-budget' },
            'operator',
            'First raise',
            60_000,
        );
        const staleApproval = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'raise-budget' },
            'operator',
            'Stale raise',
            60_000,
        );
        const second = new GoalStore(path);
        stores.push(second);
        const larger: GoalBudget = {
            maxAttempts: 40,
            maxWallClockMs: 200_000_000,
            maxVerificationMs: 20_000_000,
            maxTokens: 4_000_000,
        };
        const staleSmaller: GoalBudget = {
            maxAttempts: 30,
            maxWallClockMs: 150_000_000,
            maxVerificationMs: 15_000_000,
            maxTokens: 3_000_000,
        };

        expect(store.setBudget(goal.id, larger, firstApproval.token)).toEqual(
            larger,
        );
        expect(() =>
            second.setBudget(goal.id, staleSmaller, staleApproval.token),
        ).toThrow('may not reduce');
        expect(second.getBudget(goal.id).budget).toEqual(larger);
        expect(
            second.setBudget(
                goal.id,
                { ...larger, maxAttempts: 41 },
                staleApproval.token,
            ),
        ).toEqual({ ...larger, maxAttempts: 41 });
    });

    test('deduplicates observations and requires final verification before achievement', async () => {
        const { store } = await storeFor();
        const goal = store.create('/workspace', 'Complete final checks');
        approveAndStart(
            store,
            goal.id,
            planInput(
                [
                    {
                        id: 'implement',
                        title: 'Implement',
                        instructions: 'Implement the change.',
                        dependencyIds: [],
                        acceptanceCriteria: ['Must be implemented'],
                    },
                ],
                [requirement('final-check')],
            ),
        );
        const observedAt = '2026-01-01T00:00:00.000Z';
        const observation = store.recordObservation(goal.id, {
            source: 'operator',
            kind: 'status',
            observedAt,
            summary: 'Implementation started.',
            deduplicationKey: 'operator://status/1',
            data: { phase: 'implementation' },
        });
        expect(
            store.recordObservation(goal.id, {
                source: 'operator',
                kind: 'status',
                observedAt,
                summary: 'Duplicate delivery.',
                deduplicationKey: 'operator://status/1',
                data: { phase: 'duplicate' },
            }),
        ).toEqual(observation);

        const attempt = store.claimNextWork('worker', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            status: 'completed',
            summary: 'Implemented.',
            evidenceRefs: [
                { ref: 'artifact://implementation', digest: digest() },
            ],
            verificationRefs: [],
        });
        expect(() => store.finalizeGoal(goal.id)).toThrow('final verification');
        const planId = store.get(goal.id)!.activePlanId!;
        store.recordFinalVerificationResult(goal.id, planId, {
            requirementId: 'final-check',
            status: 'failed',
            summary: 'Final check failed.',
            evidenceRefs: [{ ref: 'log://final-failed', digest: digest('e') }],
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
        });
        expect(() => store.finalizeGoal(goal.id)).toThrow('final verification');
        store.recordFinalVerificationResult(goal.id, planId, {
            requirementId: 'final-check',
            status: 'passed',
            summary: 'Final check passed.',
            evidenceRefs: [{ ref: 'log://final-passed', digest: digest('f') }],
            startedAt: '2026-01-01T00:00:02.000Z',
            completedAt: '2026-01-01T00:00:03.000Z',
            outputDigest: digest('1'),
            output: 'passed',
        });
        expect(store.finalizeGoal(goal.id).state).toBe('achieved');
    });

    test('recovers pending permission type from durable observations', async () => {
        const { store, path } = await storeFor();
        const goal = store.create('/workspace', 'Persist permission scope');
        store.recordObservation(goal.id, {
            source: 'system',
            kind: 'decision',
            observedAt: '2026-01-01T00:00:00.000Z',
            summary: 'Permission requested.',
            issueClassification: 'permission',
            data: {
                eventType: 'permission.updated',
                sessionId: 'session-1',
                permissionId: 'permission-1',
                permissionType: 'bash',
                response: 'pending',
            },
        });
        store.close();

        const reopened = new GoalStore(path);
        stores.push(reopened);
        expect(
            reopened.findPendingPermissionScope(
                goal.id,
                'session-1',
                'permission-1',
            ),
        ).toEqual({
            permissionId: 'permission-1',
            permissionType: 'bash',
        });
    });

    test('never reuses a same-ID final verification from another plan', async () => {
        const { store } = await storeFor();
        const goal = store.create('/workspace', 'Verify the active revision');
        const input = planInput(
            [
                {
                    id: 'implement',
                    title: 'Implement',
                    instructions: 'Implement the active revision.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must implement this revision'],
                },
            ],
            [requirement('final-check')],
        );
        approveAndStart(store, goal.id, input);
        const firstPlanId = store.get(goal.id)!.activePlanId!;
        store.recordFinalVerificationResult(goal.id, firstPlanId, {
            requirementId: 'final-check',
            status: 'passed',
            summary: 'First plan passed.',
            evidenceRefs: [{ ref: 'log:first-plan', digest: digest('2') }],
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
        });
        const firstAttempt = store.claimNextWork('worker-1', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: firstAttempt.id,
            leaseToken: firstAttempt.leaseToken,
            status: 'needs-replan',
            summary: 'The first plan needs revision.',
            evidenceRefs: [],
            verificationRefs: [],
            issueClassification: 'contradictory-criteria',
        });
        const secondPlan = store.proposePlan(goal.id, input);
        store.approvePlan(goal.id, secondPlan.id, 'operator');
        const restart = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'unattended-start' },
            'operator',
            'Start revised plan',
            60_000,
        );
        store.startGoal(goal.id, restart.token);
        const secondAttempt = store.claimNextWork('worker-2', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: secondAttempt.id,
            leaseToken: secondAttempt.leaseToken,
            status: 'completed',
            summary: 'Revised plan implemented.',
            evidenceRefs: [{ ref: 'artifact:revision', digest: digest('3') }],
            verificationRefs: [],
        });

        expect(() => store.finalizeGoal(goal.id)).toThrow('final verification');
        expect(() =>
            store.recordFinalVerificationResult(goal.id, firstPlanId, {
                requirementId: 'final-check',
                status: 'passed',
                summary: 'Stale plan result.',
                evidenceRefs: [],
                startedAt: '2026-01-01T00:00:02.000Z',
                completedAt: '2026-01-01T00:00:03.000Z',
            }),
        ).toThrow('not the active plan');
        store.recordFinalVerificationResult(goal.id, secondPlan.id, {
            requirementId: 'final-check',
            status: 'passed',
            summary: 'Second plan passed.',
            evidenceRefs: [{ ref: 'log:second-plan', digest: digest('4') }],
            startedAt: '2026-01-01T00:00:04.000Z',
            completedAt: '2026-01-01T00:00:05.000Z',
        });
        expect(store.finalizeGoal(goal.id).state).toBe('achieved');
    });
});
