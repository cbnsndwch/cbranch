import type { ArchitectureScene } from '../types';
import { citation } from './shared';

export const clientsScene: ArchitectureScene = {
    id: 'clients',
    label: 'Client delivery',
    shortLabel: 'Clients',
    description:
        'The same React application reaches the same host protocol from a browser or a Tauri WebView. Server-owned data and view-only state stay deliberately separate.',
    scope: 'Client processes and delivery adapters · the VS Code edge is marked as inactive',
    defaultNodeId: 'react-spa',
    nodes: [
        {
            id: 'browser-tab',
            label: 'Browser tab',
            eyebrow: 'Direct web delivery',
            kind: 'client',
            group: 'Delivery surfaces',
            position: { column: 0, row: 1 },
            height: 58,
            summary:
                'Loads the SPA from the host and connects back to its origin.',
            description:
                'For normal web delivery, the page derives ws/wss and http/https endpoints from window.location. The backend remains the source of all repository data.',
            responsibilities: [
                'Host DOM and browser WebSocket implementation',
                'Initiate user downloads through guarded HTTP routes',
            ],
            builtWith: ['Web platform', 'WebSocket', 'Fetch / downloads'],
            citations: [
                citation(
                    'packages/ui/src/rpc/client.ts',
                    86,
                    'Endpoint derivation',
                ),
            ],
            status: 'active',
        },
        {
            id: 'tauri-shell',
            label: 'Tauri shell',
            eyebrow: '@cbranch/tauri · Rust',
            kind: 'app',
            group: 'Delivery surfaces',
            position: { column: 0, row: 3 },
            height: 76,
            width: 108,
            summary: 'Owns profiles and exactly one forwarding child process.',
            description:
                'The Rust shell stores non-secret connection profiles, allocates a loopback port, spawns one owned OpenSSH forward, performs health preflight, and injects the resulting host endpoint into the WebView.',
            responsibilities: [
                'Persist validated connection profiles',
                'Own and reap only its own SSH forwarding child',
                'Probe backend identity before mounting Git UI',
            ],
            builtWith: ['Tauri 2', 'Rust', 'System OpenSSH'],
            citations: [
                citation(
                    'apps/tauri/src-tauri/src/lib.rs',
                    44,
                    'Profile and endpoint types',
                ),
                citation(
                    'apps/tauri/src-tauri/src/lib.rs',
                    281,
                    'Safe SSH argument vectors',
                ),
            ],
            status: 'active',
        },
        {
            id: 'ssh-forward',
            label: 'Owned SSH forward',
            eyebrow: 'ssh -N -L',
            kind: 'worker',
            group: 'Delivery surfaces',
            position: { column: 1, row: 3 },
            height: 62,
            summary:
                'Maps a local loopback port to the remote loopback host service.',
            description:
                'The child uses BatchMode, strict host-key checking, and ExitOnForwardFailure. It is transport only: no Git logic or credential material moves into the desktop app.',
            responsibilities: [
                'Forward RPC and HTTP bytes over SSH',
                'Use the user’s normal SSH agent and configuration',
                'Fail closed when host identity or auth is unavailable',
            ],
            builtWith: ['System ssh executable', 'Loopback TCP forwarding'],
            citations: [
                citation(
                    'apps/tauri/src-tauri/src/lib.rs',
                    281,
                    'Forward construction',
                ),
                citation(
                    'docs/spec/20-tauri-desktop-client.md',
                    7,
                    'SSH-forward transport',
                ),
            ],
            status: 'active',
        },
        {
            id: 'react-spa',
            label: 'React SPA',
            eyebrow: '@cbranch/ui',
            kind: 'app',
            group: 'Presentation runtime',
            position: { column: 2, row: 1 },
            height: 104,
            width: 116,
            summary:
                'The full Git workbench, with no Git process or filesystem logic.',
            description:
                'Routes and components render the app shell, repository views, dialogs, diffs, and plugins. A narrow CbranchApi facade prevents components from touching Effect transport details.',
            responsibilities: [
                'Render all product interaction surfaces',
                'Translate user intent into typed API calls',
                'Keep transport and Git execution outside React components',
            ],
            builtWith: ['React 19', 'React Router 8', 'Base UI', 'CodeMirror'],
            citations: [
                citation(
                    'packages/ui/src/components/AppShell.tsx',
                    73,
                    'Application shell',
                ),
                citation(
                    'packages/ui/src/rpc/api.ts',
                    1,
                    'Promise / subscription facade',
                ),
            ],
            status: 'active',
        },
        {
            id: 'query-cache',
            label: 'React Query cache',
            eyebrow: 'Host-synchronized data',
            kind: 'storage',
            group: 'Presentation runtime',
            position: { column: 3, row: 0 },
            height: 44,
            summary:
                'Caches server snapshots under repository and semantic-domain keys.',
            description:
                'This is an in-memory browser cache, not a database. InvalidationEvent domains select keys to invalidate; mounted queries then refetch canonical host state.',
            responsibilities: [
                'Own server-derived repository data',
                'Deduplicate and retry query work according to connection policy',
                'Reconcile optimistic mutations with invalidation refetch',
            ],
            builtWith: ['@tanstack/react-query', 'Domain-scoped query keys'],
            citations: [
                citation(
                    'packages/ui/src/rpc/connection-provider.tsx',
                    55,
                    'Connection-scoped QueryClient',
                ),
                citation(
                    'packages/ui/src/rpc/use-invalidation-bus.ts',
                    36,
                    'Domain-driven invalidation',
                ),
            ],
            status: 'active',
        },
        {
            id: 'zustand-state',
            label: 'Zustand view state',
            eyebrow: 'Per-tab and ephemeral',
            kind: 'storage',
            group: 'Presentation runtime',
            position: { column: 3, row: 2 },
            height: 38,
            summary:
                'Selection, dialog, layout, theme, and activity state only.',
            description:
                'Repository records never live here. The store carries UI concerns such as the active selection, dialog visibility, drafts, and bounded sync transcripts.',
            responsibilities: [
                'Own transient interaction state',
                'Reset connection-scoped selection when hosts change',
                'Avoid duplicating server-owned entities',
            ],
            builtWith: ['Zustand', 'Browser-local preferences'],
            citations: [
                citation(
                    'packages/ui/src/state/store.ts',
                    1,
                    'State ownership contract',
                ),
            ],
            status: 'active',
        },
        {
            id: 'rpc-client',
            label: 'RPC client runtime',
            eyebrow: 'Effect ManagedRuntime',
            kind: 'service',
            group: 'Presentation runtime',
            position: { column: 4, row: 1 },
            height: 80,
            summary:
                'One multiplexed socket and typed client per selected host.',
            description:
                'The runtime binds the shared RpcGroup to an NDJSON WebSocket. ConnectionProvider creates it, performs SystemInfo compatibility gating, and disposes both runtime and query cache when the endpoint changes.',
            responsibilities: [
                'Run unary and streaming RPC calls',
                'Own connection lifecycle and cancellation fibers',
                'Enforce protocol/version compatibility before mounting data consumers',
            ],
            builtWith: [
                'Effect ManagedRuntime',
                'Effect RPC client',
                'NDJSON WebSocket',
            ],
            citations: [
                citation(
                    'packages/ui/src/rpc/client.ts',
                    24,
                    'Typed client runtime',
                ),
                citation(
                    'packages/ui/src/rpc/connection-provider.tsx',
                    139,
                    'Handshake and teardown',
                ),
            ],
            status: 'active',
        },
        {
            id: 'http-routes',
            label: 'HTTP side channels',
            eyebrow: 'Same host listener',
            kind: 'service',
            group: 'Host endpoint',
            position: { column: 5, row: 0 },
            height: 54,
            summary:
                'Bounded routes for bytes that should not ride inline RPC.',
            description:
                'Blob downloads, archives, patch upload/download, and workspace avatars share the same guarded Node server. They are routes, not separate processes.',
            responsibilities: [
                'Move large or binary payloads outside JSON RPC',
                'Revalidate identifiers and enforce size limits',
                'Remain behind the same Origin/Host guard',
            ],
            builtWith: [
                'Effect HTTP routes',
                'Streaming bodies',
                'Bounded upload tokens',
            ],
            citations: [
                citation(
                    'apps/web-server/src/side-channel.ts',
                    96,
                    'Blob route',
                ),
                citation(
                    'apps/web-server/src/patch-channel.ts',
                    1,
                    'Bounded patch channel',
                ),
            ],
            status: 'active',
        },
        {
            id: 'host-endpoint',
            label: 'cbranch host',
            eyebrow: '/rpc · /healthz · static',
            kind: 'external',
            group: 'Host endpoint',
            position: { column: 5, row: 2 },
            height: 78,
            summary: 'The selected local or SSH-forwarded Node service.',
            description:
                'Every active client session resolves to one host endpoint. The UI uses /rpc for typed control and resolves side-channel descriptors against the paired HTTP base.',
            responsibilities: [
                'Serve the SPA for browser delivery',
                'Accept the single RPC WebSocket',
                'Expose health identity and guarded transfer routes',
            ],
            builtWith: ['Node HTTP', 'Effect RPC server'],
            citations: [
                citation(
                    'apps/web-server/src/server.ts',
                    39,
                    'Endpoint assembly',
                ),
            ],
            status: 'active',
        },
        {
            id: 'vscode-scaffold',
            label: 'VS Code extension',
            eyebrow: 'Placeholder only',
            kind: 'client',
            group: 'Delivery surfaces',
            position: { column: 1, row: 0 },
            height: 48,
            summary:
                'A typed package scaffold with no active transport implementation.',
            description:
                'The source exports only a version and contract placeholder type. The planned postMessage binding is specification, not a current runtime path, so no packet flow enters this node.',
            responsibilities: ['Reserve the future extension package boundary'],
            builtWith: [
                'TypeScript placeholder',
                '@cbranch/rpc-contract type import',
            ],
            citations: [
                citation(
                    'apps/vscode-ext/src/index.ts',
                    1,
                    'Explicit placeholder implementation',
                ),
            ],
            status: 'scaffold',
        },
    ],
    edges: [
        {
            id: 'browser-spa',
            from: 'browser-tab',
            to: 'react-spa',
            label: 'renders',
            kind: 'call',
        },
        {
            id: 'tauri-forward',
            from: 'tauri-shell',
            to: 'ssh-forward',
            label: 'spawns / owns',
            kind: 'spawn',
        },
        {
            id: 'forward-host',
            from: 'ssh-forward',
            to: 'host-endpoint',
            label: 'loopback tunnel',
            kind: 'network',
            bidirectional: true,
        },
        {
            id: 'tauri-spa',
            from: 'tauri-shell',
            to: 'react-spa',
            label: 'injects endpoint into WebView',
            kind: 'call',
            bend: -28,
        },
        {
            id: 'spa-query',
            from: 'react-spa',
            to: 'query-cache',
            label: 'server state',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'spa-zustand',
            from: 'react-spa',
            to: 'zustand-state',
            label: 'view state',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'spa-rpc',
            from: 'react-spa',
            to: 'rpc-client',
            label: 'CbranchApi calls',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'rpc-host',
            from: 'rpc-client',
            to: 'host-endpoint',
            label: 'one /rpc WebSocket',
            kind: 'rpc',
            bidirectional: true,
        },
        {
            id: 'spa-http',
            from: 'react-spa',
            to: 'http-routes',
            label: 'large / binary bytes',
            kind: 'network',
            bidirectional: true,
            bend: -22,
        },
        {
            id: 'http-host',
            from: 'http-routes',
            to: 'host-endpoint',
            label: 'same listener',
            kind: 'call',
        },
    ],
    flows: [
        {
            id: 'desktop-connect',
            label: 'Desktop → SSH-forwarded host',
            shortLabel: 'Desktop connect',
            summary:
                'The desktop shell creates a constrained tunnel, preflights the server, then gives the existing React connection layer ordinary ws/http loopback URLs.',
            color: '#58d6c7',
            steps: [
                {
                    edgeId: 'tauri-forward',
                    label: 'Spawn owned OpenSSH',
                    detail: 'A validated profile becomes an argument vector, never a shell string.',
                    payload:
                        'ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -p 22 -L 127.0.0.1:49152:127.0.0.1:7420 dev@host',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/tauri/src-tauri/src/lib.rs',
                            281,
                            'SSH argument construction',
                        ),
                    ],
                },
                {
                    edgeId: 'forward-host',
                    label: 'Probe /healthz',
                    detail: 'The local forward carries a bounded identity check to the remote loopback service.',
                    payload: 'GET /healthz',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'docs/spec/20-tauri-desktop-client.md',
                            22,
                            'Health preflight',
                        ),
                    ],
                },
                {
                    edgeId: 'tauri-spa',
                    phaseBreak:
                        'After the health preflight succeeds, the shell configures its WebView.',
                    label: 'Inject HostEndpoint',
                    detail: 'The WebView receives only loopback RPC and HTTP addresses.',
                    payload:
                        '{\n  "rpcUrl": "ws://127.0.0.1:49152/rpc",\n  "httpBaseUrl": "http://127.0.0.1:49152"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'apps/tauri/src-tauri/src/lib.rs',
                            73,
                            'TunnelConnection DTO',
                        ),
                    ],
                },
                {
                    edgeId: 'spa-rpc',
                    label: 'Create connection session',
                    detail: 'React creates a fresh runtime and cache for the selected endpoint.',
                    payload: 'makeAppRuntime(endpoint.rpcUrl)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/connection-provider.tsx',
                            139,
                            'Session creation',
                        ),
                    ],
                },
                {
                    edgeId: 'rpc-host',
                    label: 'SystemInfo handshake',
                    detail: 'Normal Git UI mounts only after protocol and backend versions pass.',
                    payload:
                        '{\n  "version": "0.2.4",\n  "protocolVersion": 1,\n  "capabilities": ["system-info", "loopback-rpc-v1", "side-channel-v1"]\n}',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            23,
                            'SystemInfo response',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'client-invalidation',
            label: 'Invalidation → query refetch',
            shortLabel: 'Cache refetch',
            summary:
                'A compact streamed domain event reaches the API facade, invalidates matching React Query keys, and triggers ordinary typed reads.',
            color: '#f3b95f',
            steps: [
                {
                    edgeId: 'rpc-host',
                    direction: 'reverse',
                    label: 'Receive RepoSubscribe item',
                    detail: 'The stream carries domain names only.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "domains": ["status", "commits"]\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'packages/ui/src/components/components.test.tsx',
                            318,
                            'Invalidation fixture',
                        ),
                    ],
                },
                {
                    edgeId: 'spa-rpc',
                    direction: 'reverse',
                    label: 'Subscription callback',
                    detail: 'The facade translates the Effect Stream into callback handlers and an unsubscribe.',
                    payload: 'onItem(event)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/api.ts',
                            1,
                            'Stream callback facade',
                        ),
                    ],
                },
                {
                    edgeId: 'spa-query',
                    label: 'Invalidate semantic keys',
                    detail: 'Each domain targets its repository-scoped cache subtree.',
                    payload: 'queryKey: [repoId, "status"]',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/use-invalidation-bus.ts',
                            36,
                            'Invalidate matching keys',
                        ),
                    ],
                },
                {
                    edgeId: 'spa-rpc',
                    phaseBreak:
                        'Mounted queries react to invalidation by starting a new unary read.',
                    label: 'Refetch typed snapshot',
                    detail: 'Mounted queries issue their normal unary reads again.',
                    payload: 'StatusGet({ repoId: "7f4a…" })',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            456,
                            'StatusGet catalog entry',
                        ),
                    ],
                },
            ],
        },
    ],
};
