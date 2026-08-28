import { createHash } from 'node:crypto';

import { z } from 'zod';

import { DomainIdSchema, GoalStateSchema } from './domain.js';
import {
    GoalPlanInputSchema,
    MAX_GOAL_PLAN_MARKDOWN_BYTES,
    type GoalPlanInput,
} from './goal-plan.js';

export const TUI_BRIDGE_PROTOCOL = 'cbranch-goal-supervisor.tui/1' as const;
export const TUI_BRIDGE_COMMAND = '__tui-bridge-v1' as const;
export const MAX_TUI_BRIDGE_REQUEST_BYTES =
    6 * MAX_GOAL_PLAN_MARKDOWN_BYTES + 64 * 1_024;
export const MAX_TUI_BRIDGE_GOALS = 20;

const WirePathSchema = z
    .string()
    .min(1)
    .max(4_096)
    .refine(value => !value.includes('\0'), {
        message: 'Expected a nonempty path without NUL.',
    });

const PlanMarkdownSchema = z
    .string()
    .refine(
        value =>
            !value.includes('\0') &&
            new TextEncoder().encode(value).byteLength <=
                MAX_GOAL_PLAN_MARKDOWN_BYTES,
        {
            message: `Goal-plan Markdown must not contain NUL and must be at most ${MAX_GOAL_PLAN_MARKDOWN_BYTES} UTF-8 bytes.`,
        },
    );

const TerminalTextSchema = z
    .string()
    .max(500)
    .refine(
        value =>
            Array.from(value).every(character => {
                const code = character.codePointAt(0)!;
                return (
                    code >= 0x20 &&
                    (code < 0x7f || code > 0x9f) &&
                    code !== 0x2028 &&
                    code !== 0x2029
                );
            }),
        'Expected terminal-safe text.',
    );

const requestEnvelope = {
    protocol: z.literal(TUI_BRIDGE_PROTOCOL),
};

export const TuiBridgeInitRequestSchema = z
    .object({
        ...requestEnvelope,
        operation: z.literal('init'),
        workspace: WirePathSchema,
    })
    .strict();

export const TuiBridgeListRequestSchema = z
    .object({
        ...requestEnvelope,
        operation: z.literal('list'),
        workspace: WirePathSchema,
    })
    .strict();

export const TuiBridgeLaunchRequestSchema = z
    .object({
        ...requestEnvelope,
        operation: z.literal('launch'),
        workspace: WirePathSchema,
        planPath: WirePathSchema,
        planMarkdown: PlanMarkdownSchema,
        actor: DomainIdSchema,
    })
    .strict();

export const TuiBridgeRequestSchema = z.discriminatedUnion('operation', [
    TuiBridgeInitRequestSchema,
    TuiBridgeListRequestSchema,
    TuiBridgeLaunchRequestSchema,
]);

export const TuiBridgeGoalSummarySchema = z
    .object({
        id: DomainIdSchema,
        state: GoalStateSchema,
        objective: TerminalTextSchema,
    })
    .strict();

export const TuiBridgeInitResponseSchema = z
    .object({
        protocol: z.literal(TUI_BRIDGE_PROTOCOL),
        ok: z.literal(true),
        operation: z.literal('init'),
        workspace: WirePathSchema,
    })
    .strict();

export const TuiBridgeListResponseSchema = z
    .object({
        protocol: z.literal(TUI_BRIDGE_PROTOCOL),
        ok: z.literal(true),
        operation: z.literal('list'),
        total: z.number().int().nonnegative(),
        hasExecuting: z.boolean(),
        goals: z.array(TuiBridgeGoalSummarySchema).max(MAX_TUI_BRIDGE_GOALS),
    })
    .strict();

export const TuiBridgeLaunchResponseSchema = z
    .object({
        protocol: z.literal(TUI_BRIDGE_PROTOCOL),
        ok: z.literal(true),
        operation: z.literal('launch'),
        goal: z
            .object({
                id: DomainIdSchema,
                state: GoalStateSchema,
            })
            .strict(),
    })
    .strict();

export const TuiBridgeSuccessResponseSchema = z.discriminatedUnion(
    'operation',
    [
        TuiBridgeInitResponseSchema,
        TuiBridgeListResponseSchema,
        TuiBridgeLaunchResponseSchema,
    ],
);

export const TuiBridgeFailureResponseSchema = z
    .object({
        protocol: z.literal(TUI_BRIDGE_PROTOCOL),
        ok: z.literal(false),
        error: z
            .object({
                code: z.enum(['invalid-request', 'operation-failed']),
                message: TerminalTextSchema.min(1),
            })
            .strict(),
    })
    .strict();

export const TuiBridgeResponseSchema = z.union([
    TuiBridgeSuccessResponseSchema,
    TuiBridgeFailureResponseSchema,
]);

export type TuiBridgeInitRequest = Readonly<
    z.output<typeof TuiBridgeInitRequestSchema>
>;
export type TuiBridgeListRequest = Readonly<
    z.output<typeof TuiBridgeListRequestSchema>
>;
export type TuiBridgeLaunchRequest = Readonly<
    z.output<typeof TuiBridgeLaunchRequestSchema>
>;
export type TuiBridgeRequest = Readonly<
    z.output<typeof TuiBridgeRequestSchema>
>;
export type TuiBridgeGoalSummary = Readonly<
    z.output<typeof TuiBridgeGoalSummarySchema>
>;
export type TuiBridgeInitResponse = Readonly<
    z.output<typeof TuiBridgeInitResponseSchema>
>;
export type TuiBridgeListResponse = Readonly<
    z.output<typeof TuiBridgeListResponseSchema>
>;
export type TuiBridgeLaunchResponse = Readonly<
    z.output<typeof TuiBridgeLaunchResponseSchema>
>;
export type TuiBridgeSuccessResponse = Readonly<
    z.output<typeof TuiBridgeSuccessResponseSchema>
>;
export type TuiBridgeFailureResponse = Readonly<
    z.output<typeof TuiBridgeFailureResponseSchema>
>;
export type TuiBridgeResponse = Readonly<
    z.output<typeof TuiBridgeResponseSchema>
>;

const normalizedForHash = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizedForHash);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .toSorted(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
            )
            .map(([key, item]) => [key, normalizedForHash(item)]),
    );
};

/** Stable across Markdown formatting and JSON object-key ordering. */
export const goalLaunchCommandId = (
    canonicalWorkspace: string,
    canonicalPlanPath: string,
    plan: GoalPlanInput,
    actor: string,
): string => {
    const input = JSON.stringify(
        normalizedForHash({
            actor: DomainIdSchema.parse(actor),
            plan: GoalPlanInputSchema.parse(plan),
            planPath: WirePathSchema.parse(canonicalPlanPath),
            workspace: WirePathSchema.parse(canonicalWorkspace),
        }),
    );
    return `tui-launch:${createHash('sha256').update(input).digest('hex')}`;
};
