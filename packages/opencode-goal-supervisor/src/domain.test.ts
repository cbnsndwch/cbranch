import { describe, expect, test } from 'vitest';

import {
    AgentOutcomeSchema,
    VerificationRequirementSchema,
    canTransition,
    decideGoalTransition,
    goalActions,
    goalStates,
    terminalGoalStates,
    validateAcyclicPlan,
    type GoalAction,
    type GoalState,
    type GoalTransitionContext,
    type PlanGraphDocument,
} from './domain.js';

const permissiveContext: GoalTransitionContext = {
    hasApprovedPlan: true,
    hasApprovedRevisedPlan: true,
    hasUnattendedStartApproval: true,
    hasResumeApproval: true,
    hasBlockedResumeApproval: true,
    hasDecisionApproval: true,
    hasExplicitDecision: true,
    allRequiredUnitsAccepted: true,
    hasSuccessfulFinalVerification: true,
    resumeTarget: 'executing',
    recoveryTarget: 'ready',
};

const legalActions: Record<GoalState, ReadonlySet<GoalAction>> = {
    draft: new Set(['plan-ready', 'cancel', 'replan', 'decision', 'block']),
    ready: new Set([
        'start',
        'pause',
        'cancel',
        'replan',
        'decision',
        'block',
        'unknown-outcome',
        'fail',
    ]),
    executing: new Set([
        'pause',
        'cancel',
        'replan',
        'decision',
        'block',
        'unknown-outcome',
        'achieve',
        'fail',
    ]),
    paused: new Set([
        'resume',
        'cancel',
        'replan',
        'decision',
        'block',
        'unknown-outcome',
        'fail',
    ]),
    'needs-replan': new Set([
        'plan-ready',
        'cancel',
        'decision',
        'block',
        'unknown-outcome',
        'fail',
    ]),
    'awaiting-decision': new Set([
        'pause',
        'resume',
        'cancel',
        'replan',
        'block',
        'unknown-outcome',
        'fail',
    ]),
    blocked: new Set([
        'resume',
        'cancel',
        'replan',
        'decision',
        'unknown-outcome',
    ]),
    'unknown-outcome': new Set(['recover']),
    achieved: new Set(),
    cancelled: new Set(),
};

