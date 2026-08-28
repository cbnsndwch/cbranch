import { describe, expect, test } from 'vitest';

import {
    SCHEMA_VERSION,
    type AgentOutcome,
    type OutboxCommand,
} from './domain.js';
import {
    OpenCodeSessionAdapter,
    createOpenCodeAdapter,
    openCodePromptMessageId,
    openCodeSessionTitle,
    type LegacyOpencodeClient,
} from './opencode-adapter.js';
import type { SessionDispatchInput } from './supervisor.js';

type FakeMessage = {
    readonly info: {
        readonly id: string;
        readonly sessionID: string;
        readonly role: 'user' | 'assistant';
        readonly time: {
            readonly created: number;
            readonly completed?: number;
        };
        readonly finish?: string;
        readonly error?: unknown;
    };
    readonly parts: readonly {
        readonly type: string;
        readonly text?: string;
    }[];
};

class FakeLegacyClient implements LegacyOpencodeClient {
    readonly calls: {
        readonly list: unknown[];
        readonly create: unknown[];
        readonly status: unknown[];
        readonly messages: unknown[];
        readonly prompt: unknown[];
        readonly abort: unknown[];
        readonly events: unknown[];
    } = {
        list: [],
        create: [],
        status: [],
        messages: [],
        prompt: [],
        abort: [],
        events: [],
    };
    readonly sessions: Array<{
        readonly id: string;
        readonly title: string;
        readonly time: { readonly created: number; readonly updated: number };
    }> = [];
    readonly messageBySession = new Map<string, FakeMessage[]>();
    readonly statusBySession: Record<string, { type: 'idle' | 'busy' }> = {};
    streamEvents: unknown[] = [];

    readonly session: LegacyOpencodeClient['session'] = {
        list: async options => {
            this.calls.list.push(options);
            return { data: this.sessions };
        },
        create: async options => {
            this.calls.create.push(options);
            const session = {
                id: `session-${this.sessions.length + 1}`,
                title: options.body.title,
                time: {
                    created: this.sessions.length + 1,
                    updated: Date.now(),
                },
            };
            this.sessions.push(session);
            this.messageBySession.set(session.id, []);
            this.statusBySession[session.id] = { type: 'busy' };
            return { data: session };
        },
        status: async options => {
            this.calls.status.push(options);
            return { data: this.statusBySession };
        },
        messages: async options => {
            this.calls.messages.push(options);
            return { data: this.messageBySession.get(options.path.id) ?? [] };
        },
        promptAsync: async options => {
            this.calls.prompt.push(options);
            const messages = this.messageBySession.get(options.path.id) ?? [];
            if (
                messages.some(
                    message => message.info.id === options.body.messageID,
                )
            ) {
                return { data: undefined };
            }
            messages.push({
                info: {
                    id: options.body.messageID,
                    sessionID: options.path.id,
                    role: 'user',
                    time: { created: Date.now() },
                },
                parts: options.body.parts,
            });
            this.messageBySession.set(options.path.id, messages);
            return { data: undefined };
        },
        abort: async options => {
            this.calls.abort.push(options);
            return { data: true };
        },
    };

    readonly event: NonNullable<LegacyOpencodeClient['event']> = {
        subscribe: async options => {
            this.calls.events.push(options);
            const events = this.streamEvents;
            return {
                stream: (async function* () {
                    for (const event of events) yield event;
                })(),
            };
        },
    };
}

