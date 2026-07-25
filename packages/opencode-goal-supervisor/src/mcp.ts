import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
    ControlBudgetRequestSchema,
    ControlCreateRequestSchema,
    ControlDoctorRequestSchema,
    ControlGoalRequestSchema,
    ControlListRequestSchema,
    ControlPlanRequestSchema,
    ControlReasonRequestSchema,
    ControlRecoverRequestSchema,
    ControlStartRequestSchema,
    GOAL_SUPERVISOR_VERSION,
    GoalControlService,
    formatGoalStatus,
} from './control.js';
import { DomainIdSchema } from './domain.js';

export { GOAL_SUPERVISOR_VERSION } from './control.js';

const transportEnvelope = {
    commandId: DomainIdSchema.optional(),
};

export const McpCreateRequestSchema = ControlCreateRequestSchema.omit({
    authToken: true,
});
export const McpListRequestSchema = ControlListRequestSchema.omit({
    authToken: true,
});
export const McpGoalRequestSchema = ControlGoalRequestSchema.omit({
    authToken: true,
});
export const McpPlanRequestSchema = ControlPlanRequestSchema.omit({
    authToken: true,
});
export const McpStartRequestSchema = ControlStartRequestSchema.omit({
    authToken: true,
});
export const McpReasonRequestSchema = ControlReasonRequestSchema.omit({
    authToken: true,
});
export const McpRecoverRequestSchema = ControlRecoverRequestSchema.omit({
    authToken: true,
});
export const McpBudgetRequestSchema = ControlBudgetRequestSchema.omit({
    authToken: true,
});
export const McpDoctorRequestSchema = ControlDoctorRequestSchema.omit({
    authToken: true,
});

export const McpApprovalRequestSchema = z
    .object({
        ...transportEnvelope,
        action: z.enum([
            'approve-plan',
            'issue-start',
            'issue-resume',
            'issue-blocked-resume',
            'issue-recovery',
            'issue-budget',
            'issue-destructive',
            'approve-destructive',
        ]),
        goalId: DomainIdSchema,
        planId: DomainIdSchema.optional(),
        workUnitId: DomainIdSchema.optional(),
    })
    .strict()
    .superRefine((request, context) => {
        if (request.action === 'approve-plan' && !request.planId) {
            context.addIssue({
                code: 'custom',
                path: ['planId'],
                message: 'approve-plan requires planId.',
            });
        }
        if (
            (request.action === 'issue-destructive' ||
                request.action === 'approve-destructive') &&
            !request.workUnitId
        ) {
            context.addIssue({
                code: 'custom',
                path: ['workUnitId'],
                message: `${request.action} requires workUnitId.`,
            });
        }
    });

type CommandRequest = { readonly commandId?: string };

const atTransportEdge = <Request extends CommandRequest>(
    request: Request,
    authToken: string,
): Request & { readonly authToken: string; readonly commandId: string } => ({
    ...request,
    authToken,
    commandId: request.commandId ?? randomUUID(),
});

