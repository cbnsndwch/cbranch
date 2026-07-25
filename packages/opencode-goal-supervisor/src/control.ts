import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import {
    ApprovalScopeSchema,
    ApprovalTokenSchema,
    DomainIdSchema,
    GoalBudgetSchema,
    ObservationSchema,
    PlanUnitSchema,
    VerificationRequirementSchema,
    type Approval,
    type ApprovalScope,
    type Goal,
    type GoalBudget,
    type Observation,
    type Plan,
    type RecoveryGoalState,
    type WorkUnit,
} from './domain.js';
import { parseGoalPlanMarkdown } from './goal-plan.js';
import {
    GoalStore,
    type ExecutingGoalPlan,
    type GoalInspection,
    type GoalPlanLaunchInput,
    type GoalStatus,
    type GoalStoreOptions,
    type IntegrityReport,
    type PendingPermissionScope,
    type PlanInput,
    type StartupReconcileResult,
} from './store.js';

export const GOAL_SUPERVISOR_VERSION = '0.1.0' as const;
export const CONTROL_TOKEN_RELATIVE_PATH = join(
    '.opencode',
    'goal-supervisor',
    'control.token',
);

const MAX_APPROVAL_TTL_MS = 365 * 24 * 60 * 60_000;
const isPosix = process.platform !== 'win32';

const NonEmptyTextSchema = z.string().trim().min(1);
const ConciseTextSchema = NonEmptyTextSchema.max(500).refine(
    value =>
        Array.from(value).every(character => {
            const code = character.charCodeAt(0);
            return code !== 0 && code !== 10 && code !== 13;
        }),
    'Expected a single line without NUL characters.',
);
const ControlAuthTokenSchema = z.string().min(1).max(512);
const CommandIdSchema = DomainIdSchema.optional();

const controlEnvelope = {
    authToken: ControlAuthTokenSchema,
    commandId: CommandIdSchema,
};

export const ControlVerificationRequirementSchema =
    VerificationRequirementSchema;
export const ControlPlanUnitSchema = PlanUnitSchema;
export const ControlPlanInputSchema = z
    .object({
        objective: NonEmptyTextSchema.max(20_000).optional(),
        units: z.array(ControlPlanUnitSchema).min(1).max(1_024),
        finalVerificationRequirements: z
            .array(ControlVerificationRequirementSchema)
            .max(128)
            .default([]),
        authoredBy: DomainIdSchema,
    })
    .strict();

export const ControlCreateRequestSchema = z
    .object({
        ...controlEnvelope,
        objective: NonEmptyTextSchema.max(20_000),
        budget: GoalBudgetSchema.optional(),
    })
    .strict();
export const ControlCreateProposeApproveStartRequestSchema = z
    .object({
        ...controlEnvelope,
        planMarkdown: z.string(),
        actor: DomainIdSchema,
        budget: GoalBudgetSchema.optional(),
    })
    .strict();
export const ControlListRequestSchema = z.object(controlEnvelope).strict();
export const ControlGoalRequestSchema = z
    .object({ ...controlEnvelope, goalId: DomainIdSchema })
    .strict();
export const ControlPlanRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        plan: ControlPlanInputSchema,
    })
    .strict();
export const ControlStartRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        approvalToken: ApprovalTokenSchema,
    })
    .strict();
export const ControlReasonRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        reason: ConciseTextSchema,
    })
    .strict();
export const ControlApprovePlanRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        planId: DomainIdSchema,
        actor: DomainIdSchema,
    })
    .strict();
export const ControlIssueApprovalRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        scope: ApprovalScopeSchema,
        actor: DomainIdSchema,
        reason: ConciseTextSchema,
        ttlMs: z.number().int().positive().max(MAX_APPROVAL_TTL_MS),
    })
    .strict();
export const ControlApproveDestructiveRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        workUnitId: DomainIdSchema,
        approvalToken: ApprovalTokenSchema,
    })
    .strict();
export const ControlBudgetRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        budget: GoalBudgetSchema,
        approvalToken: ApprovalTokenSchema,
    })
    .strict();
export const ControlRecoverRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        approvalToken: ApprovalTokenSchema,
        targetState: z.enum([
            'ready',
            'executing',
            'paused',
            'needs-replan',
            'awaiting-decision',
            'blocked',
            'cancelled',
        ]),
        decision: ConciseTextSchema,
    })
    .strict();