const command = (): OutboxCommand => ({
    schemaVersion: SCHEMA_VERSION,
    id: 'outbox-1',
    type: 'dispatch-attempt',
    goalId: 'goal-1',
    workUnitId: 'unit-1',
    attemptId: 'attempt-1',
    leaseToken: 'lease-1',
    idempotencyKey: 'attempt:attempt-1',
    payload: {
        kind: 'agent',
        input: {
            title: 'Implement runtime',
            instructions: 'Implement the requested runtime.',
            acceptanceCriteria: ['Must be idempotent'],
        },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
});

const dispatchInput = (): SessionDispatchInput => ({
    idempotencyKey: 'attempt:attempt-1',
    command: command(),
    workspace: '/workspace',
});

const outcome = (): AgentOutcome => ({
    schemaVersion: SCHEMA_VERSION,
    attemptId: 'attempt-1',
    leaseToken: 'lease-1',
    status: 'completed',
    summary: 'Runtime implemented.',
    evidenceRefs: [
        { ref: 'artifact:runtime', digest: `sha256:${'a'.repeat(64)}` },
    ],
    verificationRefs: [],
});

describe('OpenCodeSessionAdapter', () => {
    test('uses exact create/prompt shapes and is idempotent across restart', async () => {
        const client = new FakeLegacyClient();
        const first = new OpenCodeSessionAdapter(client, '/workspace');

        expect(await first.dispatch(dispatchInput())).toEqual({
            externalRef: 'opencode-session:session-1',
        });
        const restarted = new OpenCodeSessionAdapter(client, '/workspace');
        expect(await restarted.dispatch(dispatchInput())).toEqual({
            externalRef: 'opencode-session:session-1',
        });

        expect(client.calls.create).toEqual([
            {
                query: { directory: '/workspace' },
                body: { title: openCodeSessionTitle('attempt:attempt-1') },
                signal: undefined,
            },
        ]);
        expect(client.calls.prompt).toHaveLength(1);
        expect(client.calls.prompt[0]).toMatchObject({
            path: { id: 'session-1' },
            query: { directory: '/workspace' },
            body: { parts: [{ type: 'text' }] },
        });
        expect(
            (
                client.calls.prompt[0] as {
                    readonly body: { readonly messageID: string };
                }
            ).body.messageID,
        ).toBe(openCodePromptMessageId('attempt:attempt-1'));
        const prompt = (
            client.calls.prompt[0] as {
                readonly body: {
                    readonly parts: readonly [{ readonly text: string }];
                };
            }
        ).body.parts[0].text;
        expect(prompt).toContain('Attempt ID: attempt-1');
        expect(prompt).toContain('Lease token: lease-1');
        expect(prompt).toContain('whole JSON object');
    });

    test('coalesces concurrent dispatches for the same workspace and key', async () => {
        const client = new FakeLegacyClient();
        const adapter = new OpenCodeSessionAdapter(client, '/workspace');

        const [first, second] = await Promise.all([
            adapter.dispatch(dispatchInput()),
            adapter.dispatch(dispatchInput()),
        ]);

        expect(second).toEqual(first);
        expect(client.calls.create).toHaveLength(1);
        expect(client.calls.prompt).toHaveLength(1);
        expect(
            (
                client.calls.prompt[0] as {
                    readonly body: { readonly messageID: string };
                }
            ).body.messageID,
        ).toBe(openCodePromptMessageId('attempt:attempt-1'));
    });

    test('probes restart state from exact title, status, and messages', async () => {
        const client = new FakeLegacyClient();
        const adapter = new OpenCodeSessionAdapter(client, '/workspace');
        expect(
            await adapter.probe({
                ...dispatchInput(),
            }),
        ).toEqual({ status: 'absent' });
        await adapter.dispatch(dispatchInput());

        expect(
            await adapter.probe({
                ...dispatchInput(),
            }),
        ).toEqual({
            status: 'active',
            externalRef: 'opencode-session:session-1',
        });
        client.statusBySession['session-1'] = { type: 'idle' };
        expect(
            await adapter.probe({
                ...dispatchInput(),
            }),
        ).toEqual({
            status: 'active',
            externalRef: 'opencode-session:session-1',
        });
    });

    test('settles only whole-text AgentOutcome JSON and returns a pointer', async () => {
        const client = new FakeLegacyClient();
        const adapter = new OpenCodeSessionAdapter(client, '/workspace');
        await adapter.dispatch(dispatchInput());
        const messages = client.messageBySession.get('session-1')!;
        messages.push({
            info: {
                id: 'assistant-1',
                sessionID: 'session-1',
                role: 'assistant',
                time: { created: Date.now(), completed: Date.now() },
                finish: 'stop',
            },
            parts: [
                { type: 'text', text: `result: ${JSON.stringify(outcome())}` },
            ],
        });
        expect(
            await adapter.readOutcome({
                externalRef: 'opencode-session:session-1',
                attemptId: 'attempt-1',
                leaseToken: 'lease-1',
                workspace: '/workspace',
            }),
        ).toEqual({ status: 'active' });

        client.statusBySession['session-1'] = { type: 'idle' };
        expect(
            await adapter.readOutcome({
                externalRef: 'opencode-session:session-1',
                attemptId: 'attempt-1',
                leaseToken: 'lease-1',
                workspace: '/workspace',
            }),
        ).toMatchObject({ status: 'terminal-unknown' });

        messages.push({
            info: {
                id: 'assistant-2',
                sessionID: 'session-1',
                role: 'assistant',
                time: { created: Date.now() + 1, completed: Date.now() + 1 },
                finish: 'stop',
            },
            parts: [{ type: 'text', text: JSON.stringify(outcome()) }],
        });
        client.statusBySession['session-1'] = { type: 'busy' };
        expect(
            await adapter.readOutcome({
                externalRef: 'opencode-session:session-1',
                attemptId: 'attempt-1',
                leaseToken: 'lease-1',
                workspace: '/workspace',
            }),
        ).toEqual({
            status: 'completed',
            outcome: outcome(),
            transcriptRef: 'opencode-transcript:session-1',
        });
        expect(client.calls.abort).toHaveLength(1);
        messages.push({
            info: {
                id: 'assistant-residual',
                sessionID: 'session-1',
                role: 'assistant',
                time: { created: Date.now() + 2, completed: Date.now() + 2 },
                finish: 'stop',
                error: { name: 'AbortError' },
            },
            parts: [],
        });
        client.statusBySession['session-1'] = { type: 'idle' };
        expect(
            await adapter.readOutcome({
                externalRef: 'opencode-session:session-1',
                attemptId: 'attempt-1',
                leaseToken: 'lease-1',
                workspace: '/workspace',
            }),
        ).toMatchObject({ status: 'completed', outcome: outcome() });
        messages.pop();
        messages[2] = {
            ...messages[2]!,
            info: { ...messages[2]!.info, finish: 'tool-calls' },
        };
        client.statusBySession['session-1'] = { type: 'idle' };
        expect(
            await adapter.readOutcome({
                externalRef: 'opencode-session:session-1',
                attemptId: 'attempt-1',
                leaseToken: 'lease-1',
                workspace: '/workspace',
            }),
        ).toMatchObject({ status: 'terminal-unknown' });
        messages[2] = {
            ...messages[2]!,
            info: { ...messages[2]!.info, finish: 'stop' },
        };
        expect(
            await adapter.readOutcome({
                externalRef: 'opencode-session:session-1',
                attemptId: 'attempt-1',
                leaseToken: 'lease-1',
                workspace: '/workspace',
            }),
        ).toEqual({
            status: 'completed',
            outcome: outcome(),
            transcriptRef: 'opencode-transcript:session-1',
        });
    });

    test('aborts with exact path/query and normalizes only relevant events', async () => {
        const client = new FakeLegacyClient();
        const adapter = new OpenCodeSessionAdapter(client, '/workspace');
        client.streamEvents = [
            {
                type: 'session.status',
                properties: {
                    sessionID: 'session-1',
                    status: { type: 'idle' },
                },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'message-1',
                        sessionID: 'session-1',
                        role: 'assistant',
                    },
                },
            },
            {
                type: 'permission.updated',
                properties: { id: 'permission-1', sessionID: 'session-1' },
            },
            {
                type: 'session.error',
                properties: {
                    sessionID: 'unrelated',
                    error: { name: 'error' },
                },
            },
        ];
        const controller = new AbortController();
        const observations = [];
        for await (const observation of adapter.observe({
            externalRefs: () => ['opencode-session:session-1'],
            signal: controller.signal,
            maxRetryAttempts: 2,
            maxRetryDelayMs: 50,
        })) {
            observations.push(observation);
        }

        expect(observations.map(observation => observation.kind)).toEqual([
            'status',
            'progress',
            'decision',
        ]);
        expect(observations[0]?.data).toMatchObject({
            status: 'idle',
            schedulerAction: false,
        });
        expect(
            new Set(observations.map(item => item.deduplicationKey)).size,
        ).toBe(3);
        expect(
            await adapter.abort({
                externalRef: 'opencode-session:session-1',
                workspace: '/workspace',
                reason: 'cancel',
            }),
        ).toEqual({ aborted: true });
        expect(client.calls.abort).toEqual([
            {
                path: { id: 'session-1' },
                query: { directory: '/workspace' },
                signal: undefined,
            },
        ]);
    });

    test('constructs the legacy client with only baseUrl', async () => {
        const client = new FakeLegacyClient();
        const configs: unknown[] = [];
        const adapter = await createOpenCodeAdapter({
            baseUrl: 'http://127.0.0.1:4096',
            directory: '/workspace',
            clientFactory(config) {
                configs.push(config);
                return client;
            },
        });

        expect(adapter).toBeInstanceOf(OpenCodeSessionAdapter);
        expect(configs).toEqual([{ baseUrl: 'http://127.0.0.1:4096' }]);
    });
});
