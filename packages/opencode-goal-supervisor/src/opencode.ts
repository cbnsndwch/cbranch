import { createHash, randomUUID } from 'node:crypto';

import { tool, type Plugin } from '@opencode-ai/plugin';

import {
    ControlPlanInputSchema,
    formatGoalStatus,
    initWorkspaceControl,
    terminalText,
    type InitializedWorkspaceControl,
} from './control.js';
import {
    ApprovalTokenSchema,
    DomainIdSchema,
    GoalBudgetSchema,
} from './domain.js';

type UnknownRecord = Readonly<Record<string, unknown>>;
type NormalizedHostObservation = {
    readonly kind: 'status' | 'failure' | 'decision';
    readonly summary: string;
    readonly observedAt: string;
    readonly deduplicationKey: string;
    readonly issueClassification?: 'permission' | 'external-ambiguity';
    readonly data: Readonly<Record<string, string | number | boolean>>;
};

const asRecord = (value: unknown): UnknownRecord | undefined =>
    value !== null && typeof value === 'object'
        ? (value as UnknownRecord)
        : undefined;

const eventType = (event: unknown): string | undefined => {
    const type = asRecord(event)?.type;
    return typeof type === 'string' ? type : undefined;
};

const eventProperties = (event: unknown): UnknownRecord =>
    asRecord(asRecord(event)?.properties) ?? {};

const eventSessionId = (event: unknown): string | undefined => {
    const properties = eventProperties(event);
    if (typeof properties.sessionID === 'string') return properties.sessionID;
    const info = asRecord(properties.info);
    if (typeof info?.sessionID === 'string') return info.sessionID;
    const permission = asRecord(properties.permission);
    if (typeof permission?.sessionID === 'string') return permission.sessionID;
    return undefined;
};

const eventObservedAt = (event: unknown): string => {
    const properties = eventProperties(event);
    const info = asRecord(properties.info);
    const time = asRecord(info?.time) ?? asRecord(properties.time);
    return typeof time?.created === 'number' && Number.isFinite(time.created)
        ? new Date(time.created).toISOString()
        : new Date().toISOString();
};

const eventPermission = (
    event: unknown,
):
    | { readonly permissionId?: string; readonly permissionType?: string }
    | undefined => {
    const type = eventType(event);
    if (type !== 'permission.updated' && type !== 'permission.replied') {
        if (type !== 'permission.ask') return undefined;
    }
    const properties = eventProperties(event);
    const permission = asRecord(properties.permission);
    const permissionId =
        typeof properties.permissionID === 'string'
            ? properties.permissionID
            : typeof properties.id === 'string'
              ? properties.id
              : typeof permission?.id === 'string'
                ? permission.id
                : undefined;
    const permissionType =
        typeof properties.permissionType === 'string'
            ? properties.permissionType
            : typeof permission?.type === 'string'
              ? permission.type
              : typeof properties.type === 'string'
                ? properties.type
                : undefined;
    return { permissionId, permissionType };
};

const eventDigest = (event: unknown): string => {
    let serialized: string;
    try {
        serialized = JSON.stringify(event);
    } catch {
        serialized = eventType(event) ?? 'unknown';
    }
    return createHash('sha256').update(serialized).digest('hex');
};

const concise = (value: unknown, fallback: string): string => {
    const text = typeof value === 'string' ? value : fallback;
    return Array.from(text)
        .filter(character => {
            const code = character.charCodeAt(0);
            return code >= 0x20 && code !== 0x7f;
        })
        .join(' ')
        .trim()
        .slice(0, 200);
};

