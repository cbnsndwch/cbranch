import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
    AgentOutcomeSchema,
    ApprovalScopeSchema,
    ApprovalSchema,
    CompactReferenceSchema,
    DomainIdSchema,
    GoalBudgetSchema,
    GoalSchema,
    ObservationSchema,
    OutboxCommandSchema,
    PlanSchema,
    SCHEMA_VERSION,
    Sha256DigestSchema,
    VerificationResultSchema,
    decideGoalTransition,
    normalizeAgentOutcomeForPolicy,
    validateAcyclicPlan,
    type AgentOutcome,
    type Approval,
    type ApprovalScope,
    type EvidenceReference,
    type Goal,
    type GoalBudget,
    type GoalBudgetUsage,
    type GoalEvent,
    type GoalState,
    type JsonObject,
    type Observation,
    type OutboxCommand,
    type Plan,
    type PlanUnit,
    type RecoveryGoalState,
    type VerificationRequirement,
    type VerificationResult,
    type WorkAttempt,
    type WorkUnit,
} from './domain.js';

type Row = Record<string, unknown>;

const LATEST_MIGRATION = 3;
const MAX_LEASE_MS = 24 * 60 * 60_000;
const MAX_APPROVAL_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_ERROR_LENGTH = 2_000;
const MAX_COMPACT_OUTPUT_LENGTH = 4_096;
const VERIFICATION_RUNTIME_STATUSES: ReadonlySet<VerificationRuntimeStatus> =
    new Set([
        'passed',
        'failed',
        'timed-out',
        'cancelled',
        'output-limit',
        'spawn-error',
    ]);
const isPosix = process.platform !== 'win32';

const isDefaultWorkspaceDatabase = (path: string): boolean => {
    const controlDirectory = dirname(path);
    return (
        basename(path) === 'goal.db' &&
        basename(controlDirectory) === 'goal-supervisor' &&
        basename(dirname(controlDirectory)) === '.opencode'
    );
};

const assertSecureDefaultDatabaseFile = (
    path: string,
    required: boolean,
): void => {
    let info: ReturnType<typeof lstatSync>;
    try {
        info = lstatSync(path);
    } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
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
    if (realpathSync(path) !== path) {
        throw new Error(
            'Goal supervisor database must remain at its canonical workspace path.',
        );
    }
};

const assertSecureDefaultDatabasePath = (path: string): void => {
    const controlDirectory = dirname(path);
    const directoryInfo = lstatSync(controlDirectory);
    if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        realpathSync(controlDirectory) !== controlDirectory
    ) {
        throw new Error(
            'Goal supervisor database directory must be canonical and may not be a symbolic link.',
        );
    }
    if (
        isPosix &&
        typeof process.getuid === 'function' &&
        directoryInfo.uid !== process.getuid()
    ) {
        throw new Error(
            'Goal supervisor database directory must be owned by the current user.',
        );
    }
    assertSecureDefaultDatabaseFile(path, false);
    assertSecureDefaultDatabaseFile(`${path}-wal`, false);
    assertSecureDefaultDatabaseFile(`${path}-shm`, false);
};

export const DEFAULT_GOAL_BUDGET: GoalBudget = {
    maxAttempts: 20,
    maxWallClockMs: 24 * 60 * 60_000,
    maxVerificationMs: 60 * 60_000,
    maxTokens: 1_000_000,
};

export type GoalStoreOptions = {
    readonly clock?: () => Date | string;
    readonly now?: () => Date | string;
    readonly idFactory?: () => string;
    readonly id?: () => string;
    readonly tokenFactory?: () => string;
};

export type VerificationRequirementInput = Omit<
    VerificationRequirement,
    'expectedExitCode' | 'required'
> & {
    readonly expectedExitCode?: number;
    readonly required?: boolean;
};

export type PlanUnitInput = Omit<
    PlanUnit,
    'verificationRequirements' | 'required' | 'destructive'
> & {
    readonly verificationRequirements?: readonly VerificationRequirementInput[];
    readonly required?: boolean;
    readonly destructive?: boolean;
};

export type PlanInput = {
    readonly objective?: string;
    readonly units: readonly PlanUnitInput[];
    readonly finalVerificationRequirements?: readonly VerificationRequirementInput[];
    readonly authoredBy: string;
};

export type StoredGoalEvent = GoalEvent & { readonly sequence: number };

export type IssuedApproval = {
    readonly approval: Approval;
    readonly token: string;
};

export type ClaimedOutboxMessage = {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly leaseToken: string;
    readonly leaseExpiresAt: string;
    readonly retryCount: number;
    readonly nextAttemptAt: string;
    readonly needsProbe: boolean;
    readonly probeState?: string;
    readonly externalRef?: string;
};

export type GoalStatus = {
    readonly workspace: string;
    readonly goal: Goal;
    readonly budget: GoalBudget;
    readonly usage: GoalBudgetUsage;
    readonly activePlan?: Plan;
};

export type GoalInspection = GoalStatus & {
    readonly plans: readonly Plan[];
    readonly workUnits: readonly WorkUnit[];
    readonly activeAttempts: readonly WorkAttempt[];
    readonly cancellationRequests: readonly CancellationRequest[];
    readonly approvals: readonly Approval[];
    readonly sessionReferences: readonly SessionReference[];
};

export type CancellationRequest = {
    readonly id: string;
    readonly goalId: string;
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly externalRef?: string;
    readonly reason: string;
    readonly state: 'pending' | 'acknowledged' | 'failed';
    readonly createdAt: string;
    readonly acknowledgedAt?: string;
    readonly lastError?: string;
    readonly observedAt?: string;
};

export type SessionReference = {
    readonly id: string;
    readonly goalId: string;
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly kind: string;
    readonly externalRef: string;
    readonly createdAt: string;
};

export type PendingPermissionScope = {
    readonly permissionId: string;
    readonly permissionType: string;
};

export type VerificationResultInput = Omit<
    VerificationResult,
    'schemaVersion' | 'id' | 'goalId' | 'workUnitId' | 'attemptId'
> & {
    readonly id?: string;
    readonly outputDigest?: string;
    readonly output?: string;
    readonly runtimeStatus?: VerificationRuntimeStatus;
};

export type FinalVerificationResult = {
    readonly id: string;
    readonly goalId: string;
    readonly planId: string;
    readonly requirementId: string;
    readonly status: 'passed' | 'failed' | 'inconclusive' | 'error';
    readonly summary: string;
    readonly evidenceRefs: readonly EvidenceReference[];
    readonly outputDigest?: string;
    readonly output?: string;
    readonly startedAt: string;
    readonly completedAt: string;
};

export type FinalVerificationResultInput = Omit<
    FinalVerificationResult,
    'id' | 'goalId' | 'planId'
> & { readonly id?: string };

export type VerificationRuntimeStatus =
    | 'passed'
    | 'failed'
    | 'timed-out'
    | 'cancelled'
    | 'output-limit'
    | 'spawn-error';

export type DurableVerificationBaseline = {
    readonly status: VerificationRuntimeStatus;
    readonly exitCode?: number | null;
    readonly outputDigest?: string;
};

export type OutcomeReport = {
    readonly goal: Goal;
    readonly workUnit: WorkUnit;
    readonly attempt: WorkAttempt;
};

export type StartupReconcileResult = {
    readonly expiredAttempts: number;
    readonly expiredOutboxLeases: number;
};

export type IntegrityReport = {
    readonly ok: boolean;
    readonly quickCheck: readonly string[];
    readonly foreignKeyViolations: readonly Row[];
    readonly schemaVersion: number;
    readonly latestSchemaVersion: number;
    readonly journalMode: string;
    readonly synchronous: number;
    readonly wal: readonly Row[];
};

const canonicalize = (value: unknown): unknown => {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error('JSON numbers must be finite.');
        return value;
    }
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonicalize(item)]),
        );
    }
    throw new Error('Values persisted as JSON must be JSON-compatible.');
};

const canonicalJson = (value: unknown): string =>
    JSON.stringify(canonicalize(value));

const sha256 = (value: string): `sha256:${string}` =>
    `sha256:${createHash('sha256').update(value).digest('hex')}`;

const parseJson = <Value>(value: unknown): Value =>
    JSON.parse(String(value)) as Value;

const optionalString = (value: unknown): string | undefined =>
    value === null || value === undefined ? undefined : String(value);

const optionalNumber = (value: unknown): number | undefined =>
    value === null || value === undefined ? undefined : Number(value);