const parseApprovalRequest = (
    input: z.input<typeof McpApprovalRequestSchema>,
): z.output<typeof McpApprovalRequestSchema> => {
    const parsed = McpApprovalRequestSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new Error(
        `Invalid approval request: ${parsed.error.issues
            .map(issue => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
    );
};

const approvalInstruction = (
    request: z.output<typeof McpApprovalRequestSchema>,
): string => {
    const command = `cbranch-goal-supervisor approve ${request.goalId} ${request.action}`;
    if (request.action === 'approve-plan') {
        return `Operator approval is required. Run this outside the model session: ${command} --plan-id ${request.planId!}`;
    }
    if (
        request.action === 'issue-destructive' ||
        request.action === 'approve-destructive'
    ) {
        const suffix = ` --work-unit-id ${request.workUnitId!}`;
        return request.action === 'approve-destructive'
            ? `Operator approval is required. Run this outside the model session: ${command}${suffix} --approval-token 'OPERATOR_ISSUED_TOKEN'`
            : `Operator approval is required. Run this outside the model session: ${command}${suffix}`;
    }
    return `Operator approval is required. Run this outside the model session: ${command}`;
};

/** Adapter-neutral handlers. The transport credential is never a tool input. */
export const goalMcpTools = (
    control: GoalControlService,
    transportAuthToken: string,
) => {
    control.authorizeTransport(transportAuthToken);
    return {
        goal_create: (input: z.input<typeof McpCreateRequestSchema>) =>
            control.create(atTransportEdge(input, transportAuthToken)),
        goal_list: (input: z.input<typeof McpListRequestSchema>) =>
            control.list(atTransportEdge(input, transportAuthToken)),
        goal_plan: (input: z.input<typeof McpPlanRequestSchema>) =>
            control.plan(atTransportEdge(input, transportAuthToken)),
        goal_status: (input: z.input<typeof McpGoalRequestSchema>) =>
            control.status(atTransportEdge(input, transportAuthToken)),
        goal_start: (input: z.input<typeof McpStartRequestSchema>) =>
            control.start(atTransportEdge(input, transportAuthToken)),
        goal_pause: (input: z.input<typeof McpReasonRequestSchema>) =>
            control.pause(atTransportEdge(input, transportAuthToken)),
        goal_resume: (input: z.input<typeof McpStartRequestSchema>) =>
            control.resume(atTransportEdge(input, transportAuthToken)),
        goal_cancel: (input: z.input<typeof McpReasonRequestSchema>) =>
            control.cancel(atTransportEdge(input, transportAuthToken)),
        goal_approve: (input: z.input<typeof McpApprovalRequestSchema>) =>
            approvalInstruction(parseApprovalRequest(input)),
        goal_inspect: (input: z.input<typeof McpGoalRequestSchema>) =>
            control.inspect(atTransportEdge(input, transportAuthToken)),
        goal_recover: (input: z.input<typeof McpRecoverRequestSchema>) =>
            control.recover(atTransportEdge(input, transportAuthToken)),
        goal_raise_budget: (input: z.input<typeof McpBudgetRequestSchema>) =>
            control.raiseBudget(atTransportEdge(input, transportAuthToken)),
        goal_doctor: (input: z.input<typeof McpDoctorRequestSchema>) =>
            control.doctor(atTransportEdge(input, transportAuthToken)),
    };
};

const textResult = (value: unknown) => ({
    content: [
        {
            type: 'text' as const,
            text: typeof value === 'string' ? value : JSON.stringify(value),
        },
    ],
});

const registerTools = (
    server: McpServer,
    tools: ReturnType<typeof goalMcpTools>,
): void => {
    server.registerTool(
        'goal_create',
        {
            description: 'Create a durable goal in the current workspace.',
            inputSchema: McpCreateRequestSchema,
        },
        input => textResult(tools.goal_create(input)),
    );
    server.registerTool(
        'goal_list',
        {
            description: 'List durable goals in the current workspace.',
            inputSchema: McpListRequestSchema,
        },
        input => textResult(tools.goal_list(input)),
    );
    server.registerTool(
        'goal_plan',
        {
            description:
                'Propose a validated structured plan. This does not schedule work.',
            inputSchema: McpPlanRequestSchema,
        },
        input => textResult(tools.goal_plan(input)),
    );
    server.registerTool(
        'goal_status',
        {
            description: 'Show goal state and budget usage.',
            inputSchema: McpGoalRequestSchema,
        },
        input => textResult(formatGoalStatus(tools.goal_status(input))),
    );
    server.registerTool(
        'goal_start',
        {
            description: 'Start a ready goal using a scoped action token.',
            inputSchema: McpStartRequestSchema,
        },
        input => textResult(tools.goal_start(input)),
    );
    server.registerTool(
        'goal_pause',
        {
            description: 'Pause and immediately fence a goal.',
            inputSchema: McpReasonRequestSchema,
        },
        input => textResult(tools.goal_pause(input)),
    );
    server.registerTool(
        'goal_resume',
        {
            description: 'Resume a paused or blocked goal with a scoped token.',
            inputSchema: McpStartRequestSchema,
        },
        input => textResult(tools.goal_resume(input)),
    );
    server.registerTool(
        'goal_cancel',
        {
            description: 'Cancel and terminally fence a goal.',
            inputSchema: McpReasonRequestSchema,
        },
        input => textResult(tools.goal_cancel(input)),
    );
    server.registerTool(
        'goal_approve',
        {
            description:
                'Show the operator-only CLI command for an approval request. This tool cannot approve or issue tokens.',
            inputSchema: McpApprovalRequestSchema,
        },
        input => textResult(tools.goal_approve(input)),
    );
    server.registerTool(
        'goal_inspect',
        {
            description:
                'Inspect durable goal details without secret token hashes.',
            inputSchema: McpGoalRequestSchema,
        },
        input => textResult(tools.goal_inspect(input)),
    );
    server.registerTool(
        'goal_recover',
        {
            description:
                'Recover an unknown outcome using a scoped token and explicit decision target.',
            inputSchema: McpRecoverRequestSchema,
        },
        input => textResult(tools.goal_recover(input)),
    );
    server.registerTool(
        'goal_raise_budget',
        {
            description: 'Raise goal limits using a scoped budget token.',
            inputSchema: McpBudgetRequestSchema,
        },
        input => textResult(tools.goal_raise_budget(input)),
    );
    server.registerTool(
        'goal_doctor',
        {
            description:
                'Check store integrity and projections, optionally reconciling expired leases.',
            inputSchema: McpDoctorRequestSchema,
        },
        input => textResult(tools.goal_doctor(input)),
    );
};

export async function runGoalMcp(
    control: GoalControlService,
    transportAuthToken: string,
): Promise<void> {
    const tools = goalMcpTools(control, transportAuthToken);
    const server = new McpServer({
        name: 'cbranch-goal-supervisor',
        version: GOAL_SUPERVISOR_VERSION,
    });
    registerTools(server, tools);

    const transport = new StdioServerTransport();
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => {
        resolveClosed = resolve;
    });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP exposes a callback property, not EventTarget.
    server.server.onclose = () => resolveClosed?.();
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
        shutdownPromise ??= server.close().finally(() => resolveClosed?.());
        return shutdownPromise;
    };
    const onEnd = (): void => {
        void shutdown();
    };
    const onSignal = (): void => {
        void shutdown();
    };

    process.stdin.once('end', onEnd);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        await server.connect(transport);
        if (process.stdin.readableEnded) await shutdown();
        await closed;
    } finally {
        process.stdin.off('end', onEnd);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        await shutdown();
    }
}
