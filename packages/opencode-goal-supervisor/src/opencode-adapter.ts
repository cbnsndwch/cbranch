import { createHash } from 'node:crypto';

import { AgentOutcomeSchema, type AgentOutcome } from './domain.js';
import {
    type GoalSessionAdapter,
    type SessionAbortInput,
    type SessionAbortResult,
    type SessionDispatchInput,
    type SessionDispatchResult,
    type SessionHealthResult,
    type SessionObservation,
    type SessionObserveInput,
    type SessionOutcomeInput,
    type SessionOutcomeRead,
    type SessionProbeInput,
    type SessionProbeResult,
} from './supervisor.js';

type LegacySession = {
    readonly id: string;
    readonly title: string;
    readonly directory?: string;
    readonly time?: {
        readonly created?: number;
        readonly updated?: number;
    };
};

type LegacySessionStatus =
    | { readonly type: 'idle' }
    | { readonly type: 'busy' }
    | {
          readonly type: 'retry';
          readonly attempt?: number;
          readonly message?: string;
          readonly next?: number;
      };

type LegacyMessage = {
    readonly info: {
        readonly id?: string;
        readonly sessionID?: string;
        readonly role?: 'user' | 'assistant';
        readonly time?: {
            readonly created?: number;
            readonly completed?: number;
        };
        readonly finish?: string;
        readonly error?: unknown;
    };
    readonly parts: readonly {
        readonly type?: string;
        readonly text?: string;
    }[];
};

export type LegacyCallResult<Value> =
    | {
          readonly data: Value;
          readonly error?: undefined;
          readonly request?: Request;
          readonly response?: Response;
      }
    | {
          readonly data?: undefined;
          readonly error: unknown;
          readonly request?: Request;
          readonly response?: Response;
      };

type LegacyCall<Value> = Promise<LegacyCallResult<Value>>;

export interface LegacyOpencodeClient {
    readonly session: {
        readonly list: (options: {
            readonly query: { readonly directory: string };
            readonly signal?: AbortSignal;
        }) => LegacyCall<readonly LegacySession[]>;
        readonly create: (options: {
            readonly query: { readonly directory: string };
            readonly body: { readonly title: string };
            readonly signal?: AbortSignal;
        }) => LegacyCall<LegacySession>;
        readonly status: (options: {
            readonly query: { readonly directory: string };
            readonly signal?: AbortSignal;
        }) => LegacyCall<Readonly<Record<string, LegacySessionStatus>>>;
        readonly messages: (options: {
            readonly path: { readonly id: string };
            readonly query: { readonly directory: string };
            readonly signal?: AbortSignal;
        }) => LegacyCall<readonly LegacyMessage[]>;
        readonly promptAsync: (options: {
            readonly path: { readonly id: string };
            readonly query: { readonly directory: string };
            readonly body: {
                readonly messageID: string;
                readonly parts: readonly [
                    { readonly type: 'text'; readonly text: string },
                ];
            };
            readonly signal?: AbortSignal;
        }) => LegacyCall<void>;
        readonly abort: (options: {
            readonly path: { readonly id: string };
            readonly query: { readonly directory: string };
            readonly signal?: AbortSignal;
        }) => LegacyCall<boolean>;
    };
    readonly event?: {
        readonly subscribe: (options: {
            readonly query: { readonly directory: string };
            readonly signal: AbortSignal;
            readonly sseDefaultRetryDelay: number;
            readonly sseMaxRetryAttempts: number;
            readonly sseMaxRetryDelay: number;
        }) => Promise<{ readonly stream: AsyncIterable<unknown> }>;
    };
}

export type LegacyOpencodeClientFactory = (config: {
    readonly baseUrl: string;
}) => LegacyOpencodeClient;

export interface OpenCodeAdapterOptions {
    readonly baseUrl: string;
    readonly directory: string;
    readonly client?: LegacyOpencodeClient;
    readonly clientFactory?: LegacyOpencodeClientFactory;
}

export class OpenCodeAdapterError extends Error {
    constructor(operation: string, error: unknown) {
        super(`${operation}: ${redactError(error)}`);
        this.name = 'OpenCodeAdapterError';
    }
}

const redactError = (error: unknown): string => {
    let message = 'OpenCode request failed';
    if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'string') {
        message = error;
    } else if (
        typeof error === 'object' &&
        error !== null &&
        'data' in error &&
        typeof error.data === 'object' &&
        error.data !== null &&
        'message' in error.data &&
        typeof error.data.message === 'string'
    ) {
        message = error.data.message;
    }
    return Array.from(message)
        .filter(character => {
            const code = character.charCodeAt(0);
            return code >= 0x20 && code !== 0x7f;
        })
        .join('')
        .replace(
            /\b(authorization|token|password|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi,
            '$1=[REDACTED]',
        )
        .replace(/(?:https?:\/\/)[^\s]+/gi, '[REDACTED_URL]')
        .slice(0, 500);
};