const normalizeHostEvent = (
    event: unknown,
    sessionId: string,
    persistedPermissionType?: string,
): NormalizedHostObservation | undefined => {
    const type = eventType(event);
    if (!type) return undefined;
    const properties = eventProperties(event);
    const digest = eventDigest(event);
    const base = {
        observedAt: eventObservedAt(event),
        deduplicationKey: `opencode-event:${digest}`,
    };
    if (type === 'permission.updated' || type === 'permission.replied') {
        const details = eventPermission(event);
        const permissionId = details?.permissionId ?? 'unknown';
        const permissionType =
            details?.permissionType ?? persistedPermissionType ?? 'unknown';
        const response =
            typeof properties.response === 'string'
                ? concise(properties.response, 'unknown')
                : 'pending';
        return {
            ...base,
            kind: 'decision',
            summary:
                type === 'permission.replied'
                    ? `OpenCode permission ${permissionId} replied: ${response}.`
                    : `OpenCode permission ${permissionId} updated.`,
            issueClassification: 'permission',
            data: {
                eventType: type,
                sessionId,
                permissionId,
                permissionType,
                response,
            },
        };
    }
    if (type === 'permission.ask') {
        const details = eventPermission(event);
        const permissionId = details?.permissionId ?? 'unknown';
        const permissionType = details?.permissionType ?? 'unknown';
        return {
            ...base,
            kind: 'decision',
            summary: `OpenCode permission ${permissionId} requested.`,
            issueClassification: 'permission',
            data: {
                eventType: type,
                sessionId,
                permissionId,
                permissionType,
                response: 'pending',
            },
        };
    }
    if (!type.startsWith('session.')) return undefined;
    if (type === 'session.error') {
        const error = asRecord(properties.error);
        const errorData = asRecord(error?.data);
        const message = concise(
            errorData?.message ?? error?.name,
            'session error',
        );
        return {
            ...base,
            kind: 'failure',
            summary: `OpenCode session error: ${message}.`,
            issueClassification: 'external-ambiguity',
            data: { eventType: type, sessionId },
        };
    }
    const status = asRecord(properties.status);
    const statusType =
        typeof status?.type === 'string' ? status.type : 'observed';
    return {
        ...base,
        kind: 'status',
        summary: `OpenCode ${type}: ${concise(statusType, 'observed')}.`,
        data: {
            eventType: type,
            sessionId,
            status: statusType,
            schedulerAction: false,
        },
    };
};

const commandId = (prefix: string, digest?: string): string =>
    digest ? `${prefix}.${digest}` : randomUUID();

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const renderGoals = (
    goals: readonly {
        readonly id: string;
        readonly state: string;
        readonly objective: string;
    }[],
): string =>
    goals.length === 0
        ? 'No supervised goals in this workspace.'
        : goals
              .map(
                  goal =>
                      `- ${terminalText(goal.id)} [${goal.state}] ${terminalText(goal.objective)}`,
              )
              .join('\n');

const pluginApprovalActions = [
    'approve-plan',
    'issue-start',
    'issue-resume',
    'issue-blocked-resume',
    'issue-recovery',
    'issue-budget',
    'issue-destructive',
    'approve-destructive',
] as const;

const approvalInstruction = (input: {
    readonly action: (typeof pluginApprovalActions)[number];
    readonly goalId: string;
    readonly planId?: string;
    readonly workUnitId?: string;
}): string => {
    const goalId = DomainIdSchema.parse(input.goalId);
    const command = `cbranch-goal-supervisor approve ${goalId} ${input.action}`;
    if (input.action === 'approve-plan') {
        if (!input.planId) {
            return 'Operator approval requires the exact plan ID; inspect the goal and request approval again.';
        }
        const planId = DomainIdSchema.parse(input.planId);
        return `Operator approval is required. Run this outside the model session: ${command} --plan-id ${planId}`;
    }
    if (
        input.action === 'issue-destructive' ||
        input.action === 'approve-destructive'
    ) {
        if (!input.workUnitId) {
            return 'Operator approval requires the exact work-unit ID; inspect the goal and request approval again.';
        }
        const suffix = ` --work-unit-id ${DomainIdSchema.parse(input.workUnitId)}`;
        return input.action === 'approve-destructive'
            ? `Operator approval is required. Run this outside the model session: ${command}${suffix} --approval-token 'OPERATOR_ISSUED_TOKEN'`
            : `Operator approval is required. Run this outside the model session: ${command}${suffix}`;
    }
    return `Operator approval is required. Run this outside the model session: ${command}`;
};