const toGoal = (row: Row): Goal => ({
    schemaVersion: SCHEMA_VERSION,
    id: String(row.id),
    workspace: String(row.workspace),
    objective: String(row.objective),
    state: row.state as GoalState,
    version: Number(row.version),
    activePlanId: optionalString(row.active_plan_id),
    activePlanRevision: optionalNumber(row.active_plan_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
});

const toWorkUnit = (row: Row): WorkUnit => ({
    schemaVersion: SCHEMA_VERSION,
    id: String(row.id),
    goalId: String(row.goal_id),
    planUnitId: optionalString(row.plan_unit_id),
    kind: String(row.kind),
    input: parseJson<Record<string, unknown>>(row.input_json),
    state: row.state as WorkUnit['state'],
    dependencyIds: parseJson<string[]>(row.dependency_json ?? '[]'),
    required: Boolean(row.required),
    activeAttemptId: optionalString(row.active_attempt_id),
    nextAttemptNumber: Number(row.next_attempt_number),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
});

const toAttempt = (row: Row): WorkAttempt => ({
    schemaVersion: SCHEMA_VERSION,
    id: String(row.id),
    workUnitId: String(row.work_unit_id),
    number: Number(row.number),
    state: row.state as WorkAttempt['state'],
    leaseToken: String(row.lease_token),
    leaseOwner: String(row.lease_owner),
    leaseAcquiredAt: optionalString(row.lease_acquired_at),
    leaseExpiresAt: String(row.lease_expires_at),
    createdAt: String(row.created_at),
    startedAt: optionalString(row.started_at),
    completedAt: optionalString(row.completed_at),
});

const redactError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    const printable = Array.from(message)
        .filter(character => {
            const code = character.charCodeAt(0);
            return code >= 0x20 && code !== 0x7f;
        })
        .join('');
    return printable
        .replace(
            /\b(authorization|token|password|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi,
            '$1=[REDACTED]',
        )
        .slice(0, MAX_ERROR_LENGTH);
};

const requirePositiveDuration = (value: number, label: string): void => {
    if (!Number.isInteger(value) || value <= 0 || value > MAX_LEASE_MS) {
        throw new Error(
            `${label} must be a positive integer at most ${MAX_LEASE_MS}.`,
        );
    }
};

const getRequiredRequirements = (
    requirements: readonly VerificationRequirement[],
): readonly VerificationRequirement[] =>
    requirements.filter(requirement => requirement.required);

export class GoalStore {
    readonly #database: Database.Database;
    readonly #path: string;
    readonly #clock: () => Date | string;
    readonly #idFactory: () => string;
    readonly #tokenFactory: () => string;
    #closed = false;
    #commandContext:
        | {
              readonly commandId: string;
              readonly correlationId: string;
          }
        | undefined;

    constructor(
        path: string,
        optionsOrClock: GoalStoreOptions | (() => Date | string) = {},
        idFactory?: () => string,
    ) {
        if (!path.trim()) throw new Error('Database path must be nonempty.');
        const options: GoalStoreOptions =
            typeof optionsOrClock === 'function'
                ? { clock: optionsOrClock, idFactory }
                : optionsOrClock;
        this.#path = path === ':memory:' ? path : resolve(path);
        this.#clock = options.clock ?? options.now ?? (() => new Date());
        this.#idFactory = options.idFactory ?? options.id ?? randomUUID;
        this.#tokenFactory =
            options.tokenFactory ??
            (() => randomBytes(32).toString('base64url'));

        if (path !== ':memory:') {
            mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
            if (isDefaultWorkspaceDatabase(this.#path)) {
                assertSecureDefaultDatabasePath(this.#path);
            }
            this.#bestEffortMode(dirname(this.#path), 0o700);
        }
        this.#database = new Database(this.#path);
        this.#database.pragma('foreign_keys = ON');
        this.#database.pragma('journal_mode = WAL');
        this.#database.pragma('synchronous = FULL');
        this.#database.pragma('busy_timeout = 5000');
        this.#migrate();
        this.#hardenDatabaseFiles();
    }

    get path(): string {
        return this.#path;
    }

    #now(): string {
        const value = this.#clock();
        const date = typeof value === 'string' ? new Date(value) : value;
        if (Number.isNaN(date.getTime()))
            throw new Error('Clock returned an invalid date.');
        return date.toISOString();
    }

    #id(): string {
        return DomainIdSchema.parse(this.#idFactory());
    }

    #token(): string {
        const token = this.#tokenFactory();
        if (
            token.length < 32 ||
            token.length > 512 ||
            !/^[A-Za-z0-9._~+-]+$/.test(token)
        ) {
            throw new Error(
                'Token factory returned an invalid approval token.',
            );
        }
        return token;
    }

    #bestEffortMode(path: string, mode: number): void {
        try {
            chmodSync(path, mode);
        } catch {
            // Filesystem permission hardening is best effort on unsupported platforms.
        }
    }

    #hardenDatabaseFiles(): void {
        if (this.#path === ':memory:') return;
        this.#bestEffortMode(this.#path, 0o600);
        this.#bestEffortMode(`${this.#path}-wal`, 0o600);
        this.#bestEffortMode(`${this.#path}-shm`, 0o600);
    }

    #tableExists(name: string): boolean {
        return Boolean(
            this.#database
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                )
                .get(name),
        );
    }

    #columns(table: string): ReadonlySet<string> {
        return new Set(
            (this.#database.pragma(`table_info(${table})`) as Row[]).map(row =>
                String(row.name),
            ),
        );
    }

    #addColumn(table: string, name: string, definition: string): void {
        if (!this.#columns(table).has(name)) {
            this.#database.exec(
                `ALTER TABLE ${table} ADD COLUMN ${definition}`,
            );
        }
    }

    #migrate(): void {
        const prototypeTables = [
            'goals',
            'goal_events',
            'work_units',
            'work_attempts',
            'outbox',
        ];
        const hasPrototype = prototypeTables.every(table =>
            this.#tableExists(table),
        );
        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
        const applied = this.#database
            .prepare('SELECT version FROM schema_migrations ORDER BY version')
            .all() as Row[];
        if (applied.length === 0 && hasPrototype) {
            this.#database
                .prepare(
                    'INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)',
                )
                .run(this.#now());
        }

        const migrations = [
            { version: 1, apply: () => this.#applyPrototypeSchema() },
            { version: 2, apply: () => this.#applyDurableSchema() },
            { version: 3, apply: () => this.#applyPlanScopedVerification() },
        ] as const;
        for (const migration of migrations) {
            const exists = this.#database
                .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
                .get(migration.version);
            if (exists) continue;
            this.#database
                .transaction(() => {
                    migration.apply();
                    this.#database
                        .prepare(
                            'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
                        )
                        .run(migration.version, this.#now());
                })
                .immediate();
        }
    }

    #applyPrototypeSchema(): void {
        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_events (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_units (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL,
        active_attempt_id TEXT,
        next_attempt_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_attempts (
        id TEXT PRIMARY KEY,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id),
        number INTEGER NOT NULL,
        lease_token TEXT NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(work_unit_id, number)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    }

    #applyDurableSchema(): void {
        if (!this.#columns('goal_events').has('sequence')) {
            this.#database.exec(`
        ALTER TABLE goal_events RENAME TO goal_events_v1;
        CREATE TABLE goal_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          schema_version INTEGER NOT NULL,
          goal_id TEXT NOT NULL REFERENCES goals(id),
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          command_id TEXT,
          causation_id TEXT,
          correlation_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO goal_events(
          id, schema_version, goal_id, type, payload_json, created_at
        )
        SELECT id, 1, goal_id, type, payload, created_at
        FROM goal_events_v1
        ORDER BY rowid;
        DROP TABLE goal_events_v1;
      `);
        }

        this.#addColumn(
            'goals',
            'schema_version',
            'schema_version INTEGER NOT NULL DEFAULT 1',
        );
        this.#addColumn('goals', 'active_plan_id', 'active_plan_id TEXT');
        this.#addColumn(
            'goals',
            'active_plan_revision',
            'active_plan_revision INTEGER',
        );

        this.#addColumn('work_units', 'plan_id', 'plan_id TEXT');
        this.#addColumn('work_units', 'plan_unit_id', 'plan_unit_id TEXT');
        this.#addColumn(
            'work_units',
            'dependency_json',
            "dependency_json TEXT NOT NULL DEFAULT '[]'",
        );
        this.#addColumn(
            'work_units',
            'requirements_json',
            "requirements_json TEXT NOT NULL DEFAULT '[]'",
        );
        this.#addColumn(
            'work_units',
            'acceptance_json',
            "acceptance_json TEXT NOT NULL DEFAULT '[]'",
        );
        this.#addColumn(
            'work_units',
            'required',
            'required INTEGER NOT NULL DEFAULT 1',
        );
        this.#addColumn(
            'work_units',
            'destructive',
            'destructive INTEGER NOT NULL DEFAULT 0',
        );
        this.#addColumn('work_units', 'approval_id', 'approval_id TEXT');
        this.#addColumn('work_units', 'approved_at', 'approved_at TEXT');

        this.#addColumn(
            'work_attempts',
            'lease_acquired_at',
            'lease_acquired_at TEXT',
        );
        this.#addColumn('work_attempts', 'started_at', 'started_at TEXT');
        this.#addColumn('work_attempts', 'completed_at', 'completed_at TEXT');
        this.#addColumn(
            'work_attempts',
            'failure_fingerprint',
            'failure_fingerprint TEXT',
        );
        this.#addColumn(
            'work_attempts',
            'material_change_digest',
            'material_change_digest TEXT',
        );
        this.#addColumn(
            'work_attempts',
            'issue_classification',
            'issue_classification TEXT',
        );
        this.#addColumn(
            'work_attempts',
            'verification_improved',
            'verification_improved INTEGER NOT NULL DEFAULT 0',
        );
        this.#addColumn('work_attempts', 'outcome_json', 'outcome_json TEXT');

        this.#addColumn(
            'outbox',
            'retry_count',
            'retry_count INTEGER NOT NULL DEFAULT 0',
        );
        this.#addColumn('outbox', 'next_attempt_at', 'next_attempt_at TEXT');
        this.#addColumn('outbox', 'last_error', 'last_error TEXT');
        this.#addColumn(
            'outbox',
            'needs_probe',
            'needs_probe INTEGER NOT NULL DEFAULT 0',
        );
        this.#addColumn('outbox', 'probe_state', 'probe_state TEXT');
        this.#addColumn('outbox', 'ambiguity_state', 'ambiguity_state TEXT');
        this.#addColumn('outbox', 'external_ref', 'external_ref TEXT');
        this.#addColumn(
            'outbox',
            'dispatch_started_at',
            'dispatch_started_at TEXT',
        );
        this.#addColumn('outbox', 'dispatcher_owner', 'dispatcher_owner TEXT');
        this.#database.exec(
            'UPDATE outbox SET next_attempt_at = created_at WHERE next_attempt_at IS NULL',
        );

        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        revision INTEGER NOT NULL,
        parent_plan_id TEXT REFERENCES plans(id),
        content_digest TEXT NOT NULL,
        document_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed', 'approved', 'superseded')),
        authored_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        UNIQUE(goal_id, revision)
      );
      CREATE TABLE IF NOT EXISTS work_dependencies (
        work_unit_id TEXT NOT NULL REFERENCES work_units(id),
        depends_on_work_unit_id TEXT NOT NULL REFERENCES work_units(id),
        PRIMARY KEY(work_unit_id, depends_on_work_unit_id),
        CHECK(work_unit_id <> depends_on_work_unit_id)
      );
      CREATE TABLE IF NOT EXISTS command_inbox (
        command_id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        outbox_id TEXT NOT NULL REFERENCES outbox(id),
        attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
        action TEXT NOT NULL,
        dispatcher_lease_token TEXT,
        retry_count INTEGER NOT NULL,
        next_attempt_at TEXT,
        error TEXT,
        needs_probe INTEGER NOT NULL,
        probe_state TEXT,
        external_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observation_inbox (
        goal_id TEXT NOT NULL REFERENCES goals(id),
        deduplication_key TEXT NOT NULL,
        observation_id TEXT NOT NULL UNIQUE,
        received_at TEXT NOT NULL,
        PRIMARY KEY(goal_id, deduplication_key)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        work_unit_id TEXT REFERENCES work_units(id),
        attempt_id TEXT REFERENCES work_attempts(id),
        deduplication_key TEXT,
        document_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS observations_dedupe
        ON observations(goal_id, deduplication_key)
        WHERE deduplication_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        work_unit_id TEXT REFERENCES work_units(id),
        attempt_id TEXT REFERENCES work_attempts(id),
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        digest TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(goal_id, ref, digest)
      );
      CREATE TABLE IF NOT EXISTS verification_results (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        work_unit_id TEXT REFERENCES work_units(id),
        attempt_id TEXT REFERENCES work_attempts(id),
        requirement_id TEXT NOT NULL,
        final INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        output_digest TEXT,
        compact_output TEXT,
        improvement_absolute REAL,
        document_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS attempt_verification_requirement
        ON verification_results(attempt_id, requirement_id)
        WHERE attempt_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS final_verification_requirement
        ON verification_results(goal_id, requirement_id, completed_at)
        WHERE final = 1;
      CREATE TABLE IF NOT EXISTS verification_baselines (
        id TEXT PRIMARY KEY,
        verification_result_id TEXT NOT NULL UNIQUE REFERENCES verification_results(id),
        baseline_json TEXT NOT NULL,
        observed_json TEXT,
        improvement_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        scope_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cancellation_requests (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        work_unit_id TEXT NOT NULL REFERENCES work_units(id),
        attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
        external_ref TEXT,
        reason TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        UNIQUE(attempt_id, state)
      );
      CREATE TABLE IF NOT EXISTS session_external_refs (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        work_unit_id TEXT NOT NULL REFERENCES work_units(id),
        attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
        kind TEXT NOT NULL,
        external_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(attempt_id, kind, external_ref)
      );
      CREATE TABLE IF NOT EXISTS goal_budgets (
        goal_id TEXT PRIMARY KEY REFERENCES goals(id),
        max_attempts INTEGER NOT NULL,
        max_wall_clock_ms INTEGER NOT NULL,
        max_verification_ms INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_budget_usage (
        goal_id TEXT PRIMARY KEY REFERENCES goals(id),
        attempts INTEGER NOT NULL DEFAULT 0,
        wall_clock_ms INTEGER NOT NULL DEFAULT 0,
        verification_ms INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_units_claimable
        ON work_units(state, goal_id, created_at);
      CREATE INDEX IF NOT EXISTS attempts_expiry
        ON work_attempts(state, lease_expires_at);
      CREATE INDEX IF NOT EXISTS outbox_claimable
        ON outbox(state, next_attempt_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS events_goal_sequence
        ON goal_events(goal_id, sequence);
      CREATE TRIGGER IF NOT EXISTS goal_events_no_update
      BEFORE UPDATE ON goal_events BEGIN
        SELECT RAISE(ABORT, 'goal_events is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS goal_events_no_delete
      BEFORE DELETE ON goal_events BEGIN
        SELECT RAISE(ABORT, 'goal_events is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS plans_document_immutable
      BEFORE UPDATE OF document_json, content_digest, revision, goal_id ON plans
      BEGIN
        SELECT RAISE(ABORT, 'plan documents are immutable');
      END;
    `);

        const now = this.#now();
        this.#database
            .prepare(
                `INSERT OR IGNORE INTO goal_budgets(
          goal_id, max_attempts, max_wall_clock_ms, max_verification_ms,
          max_tokens, updated_at
        ) SELECT id, ?, ?, ?, ?, ? FROM goals`,
            )
            .run(
                DEFAULT_GOAL_BUDGET.maxAttempts,
                DEFAULT_GOAL_BUDGET.maxWallClockMs,
                DEFAULT_GOAL_BUDGET.maxVerificationMs,
                DEFAULT_GOAL_BUDGET.maxTokens,
                now,
            );
        this.#database
            .prepare(
                `INSERT OR IGNORE INTO goal_budget_usage(
          goal_id, attempts, wall_clock_ms, verification_ms, tokens, updated_at
        ) SELECT id, 0, 0, 0, 0, ? FROM goals`,
            )
            .run(now);

        const migratedGoals = this.#database
            .prepare('SELECT * FROM goals')
            .all() as Row[];
        for (const row of migratedGoals) {
            const goal = toGoal(row);
            this.#database
                .prepare(
                    `INSERT INTO goal_events(
            id, schema_version, goal_id, type, payload_json, created_at
          ) VALUES (?, ?, ?, 'goal.migrated', ?, ?)`,
                )
                .run(
                    this.#id(),
                    SCHEMA_VERSION,
                    goal.id,
                    canonicalJson({ goal }),
                    now,
                );
        }
    }

    #applyPlanScopedVerification(): void {
        this.#addColumn(
            'verification_results',
            'plan_id',
            'plan_id TEXT REFERENCES plans(id)',
        );
        this.#addColumn(
            'verification_results',
            'runtime_status',
            'runtime_status TEXT',
        );
        this.#addColumn(
            'verification_results',
            'exit_code',
            'exit_code INTEGER',
        );
        this.#addColumn(
            'cancellation_requests',
            'last_error',
            'last_error TEXT',
        );
        this.#addColumn(
            'cancellation_requests',
            'observed_at',
            'observed_at TEXT',
        );
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS final_verification_plan_requirement
            ON verification_results(
              goal_id, plan_id, requirement_id, completed_at
            )
            WHERE final = 1;
        `);
    }

    #event(
        goalId: string,
        type: string,
        payload: Readonly<Record<string, unknown>>,
        createdAt = this.#now(),
        metadata: {
            readonly causationId?: string;
            readonly correlationId?: string;
        } = {},
    ): StoredGoalEvent {
        const goal = this.get(goalId);
        if (!goal) throw new Error(`Goal ${goalId} was not found.`);
        const id = this.#id();
        const commandId = this.#commandContext?.commandId;
        const eventPayload = parseJson<JsonObject>(
            canonicalJson({ ...payload, goal }),
        );
        const result = this.#database
            .prepare(
                `INSERT INTO goal_events(
          id, schema_version, goal_id, type, payload_json, command_id,
          causation_id, correlation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                id,
                SCHEMA_VERSION,
                goalId,
                type,
                canonicalJson(eventPayload),
                commandId ?? null,
                metadata.causationId ?? commandId ?? null,
                metadata.correlationId ??
                    this.#commandContext?.correlationId ??
                    null,
                createdAt,
            );
        return {
            sequence: Number(result.lastInsertRowid),
            schemaVersion: SCHEMA_VERSION,
            id,
            goalId,
            type,
            payload: eventPayload,
            commandId,
            causationId: metadata.causationId ?? commandId,
            correlationId:
                metadata.correlationId ?? this.#commandContext?.correlationId,
            createdAt,
        };
    }

    create(
        workspace: string,
        objective: string,
        budget: GoalBudget = DEFAULT_GOAL_BUDGET,
    ): Goal {
        const parsedBudget = GoalBudgetSchema.parse(budget);
        const now = this.#now();
        const goal = GoalSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            id: this.#id(),
            workspace,
            objective,
            state: 'draft',
            version: 0,
            createdAt: now,
            updatedAt: now,
        });
        return this.#database
            .transaction(() => {
                this.#database
                    .prepare(
                        `INSERT INTO goals(
            id, workspace, objective, state, version, created_at, updated_at,
            schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        goal.id,
                        goal.workspace,
                        goal.objective,
                        goal.state,
                        goal.version,
                        goal.createdAt,
                        goal.updatedAt,
                        SCHEMA_VERSION,
                    );
                this.#database
                    .prepare(
                        `INSERT INTO goal_budgets(
            goal_id, max_attempts, max_wall_clock_ms, max_verification_ms,
            max_tokens, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        goal.id,
                        parsedBudget.maxAttempts,
                        parsedBudget.maxWallClockMs,
                        parsedBudget.maxVerificationMs,
                        parsedBudget.maxTokens,
                        now,
                    );
                this.#database
                    .prepare(
                        `INSERT INTO goal_budget_usage(
            goal_id, attempts, wall_clock_ms, verification_ms, tokens, updated_at
          ) VALUES (?, 0, 0, 0, 0, ?)`,
                    )
                    .run(goal.id, now);
                this.#event(
                    goal.id,
                    'goal.created',
                    {
                        workspace: goal.workspace,
                        objective: goal.objective,
                        budget: parsedBudget,
                    },
                    now,
                );
                return goal;
            })
            .immediate();
    }

    createGoal(
        workspace: string,
        objective: string,
        budget?: GoalBudget,
    ): Goal {
        return this.create(workspace, objective, budget);
    }

    get(id: string): Goal | undefined {
        const row = this.#database
            .prepare('SELECT * FROM goals WHERE id = ?')
            .get(id) as Row | undefined;
        return row ? toGoal(row) : undefined;
    }

    list(workspace: string): readonly Goal[] {
        if (!workspace.trim()) throw new Error('Workspace must be nonempty.');
        return (
            this.#database
                .prepare(
                    'SELECT * FROM goals WHERE workspace = ? ORDER BY created_at DESC, id',
                )
                .all(workspace) as Row[]
        ).map(toGoal);
    }

    assertWorkspace(goalId: string, workspace: string): Goal {
        const goal = this.#requireGoal(goalId);
        if (goal.workspace !== workspace) {
            throw new Error(
                `Goal ${goalId} does not belong to workspace ${workspace}.`,
            );
        }
        return goal;
    }

    status(goalId: string, workspace?: string): GoalStatus {
        const goal = workspace
            ? this.assertWorkspace(goalId, workspace)
            : this.#requireGoal(goalId);
        const { budget, usage } = this.getBudget(goalId);
        return {
            workspace: goal.workspace,
            goal,
            budget,
            usage,
            activePlan: goal.activePlanId
                ? this.getPlan(goal.activePlanId)
                : undefined,
        };
    }

    inspect(goalId: string, workspace?: string): GoalInspection {
        const status = this.status(goalId, workspace);
        return {
            ...status,
            plans: this.listPlans(goalId),
            workUnits: this.listWorkUnits(goalId),
            activeAttempts: this.listActiveAttempts(goalId),
            cancellationRequests: this.listCancellationRequests(goalId),
            approvals: this.listApprovals(goalId),
            sessionReferences: this.listSessionReferences(goalId),
        };
    }

    getStatus(goalId: string, workspace?: string): GoalStatus {
        return this.status(goalId, workspace);
    }

    inspectGoal(goalId: string, workspace?: string): GoalInspection {
        return this.inspect(goalId, workspace);
    }

    #requireGoal(goalId: string): Goal {
        const goal = this.get(goalId);
        if (!goal) throw new Error(`Goal ${goalId} was not found.`);
        return goal;
    }

    events(goalId: string, afterSequence = 0): readonly StoredGoalEvent[] {
        this.#requireGoal(goalId);
        return (
            this.#database
                .prepare(
                    `SELECT * FROM goal_events
           WHERE goal_id = ? AND sequence > ? ORDER BY sequence`,
                )
                .all(goalId, afterSequence) as Row[]
        ).map(row => ({
            sequence: Number(row.sequence),
            schemaVersion: SCHEMA_VERSION,
            id: String(row.id),
            goalId: String(row.goal_id),
            type: String(row.type),
            payload: parseJson<JsonObject>(row.payload_json),
            commandId: optionalString(row.command_id),
            causationId: optionalString(row.causation_id),
            correlationId: optionalString(row.correlation_id),
            createdAt: String(row.created_at),
        }));
    }

    rebuildProjections(): number {
        return this.#database
            .transaction(() => {
                const rows = this.#database
                    .prepare(
                        'SELECT payload_json FROM goal_events ORDER BY sequence',
                    )
                    .all() as Row[];
                const replayed = new Map<string, Goal>();
                for (const row of rows) {
                    const payload = parseJson<Record<string, unknown>>(
                        row.payload_json,
                    );
                    const parsed = GoalSchema.safeParse(payload.goal);
                    if (parsed.success)
                        replayed.set(parsed.data.id, parsed.data);
                }
                const projectionIds = (
                    this.#database
                        .prepare('SELECT id FROM goals')
                        .all() as Row[]
                ).map(row => String(row.id));
                for (const goalId of projectionIds) {
                    if (!replayed.has(goalId)) {
                        this.#deleteEventlessGoalProjection(goalId);
                    }
                }
                for (const goal of replayed.values()) {
                    this.#database
                        .prepare(
                            `INSERT INTO goals(
              id, workspace, objective, state, version, created_at, updated_at,
              schema_version, active_plan_id, active_plan_revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              workspace = excluded.workspace,
              objective = excluded.objective,
              state = excluded.state,
              version = excluded.version,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              schema_version = excluded.schema_version,
              active_plan_id = excluded.active_plan_id,
              active_plan_revision = excluded.active_plan_revision`,
                        )
                        .run(
                            goal.id,
                            goal.workspace,
                            goal.objective,
                            goal.state,
                            goal.version,
                            goal.createdAt,
                            goal.updatedAt,
                            SCHEMA_VERSION,
                            goal.activePlanId ?? null,
                            goal.activePlanRevision ?? null,
                        );
                }
                return replayed.size;
            })
            .immediate();
    }

    #deleteEventlessGoalProjection(goalId: string): void {
        const unitIds = (
            this.#database
                .prepare('SELECT id FROM work_units WHERE goal_id = ?')
                .all(goalId) as Row[]
        ).map(row => String(row.id));
        for (const workUnitId of unitIds) {
            const attemptIds = (
                this.#database
                    .prepare(
                        'SELECT id FROM work_attempts WHERE work_unit_id = ?',
                    )
                    .all(workUnitId) as Row[]
            ).map(row => String(row.id));
            for (const attemptId of attemptIds) {
                this.#database
                    .prepare(
                        `DELETE FROM delivery_attempts WHERE outbox_id IN (
                            SELECT id FROM outbox WHERE attempt_id = ?
                        )`,
                    )
                    .run(attemptId);
                this.#database
                    .prepare(
                        `DELETE FROM verification_baselines
                         WHERE verification_result_id IN (
                           SELECT id FROM verification_results WHERE attempt_id = ?
                         )`,
                    )
                    .run(attemptId);
                this.#database
                    .prepare(
                        'DELETE FROM verification_results WHERE attempt_id = ?',
                    )
                    .run(attemptId);
                this.#database
                    .prepare(
                        'DELETE FROM cancellation_requests WHERE attempt_id = ?',
                    )
                    .run(attemptId);
                this.#database
                    .prepare(
                        'DELETE FROM session_external_refs WHERE attempt_id = ?',
                    )
                    .run(attemptId);
                this.#database
                    .prepare('DELETE FROM evidence WHERE attempt_id = ?')
                    .run(attemptId);
                this.#database
                    .prepare('DELETE FROM observations WHERE attempt_id = ?')
                    .run(attemptId);
                this.#database
                    .prepare('DELETE FROM outbox WHERE attempt_id = ?')
                    .run(attemptId);
            }
        }
        this.#database
            .prepare('DELETE FROM observation_inbox WHERE goal_id = ?')
            .run(goalId);
        this.#database
            .prepare(
                'DELETE FROM work_dependencies WHERE work_unit_id IN (SELECT id FROM work_units WHERE goal_id = ?) OR depends_on_work_unit_id IN (SELECT id FROM work_units WHERE goal_id = ?)',
            )
            .run(goalId, goalId);
        this.#database
            .prepare(
                'DELETE FROM work_attempts WHERE work_unit_id IN (SELECT id FROM work_units WHERE goal_id = ?)',
            )
            .run(goalId);
        for (const table of [
            'verification_results',
            'evidence',
            'observations',
            'approvals',
            'cancellation_requests',
            'session_external_refs',
            'work_units',
        ]) {
            this.#database
                .prepare(`DELETE FROM ${table} WHERE goal_id = ?`)
                .run(goalId);
        }
        const planIds = (
            this.#database
                .prepare(
                    'SELECT id FROM plans WHERE goal_id = ? ORDER BY revision DESC',
                )
                .all(goalId) as Row[]
        ).map(row => String(row.id));
        for (const planId of planIds) {
            this.#database
                .prepare('DELETE FROM plans WHERE id = ?')
                .run(planId);
        }
        this.#database
            .prepare('DELETE FROM goal_budget_usage WHERE goal_id = ?')
            .run(goalId);
        this.#database
            .prepare('DELETE FROM goal_budgets WHERE goal_id = ?')
            .run(goalId);
        this.#database.prepare('DELETE FROM goals WHERE id = ?').run(goalId);
    }

    verifyProjections(): {
        readonly ok: boolean;
        readonly mismatchedGoalIds: readonly string[];
    } {
        const expected = new Map<string, Goal>();
        const rows = this.#database
            .prepare('SELECT payload_json FROM goal_events ORDER BY sequence')
            .all() as Row[];
        for (const row of rows) {
            const parsed = GoalSchema.safeParse(
                parseJson<Record<string, unknown>>(row.payload_json).goal,
            );
            if (parsed.success) expected.set(parsed.data.id, parsed.data);
        }
        const projectionIds = new Set(
            (this.#database.prepare('SELECT id FROM goals').all() as Row[]).map(
                row => String(row.id),
            ),
        );
        const allIds = new Set([...expected.keys(), ...projectionIds]);
        const mismatchedGoalIds = [...allIds].filter(id => {
            const projection = this.get(id);
            const replayed = expected.get(id);
            if (!projection || !replayed) return true;
            return canonicalJson(projection) !== canonicalJson(replayed);
        });
        return { ok: mismatchedGoalIds.length === 0, mismatchedGoalIds };
    }

    executeIdempotent<Result>(
        commandId: string,
        workspace: string,
        request: unknown,
        callback: () => Result,
    ): Result {
        DomainIdSchema.parse(commandId);
        if (!workspace.trim()) throw new Error('Workspace must be nonempty.');
        const requestJson = canonicalJson(request);
        const requestDigest = sha256(requestJson);
        const now = this.#now();
        const completed = this.#database
            .transaction(
                ():
                    | { readonly ok: true; readonly value: Result }
                    | { readonly ok: false; readonly error: unknown } => {
                    const existing = this.#database
                        .prepare(
                            'SELECT * FROM command_inbox WHERE command_id = ?',
                        )
                        .get(commandId) as Row | undefined;
                    if (existing) {
                        if (
                            existing.workspace !== workspace ||
                            existing.request_digest !== requestDigest
                        ) {
                            throw new Error(
                                `Command ${commandId} was reused with a different request.`,
                            );
                        }
                        if (!existing.finished_at) {
                            throw new Error(
                                `Command ${commandId} is already in progress.`,
                            );
                        }
                        if (existing.error) {
                            throw new Error(String(existing.error));
                        }
                        return {
                            ok: true,
                            value: parseJson<Result>(existing.result_json),
                        };
                    }
                    this.#database
                        .prepare(
                            `INSERT INTO command_inbox(
              command_id, workspace, request_digest, request_json, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
                        )
                        .run(
                            commandId,
                            workspace,
                            requestDigest,
                            requestJson,
                            now,
                        );
                    const previousContext = this.#commandContext;
                    this.#commandContext = {
                        commandId,
                        correlationId: commandId,
                    };
                    try {
                        let handled: {
                            readonly result: Result;
                            readonly resultJson: string;
                        };
                        try {
                            handled = this.#database.transaction(() => {
                                const result = callback();
                                return {
                                    result,
                                    resultJson: canonicalJson(result),
                                };
                            })();
                        } catch (error) {
                            this.#database
                                .prepare(
                                    `UPDATE command_inbox SET error = ?, finished_at = ?
                                     WHERE command_id = ?`,
                                )
                                .run(
                                    redactError(error),
                                    this.#now(),
                                    commandId,
                                );
                            return { ok: false, error };
                        }
                        this.#database
                            .prepare(
                                `UPDATE command_inbox
                                 SET result_json = ?, finished_at = ?
                                 WHERE command_id = ?`,
                            )
                            .run(handled.resultJson, this.#now(), commandId);
                        return { ok: true, value: handled.result };
                    } finally {
                        this.#commandContext = previousContext;
                    }
                },
            )
            .immediate();
        if (!completed.ok) throw completed.error;
        return completed.value;
    }

    /** Direct transitions are intentionally fenced; use the policy-specific API. */
    transition(_goalId: string, _state: GoalState): never {
        throw new Error(
            'Direct goal transitions are disabled; use startGoal, pauseGoal, resumeGoal, cancelGoal, recoverUnknownOutcome, or finalizeGoal.',
        );
    }

    #writeGoal(
        goal: Goal,
        changes: {
            readonly state?: GoalState;
            readonly activePlanId?: string | null;
            readonly activePlanRevision?: number | null;
        },
        eventType: string,
        payload: Readonly<Record<string, unknown>>,
        now = this.#now(),
    ): Goal {
        const state = changes.state ?? goal.state;
        const activePlanId =
            changes.activePlanId === undefined
                ? goal.activePlanId
                : (changes.activePlanId ?? undefined);
        const activePlanRevision =
            changes.activePlanRevision === undefined
                ? goal.activePlanRevision
                : (changes.activePlanRevision ?? undefined);
        const result = this.#database
            .prepare(
                `UPDATE goals SET
          state = ?, version = ?, updated_at = ?, active_plan_id = ?,
          active_plan_revision = ?
         WHERE id = ? AND version = ?`,
            )
            .run(
                state,
                goal.version + 1,
                now,
                activePlanId ?? null,
                activePlanRevision ?? null,
                goal.id,
                goal.version,
            );
        if (result.changes !== 1) {
            throw new Error(`Goal ${goal.id} was changed concurrently.`);
        }
        const next = this.#requireGoal(goal.id);
        this.#event(goal.id, eventType, payload, now);
        return next;
    }

    #decideAndWrite(
        goal: Goal,
        action: Parameters<typeof decideGoalTransition>[1],
        context: Parameters<typeof decideGoalTransition>[2],
        eventType: string,
        payload: Readonly<Record<string, unknown>>,
    ): Goal {
        const decision = decideGoalTransition(goal.state, action, context);
        if (!decision.ok) throw new Error(decision.reason);
        return this.#writeGoal(
            goal,
            { state: decision.state },
            eventType,
            payload,
        );
    }

    proposePlan(goalId: string, input: PlanInput): Plan {
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                if (goal.state !== 'draft' && goal.state !== 'needs-replan') {
                    throw new Error(
                        `Plans can be proposed only for draft or needs-replan goals, not ${goal.state}.`,
                    );
                }
                DomainIdSchema.parse(input.authoredBy);
                const revisionRow = this.#database
                    .prepare(
                        'SELECT COALESCE(MAX(revision), 0) AS revision FROM plans WHERE goal_id = ?',
                    )
                    .get(goalId) as Row;
                const revision = Number(revisionRow.revision) + 1;
                const createdAt = this.#now();
                const id = this.#id();
                const semanticContent = {
                    objective: input.objective ?? goal.objective,
                    units: input.units.map(unit => ({
                        ...unit,
                        verificationRequirements:
                            unit.verificationRequirements ?? [],
                    })),
                    finalVerificationRequirements:
                        input.finalVerificationRequirements ?? [],
                };
                const provisionalPlan = PlanSchema.parse({
                    schemaVersion: SCHEMA_VERSION,
                    id,
                    goalId,
                    revision,
                    parentPlanId: goal.activePlanId,
                    contentDigest: sha256(''),
                    ...semanticContent,
                    authoredBy: input.authoredBy,
                    createdAt,
                });
                const plan = PlanSchema.parse({
                    ...provisionalPlan,
                    contentDigest: sha256(
                        canonicalJson({
                            objective: provisionalPlan.objective,
                            units: provisionalPlan.units,
                            finalVerificationRequirements:
                                provisionalPlan.finalVerificationRequirements,
                        }),
                    ),
                });
                const issues = validateAcyclicPlan(plan);
                if (issues.length > 0) {
                    throw new Error(
                        `Invalid plan: ${issues.map(issue => issue.message).join('; ')}`,
                    );
                }
                this.#database
                    .prepare(
                        `INSERT INTO plans(
            id, goal_id, revision, parent_plan_id, content_digest,
            document_json, status, authored_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
                    )
                    .run(
                        plan.id,
                        plan.goalId,
                        plan.revision,
                        plan.parentPlanId ?? null,
                        plan.contentDigest,
                        canonicalJson(plan),
                        plan.authoredBy,
                        plan.createdAt,
                    );
                this.#writeGoal(
                    goal,
                    {},
                    'plan.proposed',
                    {
                        planId: plan.id,
                        revision: plan.revision,
                        contentDigest: plan.contentDigest,
                    },
                    createdAt,
                );
                return plan;
            })
            .immediate();
    }

    getPlan(planId: string): Plan | undefined {
        const row = this.#database
            .prepare('SELECT document_json FROM plans WHERE id = ?')
            .get(planId) as Row | undefined;
        return row ? PlanSchema.parse(parseJson(row.document_json)) : undefined;
    }

    listPlans(goalId: string): readonly Plan[] {
        this.#requireGoal(goalId);
        return (
            this.#database
                .prepare(
                    'SELECT document_json FROM plans WHERE goal_id = ? ORDER BY revision',
                )
                .all(goalId) as Row[]
        ).map(row => PlanSchema.parse(parseJson(row.document_json)));
    }

    approvePlan(goalId: string, planId: string, actor: string): Goal {
        DomainIdSchema.parse(actor);
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                if (goal.state !== 'draft' && goal.state !== 'needs-replan') {
                    throw new Error(
                        `A plan cannot be approved while the goal is ${goal.state}.`,
                    );
                }
                const planRow = this.#database
                    .prepare('SELECT * FROM plans WHERE id = ? AND goal_id = ?')
                    .get(planId, goalId) as Row | undefined;
                if (!planRow)
                    throw new Error(
                        `Plan ${planId} was not found for goal ${goalId}.`,
                    );
                if (planRow.status !== 'proposed') {
                    throw new Error(
                        `Plan ${planId} is not an unapproved proposal.`,
                    );
                }
                const latest = this.#database
                    .prepare(
                        'SELECT id FROM plans WHERE goal_id = ? ORDER BY revision DESC LIMIT 1',
                    )
                    .get(goalId) as Row;
                if (latest.id !== planId) {
                    throw new Error(
                        `Plan ${planId} is stale and cannot be approved.`,
                    );
                }
                const plan = PlanSchema.parse(parseJson(planRow.document_json));
                if (
                    (goal.activePlanId &&
                        plan.parentPlanId !== goal.activePlanId) ||
                    (!goal.activePlanId && plan.parentPlanId)
                ) {
                    throw new Error(
                        `Plan ${planId} does not revise the active plan.`,
                    );
                }
                const decision = decideGoalTransition(
                    goal.state,
                    'plan-ready',
                    {
                        hasApprovedPlan: goal.state === 'draft',
                        hasApprovedRevisedPlan:
                            goal.state === 'needs-replan' &&
                            Boolean(goal.activePlanId),
                    },
                );
                if (!decision.ok) throw new Error(decision.reason);

                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE plans SET status = 'superseded'
           WHERE goal_id = ? AND status = 'approved'`,
                    )
                    .run(goalId);
                const approved = this.#database
                    .prepare(
                        `UPDATE plans SET status = 'approved', approved_by = ?, approved_at = ?
           WHERE id = ? AND status = 'proposed'`,
                    )
                    .run(actor, now, planId);
                if (approved.changes !== 1) {
                    throw new Error(
                        `Plan ${planId} changed while it was being approved.`,
                    );
                }

                const workUnitByPlanUnit = new Map<string, string>();
                for (const unit of plan.units) {
                    const workUnitId = this.#id();
                    workUnitByPlanUnit.set(unit.id, workUnitId);
                    this.#database
                        .prepare(
                            `INSERT INTO work_units(
              id, goal_id, kind, input_json, state, active_attempt_id,
              next_attempt_number, created_at, updated_at, plan_id,
              plan_unit_id, dependency_json, requirements_json,
              acceptance_json, required, destructive
            ) VALUES (?, ?, 'agent', ?, 'queued', NULL, 1, ?, ?, ?, ?,
                      '[]', ?, ?, ?, ?)`,
                        )
                        .run(
                            workUnitId,
                            goalId,
                            canonicalJson({
                                title: unit.title,
                                instructions: unit.instructions,
                                acceptanceCriteria: unit.acceptanceCriteria,
                            }),
                            now,
                            now,
                            plan.id,
                            unit.id,
                            canonicalJson(unit.verificationRequirements),
                            canonicalJson(unit.acceptanceCriteria),
                            unit.required ? 1 : 0,
                            unit.destructive ? 1 : 0,
                        );
                }
                for (const unit of plan.units) {
                    const workUnitId = workUnitByPlanUnit.get(unit.id)!;
                    const dependencyIds = unit.dependencyIds.map(
                        dependencyId => {
                            const materializedId =
                                workUnitByPlanUnit.get(dependencyId);
                            if (!materializedId) {
                                throw new Error(
                                    `Unknown dependency ${dependencyId}.`,
                                );
                            }
                            this.#database
                                .prepare(
                                    `INSERT INTO work_dependencies(
                work_unit_id, depends_on_work_unit_id
              ) VALUES (?, ?)`,
                                )
                                .run(workUnitId, materializedId);
                            return materializedId;
                        },
                    );
                    this.#database
                        .prepare(
                            'UPDATE work_units SET dependency_json = ? WHERE id = ?',
                        )
                        .run(canonicalJson(dependencyIds), workUnitId);
                }

                return this.#writeGoal(
                    goal,
                    {
                        state: decision.state,
                        activePlanId: plan.id,
                        activePlanRevision: plan.revision,
                    },
                    'plan.approved',
                    {
                        planId: plan.id,
                        revision: plan.revision,
                        approvedBy: actor,
                        materializedWorkUnitIds: [
                            ...workUnitByPlanUnit.values(),
                        ],
                    },
                    now,
                );
            })
            .immediate();
    }

    listWorkUnits(goalId: string, activePlanOnly = false): readonly WorkUnit[] {
        const goal = this.#requireGoal(goalId);
        const rows = activePlanOnly
            ? (this.#database
                  .prepare(
                      `SELECT * FROM work_units
             WHERE goal_id = ? AND plan_id = ? ORDER BY created_at, id`,
                  )
                  .all(goalId, goal.activePlanId ?? '') as Row[])
            : (this.#database
                  .prepare(
                      'SELECT * FROM work_units WHERE goal_id = ? ORDER BY created_at, id',
                  )
                  .all(goalId) as Row[]);
        return rows.map(toWorkUnit);
    }

    getWorkUnit(workUnitId: string): WorkUnit | undefined {
        const row = this.#database
            .prepare('SELECT * FROM work_units WHERE id = ?')
            .get(workUnitId) as Row | undefined;
        return row ? toWorkUnit(row) : undefined;
    }

    issueApproval(
        goalId: string,
        scope: ApprovalScope,
        actor: string,
        reason: string,
        ttlMs: number,
    ): IssuedApproval {
        const parsedScope = ApprovalScopeSchema.parse(scope);
        DomainIdSchema.parse(actor);
        if (
            !Number.isInteger(ttlMs) ||
            ttlMs <= 0 ||
            ttlMs > MAX_APPROVAL_TTL_MS
        ) {
            throw new Error(
                `Approval TTL must be a positive integer at most ${MAX_APPROVAL_TTL_MS}.`,
            );
        }
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                if (parsedScope.type === 'plan') {
                    const plan = this.getPlan(parsedScope.planId);
                    if (
                        !plan ||
                        plan.goalId !== goalId ||
                        plan.revision !== parsedScope.revision
                    ) {
                        throw new Error(
                            'Approval scope refers to the wrong plan revision.',
                        );
                    }
                } else if (parsedScope.type === 'work-unit') {
                    const unit = this.#database
                        .prepare('SELECT goal_id FROM work_units WHERE id = ?')
                        .get(parsedScope.workUnitId) as Row | undefined;
                    if (!unit || unit.goal_id !== goalId) {
                        throw new Error(
                            'Approval scope refers to the wrong work unit.',
                        );
                    }
                }
                const token = this.#token();
                const createdAt = this.#now();
                const expiresAt = new Date(
                    Date.parse(createdAt) + ttlMs,
                ).toISOString();
                const approval = ApprovalSchema.parse({
                    schemaVersion: SCHEMA_VERSION,
                    id: this.#id(),
                    goalId,
                    scope: parsedScope,
                    decision: 'approved',
                    decidedBy: actor,
                    reason,
                    tokenHash: sha256(token),
                    createdAt,
                    expiresAt,
                });
                this.#database
                    .prepare(
                        `INSERT INTO approvals(
            id, goal_id, scope_json, decision, decided_by, reason,
            token_hash, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        approval.id,
                        approval.goalId,
                        canonicalJson(approval.scope),
                        approval.decision,
                        approval.decidedBy,
                        approval.reason,
                        approval.tokenHash,
                        approval.createdAt,
                        approval.expiresAt ?? null,
                    );
                this.#event(
                    goal.id,
                    'approval.issued',
                    {
                        approvalId: approval.id,
                        scope: approval.scope,
                        decidedBy: approval.decidedBy,
                        expiresAt: approval.expiresAt,
                    },
                    createdAt,
                );
                return { approval, token };
            })
            .immediate();
    }

    listApprovals(goalId: string): readonly Approval[] {
        this.#requireGoal(goalId);
        return (
            this.#database
                .prepare(
                    'SELECT * FROM approvals WHERE goal_id = ? ORDER BY created_at, id',
                )
                .all(goalId) as Row[]
        ).map(row =>
            ApprovalSchema.parse({
                schemaVersion: SCHEMA_VERSION,
                id: row.id,
                goalId: row.goal_id,
                scope: parseJson(row.scope_json),
                decision: row.decision,
                decidedBy: row.decided_by,
                reason: row.reason,
                tokenHash: row.token_hash,
                createdAt: row.created_at,
                expiresAt: optionalString(row.expires_at),
                consumedAt: optionalString(row.consumed_at),
            }),
        );
    }

    recordApprovalDecision(
        goalId: string,
        scope: ApprovalScope,
        decision: 'approved' | 'rejected',
        actor: string,
        reason: string,
    ): Approval {
        const parsedScope = ApprovalScopeSchema.parse(scope);
        DomainIdSchema.parse(actor);
        return this.#database
            .transaction(() => {
                this.#requireGoal(goalId);
                const createdAt = this.#now();
                const approval = ApprovalSchema.parse({
                    schemaVersion: SCHEMA_VERSION,
                    id: this.#id(),
                    goalId,
                    scope: parsedScope,
                    decision,
                    decidedBy: actor,
                    reason,
                    tokenHash: sha256(this.#token()),
                    createdAt,
                });
                this.#database
                    .prepare(
                        `INSERT INTO approvals(
              id, goal_id, scope_json, decision, decided_by, reason,
              token_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        approval.id,
                        approval.goalId,
                        canonicalJson(approval.scope),
                        approval.decision,
                        approval.decidedBy,
                        approval.reason,
                        approval.tokenHash,
                        approval.createdAt,
                    );
                this.#event(
                    goalId,
                    'approval.recorded',
                    {
                        approvalId: approval.id,
                        scope: approval.scope,
                        decision: approval.decision,
                        decidedBy: approval.decidedBy,
                    },
                    createdAt,
                );
                return approval;
            })
            .immediate();
    }

    #consumeApproval(
        goalId: string,
        scope: ApprovalScope,
        token: string,
    ): Approval {
        const tokenHash = sha256(token);
        const row = this.#database
            .prepare(
                `SELECT * FROM approvals
         WHERE goal_id = ? AND token_hash = ? AND decision = 'approved'`,
            )
            .get(goalId, tokenHash) as Row | undefined;
        if (!row) throw new Error('Approval token is invalid for this goal.');
        if (row.consumed_at)
            throw new Error('Approval token has already been used.');
        const now = this.#now();
        if (
            row.expires_at &&
            Date.parse(String(row.expires_at)) <= Date.parse(now)
        ) {
            throw new Error('Approval token has expired.');
        }
        const storedScope = ApprovalScopeSchema.parse(
            parseJson(row.scope_json),
        );
        if (canonicalJson(storedScope) !== canonicalJson(scope)) {
            throw new Error('Approval token has the wrong scope.');
        }
        const consumed = this.#database
            .prepare(
                `UPDATE approvals SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
            )
            .run(now, row.id);
        if (consumed.changes !== 1) {
            throw new Error('Approval token has already been used.');
        }
        const approval = ApprovalSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            id: row.id,
            goalId: row.goal_id,
            scope: storedScope,
            decision: row.decision,
            decidedBy: row.decided_by,
            reason: row.reason,
            tokenHash: row.token_hash,
            createdAt: row.created_at,
            expiresAt: optionalString(row.expires_at),
            consumedAt: now,
        });
        this.#event(
            goalId,
            'approval.consumed',
            { approvalId: approval.id, scope: approval.scope },
            now,
        );
        return approval;
    }

    startGoal(goalId: string, approvalToken: string): Goal {
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                this.#consumeApproval(
                    goalId,
                    { type: 'goal-action', action: 'unattended-start' },
                    approvalToken,
                );
                return this.#decideAndWrite(
                    goal,
                    'start',
                    {
                        hasApprovedPlan: Boolean(goal.activePlanId),
                        hasUnattendedStartApproval: true,
                    },
                    'goal.started',
                    {},
                );
            })
            .immediate();
    }

    resumeGoal(goalId: string, approvalToken: string): Goal {
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                const action =
                    goal.state === 'blocked' ? 'blocked-resume' : 'resume';
                this.#consumeApproval(
                    goalId,
                    { type: 'goal-action', action },
                    approvalToken,
                );
                const next = this.#decideAndWrite(
                    goal,
                    'resume',
                    {
                        hasResumeApproval: action === 'resume',
                        hasBlockedResumeApproval: action === 'blocked-resume',
                        hasDecisionApproval: action === 'resume',
                        resumeTarget: 'executing',
                    },
                    'goal.resumed',
                    {},
                );
                this.#database
                    .prepare(
                        `UPDATE work_units SET state = 'queued', updated_at = ?
           WHERE goal_id = ? AND plan_id = ? AND state = 'failed'`,
                    )
                    .run(this.#now(), goalId, next.activePlanId ?? '');
                return next;
            })
            .immediate();
    }

    recoverUnknownOutcome(
        goalId: string,
        approvalToken: string,
        targetState: RecoveryGoalState,
        decision: string,
    ): Goal {
        if (!decision.trim())
            throw new Error('Recovery requires an explicit decision.');
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                this.#consumeApproval(
                    goalId,
                    { type: 'goal-action', action: 'recover-unknown-outcome' },
                    approvalToken,
                );
                const next = this.#decideAndWrite(
                    goal,
                    'recover',
                    {
                        hasExplicitDecision: true,
                        recoveryTarget: targetState,
                    },
                    'goal.recovered',
                    { targetState, decision: decision.trim().slice(0, 500) },
                );
                const state =
                    targetState === 'ready' || targetState === 'executing'
                        ? 'queued'
                        : targetState === 'cancelled'
                          ? 'cancelled'
                          : 'failed';
                this.#database
                    .prepare(
                        `UPDATE work_units SET state = ?, active_attempt_id = NULL,
             updated_at = ?
           WHERE goal_id = ? AND state = 'unknown-outcome'`,
                    )
                    .run(state, this.#now(), goalId);
                return next;
            })
            .immediate();
    }

    pauseGoal(goalId: string, reason: string): Goal {
        if (!reason.trim()) throw new Error('Pause reason must be nonempty.');
        return this.#fenceGoal(goalId, 'pause', reason, false);
    }

    cancelGoal(goalId: string, reason: string): Goal {
        if (!reason.trim())
            throw new Error('Cancellation reason must be nonempty.');
        return this.#fenceGoal(goalId, 'cancel', reason, true);
    }

    #fenceGoal(
        goalId: string,
        action: 'pause' | 'cancel',
        reason: string,
        cancelUnits: boolean,
    ): Goal {
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                const now = this.#now();
                const next = this.#decideAndWrite(
                    goal,
                    action,
                    {},
                    action === 'pause' ? 'goal.paused' : 'goal.cancelled',
                    { reason: reason.trim().slice(0, 500) },
                );
                const attempts = this.#database
                    .prepare(
                        `SELECT a.*, wu.goal_id, o.id AS outbox_id,
                  o.external_ref, o.dispatch_started_at
           FROM work_attempts a
           JOIN work_units wu ON wu.id = a.work_unit_id
           LEFT JOIN outbox o ON o.attempt_id = a.id
           WHERE wu.goal_id = ? AND wu.active_attempt_id = a.id
             AND a.state IN ('leased', 'dispatched', 'running', 'verifying')`,
                    )
                    .all(goalId) as Row[];
                for (const attempt of attempts) {
                    if (
                        attempt.dispatch_started_at ||
                        attempt.external_ref ||
                        attempt.state !== 'leased'
                    ) {
                        this.#database
                            .prepare(
                                `INSERT OR IGNORE INTO cancellation_requests(
                id, goal_id, work_unit_id, attempt_id, external_ref, reason,
                state, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
                            )
                            .run(
                                this.#id(),
                                goalId,
                                attempt.work_unit_id,
                                attempt.id,
                                attempt.external_ref ?? null,
                                reason.trim().slice(0, 500),
                                now,
                            );
                    }
                    if (attempt.outbox_id) {
                        const outbox = this.#database
                            .prepare('SELECT * FROM outbox WHERE id = ?')
                            .get(attempt.outbox_id) as Row;
                        const changed = this.#database
                            .prepare(
                                `UPDATE outbox SET state = 'cancelled', lease_token = NULL,
                 lease_expires_at = NULL
               WHERE id = ? AND state IN ('pending', 'leased')`,
                            )
                            .run(attempt.outbox_id);
                        if (changed.changes === 1) {
                            this.#recordDelivery(outbox, 'release', now, {
                                error:
                                    action === 'pause'
                                        ? 'goal paused'
                                        : 'goal cancelled',
                            });
                        }
                    }
                    this.#database
                        .prepare(
                            `UPDATE work_attempts SET state = 'cancelled', completed_at = ?
             WHERE id = ? AND state IN ('leased', 'dispatched', 'running', 'verifying')`,
                        )
                        .run(now, attempt.id);
                    this.#database
                        .prepare(
                            `UPDATE work_units SET state = ?, active_attempt_id = NULL,
               updated_at = ?
             WHERE id = ? AND active_attempt_id = ?`,
                        )
                        .run(
                            cancelUnits ? 'cancelled' : 'queued',
                            now,
                            attempt.work_unit_id,
                            attempt.id,
                        );
                }
                if (cancelUnits) {
                    this.#database
                        .prepare(
                            `UPDATE work_units SET state = 'cancelled', active_attempt_id = NULL,
               updated_at = ?
             WHERE goal_id = ? AND state IN ('queued', 'running', 'verifying', 'failed')`,
                        )
                        .run(now, goalId);
                }
                this.#event(
                    goalId,
                    'dispatch.fenced',
                    {
                        action,
                        affectedAttemptIds: attempts.map(attempt =>
                            String(attempt.id),
                        ),
                    },
                    now,
                );
                return next;
            })
            .immediate();
    }

    getBudget(goalId: string): {
        readonly budget: GoalBudget;
        readonly usage: GoalBudgetUsage;
    } {
        this.#requireGoal(goalId);
        const row = this.#database
            .prepare(
                `SELECT b.*, u.attempts, u.wall_clock_ms, u.verification_ms, u.tokens
         FROM goal_budgets b
         JOIN goal_budget_usage u ON u.goal_id = b.goal_id
         WHERE b.goal_id = ?`,
            )
            .get(goalId) as Row | undefined;
        if (!row) throw new Error(`Budget for goal ${goalId} was not found.`);
        return {
            budget: {
                maxAttempts: Number(row.max_attempts),
                maxWallClockMs: Number(row.max_wall_clock_ms),
                maxVerificationMs: Number(row.max_verification_ms),
                maxTokens: Number(row.max_tokens),
            },
            usage: {
                attempts: Number(row.attempts),
                wallClockMs: Number(row.wall_clock_ms),
                verificationMs: Number(row.verification_ms),
                tokens: Number(row.tokens),
            },
        };
    }

    setBudget(
        goalId: string,
        budget: GoalBudget,
        approvalToken: string,
    ): GoalBudget {
        const parsed = GoalBudgetSchema.parse(budget);
        return this.#database
            .transaction(() => {
                this.#requireGoal(goalId);
                const current = this.getBudget(goalId).budget;
                if (
                    parsed.maxAttempts < current.maxAttempts ||
                    parsed.maxWallClockMs < current.maxWallClockMs ||
                    parsed.maxVerificationMs < current.maxVerificationMs ||
                    parsed.maxTokens < current.maxTokens
                ) {
                    throw new Error(
                        'Budget limits may not reduce an existing limit.',
                    );
                }
                this.#consumeApproval(
                    goalId,
                    { type: 'goal-action', action: 'raise-budget' },
                    approvalToken,
                );
                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE goal_budgets SET
            max_attempts = ?, max_wall_clock_ms = ?,
            max_verification_ms = ?, max_tokens = ?, updated_at = ?
           WHERE goal_id = ?`,
                    )
                    .run(
                        parsed.maxAttempts,
                        parsed.maxWallClockMs,
                        parsed.maxVerificationMs,
                        parsed.maxTokens,
                        now,
                        goalId,
                    );
                this.#event(goalId, 'budget.set', { budget: parsed }, now);
                return parsed;
            })
            .immediate();
    }

    raiseBudget(
        goalId: string,
        budget: GoalBudget,
        approvalToken: string,
    ): GoalBudget {
        return this.setBudget(goalId, budget, approvalToken);
    }

    recordBudgetUsage(
        goalId: string,
        delta: Partial<GoalBudgetUsage>,
    ): GoalBudgetUsage {
        const values = {
            attempts: delta.attempts ?? 0,
            wallClockMs: delta.wallClockMs ?? 0,
            verificationMs: delta.verificationMs ?? 0,
            tokens: delta.tokens ?? 0,
        };
        for (const [name, value] of Object.entries(values)) {
            if (!Number.isInteger(value) || value < 0) {
                throw new Error(`${name} usage must be a nonnegative integer.`);
            }
        }
        return this.#database
            .transaction(() => {
                this.#requireGoal(goalId);
                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE goal_budget_usage SET
            attempts = attempts + ?, wall_clock_ms = wall_clock_ms + ?,
            verification_ms = verification_ms + ?, tokens = tokens + ?,
            updated_at = ? WHERE goal_id = ?`,
                    )
                    .run(
                        values.attempts,
                        values.wallClockMs,
                        values.verificationMs,
                        values.tokens,
                        now,
                        goalId,
                    );
                const usage = this.getBudget(goalId).usage;
                this.#event(
                    goalId,
                    'budget.usage-recorded',
                    { delta: values, usage },
                    now,
                );
                return usage;
            })
            .immediate();
    }

    approveDestructiveUnit(
        goalId: string,
        workUnitId: string,
        approvalToken: string,
    ): WorkUnit {
        return this.#database
            .transaction(() => {
                this.#requireGoal(goalId);
                const row = this.#database
                    .prepare(
                        'SELECT * FROM work_units WHERE id = ? AND goal_id = ?',
                    )
                    .get(workUnitId, goalId) as Row | undefined;
                if (!row)
                    throw new Error(`Work unit ${workUnitId} was not found.`);
                if (!row.destructive) {
                    throw new Error(
                        `Work unit ${workUnitId} is not destructive.`,
                    );
                }
                if (row.approved_at) {
                    throw new Error(
                        `Work unit ${workUnitId} is already approved.`,
                    );
                }
                const approval = this.#consumeApproval(
                    goalId,
                    { type: 'work-unit', workUnitId },
                    approvalToken,
                );
                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE work_units SET approval_id = ?, approved_at = ?, updated_at = ?
           WHERE id = ? AND approved_at IS NULL`,
                    )
                    .run(approval.id, now, now, workUnitId);
                this.#event(
                    goalId,
                    'work.destructive-approved',
                    { workUnitId, approvalId: approval.id },
                    now,
                );
                return toWorkUnit(
                    this.#database
                        .prepare('SELECT * FROM work_units WHERE id = ?')
                        .get(workUnitId) as Row,
                );
            })
            .immediate();
    }

    listCancellationRequests(goalId?: string): readonly CancellationRequest[] {
        const rows = goalId
            ? (this.#database
                  .prepare(
                      'SELECT * FROM cancellation_requests WHERE goal_id = ? ORDER BY created_at, id',
                  )
                  .all(goalId) as Row[])
            : (this.#database
                  .prepare(
                      'SELECT * FROM cancellation_requests ORDER BY created_at, id',
                  )
                  .all() as Row[]);
        return rows.map(row => ({
            id: String(row.id),
            goalId: String(row.goal_id),
            workUnitId: String(row.work_unit_id),
            attemptId: String(row.attempt_id),
            externalRef: optionalString(row.external_ref),
            reason: String(row.reason),
            state: row.state as CancellationRequest['state'],
            createdAt: String(row.created_at),
            acknowledgedAt: optionalString(row.acknowledged_at),
            lastError: optionalString(row.last_error),
            observedAt: optionalString(row.observed_at),
        }));
    }

    getDispatchCommand(attemptId: string): OutboxCommand | undefined {
        const row = this.#database
            .prepare(
                `SELECT id, attempt_id, idempotency_key, payload_json
                 FROM outbox WHERE attempt_id = ?
                 ORDER BY created_at DESC LIMIT 1`,
            )
            .get(attemptId) as Row | undefined;
        if (!row) return undefined;
        const command = OutboxCommandSchema.parse(
            parseJson<Record<string, unknown>>(row.payload_json),
        );
        if (
            command.id !== row.id ||
            command.attemptId !== row.attempt_id ||
            command.idempotencyKey !== row.idempotency_key
        ) {
            throw new Error(
                `Dispatch command for attempt ${attemptId} has an invalid durable envelope.`,
            );
        }
        return command;
    }

    persistCancellationExternalReference(
        requestId: string,
        externalRef: string,
    ): CancellationRequest {
        const parsedExternalRef = CompactReferenceSchema.parse(externalRef);
        return this.#database
            .transaction(() => {
                const row = this.#database
                    .prepare(
                        `SELECT cr.*, wu.goal_id AS unit_goal_id
                         FROM cancellation_requests cr
                         JOIN work_units wu ON wu.id = cr.work_unit_id
                         WHERE cr.id = ? AND cr.state = 'pending'`,
                    )
                    .get(requestId) as Row | undefined;
                if (!row) {
                    throw new Error(
                        `Cancellation request ${requestId} is not pending.`,
                    );
                }
                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE cancellation_requests SET external_ref = ?
                         WHERE id = ? AND state = 'pending'`,
                    )
                    .run(parsedExternalRef, requestId);
                this.#database
                    .prepare(
                        `UPDATE outbox SET external_ref = ?
                         WHERE attempt_id = ?`,
                    )
                    .run(parsedExternalRef, row.attempt_id);
                this.#database
                    .prepare(
                        `INSERT OR IGNORE INTO session_external_refs(
                           id, goal_id, work_unit_id, attempt_id, kind,
                           external_ref, created_at
                         ) VALUES (?, ?, ?, ?, 'cancellation', ?, ?)`,
                    )
                    .run(
                        this.#id(),
                        row.goal_id,
                        row.work_unit_id,
                        row.attempt_id,
                        parsedExternalRef,
                        now,
                    );
                this.#event(
                    String(row.goal_id),
                    'cancellation.reference-recorded',
                    {
                        requestId,
                        attemptId: String(row.attempt_id),
                        externalRef: parsedExternalRef,
                    },
                    now,
                );
                return this.listCancellationRequests(String(row.goal_id)).find(
                    request => request.id === requestId,
                )!;
            })
            .immediate();
    }

    recordLateDispatchReference(attemptId: string, externalRef: string): void {
        const parsedExternalRef = CompactReferenceSchema.parse(externalRef);
        this.#database
            .transaction(() => {
                const row = this.#database
                    .prepare(
                        `SELECT o.*, a.work_unit_id, wu.goal_id
                         FROM outbox o
                         JOIN work_attempts a ON a.id = o.attempt_id
                         JOIN work_units wu ON wu.id = a.work_unit_id
                         WHERE o.attempt_id = ?
                           AND o.dispatch_started_at IS NOT NULL
                         ORDER BY o.created_at DESC LIMIT 1`,
                    )
                    .get(attemptId) as Row | undefined;
                if (!row) {
                    throw new Error(
                        `Attempt ${attemptId} did not cross the durable dispatch boundary.`,
                    );
                }
                const now = this.#now();
                this.#database
                    .prepare('UPDATE outbox SET external_ref = ? WHERE id = ?')
                    .run(parsedExternalRef, row.id);
                this.#database
                    .prepare(
                        `INSERT OR IGNORE INTO session_external_refs(
                           id, goal_id, work_unit_id, attempt_id, kind,
                           external_ref, created_at
                         ) VALUES (?, ?, ?, ?, 'late-dispatch', ?, ?)`,
                    )
                    .run(
                        this.#id(),
                        row.goal_id,
                        row.work_unit_id,
                        attemptId,
                        parsedExternalRef,
                        now,
                    );
                const pending = this.#database
                    .prepare(
                        `UPDATE cancellation_requests SET external_ref = ?
                         WHERE attempt_id = ? AND state = 'pending'`,
                    )
                    .run(parsedExternalRef, attemptId);
                if (pending.changes === 0) {
                    const previous = this.#database
                        .prepare(
                            `SELECT id FROM cancellation_requests
                             WHERE attempt_id = ?
                             ORDER BY created_at DESC, id DESC LIMIT 1`,
                        )
                        .get(attemptId) as Row | undefined;
                    if (previous) {
                        this.#database
                            .prepare(
                                `UPDATE cancellation_requests
                                 SET state = 'pending', external_ref = ?,
                                     acknowledged_at = NULL, last_error = NULL,
                                     observed_at = NULL
                                 WHERE id = ?`,
                            )
                            .run(parsedExternalRef, previous.id);
                    }
                }
                this.#event(
                    String(row.goal_id),
                    'dispatch.reference-recorded-late',
                    { attemptId, externalRef: parsedExternalRef },
                    now,
                );
            })
            .immediate();
    }

    recordCancellationPending(requestId: string, error: unknown): void {
        this.#database
            .transaction(() => {
                const row = this.#database
                    .prepare(
                        `SELECT * FROM cancellation_requests
                         WHERE id = ? AND state = 'pending'`,
                    )
                    .get(requestId) as Row | undefined;
                if (!row) {
                    throw new Error(
                        `Cancellation request ${requestId} is not pending.`,
                    );
                }
                const now = this.#now();
                const message =
                    redactError(error) || 'Cancellation remains inconclusive.';
                this.#database
                    .prepare(
                        `UPDATE cancellation_requests
                         SET last_error = ?, observed_at = ?
                         WHERE id = ? AND state = 'pending'`,
                    )
                    .run(message, now, requestId);
                this.#event(
                    String(row.goal_id),
                    'cancellation.pending',
                    {
                        requestId,
                        attemptId: String(row.attempt_id),
                        error: message,
                    },
                    now,
                );
            })
            .immediate();
    }

    acknowledgeCancellationRequest(
        requestId: string,
        succeeded = true,
    ): CancellationRequest {
        return this.#database
            .transaction(() => {
                const row = this.#database
                    .prepare('SELECT * FROM cancellation_requests WHERE id = ?')
                    .get(requestId) as Row | undefined;
                if (!row)
                    throw new Error(
                        `Cancellation request ${requestId} was not found.`,
                    );
                if (row.state !== 'pending') {
                    throw new Error(
                        `Cancellation request ${requestId} is already settled.`,
                    );
                }
                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE cancellation_requests SET state = ?, acknowledged_at = ?
           WHERE id = ? AND state = 'pending'`,
                    )
                    .run(succeeded ? 'acknowledged' : 'failed', now, requestId);
                this.#event(
                    String(row.goal_id),
                    'cancellation.acknowledged',
                    { requestId, succeeded },
                    now,
                );
                return this.listCancellationRequests(String(row.goal_id)).find(
                    request => request.id === requestId,
                )!;
            })
            .immediate();
    }

    ackCancellationRequest(
        requestId: string,
        succeeded = true,
    ): CancellationRequest {
        return this.acknowledgeCancellationRequest(requestId, succeeded);
    }

    recordSessionReference(
        attemptId: string,
        kind: string,
        externalRef: string,
    ): SessionReference {
        if (!kind.trim() || kind.length > 128) {
            throw new Error(
                'Session reference kind must be nonempty and compact.',
            );
        }
        const parsedExternalRef = CompactReferenceSchema.parse(externalRef);
        return this.#database
            .transaction(() => {
                const row = this.#database
                    .prepare(
                        `SELECT a.work_unit_id, wu.goal_id
           FROM work_attempts a JOIN work_units wu ON wu.id = a.work_unit_id
           WHERE a.id = ?`,
                    )
                    .get(attemptId) as Row | undefined;
                if (!row)
                    throw new Error(`Attempt ${attemptId} was not found.`);
                const id = this.#id();
                const now = this.#now();
                this.#database
                    .prepare(
                        `INSERT INTO session_external_refs(
            id, goal_id, work_unit_id, attempt_id, kind, external_ref,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        id,
                        row.goal_id,
                        row.work_unit_id,
                        attemptId,
                        kind.trim(),
                        parsedExternalRef,
                        now,
                    );
                this.#event(
                    String(row.goal_id),
                    'session.reference-recorded',
                    {
                        attemptId,
                        kind: kind.trim(),
                        externalRef: parsedExternalRef,
                    },
                    now,
                );
                return {
                    id,
                    goalId: String(row.goal_id),
                    workUnitId: String(row.work_unit_id),
                    attemptId,
                    kind: kind.trim(),
                    externalRef: parsedExternalRef,
                    createdAt: now,
                };
            })
            .immediate();
    }

    listSessionReferences(goalId?: string): readonly SessionReference[] {
        const rows = goalId
            ? (this.#database
                  .prepare(
                      'SELECT * FROM session_external_refs WHERE goal_id = ? ORDER BY created_at, id',
                  )
                  .all(goalId) as Row[])
            : (this.#database
                  .prepare(
                      'SELECT * FROM session_external_refs ORDER BY created_at, id',
                  )
                  .all() as Row[]);
        return rows.map(row => ({
            id: String(row.id),
            goalId: String(row.goal_id),
            workUnitId: String(row.work_unit_id),
            attemptId: String(row.attempt_id),
            kind: String(row.kind),
            externalRef: String(row.external_ref),
            createdAt: String(row.created_at),
        }));
    }

    recordSessionRef(
        attemptId: string,
        kind: string,
        externalRef: string,
    ): SessionReference {
        return this.recordSessionReference(attemptId, kind, externalRef);
    }

    listSessionRefs(goalId?: string): readonly SessionReference[] {
        return this.listSessionReferences(goalId);
    }

    claimNextWork(
        owner: string,
        leaseDurationMs: number,
        workspace?: string,
    ): WorkAttempt | undefined;
    claimNextWork(
        workspace: string,
        owner: string,
        leaseDurationMs: number,
    ): WorkAttempt | undefined;
    claimNextWork(
        first: string,
        second: string | number,
        third?: string | number,
    ): WorkAttempt | undefined {
        const workspace =
            typeof second === 'string' ? first : (third as string | undefined);
        const owner = typeof second === 'string' ? second : first;
        const leaseDurationMs =
            typeof second === 'string' ? Number(third) : second;
        DomainIdSchema.parse(owner);
        requirePositiveDuration(leaseDurationMs, 'Work lease duration');
        return this.#database
            .transaction(() => {
                const now = this.#now();
                const exhausted = this.#database
                    .prepare(
                        `SELECT g.* FROM goals g
           JOIN goal_budgets b ON b.goal_id = g.id
           JOIN goal_budget_usage u ON u.goal_id = g.id
           WHERE g.state = 'executing'
             AND (? IS NULL OR g.workspace = ?)
             AND (u.attempts >= b.max_attempts
               OR u.wall_clock_ms >= b.max_wall_clock_ms
               OR u.verification_ms >= b.max_verification_ms
               OR u.tokens >= b.max_tokens)`,
                    )
                    .all(workspace ?? null, workspace ?? null) as Row[];
                for (const row of exhausted) {
                    this.#decideAndWrite(
                        toGoal(row),
                        'block',
                        {},
                        'goal.budget-exhausted',
                        {},
                    );
                }

                const row = this.#database
                    .prepare(
                        `SELECT wu.* FROM work_units wu
           JOIN goals g ON g.id = wu.goal_id
           JOIN goal_budgets b ON b.goal_id = g.id
           JOIN goal_budget_usage u ON u.goal_id = g.id
           WHERE wu.state = 'queued'
             AND g.state = 'executing'
             AND wu.plan_id = g.active_plan_id
             AND (? IS NULL OR g.workspace = ?)
             AND (wu.destructive = 0 OR wu.approved_at IS NOT NULL)
             AND u.attempts < b.max_attempts
             AND u.wall_clock_ms < b.max_wall_clock_ms
             AND u.verification_ms < b.max_verification_ms
             AND u.tokens < b.max_tokens
             AND NOT EXISTS (
               SELECT 1 FROM work_dependencies d
               JOIN work_units prerequisite
                 ON prerequisite.id = d.depends_on_work_unit_id
               WHERE d.work_unit_id = wu.id
                 AND prerequisite.state <> 'accepted'
             )
           ORDER BY wu.created_at, wu.id LIMIT 1`,
                    )
                    .get(workspace ?? null, workspace ?? null) as
                    | Row
                    | undefined;
                if (!row) return undefined;

                const attemptId = this.#id();
                const leaseToken = this.#id();
                const expiresAt = new Date(
                    Date.parse(now) + leaseDurationMs,
                ).toISOString();
                const updated = this.#database
                    .prepare(
                        `UPDATE work_units SET state = 'running', active_attempt_id = ?,
             next_attempt_number = next_attempt_number + 1, updated_at = ?
           WHERE id = ? AND state = 'queued' AND active_attempt_id IS NULL`,
                    )
                    .run(attemptId, now, row.id);
                if (updated.changes !== 1) return undefined;
                this.#database
                    .prepare(
                        `INSERT INTO work_attempts(
            id, work_unit_id, number, lease_token, lease_owner,
            lease_expires_at, state, created_at, lease_acquired_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'leased', ?, ?)`,
                    )
                    .run(
                        attemptId,
                        row.id,
                        row.next_attempt_number,
                        leaseToken,
                        owner,
                        expiresAt,
                        now,
                        now,
                    );
                const outboxId = this.#id();
                const idempotencyKey = `attempt:${attemptId}`;
                const payload = {
                    schemaVersion: SCHEMA_VERSION,
                    id: outboxId,
                    type: 'dispatch-attempt',
                    goalId: String(row.goal_id),
                    workUnitId: String(row.id),
                    attemptId,
                    leaseToken,
                    idempotencyKey,
                    payload: {
                        kind: String(row.kind),
                        input: parseJson<Record<string, unknown>>(
                            row.input_json,
                        ),
                    },
                    createdAt: now,
                };
                this.#database
                    .prepare(
                        `INSERT INTO outbox(
            id, attempt_id, idempotency_key, payload_json, state,
            created_at, retry_count, next_attempt_at, needs_probe
          ) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, 0)`,
                    )
                    .run(
                        outboxId,
                        attemptId,
                        idempotencyKey,
                        canonicalJson(payload),
                        now,
                        now,
                    );
                this.#database
                    .prepare(
                        `UPDATE goal_budget_usage SET attempts = attempts + 1,
             updated_at = ? WHERE goal_id = ?`,
                    )
                    .run(now, row.goal_id);
                this.#event(
                    String(row.goal_id),
                    'work.claimed',
                    {
                        workUnitId: String(row.id),
                        attemptId,
                        attemptNumber: Number(row.next_attempt_number),
                        leaseOwner: owner,
                        leaseExpiresAt: expiresAt,
                        outboxId,
                        idempotencyKey,
                    },
                    now,
                );
                return toAttempt(
                    this.#database
                        .prepare('SELECT * FROM work_attempts WHERE id = ?')
                        .get(attemptId) as Row,
                );
            })
            .immediate();
    }

    getAttempt(attemptId: string): WorkAttempt | undefined {
        const row = this.#database
            .prepare('SELECT * FROM work_attempts WHERE id = ?')
            .get(attemptId) as Row | undefined;
        return row ? toAttempt(row) : undefined;
    }

    listActiveAttempts(goalId?: string): readonly WorkAttempt[] {
        const rows = this.#database
            .prepare(
                `SELECT a.* FROM work_attempts a
         JOIN work_units wu ON wu.id = a.work_unit_id
         WHERE (? IS NULL OR wu.goal_id = ?)
           AND wu.active_attempt_id = a.id
           AND a.state IN ('leased', 'dispatched', 'running', 'verifying')
         ORDER BY a.created_at, a.id`,
            )
            .all(goalId ?? null, goalId ?? null) as Row[];
        return rows.map(toAttempt);
    }

    renewAttempt(
        attemptId: string,
        leaseToken: string,
        owner: string,
        leaseDurationMs: number,
    ): WorkAttempt {
        DomainIdSchema.parse(owner);
        requirePositiveDuration(leaseDurationMs, 'Work lease duration');
        return this.#database
            .transaction(() => {
                const row = this.#database
                    .prepare(
                        `SELECT a.*, wu.goal_id FROM work_attempts a
           JOIN work_units wu ON wu.id = a.work_unit_id
           JOIN goals g ON g.id = wu.goal_id
           WHERE a.id = ? AND a.lease_token = ? AND a.lease_owner = ?
             AND a.lease_expires_at > ?
             AND a.state IN ('leased', 'dispatched', 'running', 'verifying')
             AND wu.active_attempt_id = a.id AND g.state = 'executing'`,
                    )
                    .get(attemptId, leaseToken, owner, this.#now()) as
                    | Row
                    | undefined;
                if (!row)
                    throw new Error(
                        `Attempt ${attemptId} cannot be renewed by this lease.`,
                    );
                const now = this.#now();
                const expiresAt = new Date(
                    Date.parse(now) + leaseDurationMs,
                ).toISOString();
                const changed = this.#database
                    .prepare(
                        `UPDATE work_attempts SET lease_expires_at = ?
           WHERE id = ? AND lease_token = ? AND lease_owner = ?
             AND lease_expires_at > ?`,
                    )
                    .run(expiresAt, attemptId, leaseToken, owner, now);
                if (changed.changes !== 1) {
                    throw new Error(
                        `Attempt ${attemptId} cannot be renewed by this lease.`,
                    );
                }
                this.#event(
                    String(row.goal_id),
                    'attempt.renewed',
                    { attemptId, leaseOwner: owner, leaseExpiresAt: expiresAt },
                    now,
                );
                return toAttempt(
                    this.#database
                        .prepare('SELECT * FROM work_attempts WHERE id = ?')
                        .get(attemptId) as Row,
                );
            })
            .immediate();
    }

    recoverExpiredAttempts(): number {
        return this.#database
            .transaction(() => {
                const now = this.#now();
                const rows = this.#database
                    .prepare(
                        `SELECT a.*, wu.goal_id, wu.active_attempt_id, g.state AS goal_state,
                  b.max_attempts, b.max_wall_clock_ms,
                  b.max_verification_ms, b.max_tokens,
                  u.attempts, u.wall_clock_ms, u.verification_ms, u.tokens
           FROM work_attempts a
           JOIN work_units wu ON wu.id = a.work_unit_id
           JOIN goals g ON g.id = wu.goal_id
           JOIN goal_budgets b ON b.goal_id = g.id
           JOIN goal_budget_usage u ON u.goal_id = g.id
           WHERE a.lease_expires_at <= ?
             AND a.state IN ('leased', 'dispatched', 'running', 'verifying')`,
                    )
                    .all(now) as Row[];
                for (const row of rows) {
                    const externalDispatch = this.#database
                        .prepare(
                            `SELECT * FROM outbox WHERE attempt_id = ?
               AND (dispatch_started_at IS NOT NULL OR delivered_at IS NOT NULL
                    OR external_ref IS NOT NULL)
               ORDER BY created_at DESC LIMIT 1`,
                        )
                        .get(row.id) as Row | undefined;
                    if (externalDispatch) {
                        this.#database
                            .prepare(
                                `UPDATE work_attempts
                   SET state = 'unknown-outcome', completed_at = ?
                 WHERE id = ?
                   AND state IN ('leased', 'dispatched', 'running', 'verifying')`,
                            )
                            .run(now, row.id);
                        this.#database
                            .prepare(
                                `UPDATE work_units
                   SET state = 'unknown-outcome', active_attempt_id = NULL,
                       updated_at = ?
                 WHERE id = ? AND active_attempt_id = ?`,
                            )
                            .run(now, row.work_unit_id, row.id);
                        this.#retireAttemptOutbox(
                            String(row.id),
                            now,
                            'attempt expired after external dispatch',
                        );
                        const goal = this.#requireGoal(String(row.goal_id));
                        if (goal.state === 'executing') {
                            this.#decideAndWrite(
                                goal,
                                'unknown-outcome',
                                {},
                                'goal.unknown-outcome',
                                {
                                    attemptId: String(row.id),
                                    externalRef: optionalString(
                                        externalDispatch.external_ref,
                                    ),
                                    reason: 'attempt lease expired after an external dispatch boundary',
                                },
                            );
                        }
                        this.#event(
                            String(row.goal_id),
                            'attempt.expired-ambiguous',
                            {
                                attemptId: String(row.id),
                                workUnitId: String(row.work_unit_id),
                                externalRef: optionalString(
                                    externalDispatch.external_ref,
                                ),
                            },
                            now,
                        );
                        continue;
                    }
                    this.#database
                        .prepare(
                            `UPDATE work_attempts SET state = 'expired', completed_at = ?
             WHERE id = ? AND state IN ('leased', 'dispatched', 'running', 'verifying')`,
                        )
                        .run(now, row.id);
                    const outboxes = this.#database
                        .prepare(
                            `SELECT * FROM outbox WHERE attempt_id = ?
             AND state IN ('pending', 'leased')`,
                        )
                        .all(row.id) as Row[];
                    for (const outbox of outboxes) {
                        this.#database
                            .prepare(
                                `UPDATE outbox SET state = 'retired', lease_token = NULL,
                 lease_expires_at = NULL WHERE id = ?`,
                            )
                            .run(outbox.id);
                        this.#recordDelivery(outbox, 'release', now, {
                            error: 'attempt lease expired',
                        });
                    }
                    const viable =
                        row.goal_state === 'executing' &&
                        Number(row.attempts) < Number(row.max_attempts) &&
                        Number(row.wall_clock_ms) <
                            Number(row.max_wall_clock_ms) &&
                        Number(row.verification_ms) <
                            Number(row.max_verification_ms) &&
                        Number(row.tokens) < Number(row.max_tokens);
                    if (row.active_attempt_id === row.id) {
                        this.#database
                            .prepare(
                                `UPDATE work_units SET state = ?, active_attempt_id = NULL,
                 updated_at = ? WHERE id = ? AND active_attempt_id = ?`,
                            )
                            .run(
                                viable ? 'queued' : 'failed',
                                now,
                                row.work_unit_id,
                                row.id,
                            );
                    }
                    if (row.goal_state === 'executing' && !viable) {
                        this.#decideAndWrite(
                            this.#requireGoal(String(row.goal_id)),
                            'block',
                            {},
                            'goal.budget-exhausted',
                            { attemptId: String(row.id) },
                        );
                    }
                    this.#event(
                        String(row.goal_id),
                        'attempt.expired',
                        {
                            attemptId: String(row.id),
                            workUnitId: String(row.work_unit_id),
                            requeued: viable,
                        },
                        now,
                    );
                }
                return rows.length;
            })
            .immediate();
    }

    recoverExpiredOutboxLeases(): number {
        return this.#database
            .transaction(() => {
                const now = this.#now();
                const rows = this.#database
                    .prepare(
                        `SELECT o.*, wu.goal_id, wu.active_attempt_id,
                                a.state AS attempt_state,
                                a.lease_expires_at AS attempt_expires_at,
                                g.state AS goal_state
           FROM outbox o
           JOIN work_attempts a ON a.id = o.attempt_id
           JOIN work_units wu ON wu.id = a.work_unit_id
           JOIN goals g ON g.id = wu.goal_id
           WHERE o.state = 'leased' AND o.lease_expires_at <= ?`,
                    )
                    .all(now) as Row[];
                for (const row of rows) {
                    const dispatchable =
                        row.goal_state === 'executing' &&
                        row.active_attempt_id === row.attempt_id &&
                        [
                            'leased',
                            'dispatched',
                            'running',
                            'verifying',
                        ].includes(String(row.attempt_state)) &&
                        Date.parse(String(row.attempt_expires_at)) >
                            Date.parse(now);
                    const needsProbe =
                        dispatchable &&
                        Boolean(row.needs_probe || row.dispatch_started_at);
                    this.#database
                        .prepare(
                            `UPDATE outbox SET state = ?, lease_token = NULL,
               lease_expires_at = NULL, dispatcher_owner = NULL,
               needs_probe = ?, probe_state = ?
              WHERE id = ? AND state = 'leased' AND lease_expires_at <= ?`,
                        )
                        .run(
                            dispatchable ? 'pending' : 'retired',
                            needsProbe ? 1 : 0,
                            needsProbe ? 'required' : null,
                            row.id,
                            now,
                        );
                    this.#recordDelivery(row, 'release', now, {
                        needsProbe,
                        probeState: needsProbe ? 'required' : undefined,
                        error: dispatchable
                            ? 'dispatcher lease expired'
                            : 'stale dispatcher lease retired',
                    });
                    this.#event(
                        String(row.goal_id),
                        'outbox.lease-expired',
                        { outboxId: String(row.id), needsProbe },
                        now,
                    );
                }
                return rows.length;
            })
            .immediate();
    }

    startupReconcile(): StartupReconcileResult {
        const expiredAttempts = this.recoverExpiredAttempts();
        const expiredOutboxLeases = this.recoverExpiredOutboxLeases();
        return { expiredAttempts, expiredOutboxLeases };
    }

    #recordDelivery(
        outbox: Row,
        action: string,
        createdAt: string,
        overrides: {
            readonly error?: string;
            readonly needsProbe?: boolean;
            readonly probeState?: string;
            readonly externalRef?: string;
            readonly leaseToken?: string;
            readonly nextAttemptAt?: string;
            readonly retryCount?: number;
        } = {},
    ): void {
        this.#database
            .prepare(
                `INSERT INTO delivery_attempts(
          id, outbox_id, attempt_id, action, dispatcher_lease_token,
          retry_count, next_attempt_at, error, needs_probe, probe_state,
          external_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                this.#id(),
                outbox.id,
                outbox.attempt_id,
                action,
                overrides.leaseToken ?? outbox.lease_token ?? null,
                overrides.retryCount ?? Number(outbox.retry_count ?? 0),
                overrides.nextAttemptAt ?? outbox.next_attempt_at ?? null,
                overrides.error ?? outbox.last_error ?? null,
                (overrides.needsProbe ?? Boolean(outbox.needs_probe)) ? 1 : 0,
                overrides.probeState ?? outbox.probe_state ?? null,
                overrides.externalRef ?? outbox.external_ref ?? null,
                createdAt,
            );
    }

    claimOutbox(
        limit: number,
        leaseDurationMs: number,
        owner?: string,
    ): readonly ClaimedOutboxMessage[];
    claimOutbox(
        owner: string,
        limit: number,
        leaseDurationMs: number,
    ): readonly ClaimedOutboxMessage[];
    claimOutbox(
        first: number | string,
        second: number,
        third?: number | string,
    ): readonly ClaimedOutboxMessage[] {
        const owner =
            typeof first === 'string' ? first : (third as string | undefined);
        const limit = typeof first === 'string' ? second : first;
        const leaseDurationMs =
            typeof first === 'string' ? Number(third) : second;
        if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
            throw new Error('Outbox claim limit must be between 1 and 1000.');
        }
        requirePositiveDuration(leaseDurationMs, 'Dispatcher lease duration');
        if (owner) DomainIdSchema.parse(owner);
        return this.#database
            .transaction(() => {
                const now = this.#now();
                const stale = this.#database
                    .prepare(
                        `SELECT o.*, wu.goal_id FROM outbox o
           JOIN work_attempts a ON a.id = o.attempt_id
           JOIN work_units wu ON wu.id = a.work_unit_id
           JOIN goals g ON g.id = wu.goal_id
           WHERE o.state IN ('pending', 'leased')
             AND (
               g.state <> 'executing'
               OR wu.active_attempt_id <> a.id
               OR a.state NOT IN ('leased', 'dispatched', 'running', 'verifying')
               OR a.lease_expires_at <= ?
             )`,
                    )
                    .all(now) as Row[];
                for (const row of stale) {
                    this.#database
                        .prepare(
                            `UPDATE outbox SET state = 'retired', lease_token = NULL,
               lease_expires_at = NULL, dispatcher_owner = NULL WHERE id = ?`,
                        )
                        .run(row.id);
                    this.#recordDelivery(row, 'release', now, {
                        error: 'stale dispatch command retired',
                    });
                    this.#event(
                        String(row.goal_id),
                        'outbox.retired',
                        { outboxId: String(row.id), reason: 'stale command' },
                        now,
                    );
                }

                const rows = this.#database
                    .prepare(
                        `SELECT o.*, wu.goal_id FROM outbox o
           JOIN work_attempts a ON a.id = o.attempt_id
           JOIN work_units wu ON wu.id = a.work_unit_id
           JOIN goals g ON g.id = wu.goal_id
           WHERE (
             (o.state = 'pending' AND o.next_attempt_at <= ?)
             OR (o.state = 'leased' AND o.lease_expires_at <= ?)
           )
             AND g.state = 'executing'
             AND wu.active_attempt_id = a.id
             AND a.state IN ('leased', 'dispatched', 'running', 'verifying')
             AND a.lease_expires_at > ?
           ORDER BY o.created_at, o.id LIMIT ?`,
                    )
                    .all(now, now, now, limit) as Row[];
                return rows.flatMap(row => {
                    const leaseToken = this.#id();
                    const leaseExpiresAt = new Date(
                        Date.parse(now) + leaseDurationMs,
                    ).toISOString();
                    const wasExpiredLease =
                        row.state === 'leased' &&
                        Date.parse(String(row.lease_expires_at)) <=
                            Date.parse(now);
                    const needsProbe = Boolean(
                        row.needs_probe ||
                        (wasExpiredLease && row.dispatch_started_at),
                    );
                    const changed = this.#database
                        .prepare(
                            `UPDATE outbox SET state = 'leased', lease_token = ?,
               lease_expires_at = ?, dispatcher_owner = ?, needs_probe = ?,
               probe_state = ?
             WHERE id = ? AND (
               (state = 'pending' AND next_attempt_at <= ?)
               OR (state = 'leased' AND lease_expires_at <= ?)
             )`,
                        )
                        .run(
                            leaseToken,
                            leaseExpiresAt,
                            owner ?? null,
                            needsProbe ? 1 : 0,
                            needsProbe ? 'required' : row.probe_state,
                            row.id,
                            now,
                            now,
                        );
                    if (changed.changes !== 1) return [];
                    this.#recordDelivery(
                        row,
                        wasExpiredLease ? 'reclaim' : 'claim',
                        now,
                        {
                            leaseToken,
                            needsProbe,
                            probeState: needsProbe
                                ? 'required'
                                : optionalString(row.probe_state),
                        },
                    );
                    this.#event(
                        String(row.goal_id),
                        'outbox.claimed',
                        {
                            outboxId: String(row.id),
                            attemptId: String(row.attempt_id),
                            retryCount: Number(row.retry_count),
                            needsProbe,
                        },
                        now,
                    );
                    return [
                        {
                            schemaVersion: SCHEMA_VERSION,
                            id: String(row.id),
                            attemptId: String(row.attempt_id),
                            idempotencyKey: String(row.idempotency_key),
                            payload: parseJson<Record<string, unknown>>(
                                row.payload_json,
                            ),
                            leaseToken,
                            leaseExpiresAt,
                            retryCount: Number(row.retry_count),
                            nextAttemptAt: String(row.next_attempt_at),
                            needsProbe,
                            probeState: needsProbe
                                ? 'required'
                                : optionalString(row.probe_state),
                            externalRef: optionalString(row.external_ref),
                        },
                    ];
                });
            })
            .immediate();
    }

    #leasedOutbox(outboxId: string, leaseToken: string): Row {
        const now = this.#now();
        const row = this.#database
            .prepare(
                `SELECT o.*, wu.goal_id, a.work_unit_id FROM outbox o
         JOIN work_attempts a ON a.id = o.attempt_id
         JOIN work_units wu ON wu.id = a.work_unit_id
         JOIN goals g ON g.id = wu.goal_id
         WHERE o.id = ? AND o.state = 'leased' AND o.lease_token = ?
           AND o.lease_expires_at > ? AND a.lease_expires_at > ?
           AND a.state IN ('leased', 'dispatched', 'running', 'verifying')
           AND wu.active_attempt_id = a.id AND g.state = 'executing'`,
            )
            .get(outboxId, leaseToken, now, now) as Row | undefined;
        if (!row) {
            throw new Error(
                `Outbox message ${outboxId} is not held by an unexpired dispatcher lease.`,
            );
        }
        return row;
    }

    markDispatchStarted(outboxId: string, leaseToken: string): void {
        this.#database
            .transaction(() => {
                const row = this.#leasedOutbox(outboxId, leaseToken);
                const now = this.#now();
                this.#database
                    .prepare(
                        `UPDATE outbox SET dispatch_started_at = COALESCE(dispatch_started_at, ?)
           WHERE id = ? AND state = 'leased' AND lease_token = ?
             AND lease_expires_at > ?`,
                    )
                    .run(now, outboxId, leaseToken, now);
                this.#database
                    .prepare(
                        `UPDATE work_attempts SET state = 'dispatched'
           WHERE id = ? AND state = 'leased'`,
                    )
                    .run(row.attempt_id);
                this.#recordDelivery(row, 'started', now, { leaseToken });
                this.#event(
                    String(row.goal_id),
                    'dispatch.started',
                    { outboxId, attemptId: String(row.attempt_id) },
                    now,
                );
            })
            .immediate();
    }

    markOutboxDelivered(
        outboxId: string,
        leaseToken: string,
        externalRef?: string,
    ): void {
        const parsedExternalRef = externalRef
            ? CompactReferenceSchema.parse(externalRef)
            : undefined;
        this.#database
            .transaction(() => {
                const row = this.#leasedOutbox(outboxId, leaseToken);
                if (row.needs_probe) {
                    throw new Error(
                        `Outbox message ${outboxId} requires a probe before delivery.`,
                    );
                }
                const now = this.#now();
                const changed = this.#database
                    .prepare(
                        `UPDATE outbox SET state = 'delivered', delivered_at = ?,
             external_ref = ?, lease_token = NULL, lease_expires_at = NULL,
             dispatcher_owner = NULL, probe_state = 'confirmed'
           WHERE id = ? AND state = 'leased' AND lease_token = ?
             AND lease_expires_at > ? AND needs_probe = 0`,
                    )
                    .run(
                        now,
                        parsedExternalRef ?? row.external_ref ?? null,
                        outboxId,
                        leaseToken,
                        now,
                    );
                if (changed.changes !== 1) {
                    throw new Error(
                        `Outbox message ${outboxId} could not be delivered.`,
                    );
                }
                this.#database
                    .prepare(
                        `UPDATE work_attempts SET state = 'running',
             started_at = COALESCE(started_at, ?)
           WHERE id = ? AND state IN ('leased', 'dispatched')`,
                    )
                    .run(now, row.attempt_id);
                if (parsedExternalRef) {
                    this.#database
                        .prepare(
                            `INSERT OR IGNORE INTO session_external_refs(
              id, goal_id, work_unit_id, attempt_id, kind, external_ref,
              created_at
            ) VALUES (?, ?, ?, ?, 'dispatch', ?, ?)`,
                        )
                        .run(
                            this.#id(),
                            row.goal_id,
                            row.work_unit_id,
                            row.attempt_id,
                            parsedExternalRef,
                            now,
                        );
                }
                this.#recordDelivery(row, 'delivered', now, {
                    leaseToken,
                    externalRef: parsedExternalRef,
                    probeState: 'confirmed',
                });
                this.#event(
                    String(row.goal_id),
                    'dispatch.delivered',
                    {
                        outboxId,
                        attemptId: String(row.attempt_id),
                        externalRef: parsedExternalRef,
                    },
                    now,
                );
            })
            .immediate();
    }

    recordDispatchFailure(
        outboxId: string,
        leaseToken: string,
        error: unknown,
        ambiguity: boolean | { readonly ambiguous?: boolean } = false,
    ): void {
        const ambiguous =
            typeof ambiguity === 'boolean'
                ? ambiguity
                : Boolean(ambiguity.ambiguous);
        this.#database
            .transaction(() => {
                const row = this.#leasedOutbox(outboxId, leaseToken);
                const now = this.#now();
                const message = redactError(error);
                const retryCount = Number(row.retry_count) + 1;
                const delayMs = ambiguous
                    ? 0
                    : Math.min(
                          60_000,
                          1_000 * 2 ** Math.min(retryCount - 1, 6),
                      );
                const nextAttemptAt = new Date(
                    Date.parse(now) + delayMs,
                ).toISOString();
                this.#database
                    .prepare(
                        `UPDATE outbox SET state = 'pending', retry_count = ?,
             next_attempt_at = ?, last_error = ?, needs_probe = ?,
             probe_state = ?, ambiguity_state = ?, lease_token = NULL,
             lease_expires_at = NULL, dispatcher_owner = NULL,
             dispatch_started_at = CASE WHEN ? THEN dispatch_started_at ELSE NULL END
           WHERE id = ? AND state = 'leased' AND lease_token = ?
             AND lease_expires_at > ?`,
                    )
                    .run(
                        retryCount,
                        nextAttemptAt,
                        message,
                        ambiguous ? 1 : 0,
                        ambiguous ? 'required' : null,
                        ambiguous ? 'ambiguous' : null,
                        ambiguous ? 1 : 0,
                        outboxId,
                        leaseToken,
                        now,
                    );
                this.#recordDelivery(row, 'failure', now, {
                    leaseToken,
                    retryCount,
                    nextAttemptAt,
                    error: message,
                    needsProbe: ambiguous,
                    probeState: ambiguous ? 'required' : undefined,
                });
                this.#recordDelivery(row, 'release', now, {
                    leaseToken,
                    retryCount,
                    nextAttemptAt,
                    error: message,
                    needsProbe: ambiguous,
                    probeState: ambiguous ? 'required' : undefined,
                });
                this.#event(
                    String(row.goal_id),
                    'dispatch.failed',
                    {
                        outboxId,
                        retryCount,
                        nextAttemptAt,
                        ambiguous,
                        error: message,
                    },
                    now,
                );
            })
            .immediate();
    }

    recordProbeResult(
        outboxId: string,
        leaseToken: string,
        result:
            | 'absent'
            | 'active'
            | 'completed'
            | 'unknown'
            | {
                  readonly status:
                      | 'absent'
                      | 'active'
                      | 'completed'
                      | 'unknown';
                  readonly externalRef?: string;
              },
        explicitExternalRef?: string,
    ): void {
        const status = typeof result === 'string' ? result : result.status;
        const externalRef =
            explicitExternalRef ??
            (typeof result === 'string' ? undefined : result.externalRef);
        if (externalRef) CompactReferenceSchema.parse(externalRef);
        this.#database
            .transaction(() => {
                const row = this.#leasedOutbox(outboxId, leaseToken);
                if (!row.needs_probe) {
                    throw new Error(
                        `Outbox message ${outboxId} does not require a probe.`,
                    );
                }
                const now = this.#now();
                this.#recordDelivery(row, `probe-${status}`, now, {
                    leaseToken,
                    probeState: status,
                    externalRef,
                });
                if (status === 'absent') {
                    this.#database
                        .prepare(
                            `UPDATE outbox SET state = 'pending', needs_probe = 0,
               probe_state = 'absent', ambiguity_state = NULL,
               dispatch_started_at = NULL, lease_token = NULL,
               lease_expires_at = NULL, dispatcher_owner = NULL,
               next_attempt_at = ?
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND lease_expires_at > ?`,
                        )
                        .run(now, outboxId, leaseToken, now);
                    this.#recordDelivery(row, 'release', now, {
                        leaseToken,
                        needsProbe: false,
                        probeState: 'absent',
                        nextAttemptAt: now,
                    });
                } else if (status === 'active' || status === 'completed') {
                    this.#database
                        .prepare(
                            `UPDATE outbox SET state = 'delivered', delivered_at = ?,
               external_ref = COALESCE(?, external_ref), needs_probe = 0,
               probe_state = ?, ambiguity_state = NULL, lease_token = NULL,
               lease_expires_at = NULL, dispatcher_owner = NULL
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND lease_expires_at > ?`,
                        )
                        .run(
                            now,
                            externalRef ?? null,
                            status,
                            outboxId,
                            leaseToken,
                            now,
                        );
                    this.#database
                        .prepare(
                            `UPDATE work_attempts SET state = 'running',
               started_at = COALESCE(started_at, ?)
             WHERE id = ? AND state IN ('leased', 'dispatched')`,
                        )
                        .run(now, row.attempt_id);
                    if (externalRef) {
                        this.#database
                            .prepare(
                                `INSERT OR IGNORE INTO session_external_refs(
                                  id, goal_id, work_unit_id, attempt_id, kind,
                                  external_ref, created_at
                                ) VALUES (?, ?, ?, ?, 'probe', ?, ?)`,
                            )
                            .run(
                                this.#id(),
                                row.goal_id,
                                row.work_unit_id,
                                row.attempt_id,
                                externalRef,
                                now,
                            );
                    }
                    this.#recordDelivery(row, 'delivered', now, {
                        leaseToken,
                        needsProbe: false,
                        probeState: status,
                        externalRef,
                    });
                } else {
                    this.#markUnknownOutcome(
                        row,
                        leaseToken,
                        'probe remained inconclusive',
                        now,
                    );
                }
                this.#event(
                    String(row.goal_id),
                    'dispatch.probed',
                    { outboxId, status, externalRef },
                    now,
                );
            })
            .immediate();
    }

    markUnknownOutcome(
        outboxId: string,
        leaseToken: string,
        reason: string,
    ): Goal {
        if (!reason.trim())
            throw new Error('Unknown outcome reason must be nonempty.');
        return this.#database
            .transaction(() => {
                const row = this.#leasedOutbox(outboxId, leaseToken);
                return this.#markUnknownOutcome(
                    row,
                    leaseToken,
                    reason,
                    this.#now(),
                );
            })
            .immediate();
    }

    #markUnknownOutcome(
        row: Row,
        leaseToken: string,
        reason: string,
        now: string,
    ): Goal {
        const changed = this.#database
            .prepare(
                `UPDATE outbox SET state = 'retired', needs_probe = 1,
           probe_state = 'unknown', ambiguity_state = 'unknown',
           lease_token = NULL, lease_expires_at = NULL,
           dispatcher_owner = NULL
         WHERE id = ? AND state = 'leased' AND lease_token = ?
           AND lease_expires_at > ?`,
            )
            .run(row.id, leaseToken, now);
        if (changed.changes !== 1) {
            throw new Error(
                `Outbox message ${String(row.id)} lost its dispatcher lease.`,
            );
        }
        this.#database
            .prepare(
                `UPDATE work_attempts SET state = 'unknown-outcome', completed_at = ?
         WHERE id = ? AND state IN ('leased', 'dispatched', 'running', 'verifying')`,
            )
            .run(now, row.attempt_id);
        this.#database
            .prepare(
                `UPDATE work_units SET state = 'unknown-outcome',
           active_attempt_id = NULL, updated_at = ?
         WHERE id = ? AND active_attempt_id = ?`,
            )
            .run(now, row.work_unit_id, row.attempt_id);
        this.#recordDelivery(row, 'probe-unknown', now, {
            leaseToken,
            error: redactError(reason),
            needsProbe: true,
            probeState: 'unknown',
        });
        return this.#decideAndWrite(
            this.#requireGoal(String(row.goal_id)),
            'unknown-outcome',
            {},
            'goal.unknown-outcome',
            {
                attemptId: String(row.attempt_id),
                reason: redactError(reason),
            },
        );
    }

    deliveryHistory(outboxId: string): readonly Row[] {
        return this.#database
            .prepare(
                `SELECT sequence, id, outbox_id, attempt_id, action, retry_count,
                next_attempt_at, error, needs_probe, probe_state,
                external_ref, created_at
         FROM delivery_attempts WHERE outbox_id = ? ORDER BY sequence`,
            )
            .all(outboxId) as Row[];
    }

    recordObservation(
        goalId: string,
        input: Omit<Observation, 'schemaVersion' | 'id' | 'goalId'> & {
            readonly id?: string;
        },
    ): Observation;
    recordObservation(
        input: Omit<Observation, 'schemaVersion' | 'id'> & {
            readonly id?: string;
        },
    ): Observation;
    recordObservation(
        first:
            | string
            | (Omit<Observation, 'schemaVersion' | 'id'> & {
                  readonly id?: string;
              }),
        second?: Omit<Observation, 'schemaVersion' | 'id' | 'goalId'> & {
            readonly id?: string;
        },
    ): Observation {
        const goalId = typeof first === 'string' ? first : first.goalId;
        const input = typeof first === 'string' ? second! : first;
        return this.#database
            .transaction(() => {
                this.#requireGoal(goalId);
                if (input.deduplicationKey) {
                    const duplicate = this.#database
                        .prepare(
                            `SELECT o.document_json FROM observation_inbox i
             JOIN observations o ON o.id = i.observation_id
             WHERE i.goal_id = ? AND i.deduplication_key = ?`,
                        )
                        .get(goalId, input.deduplicationKey) as Row | undefined;
                    if (duplicate) {
                        return ObservationSchema.parse(
                            parseJson(duplicate.document_json),
                        );
                    }
                }
                if (input.workUnitId) {
                    const unit = this.#database
                        .prepare('SELECT goal_id FROM work_units WHERE id = ?')
                        .get(input.workUnitId) as Row | undefined;
                    if (!unit || unit.goal_id !== goalId) {
                        throw new Error(
                            'Observation work unit belongs to another goal.',
                        );
                    }
                }
                if (input.attemptId) {
                    const attempt = this.#database
                        .prepare(
                            `SELECT wu.goal_id FROM work_attempts a
             JOIN work_units wu ON wu.id = a.work_unit_id WHERE a.id = ?`,
                        )
                        .get(input.attemptId) as Row | undefined;
                    if (!attempt || attempt.goal_id !== goalId) {
                        throw new Error(
                            'Observation attempt belongs to another goal.',
                        );
                    }
                }
                const now = this.#now();
                const observation = ObservationSchema.parse({
                    ...input,
                    schemaVersion: SCHEMA_VERSION,
                    id: input.id ?? this.#id(),
                    goalId,
                });
                this.#database
                    .prepare(
                        `INSERT INTO observations(
            id, goal_id, work_unit_id, attempt_id, deduplication_key,
            document_json, observed_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        observation.id,
                        goalId,
                        observation.workUnitId ?? null,
                        observation.attemptId ?? null,
                        observation.deduplicationKey ?? null,
                        canonicalJson(observation),
                        observation.observedAt,
                        now,
                    );
                if (observation.deduplicationKey) {
                    this.#database
                        .prepare(
                            `INSERT INTO observation_inbox(
              goal_id, deduplication_key, observation_id, received_at
            ) VALUES (?, ?, ?, ?)`,
                        )
                        .run(
                            goalId,
                            observation.deduplicationKey,
                            observation.id,
                            now,
                        );
                }
                this.#event(
                    goalId,
                    'observation.recorded',
                    {
                        observationId: observation.id,
                        kind: observation.kind,
                        deduplicationKey: observation.deduplicationKey,
                    },
                    now,
                );
                return observation;
            })
            .immediate();
    }

    findPendingPermissionScope(
        goalId: string,
        sessionId: string,
        permissionId: string,
    ): PendingPermissionScope | undefined {
        this.#requireGoal(goalId);
        DomainIdSchema.parse(sessionId);
        DomainIdSchema.parse(permissionId);
        const row = this.#database
            .prepare(
                `SELECT document_json FROM observations
                 WHERE goal_id = ?
                   AND json_extract(document_json, '$.issueClassification') = 'permission'
                   AND json_extract(document_json, '$.data.sessionId') = ?
                   AND json_extract(document_json, '$.data.permissionId') = ?
                   AND json_extract(document_json, '$.data.eventType')
                       IN ('permission.updated', 'permission.ask')
                   AND typeof(json_extract(
                       document_json,
                       '$.data.permissionType'
                   )) = 'text'
                 ORDER BY observed_at DESC, created_at DESC, id DESC
                 LIMIT 1`,
            )
            .get(goalId, sessionId, permissionId) as Row | undefined;
        if (!row) return undefined;
        const observation = ObservationSchema.parse(
            parseJson(row.document_json),
        );
        const permissionType = observation.data.permissionType;
        if (typeof permissionType !== 'string' || !permissionType.trim()) {
            return undefined;
        }
        return { permissionId, permissionType };
    }

    #persistEvidenceReferences(
        goalId: string,
        workUnitId: string | undefined,
        attemptId: string | undefined,
        references: readonly EvidenceReference[],
        createdAt: string,
    ): void {
        for (const reference of references) {
            this.#database
                .prepare(
                    `INSERT OR IGNORE INTO evidence(
            id, goal_id, work_unit_id, attempt_id, kind, ref, digest,
            media_type, size_bytes, created_at
          ) VALUES (?, ?, ?, ?, 'other', ?, ?,
                    'application/octet-stream', 0, ?)`,
                )
                .run(
                    this.#id(),
                    goalId,
                    workUnitId ?? null,
                    attemptId ?? null,
                    reference.ref,
                    reference.digest,
                    createdAt,
                );
        }
    }

    getAttemptVerificationRequirements(
        attemptId: string,
    ): readonly VerificationRequirement[] {
        const row = this.#database
            .prepare(
                `SELECT wu.requirements_json FROM work_attempts a
         JOIN work_units wu ON wu.id = a.work_unit_id WHERE a.id = ?`,
            )
            .get(attemptId) as Row | undefined;
        if (!row) throw new Error(`Attempt ${attemptId} was not found.`);
        return parseJson<VerificationRequirement[]>(row.requirements_json);
    }

    getFinalVerificationRequirements(
        goalId: string,
    ): readonly VerificationRequirement[] {
        const goal = this.#requireGoal(goalId);
        if (!goal.activePlanId) return [];
        const plan = this.getPlan(goal.activePlanId);
        if (!plan)
            throw new Error(`Active plan ${goal.activePlanId} was not found.`);
        return plan.finalVerificationRequirements;
    }

    getVerificationBaseline(
        attemptId: string,
        requirementId: string,
    ): DurableVerificationBaseline | undefined {
        const row = this.#database
            .prepare(
                `SELECT previous.status, previous.runtime_status,
                        previous.exit_code, previous.output_digest
                 FROM work_attempts current
                 JOIN verification_results previous
                   ON previous.work_unit_id = current.work_unit_id
                 WHERE current.id = ?
                   AND previous.attempt_id <> current.id
                   AND previous.requirement_id = ?
                   AND previous.final = 0
                 ORDER BY previous.completed_at DESC, previous.rowid DESC
                 LIMIT 1`,
            )
            .get(attemptId, requirementId) as Row | undefined;
        if (!row) return undefined;
        const fallback: VerificationRuntimeStatus =
            row.status === 'passed'
                ? 'passed'
                : row.status === 'failed'
                  ? 'failed'
                  : row.status === 'inconclusive'
                    ? 'timed-out'
                    : 'spawn-error';
        const candidate = optionalString(row.runtime_status);
        const status =
            candidate &&
            VERIFICATION_RUNTIME_STATUSES.has(
                candidate as VerificationRuntimeStatus,
            )
                ? (candidate as VerificationRuntimeStatus)
                : fallback;
        const digest = optionalString(row.output_digest)?.replace(
            /^sha256:/,
            '',
        );
        return {
            status,
            ...(row.exit_code === null || row.exit_code === undefined
                ? {}
                : { exitCode: Number(row.exit_code) }),
            ...(digest ? { outputDigest: digest } : {}),
        };
    }

    recordVerificationResult(
        attemptId: string,
        input: VerificationResultInput,
    ): VerificationResult;
    recordVerificationResult(
        input: VerificationResultInput & { readonly attemptId: string },
    ): VerificationResult;
    recordVerificationResult(
        first:
            | string
            | (VerificationResultInput & { readonly attemptId: string }),
        second?: VerificationResultInput,
    ): VerificationResult {
        const attemptId = typeof first === 'string' ? first : first.attemptId;
        const input =
            typeof first === 'string'
                ? second!
                : (Object.fromEntries(
                      Object.entries(first).filter(
                          ([key]) => key !== 'attemptId',
                      ),
                  ) as VerificationResultInput);
        return this.#database
            .transaction(() => {
                const now = this.#now();
                const row = this.#database
                    .prepare(
                        `SELECT a.id, a.work_unit_id, wu.goal_id, wu.plan_id
            FROM work_attempts a
            JOIN work_units wu ON wu.id = a.work_unit_id
            JOIN goals g ON g.id = wu.goal_id
            WHERE a.id = ? AND a.lease_expires_at > ?
              AND a.state IN ('leased', 'dispatched', 'running', 'verifying')
              AND wu.active_attempt_id = a.id AND g.state = 'executing'`,
                    )
                    .get(attemptId, now) as Row | undefined;
                if (!row)
                    throw new Error(
                        `Attempt ${attemptId} is not the active unexpired attempt of an executing goal.`,
                    );
                const requirements =
                    this.getAttemptVerificationRequirements(attemptId);
                if (
                    !requirements.some(
                        requirement => requirement.id === input.requirementId,
                    )
                ) {
                    throw new Error(
                        `Verification requirement ${input.requirementId} is not declared for attempt ${attemptId}.`,
                    );
                }
                if (input.outputDigest)
                    Sha256DigestSchema.parse(input.outputDigest);
                if (
                    input.output &&
                    input.output.length > MAX_COMPACT_OUTPUT_LENGTH
                ) {
                    throw new Error(
                        `Compact verification output exceeds ${MAX_COMPACT_OUTPUT_LENGTH} characters.`,
                    );
                }
                const {
                    id: requestedId,
                    outputDigest: _outputDigest,
                    output: _output,
                    runtimeStatus: _runtimeStatus,
                    ...domainInput
                } = input;
                if (
                    input.runtimeStatus !== undefined &&
                    !VERIFICATION_RUNTIME_STATUSES.has(input.runtimeStatus)
                ) {
                    throw new Error('Verification runtime status is invalid.');
                }
                const result = VerificationResultSchema.parse({
                    ...domainInput,
                    schemaVersion: SCHEMA_VERSION,
                    id: requestedId ?? this.#id(),
                    goalId: row.goal_id,
                    workUnitId: row.work_unit_id,
                    attemptId,
                });
                if (
                    Date.parse(result.completedAt) <
                    Date.parse(result.startedAt)
                ) {
                    throw new Error(
                        'Verification completion precedes its start.',
                    );
                }
                const duration =
                    Date.parse(result.completedAt) -
                    Date.parse(result.startedAt);
                this.#database
                    .prepare(
                        `INSERT INTO verification_results(
            id, goal_id, plan_id, work_unit_id, attempt_id, requirement_id, final,
            status, summary, output_digest, compact_output,
            improvement_absolute, runtime_status, exit_code, document_json,
            started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        result.id,
                        result.goalId,
                        row.plan_id,
                        result.workUnitId,
                        result.attemptId,
                        result.requirementId,
                        result.status,
                        result.summary,
                        input.outputDigest ?? null,
                        input.output ?? null,
                        result.improvement?.absolute ?? null,
                        input.runtimeStatus ?? null,
                        result.exitCode ?? null,
                        canonicalJson(result),
                        result.startedAt,
                        result.completedAt,
                    );
                if (result.baseline) {
                    this.#database
                        .prepare(
                            `INSERT INTO verification_baselines(
              id, verification_result_id, baseline_json, observed_json,
              improvement_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
                        )
                        .run(
                            this.#id(),
                            result.id,
                            canonicalJson(result.baseline),
                            result.observed
                                ? canonicalJson(result.observed)
                                : null,
                            result.improvement
                                ? canonicalJson(result.improvement)
                                : null,
                            result.completedAt,
                        );
                }
                this.#persistEvidenceReferences(
                    result.goalId,
                    result.workUnitId,
                    result.attemptId,
                    result.evidenceRefs,
                    result.completedAt,
                );
                this.#database
                    .prepare(
                        `UPDATE goal_budget_usage SET
             verification_ms = verification_ms + ?, updated_at = ?
           WHERE goal_id = ?`,
                    )
                    .run(duration, this.#now(), result.goalId);
                this.#event(
                    result.goalId,
                    'verification.recorded',
                    {
                        verificationResultId: result.id,
                        attemptId,
                        requirementId: result.requirementId,
                        status: result.status,
                        runtimeStatus: input.runtimeStatus,
                        exitCode: result.exitCode,
                        outputDigest: input.outputDigest,
                    },
                    result.completedAt,
                );
                return result;
            })
            .immediate();
    }

    recordFinalVerificationResult(
        goalId: string,
        expectedPlanId: string,
        input: FinalVerificationResultInput,
    ): FinalVerificationResult {
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                if (
                    goal.state !== 'executing' ||
                    goal.activePlanId !== expectedPlanId
                ) {
                    throw new Error(
                        `Plan ${expectedPlanId} is not the active plan of an executing goal.`,
                    );
                }
                const requirements =
                    this.getFinalVerificationRequirements(goalId);
                if (
                    !requirements.some(
                        requirement => requirement.id === input.requirementId,
                    )
                ) {
                    throw new Error(
                        `Final verification requirement ${input.requirementId} is not declared.`,
                    );
                }
                if (!input.summary.trim() || input.summary.length > 500) {
                    throw new Error(
                        'Verification summary must be between 1 and 500 characters.',
                    );
                }
                if (input.outputDigest)
                    Sha256DigestSchema.parse(input.outputDigest);
                if (
                    input.output &&
                    input.output.length > MAX_COMPACT_OUTPUT_LENGTH
                ) {
                    throw new Error(
                        `Compact verification output exceeds ${MAX_COMPACT_OUTPUT_LENGTH} characters.`,
                    );
                }
                if (
                    Date.parse(input.completedAt) < Date.parse(input.startedAt)
                ) {
                    throw new Error(
                        'Verification completion precedes its start.',
                    );
                }
                const validated = VerificationResultSchema.parse({
                    schemaVersion: SCHEMA_VERSION,
                    id: input.id ?? this.#id(),
                    goalId,
                    attemptId: 'final-verification',
                    requirementId: input.requirementId,
                    status: input.status,
                    summary: input.summary,
                    evidenceRefs: input.evidenceRefs,
                    startedAt: input.startedAt,
                    completedAt: input.completedAt,
                });
                const result: FinalVerificationResult = {
                    id: validated.id,
                    goalId,
                    planId: expectedPlanId,
                    requirementId: validated.requirementId,
                    status: validated.status,
                    summary: validated.summary,
                    evidenceRefs: validated.evidenceRefs,
                    outputDigest: input.outputDigest,
                    output: input.output,
                    startedAt: validated.startedAt,
                    completedAt: validated.completedAt,
                };
                this.#database
                    .prepare(
                        `INSERT INTO verification_results(
            id, goal_id, plan_id, requirement_id, final, status, summary,
            output_digest, compact_output, document_json, started_at,
            completed_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        result.id,
                        goalId,
                        expectedPlanId,
                        result.requirementId,
                        result.status,
                        result.summary,
                        result.outputDigest ?? null,
                        result.output ?? null,
                        canonicalJson(result),
                        result.startedAt,
                        result.completedAt,
                    );
                this.#persistEvidenceReferences(
                    goalId,
                    undefined,
                    undefined,
                    result.evidenceRefs,
                    result.completedAt,
                );
                this.#database
                    .prepare(
                        `UPDATE goal_budget_usage SET verification_ms = verification_ms + ?,
             updated_at = ? WHERE goal_id = ?`,
                    )
                    .run(
                        Date.parse(result.completedAt) -
                            Date.parse(result.startedAt),
                        this.#now(),
                        goalId,
                    );
                this.#event(
                    goalId,
                    'verification.final-recorded',
                    {
                        verificationResultId: result.id,
                        requirementId: result.requirementId,
                        planId: expectedPlanId,
                        status: result.status,
                        outputDigest: result.outputDigest,
                    },
                    result.completedAt,
                );
                return result;
            })
            .immediate();
    }

    reportOutcome(input: AgentOutcome): OutcomeReport {
        const outcome = normalizeAgentOutcomeForPolicy(
            AgentOutcomeSchema.parse(input),
        );
        return this.#database
            .transaction(() => {
                const now = this.#now();
                const row = this.#database
                    .prepare(
                        `SELECT a.*, wu.id AS unit_id, wu.goal_id, wu.requirements_json,
                  wu.active_attempt_id, g.state AS goal_state
           FROM work_attempts a
           JOIN work_units wu ON wu.id = a.work_unit_id
           JOIN goals g ON g.id = wu.goal_id
           WHERE a.id = ? AND a.lease_token = ?
             AND a.lease_expires_at > ?
             AND a.state IN ('leased', 'dispatched', 'running', 'verifying')
             AND wu.active_attempt_id = a.id AND g.state = 'executing'`,
                    )
                    .get(outcome.attemptId, outcome.leaseToken, now) as
                    | Row
                    | undefined;
                if (!row) {
                    throw new Error(
                        `Attempt ${outcome.attemptId} is not the active unexpired lease of an executing goal.`,
                    );
                }
                const goalId = String(row.goal_id);
                const workUnitId = String(row.unit_id);
                const requirements = parseJson<VerificationRequirement[]>(
                    row.requirements_json,
                );
                if (outcome.status === 'completed') {
                    if (outcome.evidenceRefs.length === 0) {
                        throw new Error(
                            'Completed work requires at least one evidence reference.',
                        );
                    }
                    const required = getRequiredRequirements(requirements);
                    const passed = this.#database
                        .prepare(
                            `SELECT id, requirement_id FROM verification_results
             WHERE attempt_id = ? AND status = 'passed'`,
                        )
                        .all(outcome.attemptId) as Row[];
                    for (const requirement of required) {
                        const result = passed.find(
                            candidate =>
                                candidate.requirement_id === requirement.id,
                        );
                        if (!result) {
                            throw new Error(
                                `Required verification ${requirement.id} has not passed for this attempt.`,
                            );
                        }
                        if (
                            !outcome.verificationRefs.includes(
                                String(result.id),
                            )
                        ) {
                            throw new Error(
                                `Passed verification ${requirement.id} is not referenced by the outcome.`,
                            );
                        }
                    }
                }

                this.#persistEvidenceReferences(
                    goalId,
                    workUnitId,
                    outcome.attemptId,
                    outcome.evidenceRefs,
                    now,
                );
                const verificationImproved = Boolean(
                    this.#database
                        .prepare(
                            `SELECT 1 FROM verification_results
             WHERE attempt_id = ? AND improvement_absolute > 0 LIMIT 1`,
                        )
                        .get(outcome.attemptId),
                );
                const compactOutcome = {
                    ...outcome,
                    summary: outcome.summary.slice(0, 500),
                };
                const elapsed = Math.max(
                    0,
                    Date.parse(now) -
                        Date.parse(
                            String(row.lease_acquired_at ?? row.created_at),
                        ),
                );
                this.#database
                    .prepare(
                        `UPDATE goal_budget_usage SET wall_clock_ms = wall_clock_ms + ?,
             updated_at = ? WHERE goal_id = ?`,
                    )
                    .run(elapsed, now, goalId);

                if (outcome.status === 'completed') {
                    this.#database
                        .prepare(
                            `UPDATE work_attempts SET state = 'succeeded', completed_at = ?,
               outcome_json = ?, verification_improved = ? WHERE id = ?`,
                        )
                        .run(
                            now,
                            canonicalJson(compactOutcome),
                            verificationImproved ? 1 : 0,
                            outcome.attemptId,
                        );
                    this.#database
                        .prepare(
                            `UPDATE work_units SET state = 'accepted', active_attempt_id = NULL,
               updated_at = ? WHERE id = ? AND active_attempt_id = ?`,
                        )
                        .run(now, workUnitId, outcome.attemptId);
                    this.#retireAttemptOutbox(
                        outcome.attemptId,
                        now,
                        'outcome settled',
                    );
                    this.#event(
                        goalId,
                        'work.accepted',
                        {
                            workUnitId,
                            attemptId: outcome.attemptId,
                            summary: outcome.summary,
                            evidenceRefs: outcome.evidenceRefs,
                            verificationRefs: outcome.verificationRefs,
                            transcriptRef: outcome.transcriptRef,
                            artifactRefs: outcome.artifactRefs,
                        },
                        now,
                    );
                    return this.#outcomeReport(
                        goalId,
                        workUnitId,
                        outcome.attemptId,
                    );
                }

                this.#database
                    .prepare(
                        `UPDATE work_attempts SET state = ?, completed_at = ?,
             failure_fingerprint = ?, material_change_digest = ?,
             issue_classification = ?, outcome_json = ?,
             verification_improved = ? WHERE id = ?`,
                    )
                    .run(
                        outcome.status === 'unknown-outcome'
                            ? 'unknown-outcome'
                            : 'failed',
                        now,
                        outcome.failureFingerprint ?? null,
                        outcome.materialChangeDigest ?? null,
                        outcome.issueClassification ?? null,
                        canonicalJson(compactOutcome),
                        verificationImproved ? 1 : 0,
                        outcome.attemptId,
                    );
                this.#retireAttemptOutbox(
                    outcome.attemptId,
                    now,
                    'outcome settled',
                );

                const repeatedFingerprint = outcome.failureFingerprint
                    ? Number(
                          (
                              this.#database
                                  .prepare(
                                      `SELECT COUNT(*) AS count FROM work_attempts
                   WHERE work_unit_id = ? AND failure_fingerprint = ?`,
                                  )
                                  .get(
                                      workUnitId,
                                      outcome.failureFingerprint,
                                  ) as Row
                          ).count,
                      )
                    : 0;
                const unchangedWithoutImprovement = outcome.materialChangeDigest
                    ? Number(
                          (
                              this.#database
                                  .prepare(
                                      `SELECT COUNT(*) AS count FROM work_attempts
                   WHERE work_unit_id = ? AND material_change_digest = ?
                     AND verification_improved = 0`,
                                  )
                                  .get(
                                      workUnitId,
                                      outcome.materialChangeDigest,
                                  ) as Row
                          ).count,
                      )
                    : 0;
                const budget = this.getBudget(goalId);
                const budgetExhausted =
                    budget.usage.attempts >= budget.budget.maxAttempts ||
                    budget.usage.wallClockMs >= budget.budget.maxWallClockMs ||
                    budget.usage.verificationMs >=
                        budget.budget.maxVerificationMs ||
                    budget.usage.tokens >= budget.budget.maxTokens;

                const issue = outcome.issueClassification;
                let goalAction:
                    | 'unknown-outcome'
                    | 'decision'
                    | 'block'
                    | 'replan'
                    | undefined;
                if (
                    outcome.status === 'unknown-outcome' ||
                    issue === 'external-ambiguity'
                ) {
                    goalAction = 'unknown-outcome';
                } else if (issue === 'credentials' || issue === 'permission') {
                    goalAction = 'decision';
                } else if (
                    issue === 'dependency' ||
                    issue === 'budget' ||
                    outcome.status === 'blocked' ||
                    budgetExhausted
                ) {
                    goalAction = 'block';
                } else if (
                    outcome.status === 'needs-replan' ||
                    issue === 'contradictory-criteria' ||
                    repeatedFingerprint >= 3 ||
                    unchangedWithoutImprovement >= 2
                ) {
                    goalAction = 'replan';
                }

                const unitState =
                    goalAction === 'unknown-outcome'
                        ? 'unknown-outcome'
                        : goalAction
                          ? 'failed'
                          : 'queued';
                this.#database
                    .prepare(
                        `UPDATE work_units SET state = ?, active_attempt_id = NULL,
             updated_at = ? WHERE id = ? AND active_attempt_id = ?`,
                    )
                    .run(unitState, now, workUnitId, outcome.attemptId);
                if (goalAction) {
                    this.#decideAndWrite(
                        this.#requireGoal(goalId),
                        goalAction,
                        {},
                        `goal.${goalAction}`,
                        {
                            attemptId: outcome.attemptId,
                            issueClassification: issue,
                            repeatedFingerprint,
                            unchangedWithoutImprovement,
                            budgetExhausted,
                        },
                    );
                }
                this.#event(
                    goalId,
                    'outcome.reported',
                    {
                        workUnitId,
                        attemptId: outcome.attemptId,
                        status: outcome.status,
                        issueClassification: issue,
                        repeatedFingerprint,
                        unchangedWithoutImprovement,
                        requeued: !goalAction,
                        summary: outcome.summary,
                    },
                    now,
                );
                return this.#outcomeReport(
                    goalId,
                    workUnitId,
                    outcome.attemptId,
                );
            })
            .immediate();
    }

    #retireAttemptOutbox(attemptId: string, now: string, reason: string): void {
        const rows = this.#database
            .prepare(
                "SELECT * FROM outbox WHERE attempt_id = ? AND state IN ('pending', 'leased')",
            )
            .all(attemptId) as Row[];
        for (const row of rows) {
            this.#database
                .prepare(
                    `UPDATE outbox SET state = 'retired', lease_token = NULL,
             lease_expires_at = NULL, dispatcher_owner = NULL WHERE id = ?`,
                )
                .run(row.id);
            this.#recordDelivery(row, 'release', now, { error: reason });
        }
    }

    #outcomeReport(
        goalId: string,
        workUnitId: string,
        attemptId: string,
    ): OutcomeReport {
        return {
            goal: this.#requireGoal(goalId),
            workUnit: toWorkUnit(
                this.#database
                    .prepare('SELECT * FROM work_units WHERE id = ?')
                    .get(workUnitId) as Row,
            ),
            attempt: toAttempt(
                this.#database
                    .prepare('SELECT * FROM work_attempts WHERE id = ?')
                    .get(attemptId) as Row,
            ),
        };
    }

    finalizeGoal(goalId: string): Goal {
        return this.#database
            .transaction(() => {
                const goal = this.#requireGoal(goalId);
                if (!goal.activePlanId)
                    throw new Error('Goal has no approved plan.');
                const missingUnit = this.#database
                    .prepare(
                        `SELECT 1 FROM work_units
           WHERE goal_id = ? AND plan_id = ? AND required = 1
             AND state <> 'accepted' LIMIT 1`,
                    )
                    .get(goalId, goal.activePlanId);
                const finalRequirements = getRequiredRequirements(
                    this.getFinalVerificationRequirements(goalId),
                );
                let allFinalPassed = true;
                for (const requirement of finalRequirements) {
                    const latest = this.#database
                        .prepare(
                            `SELECT status FROM verification_results
              WHERE goal_id = ? AND plan_id = ? AND final = 1
                AND requirement_id = ?
              ORDER BY completed_at DESC, rowid DESC LIMIT 1`,
                        )
                        .get(goalId, goal.activePlanId, requirement.id) as
                        | Row
                        | undefined;
                    if (!latest || latest.status !== 'passed')
                        allFinalPassed = false;
                }
                const achieved = this.#decideAndWrite(
                    goal,
                    'achieve',
                    {
                        allRequiredUnitsAccepted: !missingUnit,
                        hasSuccessfulFinalVerification: allFinalPassed,
                    },
                    'goal.achieved',
                    {
                        finalRequirementIds: finalRequirements.map(
                            requirement => requirement.id,
                        ),
                    },
                );
                const now = this.#now();
                const residualAttempts = this.#database
                    .prepare(
                        `SELECT a.id, a.work_unit_id, o.external_ref,
                                o.dispatch_started_at, o.delivered_at
                         FROM work_attempts a
                          JOIN work_units wu ON wu.id = a.work_unit_id
                          LEFT JOIN outbox o ON o.attempt_id = a.id
                          WHERE wu.goal_id = ? AND wu.active_attempt_id = a.id
                            AND a.state IN ('leased', 'dispatched', 'running', 'verifying')`,
                    )
                    .all(goalId) as Row[];
                for (const attempt of residualAttempts) {
                    if (
                        attempt.dispatch_started_at ||
                        attempt.delivered_at ||
                        attempt.external_ref
                    ) {
                        this.#database
                            .prepare(
                                `INSERT OR IGNORE INTO cancellation_requests(
                                   id, goal_id, work_unit_id, attempt_id,
                                   external_ref, reason, state, created_at
                                 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
                            )
                            .run(
                                this.#id(),
                                goalId,
                                attempt.work_unit_id,
                                attempt.id,
                                attempt.external_ref ?? null,
                                'Goal achieved; cancel residual work.',
                                now,
                            );
                    }
                    this.#retireAttemptOutbox(
                        String(attempt.id),
                        now,
                        'goal achieved',
                    );
                    this.#database
                        .prepare(
                            `UPDATE work_attempts SET state = 'cancelled', completed_at = ?
                             WHERE id = ?`,
                        )
                        .run(now, attempt.id);
                    this.#database
                        .prepare(
                            `UPDATE work_units SET state = 'cancelled',
                               active_attempt_id = NULL, updated_at = ?
                             WHERE id = ? AND active_attempt_id = ?`,
                        )
                        .run(now, attempt.work_unit_id, attempt.id);
                }
                if (residualAttempts.length > 0) {
                    this.#event(
                        goalId,
                        'dispatch.fenced',
                        {
                            action: 'achieve',
                            affectedAttemptIds: residualAttempts.map(attempt =>
                                String(attempt.id),
                            ),
                        },
                        now,
                    );
                }
                return achieved;
            })
            .immediate();
    }

    integrityCheck(): IntegrityReport {
        const quickRows = this.#database.pragma('quick_check') as Row[];
        const quickCheck = quickRows.map(row =>
            String(row.quick_check ?? Object.values(row)[0]),
        );
        const foreignKeyViolations = this.#database.pragma(
            'foreign_key_check',
        ) as Row[];
        const versionRow = this.#database
            .prepare(
                'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
            )
            .get() as Row;
        const schemaVersion = Number(versionRow.version);
        const journalMode = String(
            this.#database.pragma('journal_mode', { simple: true }),
        );
        const synchronous = Number(
            this.#database.pragma('synchronous', { simple: true }),
        );
        const wal = this.#database.pragma('wal_checkpoint(PASSIVE)') as Row[];
        return {
            ok:
                quickCheck.length === 1 &&
                quickCheck[0] === 'ok' &&
                foreignKeyViolations.length === 0 &&
                schemaVersion === LATEST_MIGRATION,
            quickCheck,
            foreignKeyViolations,
            schemaVersion,
            latestSchemaVersion: LATEST_MIGRATION,
            journalMode,
            synchronous,
            wal,
        };
    }

    checkpoint(
        mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE',
    ): readonly Row[] {
        if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) {
            throw new Error(`Unsupported checkpoint mode ${String(mode)}.`);
        }
        return this.#database.pragma(`wal_checkpoint(${mode})`) as Row[];
    }

    async backup(destination: string): Promise<void> {
        if (!destination.trim())
            throw new Error('Backup destination must be nonempty.');
        const absoluteDestination = resolve(destination);
        if (this.#path !== ':memory:' && absoluteDestination === this.#path) {
            throw new Error(
                'Backup destination must differ from the live database.',
            );
        }
        mkdirSync(dirname(absoluteDestination), {
            recursive: true,
            mode: 0o700,
        });
        this.#bestEffortMode(dirname(absoluteDestination), 0o700);
        await this.#database.backup(absoluteDestination);
        this.#bestEffortMode(absoluteDestination, 0o600);
    }

    close(): void {
        if (this.#closed) return;
        this.#hardenDatabaseFiles();
        this.#database.close();
        this.#closed = true;
    }
}