describe('goal transitions', () => {
    test.each(
        goalStates.flatMap(state =>
            goalActions.map(action => ({ state, action })),
        ),
    )('classifies $state + $action', ({ state, action }) => {
        const decision = decideGoalTransition(state, action, permissiveContext);
        expect(decision.ok).toBe(legalActions[state].has(action));
    });

    test('the exhaustive transition table names every state', () => {
        expect(Object.keys(legalActions).toSorted()).toEqual(
            [...goalStates].toSorted(),
        );
        expect(Object.keys(legalActions)).toHaveLength(goalStates.length);
    });

    test('requires both plan and unattended-start approvals', () => {
        expect(
            decideGoalTransition('ready', 'start', {
                hasUnattendedStartApproval: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('ready', 'start', {
                hasApprovedPlan: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('ready', 'start', {
                hasApprovedPlan: true,
                hasUnattendedStartApproval: true,
            }),
        ).toEqual({ ok: true, state: 'executing' });
    });

    test('requires the appropriate approval to resume', () => {
        expect(decideGoalTransition('paused', 'resume', {}).ok).toBe(false);
        expect(decideGoalTransition('blocked', 'resume', {}).ok).toBe(false);
        expect(
            decideGoalTransition('paused', 'resume', {
                hasResumeApproval: true,
                resumeTarget: 'ready',
            }),
        ).toEqual({ ok: true, state: 'ready' });
        expect(
            decideGoalTransition('blocked', 'resume', {
                hasBlockedResumeApproval: true,
            }),
        ).toEqual({ ok: true, state: 'executing' });
    });

    test('requires an approved revision to leave needs-replan for ready', () => {
        expect(
            decideGoalTransition('needs-replan', 'plan-ready', {
                hasApprovedPlan: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('needs-replan', 'plan-ready', {
                hasApprovedRevisedPlan: true,
            }),
        ).toEqual({ ok: true, state: 'ready' });
    });

    test('fences achievement behind accepted units and final verification', () => {
        expect(
            decideGoalTransition('ready', 'achieve', permissiveContext).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('executing', 'achieve', {
                hasSuccessfulFinalVerification: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('executing', 'achieve', {
                allRequiredUnitsAccepted: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('executing', 'achieve', {
                allRequiredUnitsAccepted: true,
                hasSuccessfulFinalVerification: true,
            }),
        ).toEqual({ ok: true, state: 'achieved' });
    });

    test('only recovers unknown outcomes with an explicit decision and target', () => {
        expect(
            decideGoalTransition('unknown-outcome', 'cancel', {
                hasExplicitDecision: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('unknown-outcome', 'recover', {
                recoveryTarget: 'ready',
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('unknown-outcome', 'recover', {
                hasExplicitDecision: true,
            }).ok,
        ).toBe(false);
        expect(
            decideGoalTransition('unknown-outcome', 'recover', {
                hasExplicitDecision: true,
                recoveryTarget: 'cancelled',
            }),
        ).toEqual({ ok: true, state: 'cancelled' });
    });

    test('only achieved and cancelled are terminal', () => {
        expect([...terminalGoalStates].toSorted()).toEqual([
            'achieved',
            'cancelled',
        ]);
        expect(canTransition('blocked', 'executing')).toBe(true);
        expect(canTransition('achieved', 'executing')).toBe(false);
        expect(canTransition('cancelled', 'ready')).toBe(false);
    });
});

const unit = (
    id: string,
    dependencyIds: readonly string[] = [],
): PlanGraphDocument['units'][number] => ({
    id,
    dependencyIds,
    acceptanceCriteria: [`must complete ${id}`],
    verificationRequirements: [{ id: `verify-${id}` }],
});

describe('validateAcyclicPlan', () => {
    test('accepts a valid dependency graph', () => {
        const issues = validateAcyclicPlan({
            units: [
                unit('prepare'),
                unit('build', ['prepare']),
                unit('test', ['build']),
            ],
            finalVerificationRequirements: [{ id: 'verify-final' }],
        });

        expect(issues).toEqual([]);
    });

    test('reports unknown and self dependencies', () => {
        const codes = validateAcyclicPlan({
            units: [unit('a', ['a', 'missing'])],
        }).map(issue => issue.code);

        expect(codes).toContain('self-dependency');
        expect(codes).toContain('unknown-dependency');
    });

    test('reports dependency cycles', () => {
        const issues = validateAcyclicPlan({
            units: [unit('a', ['c']), unit('b', ['a']), unit('c', ['b'])],
        });

        expect(
            issues.filter(issue => issue.code === 'dependency-cycle'),
        ).toHaveLength(1);
    });

    test('reports duplicate IDs, empty and contradictory criteria', () => {
        const issues = validateAcyclicPlan({
            units: [
                {
                    id: 'a',
                    dependencyIds: [],
                    acceptanceCriteria: [
                        'must publish release',
                        'must not publish release',
                    ],
                    verificationRequirements: [{ id: 'verify-shared' }],
                },
                {
                    id: 'a',
                    dependencyIds: [],
                    acceptanceCriteria: [],
                    verificationRequirements: [{ id: 'verify-shared' }],
                },
            ],
        });
        const codes = issues.map(issue => issue.code);

        expect(codes).toContain('duplicate-unit-id');
        expect(codes).toContain('empty-acceptance-criteria');
        expect(codes).toContain('duplicate-verification-id');
        expect(codes).toContain('contradictory-criteria');
    });
});

const digest = `sha256:${'a'.repeat(64)}`;
const validOutcome = {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    leaseToken: 'lease-token-1',
    status: 'completed',
    summary: 'Implemented and verified the requested change.',
    evidenceRefs: [{ ref: 'evidence:artifact-1', digest }],
    verificationRefs: ['verification:test-1'],
} as const;

describe('AgentOutcomeSchema', () => {
    test('accepts a structured versioned outcome', () => {
        expect(AgentOutcomeSchema.safeParse(validOutcome).success).toBe(true);
    });

    test('rejects unstructured prose', () => {
        expect(
            AgentOutcomeSchema.safeParse(
                'I think the work is probably complete.',
            ).success,
        ).toBe(false);
    });

    test('rejects invalid IDs', () => {
        expect(
            AgentOutcomeSchema.safeParse({
                ...validOutcome,
                attemptId: 'attempt id in prose',
            }).success,
        ).toBe(false);
    });

    test('rejects malformed evidence and material-change digests', () => {
        expect(
            AgentOutcomeSchema.safeParse({
                ...validOutcome,
                evidenceRefs: [
                    { ref: 'evidence:artifact-1', digest: 'not-a-digest' },
                ],
            }).success,
        ).toBe(false);
        expect(
            AgentOutcomeSchema.safeParse({
                ...validOutcome,
                materialChangeDigest: `sha256:${'A'.repeat(64)}`,
            }).success,
        ).toBe(false);
    });

    test('requires schema and lease fencing fields', () => {
        const { schemaVersion: _schemaVersion, ...withoutVersion } =
            validOutcome;
        const { leaseToken: _leaseToken, ...withoutLease } = validOutcome;

        expect(AgentOutcomeSchema.safeParse(withoutVersion).success).toBe(
            false,
        );
        expect(AgentOutcomeSchema.safeParse(withoutLease).success).toBe(false);
    });

    test('requires completion evidence and rejects every line control', () => {
        expect(
            AgentOutcomeSchema.safeParse({
                ...validOutcome,
                evidenceRefs: [],
            }).success,
        ).toBe(false);
        for (const separator of [
            '\u001b',
            '\u0085',
            '\u009b',
            '\u2028',
            '\u2029',
        ]) {
            expect(
                AgentOutcomeSchema.safeParse({
                    ...validOutcome,
                    summary: `unsafe${separator}summary`,
                }).success,
            ).toBe(false);
        }
    });
});

describe('VerificationRequirementSchema', () => {
    const valid = {
        id: 'check',
        type: 'command' as const,
        executable: 'node',
        args: ['--version'],
        timeoutMs: 30 * 60_000,
        outputCapBytes: 8 * 1_024 * 1_024,
    };

    test('matches the verifier runtime timeout and output bounds', () => {
        expect(VerificationRequirementSchema.safeParse(valid).success).toBe(
            true,
        );
        expect(
            VerificationRequirementSchema.safeParse({
                ...valid,
                timeoutMs: valid.timeoutMs + 1,
            }).success,
        ).toBe(false);
        expect(
            VerificationRequirementSchema.safeParse({
                ...valid,
                outputCapBytes: valid.outputCapBytes + 1,
            }).success,
        ).toBe(false);
    });
});