const unwrap = async <Value>(
    call: LegacyCall<Value>,
    operation: string,
): Promise<Value> => {
    try {
        const result = await call;
        if (result.error !== undefined) {
            throw new OpenCodeAdapterError(operation, result.error);
        }
        return result.data as Value;
    } catch (error) {
        if (error instanceof OpenCodeAdapterError) throw error;
        throw new OpenCodeAdapterError(operation, error);
    }
};

const sessionIdFromRef = (externalRef: string): string => {
    const prefix = 'opencode-session:';
    if (
        !externalRef.startsWith(prefix) ||
        externalRef.length === prefix.length
    ) {
        throw new OpenCodeAdapterError(
            'session reference',
            'Invalid session reference',
        );
    }
    try {
        return decodeURIComponent(externalRef.slice(prefix.length));
    } catch (error) {
        throw new OpenCodeAdapterError('session reference', error);
    }
};

const sessionRef = (sessionId: string): string =>
    `opencode-session:${encodeURIComponent(sessionId)}`;

const transcriptRef = (sessionId: string): string =>
    `opencode-transcript:${encodeURIComponent(sessionId)}`;

export const openCodeSessionTitle = (idempotencyKey: string): string =>
    `Goal Supervisor | ${idempotencyKey}`;

export const openCodePromptMessageId = (idempotencyKey: string): string =>
    `msg_goal_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;

const latestAssistantMessage = (
    messages: readonly LegacyMessage[],
): LegacyMessage | undefined =>
    messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.info.role === 'assistant')
        .toSorted(
            (left, right) =>
                (left.message.info.time?.created ?? 0) -
                    (right.message.info.time?.created ?? 0) ||
                left.index - right.index,
        )
        .at(-1)?.message;

const parseAssistantOutcome = (
    message: LegacyMessage | undefined,
): AgentOutcome | undefined => {
    if (
        !message?.info.time?.completed ||
        !message.info.finish ||
        message.info.finish === 'tool-calls'
    ) {
        return undefined;
    }
    const text = message.parts
        .filter(
            (part): part is { readonly type?: string; readonly text: string } =>
                part.type === 'text' && typeof part.text === 'string',
        )
        .map(part => part.text)
        .join('');
    if (!text.trim()) return undefined;
    try {
        return AgentOutcomeSchema.parse(JSON.parse(text));
    } catch {
        return undefined;
    }
};

const latestAssistantOutcome = (
    messages: readonly LegacyMessage[],
): AgentOutcome | undefined =>
    messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.info.role === 'assistant')
        .toSorted(
            (left, right) =>
                (right.message.info.time?.created ?? 0) -
                    (left.message.info.time?.created ?? 0) ||
                right.index - left.index,
        )
        .map(({ message }) => parseAssistantOutcome(message))
        .find((outcome): outcome is AgentOutcome => outcome !== undefined);

type InspectedSession = {
    readonly state:
        | 'absent'
        | 'active'
        | 'completed'
        | 'unknown'
        | 'terminal-unknown';
    readonly outcome?: AgentOutcome;
};

const inputText = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const inputStrings = (value: unknown): readonly string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];

/** Prompt deliberately contains no transcript or unrelated goal context. */
export const buildOpenCodeWorkUnitPrompt = (
    input: SessionDispatchInput,
): string => {
    const payloadInput =
        typeof input.command.payload.input === 'object' &&
        input.command.payload.input !== null &&
        !Array.isArray(input.command.payload.input)
            ? (input.command.payload.input as Readonly<Record<string, unknown>>)
            : {};
    const title = inputText(payloadInput.title);
    const instructions =
        inputText(payloadInput.instructions) ?? 'Complete the work unit.';
    const criteria = inputStrings(payloadInput.acceptanceCriteria);
    const contract = {
        schemaVersion: 1,
        attemptId: input.command.attemptId,
        leaseToken: input.command.leaseToken,
        status: 'completed | failed | blocked | needs-replan | unknown-outcome',
        summary: 'one concise line',
        evidenceRefs: [
            {
                ref: 'compact durable evidence reference',
                digest: 'sha256:<64 lowercase hex characters>',
            },
        ],
        verificationRefs: [],
        transcriptRef: 'optional compact reference',
        artifactRefs: ['optional compact reference'],
        failureFingerprint: 'optional compact reference',
        materialChangeDigest: 'optional sha256 digest',
        issueClassification:
            'optional credentials | permission | dependency | budget | contradictory-criteria | external-ambiguity | verification | other',
    };

    return [
        'Execute this supervised work unit.',
        `Attempt ID: ${input.command.attemptId}`,
        `Lease token: ${input.command.leaseToken}`,
        ...(title ? [`Title: ${title}`] : []),
        `Instructions: ${instructions}`,
        'Acceptance criteria:',
        ...criteria.map(criterion => `- ${criterion}`),
        'Return exactly one AgentOutcome JSON object matching this contract:',
        JSON.stringify(contract),
        'Your final assistant content must be the whole JSON object.',
        'Do not wrap it in Markdown or add prose, markers, or code fences.',
        'Leave verificationRefs empty; the supervisor runs declared commands.',
    ].join('\n');
};

const eventProperties = (event: unknown): Readonly<Record<string, unknown>> => {
    if (
        typeof event !== 'object' ||
        event === null ||
        !('properties' in event) ||
        typeof event.properties !== 'object' ||
        event.properties === null
    ) {
        return {};
    }
    return event.properties as Readonly<Record<string, unknown>>;
};

const eventType = (event: unknown): string | undefined =>
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    typeof event.type === 'string'
        ? event.type
        : undefined;

const nestedRecord = (
    value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;

const eventSessionId = (event: unknown): string | undefined => {
    const properties = eventProperties(event);
    if (typeof properties.sessionID === 'string') return properties.sessionID;
    const info = nestedRecord(properties.info);
    if (typeof info?.sessionID === 'string') return info.sessionID;
    const part = nestedRecord(properties.part);
    if (typeof part?.sessionID === 'string') return part.sessionID;
    return undefined;
};

const eventObservedAt = (event: unknown): string | undefined => {
    const properties = eventProperties(event);
    const info = nestedRecord(properties.info);
    const time = nestedRecord(info?.time);
    if (typeof time?.created !== 'number' || !Number.isFinite(time.created)) {
        return undefined;
    }
    return new Date(time.created).toISOString();
};

const eventDeduplicationKey = (event: unknown): string => {
    let serialized: string;
    try {
        serialized = JSON.stringify(event);
    } catch {
        serialized = String(eventType(event) ?? 'unknown');
    }
    return `opencode-event:${createHash('sha256').update(serialized).digest('hex')}`;
};

const normalizeEvent = (
    event: unknown,
    sessionId: string,
): SessionObservation | undefined => {
    const type = eventType(event);
    const properties = eventProperties(event);
    const base = {
        externalRef: sessionRef(sessionId),
        observedAt: eventObservedAt(event),
        deduplicationKey: eventDeduplicationKey(event),
    };
    if (type === 'session.status') {
        const status = nestedRecord(properties.status);
        const statusType =
            typeof status?.type === 'string' ? status.type : 'unknown';
        return {
            ...base,
            kind: 'status',
            summary: `OpenCode session status: ${statusType}.`,
            data: {
                eventType: type,
                sessionId,
                status: statusType,
                schedulerAction: false,
            },
        };
    }
    if (type === 'session.idle') {
        return {
            ...base,
            kind: 'status',
            summary: 'OpenCode session emitted idle status.',
            data: { eventType: type, sessionId, schedulerAction: false },
        };
    }
    if (type === 'session.error') {
        const error = nestedRecord(properties.error);
        const data = nestedRecord(error?.data);
        const message = redactError(
            data?.message ?? error?.name ?? 'session error',
        );
        return {
            ...base,
            kind: 'failure',
            summary: `OpenCode session error: ${message}`.slice(0, 500),
            issueClassification: 'external-ambiguity',
            data: { eventType: type, sessionId },
        };
    }
    if (type === 'message.updated' || type === 'message.part.updated') {
        const info = nestedRecord(properties.info);
        const part = nestedRecord(properties.part);
        return {
            ...base,
            kind: 'progress',
            summary: 'OpenCode session message updated.',
            data: {
                eventType: type,
                sessionId,
                ...(typeof info?.id === 'string' ? { messageId: info.id } : {}),
                ...(typeof info?.role === 'string' ? { role: info.role } : {}),
                ...(typeof part?.id === 'string' ? { partId: part.id } : {}),
            },
        };
    }
    if (type === 'permission.updated' || type === 'permission.replied') {
        return {
            ...base,
            kind: 'decision',
            summary: 'OpenCode session permission state changed.',
            issueClassification: 'permission',
            data: {
                eventType: type,
                sessionId,
                ...(typeof properties.id === 'string'
                    ? { permissionId: properties.id }
                    : {}),
                ...(typeof properties.permissionID === 'string'
                    ? { permissionId: properties.permissionID }
                    : {}),
            },
        };
    }
    return undefined;
};

export class OpenCodeSessionAdapter implements GoalSessionAdapter {
    readonly #dispatches = new Map<string, Promise<SessionDispatchResult>>();

    constructor(
        private readonly client: LegacyOpencodeClient,
        private readonly directory: string,
    ) {
        if (!directory.trim())
            throw new TypeError('directory must be nonempty.');
    }

    async #sessions(
        workspace: string,
        signal?: AbortSignal,
    ): Promise<readonly LegacySession[]> {
        return await unwrap(
            this.client.session.list({
                query: { directory: workspace },
                signal,
            }),
            'list sessions',
        );
    }

    async #messages(
        sessionId: string,
        workspace: string,
        signal?: AbortSignal,
    ): Promise<readonly LegacyMessage[]> {
        return await unwrap(
            this.client.session.messages({
                path: { id: sessionId },
                query: { directory: workspace },
                signal,
            }),
            'read session messages',
        );
    }

    async #inspect(
        session: LegacySession,
        workspace: string,
        signal?: AbortSignal,
    ): Promise<InspectedSession> {
        const [messages, statuses] = await Promise.all([
            this.#messages(session.id, workspace, signal),
            unwrap(
                this.client.session.status({
                    query: { directory: workspace },
                    signal,
                }),
                'read session status',
            ),
        ]);
        const latest = latestAssistantMessage(messages);
        const outcome = latestAssistantOutcome(messages);
        if (!messages.some(message => message.info.role === 'user')) {
            return { state: 'absent' };
        }
        const status = statuses[session.id];
        if (status?.type === 'busy' || status?.type === 'retry') {
            return {
                state: 'active',
                ...(outcome ? { outcome } : {}),
            };
        }
        if (outcome) return { state: 'completed', outcome };
        if (
            latest?.info.error ||
            latest?.info.time?.completed ||
            latest?.info.finish
        ) {
            return { state: 'terminal-unknown' };
        }
        if (!latest) return { state: 'active' };
        return { state: 'unknown' };
    }

    async #matchingSession(
        idempotencyKey: string,
        workspace: string,
        signal?: AbortSignal,
    ): Promise<LegacySession | undefined> {
        const title = openCodeSessionTitle(idempotencyKey);
        return (await this.#sessions(workspace, signal))
            .filter(session => session.title === title)
            .toSorted(
                (left, right) =>
                    (left.time?.created ?? 0) - (right.time?.created ?? 0) ||
                    left.id.localeCompare(right.id),
            )[0];
    }

    async probe(input: SessionProbeInput): Promise<SessionProbeResult> {
        const session = await this.#matchingSession(
            input.idempotencyKey,
            input.workspace,
            input.signal,
        );
        if (!session) return { status: 'absent' };
        const inspected = await this.#inspect(
            session,
            input.workspace,
            input.signal,
        );
        if (inspected.state === 'absent') return { status: 'absent' };
        if (inspected.state === 'active' || inspected.state === 'completed') {
            return {
                status: inspected.state,
                externalRef: sessionRef(session.id),
            };
        }
        return {
            status: 'unknown',
            externalRef: sessionRef(session.id),
        };
    }

    async dispatch(
        input: SessionDispatchInput,
    ): Promise<SessionDispatchResult> {
        const key = JSON.stringify([input.workspace, input.idempotencyKey]);
        const existing = this.#dispatches.get(key);
        if (existing) return await existing;
        const pending = this.#dispatchOnce(input);
        this.#dispatches.set(key, pending);
        try {
            return await pending;
        } finally {
            if (this.#dispatches.get(key) === pending) {
                this.#dispatches.delete(key);
            }
        }
    }

    async #dispatchOnce(
        input: SessionDispatchInput,
    ): Promise<SessionDispatchResult> {
        let session = await this.#matchingSession(
            input.idempotencyKey,
            input.workspace,
            input.signal,
        );
        if (!session) {
            session = await unwrap(
                this.client.session.create({
                    query: { directory: input.workspace },
                    body: { title: openCodeSessionTitle(input.idempotencyKey) },
                    signal: input.signal,
                }),
                'create session',
            );
        }
        const messages = await this.#messages(
            session.id,
            input.workspace,
            input.signal,
        );
        if (!messages.some(message => message.info.role === 'user')) {
            await unwrap(
                this.client.session.promptAsync({
                    path: { id: session.id },
                    query: { directory: input.workspace },
                    body: {
                        messageID: openCodePromptMessageId(
                            input.idempotencyKey,
                        ),
                        parts: [
                            {
                                type: 'text',
                                text: buildOpenCodeWorkUnitPrompt(input),
                            },
                        ],
                    },
                    signal: input.signal,
                }),
                'prompt session',
            );
        }
        return { externalRef: sessionRef(session.id) };
    }

    async readOutcome(input: SessionOutcomeInput): Promise<SessionOutcomeRead> {
        const sessionId = sessionIdFromRef(input.externalRef);
        const session: LegacySession = {
            id: sessionId,
            title: '',
        };
        const inspected = await this.#inspect(
            session,
            input.workspace,
            input.signal,
        );
        if (inspected.state === 'active') {
            if (!inspected.outcome) return { status: 'active' };
            const stopped = await this.abort({
                externalRef: input.externalRef,
                workspace: input.workspace,
                reason: 'completed AgentOutcome accepted',
                signal: input.signal,
            });
            if (!stopped.aborted) return { status: 'active' };
            return {
                status: 'completed',
                outcome: inspected.outcome,
                transcriptRef: transcriptRef(sessionId),
            };
        }
        if (inspected.state === 'terminal-unknown') {
            return {
                status: 'terminal-unknown',
                reason: 'Session ended without a whole-text AgentOutcome JSON object.',
            };
        }
        if (inspected.state !== 'completed' || !inspected.outcome) {
            return {
                status: 'unknown',
                reason: 'Session has no whole-text AgentOutcome JSON object.',
            };
        }
        return {
            status: 'completed',
            outcome: inspected.outcome,
            transcriptRef: transcriptRef(sessionId),
        };
    }

    async abort(input: SessionAbortInput): Promise<SessionAbortResult> {
        const sessionId = sessionIdFromRef(input.externalRef);
        const aborted = await unwrap(
            this.client.session.abort({
                path: { id: sessionId },
                query: { directory: input.workspace },
                signal: input.signal,
            }),
            'abort session',
        );
        return { aborted };
    }

    async health(signal?: AbortSignal): Promise<SessionHealthResult> {
        try {
            await this.#sessions(this.directory, signal);
            return { healthy: true };
        } catch (error) {
            return { healthy: false, detail: redactError(error) };
        }
    }

    async *observe(
        input: SessionObserveInput,
    ): AsyncIterable<SessionObservation> {
        if (!this.client.event) return;
        try {
            const subscribed = await this.client.event.subscribe({
                query: { directory: this.directory },
                signal: input.signal,
                sseDefaultRetryDelay: 1_000,
                sseMaxRetryAttempts: input.maxRetryAttempts ?? 5,
                sseMaxRetryDelay: input.maxRetryDelayMs ?? 30_000,
            });
            for await (const event of subscribed.stream) {
                if (input.signal.aborted) return;
                const sessionId = eventSessionId(event);
                if (!sessionId) continue;
                const references = new Set(
                    input.externalRefs().map(reference => {
                        try {
                            return sessionIdFromRef(reference);
                        } catch {
                            return '';
                        }
                    }),
                );
                if (!references.has(sessionId)) continue;
                const normalized = normalizeEvent(event, sessionId);
                if (normalized) yield normalized;
            }
        } catch (error) {
            if (input.signal.aborted) return;
            throw new OpenCodeAdapterError('subscribe to events', error);
        }
    }
}

const loadLegacyClientFactory =
    async (): Promise<LegacyOpencodeClientFactory> => {
        // Kept dynamic until @opencode-ai/sdk is declared directly by the parent package.
        const moduleName = '@opencode-ai/sdk/client';
        const sdk = (await import(moduleName)) as {
            readonly createOpencodeClient?: LegacyOpencodeClientFactory;
        };
        if (typeof sdk.createOpencodeClient !== 'function') {
            throw new Error(
                'Legacy OpenCode SDK does not export createOpencodeClient.',
            );
        }
        const createOpencodeClient = sdk.createOpencodeClient;
        return ({ baseUrl }) => createOpencodeClient({ baseUrl });
    };

export const createOpenCodeAdapter = async (
    options: OpenCodeAdapterOptions,
): Promise<OpenCodeSessionAdapter> => {
    if (!options.baseUrl.trim())
        throw new TypeError('baseUrl must be nonempty.');
    if (!options.directory.trim())
        throw new TypeError('directory must be nonempty.');
    const client =
        options.client ??
        (options.clientFactory ?? (await loadLegacyClientFactory()))({
            baseUrl: options.baseUrl,
        });
    return new OpenCodeSessionAdapter(client, options.directory);
};