export const ControlDoctorRequestSchema = z
    .object({ ...controlEnvelope, recover: z.boolean().default(false) })
    .strict();

const ObservationInputSchema = ObservationSchema.omit({
    schemaVersion: true,
    id: true,
    goalId: true,
});
export const ControlObservationRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        observation: ObservationInputSchema,
    })
    .strict();
export const ControlPermissionDecisionRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        scope: z
            .object({
                type: z.literal('permission'),
                sessionId: DomainIdSchema,
                permissionId: DomainIdSchema,
                permissionType: NonEmptyTextSchema.max(128),
            })
            .strict(),
        decision: z.enum(['approved', 'rejected']),
        actor: DomainIdSchema,
        reason: ConciseTextSchema,
    })
    .strict();
export const ControlSessionReferenceRequestSchema = z
    .object({
        ...controlEnvelope,
        sessionId: DomainIdSchema,
    })
    .strict();
export const ControlPermissionScopeRequestSchema = z
    .object({
        ...controlEnvelope,
        goalId: DomainIdSchema,
        sessionId: DomainIdSchema,
        permissionId: DomainIdSchema,
    })
    .strict();

export type ControlPlanInput = z.output<typeof ControlPlanInputSchema>;
export type ControlCreateRequest = z.input<typeof ControlCreateRequestSchema>;
export type ControlCreateProposeApproveStartRequest = z.input<
    typeof ControlCreateProposeApproveStartRequestSchema
>;
export type ControlListRequest = z.input<typeof ControlListRequestSchema>;
export type ControlGoalRequest = z.input<typeof ControlGoalRequestSchema>;
export type ControlPlanRequest = z.input<typeof ControlPlanRequestSchema>;
export type ControlStartRequest = z.input<typeof ControlStartRequestSchema>;
export type ControlReasonRequest = z.input<typeof ControlReasonRequestSchema>;
export type ControlApprovePlanRequest = z.input<
    typeof ControlApprovePlanRequestSchema
>;
export type ControlIssueApprovalRequest = z.input<
    typeof ControlIssueApprovalRequestSchema
>;
export type ControlApproveDestructiveRequest = z.input<
    typeof ControlApproveDestructiveRequestSchema
>;
export type ControlBudgetRequest = z.input<typeof ControlBudgetRequestSchema>;
export type ControlRecoverRequest = z.input<typeof ControlRecoverRequestSchema>;
export type ControlDoctorRequest = z.input<typeof ControlDoctorRequestSchema>;
export type ControlObservationRequest = z.input<
    typeof ControlObservationRequestSchema
>;
export type ControlPermissionDecisionRequest = z.input<
    typeof ControlPermissionDecisionRequestSchema
>;
export type ControlSessionReferenceRequest = z.input<
    typeof ControlSessionReferenceRequestSchema
>;
export type ControlPermissionScopeRequest = z.input<
    typeof ControlPermissionScopeRequestSchema
>;

export type PublicApproval = Omit<Approval, 'tokenHash'>;
export type PublicGoalInspection = Omit<GoalInspection, 'approvals'> & {
    readonly approvals: readonly PublicApproval[];
};
export type IssuedControlApproval = {
    readonly approval: PublicApproval;
    readonly actionToken?: string;
    readonly replayed: boolean;
};
export type GoalDoctorReport = {
    readonly workspace: string;
    readonly goalCount: number;
    readonly integrity: IntegrityReport;
    readonly projections: ReturnType<GoalStore['verifyProjections']>;
    readonly recovery?: StartupReconcileResult;
};

export type GoalControlServiceOptions = {
    readonly databasePath?: string;
    readonly store?: GoalStore;
    readonly storeOptions?: GoalStoreOptions;
    readonly closeStore?: boolean;
};

export type InitializedWorkspaceControl = {
    readonly workspace: string;
    readonly tokenPath: string;
    readonly control: GoalControlService;
    /** Internal transport credential. Never include this field in tool output. */
    readonly internalTransportAuthToken: string;
};