const openCodeGoalSupervisor: Plugin = async ({ directory }) => {
    const initialized: InitializedWorkspaceControl =
        await initWorkspaceControl(directory);
    const { control, internalTransportAuthToken: authToken } = initialized;
    const permissionScopes = new Map<
        string,
        { readonly permissionId: string; readonly permissionType: string }
    >();

    const request = <Input extends { readonly commandId?: string }>(
        input: Input,
    ): Input & { readonly authToken: string; readonly commandId: string } => ({
        ...input,
        authToken,
        commandId: input.commandId ?? randomUUID(),
    });

    const recordEvent = async (event: unknown): Promise<void> => {
        const sessionId = eventSessionId(event);
        if (!sessionId) return;
        const reference = control.findSupervisorSession({
            authToken,
            commandId: randomUUID(),
            sessionId,
        });
        if (!reference) return;
        const type = eventType(event);
        const permission = eventPermission(event);
        const cacheKey = permission?.permissionId
            ? `${sessionId}:${permission.permissionId}`
            : undefined;
        const cached = cacheKey ? permissionScopes.get(cacheKey) : undefined;
        const persisted =
            type === 'permission.replied' &&
            permission?.permissionId &&
            !permission.permissionType &&
            !cached
                ? control.findPendingPermissionScope({
                      authToken,
                      goalId: reference.goalId,
                      sessionId,
                      permissionId: permission.permissionId,
                  })
                : undefined;
        const permissionType =
            permission?.permissionType ??
            cached?.permissionType ??
            persisted?.permissionType;
        const observation = normalizeHostEvent(
            event,
            sessionId,
            permissionType,
        );
        if (!observation) return;
        const digest = eventDigest(event);
        control.recordObservation({
            authToken,
            commandId: commandId('oc.obs', digest),
            goalId: reference.goalId,
            observation: {
                source: 'system',
                kind: observation.kind,
                observedAt: observation.observedAt,
                summary: observation.summary,
                workUnitId: reference.workUnitId,
                attemptId: reference.attemptId,
                issueClassification: observation.issueClassification,
                deduplicationKey: observation.deduplicationKey,
                data: observation.data,
            },
        });

        if (type !== 'permission.replied') return;
        const properties = eventProperties(event);
        const permissionId = permission?.permissionId;
        if (!permissionId) return;
        if (!permissionType) return;
        const response =
            typeof properties.response === 'string'
                ? properties.response.toLowerCase()
                : '';
        const decision = ['allow', 'allowed', 'once', 'always'].includes(
            response,
        )
            ? 'approved'
            : ['deny', 'denied', 'reject', 'rejected'].includes(response)
              ? 'rejected'
              : undefined;
        if (!decision) return;
        control.recordPermissionDecision({
            authToken,
            commandId: commandId('oc.permission', digest),
            goalId: reference.goalId,
            scope: {
                type: 'permission',
                sessionId,
                permissionId,
                permissionType,
            },
            decision,
            actor: 'opencode',
            reason: `OpenCode permission response: ${concise(response, 'unknown')}`,
        });
    };

    return {
        tool: {
            goal_create: tool({
                description: 'Create a durable goal for this workspace.',
                args: {
                    objective: tool.schema.string().trim().min(1).max(20_000),
                    budget: GoalBudgetSchema.optional(),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const goal = control.create(request(input));
                    return `Created goal ${goal.id} in state ${goal.state}.`;
                },
            }),
            goal_list: tool({
                description: 'List durable goals for this workspace.',
                args: {
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    return renderGoals(control.list(request(input)));
                },
            }),
            goal_plan: tool({
                description: 'Propose a validated structured goal plan.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    plan: ControlPlanInputSchema,
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const plan = control.plan(request(input));
                    return `Proposed plan ${plan.id}, revision ${plan.revision}, with ${plan.units.length} unit(s).`;
                },
            }),
            goal_status: tool({
                description: 'Show durable state and budget usage for a goal.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    return formatGoalStatus(control.status(request(input)));
                },
            }),
            goal_start: tool({
                description: 'Start a ready goal with a scoped approval token.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    approvalToken: ApprovalTokenSchema,
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const goal = control.start(request(input));
                    return `Goal ${goal.id} is ${goal.state}.`;
                },
            }),
            goal_pause: tool({
                description: 'Pause and fence a goal.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    reason: tool.schema.string().trim().min(1).max(500),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const goal = control.pause(request(input));
                    return `Goal ${goal.id} is ${goal.state}.`;
                },
            }),
            goal_resume: tool({
                description:
                    'Resume a paused or blocked goal with a matching approval token.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    approvalToken: ApprovalTokenSchema,
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const goal = control.resume(request(input));
                    return `Goal ${goal.id} is ${goal.state}.`;
                },
            }),
            goal_cancel: tool({
                description: 'Cancel and terminally fence a goal.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    reason: tool.schema.string().trim().min(1).max(500),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const goal = control.cancel(request(input));
                    return `Goal ${goal.id} is ${goal.state}.`;
                },
            }),
            goal_approve: tool({
                description:
                    'Show the operator-only CLI command for an approval request. This tool cannot approve or issue tokens.',
                args: {
                    action: tool.schema.enum(pluginApprovalActions),
                    goalId: DomainIdSchema,
                    planId: DomainIdSchema.optional(),
                    workUnitId: DomainIdSchema.optional(),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    return approvalInstruction(input);
                },
            }),
            goal_inspect: tool({
                description: 'Inspect durable goal details.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    return json(control.inspect(request(input)));
                },
            }),
            goal_recover: tool({
                description:
                    'Recover an unknown outcome with a scoped token and explicit decision.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    approvalToken: ApprovalTokenSchema,
                    targetState: tool.schema.enum([
                        'ready',
                        'executing',
                        'paused',
                        'needs-replan',
                        'awaiting-decision',
                        'blocked',
                        'cancelled',
                    ]),
                    decision: tool.schema.string().trim().min(1).max(500),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    const goal = control.recover(request(input));
                    return `Recovered goal ${goal.id} to ${goal.state}.`;
                },
            }),
            goal_raise_budget: tool({
                description: 'Raise goal limits with a scoped budget token.',
                args: {
                    goalId: tool.schema.string().trim().min(1),
                    budget: GoalBudgetSchema,
                    approvalToken: ApprovalTokenSchema,
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    return json(control.raiseBudget(request(input)));
                },
            }),
            goal_doctor: tool({
                description: 'Check durable store integrity and projections.',
                args: {
                    recover: tool.schema.boolean().default(false),
                    commandId: tool.schema.string().trim().min(1).optional(),
                },
                async execute(input) {
                    return json(control.doctor(request(input)));
                },
            }),
        },
        async event({ event }) {
            const sessionId = eventSessionId(event);
            const permission = eventPermission(event);
            if (
                eventType(event) === 'permission.updated' &&
                sessionId &&
                permission?.permissionId &&
                permission.permissionType
            ) {
                permissionScopes.set(
                    `${sessionId}:${permission.permissionId}`,
                    {
                        permissionId: permission.permissionId,
                        permissionType: permission.permissionType,
                    },
                );
            }
            await recordEvent(event);
        },
        async 'permission.ask'(input, _output) {
            permissionScopes.set(`${input.sessionID}:${input.id}`, {
                permissionId: input.id,
                permissionType: input.type,
            });
            try {
                await recordEvent({
                    type: 'permission.ask',
                    properties: input,
                });
            } catch {
                // Observation persistence must never change the host's decision.
            }
        },
        async dispose() {
            permissionScopes.clear();
            await control.close();
        },
    };
};

export { openCodeGoalSupervisor };
export default openCodeGoalSupervisor;