const parseRequest = <Schema extends z.ZodType>(
    schema: Schema,
    input: unknown,
): z.output<Schema> => {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    const details = result.error.issues
        .map(issue => {
            const path =
                issue.path.length > 0 ? issue.path.join('.') : 'request';
            return `${path}: ${issue.message}`;
        })
        .join('; ');
    throw new Error(`Invalid control request: ${details}`);
};

const sha256 = (value: string): `sha256:${string}` =>
    `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** Hashes both operands before the constant-time comparison. */
export const authenticateControlToken = (
    expectedToken: string,
    suppliedToken: string,
): boolean => {
    const expectedHash = createHash('sha256').update(expectedToken).digest();
    const suppliedHash = createHash('sha256').update(suppliedToken).digest();
    return timingSafeEqual(expectedHash, suppliedHash);
};

const publicApproval = (approval: Approval): PublicApproval => {
    const { tokenHash: _tokenHash, ...safe } = approval;
    return safe;
};

const formatDuration = (milliseconds: number): string => {
    if (milliseconds < 1_000) return `${milliseconds}ms`;
    if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
    if (milliseconds < 3_600_000)
        return `${Math.round(milliseconds / 60_000)}m`;
    return `${Math.round(milliseconds / 3_600_000)}h`;
};

const stateExplanation = (state: Goal['state']): string => {
    switch (state) {
        case 'paused':
            return 'PAUSED: work is fenced until an approved resume.';
        case 'blocked':
            return 'BLOCKED: operator action and blocked-resume approval are required.';
        case 'needs-replan':
            return 'NEEDS REPLAN: an approved revised plan is required.';
        case 'awaiting-decision':
            return 'AWAITING DECISION: operator approval is required.';
        case 'unknown-outcome':
            return 'UNKNOWN OUTCOME: explicit approved recovery and a target are required.';
        case 'achieved':
        case 'cancelled':
            return `TERMINAL: ${state}.`;
        case 'draft':
            return 'DRAFT: propose and approve a plan before starting.';
        case 'ready':
            return 'READY: an approved start token is required.';
        case 'executing':
            return 'EXECUTING: the external daemon owns scheduling.';
    }
};

export const terminalText = (value: string): string =>
    Array.from(value)
        .map(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('')
        .replace(/\s+/gu, ' ')
        .trim();

export const formatGoalStatus = (status: GoalStatus): string =>
    [
        `Goal ${terminalText(status.goal.id)}: ${terminalText(status.goal.objective)}`,
        `State: ${status.goal.state}`,
        stateExplanation(status.goal.state),
        `Plan: ${status.activePlan ? `${terminalText(status.activePlan.id)} r${status.activePlan.revision}` : 'none'}`,
        'Budget usage:',
        `- attempts ${status.usage.attempts}/${status.budget.maxAttempts}`,
        `- wall clock ${formatDuration(status.usage.wallClockMs)}/${formatDuration(status.budget.maxWallClockMs)}`,
        `- verification ${formatDuration(status.usage.verificationMs)}/${formatDuration(status.budget.maxVerificationMs)}`,
        `- tokens ${status.usage.tokens}/${status.budget.maxTokens}`,
    ].join('\n');

const assertOwnerOnlyDirectory = async (path: string): Promise<void> => {
    if (!isPosix) return;
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
        throw new Error(
            'Goal supervisor control directory must be an owner-only directory (0700).',
        );
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new Error(
            'Goal supervisor control directory must be owned by the current user.',
        );
    }
};

const ensureControlDirectory = async (workspace: string): Promise<string> => {
    const directory = join(workspace, '.opencode', 'goal-supervisor');
    let existed = true;
    try {
        await lstat(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existed = false;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!existed && isPosix) await chmod(directory, 0o700);
    if ((await realpath(directory)) !== directory) {
        throw new Error(
            'Goal supervisor control directory may not be redirected by a symbolic link.',
        );
    }
    await assertOwnerOnlyDirectory(directory);
    return directory;
};

const openControlDirectory = async (workspace: string): Promise<string> => {
    const directory = join(workspace, '.opencode', 'goal-supervisor');
    await assertOwnerOnlyDirectory(directory);
    if ((await realpath(directory)) !== directory) {
        throw new Error(
            'Goal supervisor control directory may not be redirected by a symbolic link.',
        );
    }
    return directory;
};

const isMissing = (error: unknown): boolean =>
    (error as NodeJS.ErrnoException).code === 'ENOENT';

const assertOwnedRegularDatabaseFile = async (
    path: string,
    required: boolean,
): Promise<void> => {
    let info: Stats;
    try {
        info = await lstat(path);
    } catch (error) {
        if (!required && isMissing(error)) return;
        throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(
            'Goal supervisor database must be a regular file and may not be a symbolic link.',
        );
    }
    if (
        isPosix &&
        typeof process.getuid === 'function' &&
        info.uid !== process.getuid()
    ) {
        throw new Error(
            'Goal supervisor database must be owned by the current user.',
        );
    }
    if ((await realpath(path)) !== path) {
        throw new Error(
            'Goal supervisor database must remain at its canonical workspace path.',
        );
    }
};

const validateDefaultDatabasePath = async (
    controlDirectory: string,
    databasePath: string,
    required: boolean,
): Promise<void> => {
    const canonicalPath = resolve(databasePath);
    if (
        dirname(canonicalPath) !== controlDirectory ||
        (await realpath(dirname(canonicalPath))) !== controlDirectory
    ) {
        throw new Error(
            'Goal supervisor database must be a direct child of its canonical control directory.',
        );
    }
    await assertOwnedRegularDatabaseFile(canonicalPath, required);
    await assertOwnedRegularDatabaseFile(`${canonicalPath}-wal`, false);
    await assertOwnedRegularDatabaseFile(`${canonicalPath}-shm`, false);
};

const validateTokenFile = (info: Stats): void => {
    if (!info.isFile()) {
        throw new Error(
            'Goal supervisor control token must be a regular file.',
        );
    }
    if (isPosix && (info.mode & 0o777) !== 0o600) {
        throw new Error(
            'Goal supervisor control token must have owner-only permissions (0600).',
        );
    }
    if (
        isPosix &&
        typeof process.getuid === 'function' &&
        info.uid !== process.getuid()
    ) {
        throw new Error(
            'Goal supervisor control token must be owned by the current user.',
        );
    }
};

const validateStoredToken = (token: string): string => {
    if (!/^[A-Za-z0-9_-]{43,512}$/u.test(token)) {
        throw new Error('Goal supervisor control token is invalid.');
    }
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.byteLength < 32) {
        throw new Error(
            'Goal supervisor control token has less than 256 bits of entropy.',
        );
    }
    return token;
};

const loadControlToken = async (tokenPath: string): Promise<string> => {
    const noFollow = isPosix ? constants.O_NOFOLLOW : 0;
    const handle = await open(tokenPath, constants.O_RDONLY | noFollow);
    try {
        validateTokenFile(await handle.stat());
        return validateStoredToken(await handle.readFile({ encoding: 'utf8' }));
    } finally {
        await handle.close();
    }
};

const loadInitializedControlToken = async (
    tokenPath: string,
): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- initialization retries must remain ordered.
            return await loadControlToken(tokenPath);
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : '';
            const retryable =
                (error as NodeJS.ErrnoException).code === 'ENOENT' ||
                message === 'Goal supervisor control token is invalid.' ||
                message.includes('less than 256 bits');
            if (!retryable || attempt === 19) throw error;
            // oxlint-disable-next-line eslint/no-await-in-loop -- delay separates ordered file-read retries.
            await delay(5);
        }
    }
    throw lastError;
};

const initializeControlToken = async (
    controlDirectory: string,
): Promise<{ readonly tokenPath: string; readonly token: string }> => {
    const tokenPath = join(controlDirectory, 'control.token');
    const token = randomBytes(32).toString('base64url');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(tokenPath, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return {
            tokenPath,
            token: await loadInitializedControlToken(tokenPath),
        };
    }

    try {
        await handle.writeFile(token, { encoding: 'utf8' });
        await handle.sync();
        if (isPosix) await handle.chmod(0o600);
        validateTokenFile(await handle.stat());
        return { tokenPath, token };
    } catch (error) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await unlink(tokenPath).catch(() => undefined);
        throw error;
    } finally {
        if (handle) await handle.close();
    }
};

export class GoalControlService {
    readonly workspace: string;
    readonly tokenPath: string;
    readonly #store: GoalStore;
    readonly #transportToken: string;
    readonly #closeStore: boolean;
    #closed = false;

    constructor(
        workspace: string,
        tokenPath: string,
        transportToken: string,
        store: GoalStore,
        closeStore = true,
    ) {
        this.workspace = workspace;
        this.tokenPath = tokenPath;
        this.#transportToken = transportToken;
        this.#store = store;
        this.#closeStore = closeStore;
    }

    #authorize(authToken: string): void {
        if (!authenticateControlToken(this.#transportToken, authToken)) {
            throw new Error('Goal supervisor control authentication failed.');
        }
    }

    authorizeTransport(authToken: string): void {
        this.#authorize(ControlAuthTokenSchema.parse(authToken));
    }

    #goal(goalId: string): Goal {
        return this.#store.assertWorkspace(goalId, this.workspace);
    }

    #mutate<Result>(
        commandId: string | undefined,
        request: unknown,
        callback: () => Result,
    ): Result {
        if (!commandId) {
            throw new Error(
                'A commandId is required for a mutating control request.',
            );
        }
        return this.#store.executeIdempotent(
            commandId,
            this.workspace,
            request,
            callback,
        );
    }

    create(input: ControlCreateRequest): Goal {
        const request = parseRequest(ControlCreateRequestSchema, input);
        this.#authorize(request.authToken);
        return this.#mutate(
            request.commandId,
            {
                operation: 'create',
                objective: request.objective,
                budget: request.budget,
            },
            () =>
                this.#store.create(
                    this.workspace,
                    request.objective,
                    request.budget,
                ),
        );
    }

    createProposeApproveStart(
        input: ControlCreateProposeApproveStartRequest,
    ): ExecutingGoalPlan {
        const request = parseRequest(
            ControlCreateProposeApproveStartRequestSchema,
            input,
        );
        this.#authorize(request.authToken);
        const plan = parseGoalPlanMarkdown(request.planMarkdown);
        return this.#mutate(
            request.commandId,
            {
                operation: 'create-propose-approve-start',
                plan,
                actor: request.actor,
                budget: request.budget,
            },
            () =>
                this.#store.createProposeApproveStart(
                    this.workspace,
                    plan satisfies GoalPlanLaunchInput,
                    request.actor,
                    request.budget,
                ),
        );
    }

    list(input: ControlListRequest): readonly Goal[] {
        const request = parseRequest(ControlListRequestSchema, input);
        this.#authorize(request.authToken);
        return this.#store.list(this.workspace);
    }

    plan(input: ControlPlanRequest): Plan {
        const request = parseRequest(ControlPlanRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            { operation: 'plan', goalId: request.goalId, plan: request.plan },
            () =>
                this.#store.proposePlan(
                    request.goalId,
                    request.plan satisfies PlanInput,
                ),
        );
    }

    propose(input: ControlPlanRequest): Plan {
        return this.plan(input);
    }

    status(input: ControlGoalRequest): GoalStatus {
        const request = parseRequest(ControlGoalRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#store.status(request.goalId, this.workspace);
    }

    start(input: ControlStartRequest): Goal {
        const request = parseRequest(ControlStartRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'start',
                goalId: request.goalId,
                approvalTokenHash: sha256(request.approvalToken),
            },
            () => this.#store.startGoal(request.goalId, request.approvalToken),
        );
    }

    pause(input: ControlReasonRequest): Goal {
        const request = parseRequest(ControlReasonRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'pause',
                goalId: request.goalId,
                reason: request.reason,
            },
            () => this.#store.pauseGoal(request.goalId, request.reason),
        );
    }

    resume(input: ControlStartRequest): Goal {
        const request = parseRequest(ControlStartRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'resume',
                goalId: request.goalId,
                approvalTokenHash: sha256(request.approvalToken),
            },
            () => this.#store.resumeGoal(request.goalId, request.approvalToken),
        );
    }

    cancel(input: ControlReasonRequest): Goal {
        const request = parseRequest(ControlReasonRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'cancel',
                goalId: request.goalId,
                reason: request.reason,
            },
            () => this.#store.cancelGoal(request.goalId, request.reason),
        );
    }

    approvePlan(input: ControlApprovePlanRequest): Goal {
        const request = parseRequest(ControlApprovePlanRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'approve-plan',
                goalId: request.goalId,
                planId: request.planId,
                actor: request.actor,
            },
            () =>
                this.#store.approvePlan(
                    request.goalId,
                    request.planId,
                    request.actor,
                ),
        );
    }

    issueScopedApproval(
        input: ControlIssueApprovalRequest,
    ): IssuedControlApproval {
        const request = parseRequest(ControlIssueApprovalRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        let actionToken: string | undefined;
        const result = this.#mutate(
            request.commandId,
            {
                operation: 'issue-approval',
                goalId: request.goalId,
                scope: request.scope,
                actor: request.actor,
                reason: request.reason,
                ttlMs: request.ttlMs,
            },
            () => {
                const issued = this.#store.issueApproval(
                    request.goalId,
                    request.scope,
                    request.actor,
                    request.reason,
                    request.ttlMs,
                );
                actionToken = issued.token;
                return { approval: publicApproval(issued.approval) };
            },
        );
        return actionToken
            ? { ...result, actionToken, replayed: false }
            : { ...result, replayed: true };
    }

    approveDestructiveUnit(input: ControlApproveDestructiveRequest): WorkUnit {
        const request = parseRequest(
            ControlApproveDestructiveRequestSchema,
            input,
        );
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'approve-destructive',
                goalId: request.goalId,
                workUnitId: request.workUnitId,
                approvalTokenHash: sha256(request.approvalToken),
            },
            () =>
                this.#store.approveDestructiveUnit(
                    request.goalId,
                    request.workUnitId,
                    request.approvalToken,
                ),
        );
    }

    setBudget(input: ControlBudgetRequest): GoalBudget {
        const request = parseRequest(ControlBudgetRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'set-budget',
                goalId: request.goalId,
                budget: request.budget,
                approvalTokenHash: sha256(request.approvalToken),
            },
            () =>
                this.#store.setBudget(
                    request.goalId,
                    request.budget,
                    request.approvalToken,
                ),
        );
    }

    raiseBudget(input: ControlBudgetRequest): GoalBudget {
        const request = parseRequest(ControlBudgetRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'raise-budget',
                goalId: request.goalId,
                budget: request.budget,
                approvalTokenHash: sha256(request.approvalToken),
            },
            () =>
                this.#store.raiseBudget(
                    request.goalId,
                    request.budget,
                    request.approvalToken,
                ),
        );
    }

    inspect(input: ControlGoalRequest): PublicGoalInspection {
        const request = parseRequest(ControlGoalRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        const inspection = this.#store.inspect(request.goalId, this.workspace);
        return {
            ...inspection,
            approvals: inspection.approvals.map(publicApproval),
        };
    }

    recoverUnknownOutcome(input: ControlRecoverRequest): Goal {
        const request = parseRequest(ControlRecoverRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'recover-unknown-outcome',
                goalId: request.goalId,
                targetState: request.targetState,
                decision: request.decision,
                approvalTokenHash: sha256(request.approvalToken),
            },
            () =>
                this.#store.recoverUnknownOutcome(
                    request.goalId,
                    request.approvalToken,
                    request.targetState satisfies RecoveryGoalState,
                    request.decision,
                ),
        );
    }

    recover(input: ControlRecoverRequest): Goal {
        return this.recoverUnknownOutcome(input);
    }

    doctor(input: ControlDoctorRequest): GoalDoctorReport {
        const request = parseRequest(ControlDoctorRequestSchema, input);
        this.#authorize(request.authToken);
        const report = (
            recovery?: StartupReconcileResult,
        ): GoalDoctorReport => ({
            workspace: this.workspace,
            goalCount: this.#store.list(this.workspace).length,
            integrity: this.#store.integrityCheck(),
            projections: this.#store.verifyProjections(),
            ...(recovery ? { recovery } : {}),
        });
        if (!request.recover) return report();
        const recovery = this.#mutate(
            request.commandId,
            { operation: 'doctor-recovery' },
            () => this.#store.startupReconcile(),
        );
        return report(recovery);
    }

    findSupervisorSession(input: ControlSessionReferenceRequest):
        | {
              readonly goalId: string;
              readonly workUnitId: string;
              readonly attemptId: string;
              readonly externalRef: string;
          }
        | undefined {
        const request = parseRequest(
            ControlSessionReferenceRequestSchema,
            input,
        );
        this.#authorize(request.authToken);
        const externalRef = `opencode-session:${encodeURIComponent(request.sessionId)}`;
        const reference = this.#store
            .listSessionReferences()
            .find(candidate => candidate.externalRef === externalRef);
        if (!reference) return undefined;
        this.#goal(reference.goalId);
        return {
            goalId: reference.goalId,
            workUnitId: reference.workUnitId,
            attemptId: reference.attemptId,
            externalRef: reference.externalRef,
        };
    }

    findPendingPermissionScope(
        input: ControlPermissionScopeRequest,
    ): PendingPermissionScope | undefined {
        const request = parseRequest(
            ControlPermissionScopeRequestSchema,
            input,
        );
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#store.findPendingPermissionScope(
            request.goalId,
            request.sessionId,
            request.permissionId,
        );
    }

    recordObservation(input: ControlObservationRequest): Observation {
        const request = parseRequest(ControlObservationRequestSchema, input);
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'record-observation',
                goalId: request.goalId,
                observation: request.observation,
            },
            () =>
                this.#store.recordObservation(
                    request.goalId,
                    request.observation,
                ),
        );
    }

    recordPermissionDecision(
        input: ControlPermissionDecisionRequest,
    ): PublicApproval {
        const request = parseRequest(
            ControlPermissionDecisionRequestSchema,
            input,
        );
        this.#authorize(request.authToken);
        this.#goal(request.goalId);
        return this.#mutate(
            request.commandId,
            {
                operation: 'record-permission-decision',
                goalId: request.goalId,
                scope: request.scope,
                decision: request.decision,
                actor: request.actor,
                reason: request.reason,
            },
            () =>
                publicApproval(
                    this.#store.recordApprovalDecision(
                        request.goalId,
                        request.scope satisfies ApprovalScope,
                        request.decision,
                        request.actor,
                        request.reason,
                    ),
                ),
        );
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        if (this.#closeStore) this.#store.close();
        this.#closed = true;
    }
}

export const initWorkspaceControl = async (
    workspace: string,
    options: GoalControlServiceOptions = {},
): Promise<InitializedWorkspaceControl> => {
    const requestedWorkspace = NonEmptyTextSchema.max(4_096).parse(workspace);
    const canonicalWorkspace = await realpath(requestedWorkspace);
    const controlDirectory = await ensureControlDirectory(canonicalWorkspace);
    const databasePath =
        options.databasePath ?? join(controlDirectory, 'goal.db');
    if (!options.store && !options.databasePath) {
        await validateDefaultDatabasePath(
            controlDirectory,
            databasePath,
            false,
        );
    }
    const { tokenPath, token } = await initializeControlToken(controlDirectory);
    const store =
        options.store ?? new GoalStore(databasePath, options.storeOptions);
    const control = new GoalControlService(
        canonicalWorkspace,
        tokenPath,
        token,
        store,
        options.closeStore ?? !options.store,
    );
    return {
        workspace: canonicalWorkspace,
        tokenPath,
        control,
        internalTransportAuthToken: token,
    };
};

export const openWorkspaceControl = async (
    workspace: string,
    options: GoalControlServiceOptions = {},
): Promise<InitializedWorkspaceControl> => {
    const requestedWorkspace = NonEmptyTextSchema.max(4_096).parse(workspace);
    const canonicalWorkspace = await realpath(requestedWorkspace);
    const controlDirectory = await openControlDirectory(canonicalWorkspace);
    const databasePath =
        options.databasePath ?? join(controlDirectory, 'goal.db');
    if (!options.store && !options.databasePath) {
        await validateDefaultDatabasePath(controlDirectory, databasePath, true);
    }
    const tokenPath = join(controlDirectory, 'control.token');
    const token = await loadControlToken(tokenPath);
    const store =
        options.store ?? new GoalStore(databasePath, options.storeOptions);
    const control = new GoalControlService(
        canonicalWorkspace,
        tokenPath,
        token,
        store,
        options.closeStore ?? !options.store,
    );
    return {
        workspace: canonicalWorkspace,
        tokenPath,
        control,
        internalTransportAuthToken: token,
    };
};
