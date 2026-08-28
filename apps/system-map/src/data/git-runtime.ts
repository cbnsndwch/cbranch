import type { ArchitectureScene } from '../types';
import { citation } from './shared';

export const gitRuntimeScene: ArchitectureScene = {
    id: 'git-runtime',
    label: 'Git request runtime',
    shortLabel: 'Git runtime',
    description:
        'Unary calls, streams, child processes, mutation fencing, object workers, and filesystem invalidation all converge here—inside one host process and one real repository.',
    scope: 'Active request path · in-process details are shown as such, not as network services',
    defaultNodeId: 'runtime-handlers',
    nodes: [
        {
            id: 'runtime-ui',
            label: 'React data hooks',
            eyebrow: 'CbranchApi + React Query',
            kind: 'client',
            group: 'Client process',
            position: { column: 0, row: 1 },
            height: 74,
            summary: 'Starts typed reads, mutations, and cancelable streams.',
            description:
                'Components depend on a Promise/subscription facade. React Query owns server state, while streaming operations retain unsubscribe functions that interrupt their RPC fibers.',
            responsibilities: [
                'Translate components into domain API calls',
                'Cache unary snapshots and consume stream items',
                'Cancel streams when users stop work or views unmount',
            ],
            builtWith: [
                'React Query',
                'CbranchApi facade',
                'Effect fibers behind facade',
            ],
            citations: [
                citation('packages/ui/src/rpc/api.ts', 1, 'UI API seam'),
                citation(
                    'packages/ui/src/components/Toolbar.tsx',
                    192,
                    'Cancelable sync streams',
                ),
            ],
            status: 'active',
        },
        {
            id: 'runtime-contract',
            label: 'RpcGroup + schemas',
            eyebrow: '@cbranch/rpc-contract',
            kind: 'contract',
            group: 'Shared library',
            position: { column: 1, row: 0 },
            height: 50,
            summary:
                'Compiles the same method and data model into client and server.',
            description:
                'This package validates both sides of the wire. Streaming flags live beside each method, and every Git failure uses the same tagged GitError record.',
            responsibilities: [
                'Declare request/success/error schemas',
                'Mark the six streaming RPC methods',
                'Provide the Effect RPC transport adapter',
            ],
            builtWith: ['Effect Schema', 'Effect RpcGroup'],
            citations: [
                citation(
                    'packages/rpc-contract/src/rpc/group.ts',
                    130,
                    'Method catalog',
                ),
                citation(
                    'packages/rpc-contract/src/schemas/errors.ts',
                    18,
                    'Canonical GitError',
                ),
            ],
            status: 'active',
        },
        {
            id: 'runtime-ws',
            label: 'Multiplexed /rpc',
            eyebrow: 'NDJSON WebSocket',
            kind: 'service',
            group: 'Host transport',
            position: { column: 2, row: 1 },
            height: 88,
            width: 104,
            summary:
                'One socket carries unary requests, six streams, and interruption.',
            description:
                'The Effect RPC client and server share NDJSON serialization over one WebSocket. This is a route on the Node host, not an independent service or one socket per method.',
            responsibilities: [
                'Multiplex request and stream frames',
                'Carry typed failures and interruption',
                'Stay behind the global origin and host guard',
            ],
            builtWith: ['Effect RPC socket protocol', 'NDJSON serialization'],
            citations: [
                citation(
                    'packages/ui/src/rpc/client.ts',
                    1,
                    'Client transport binding',
                ),
                citation(
                    'apps/web-server/src/server.ts',
                    42,
                    '/rpc route binding',
                ),
            ],
            status: 'active',
        },
        {
            id: 'runtime-guard',
            label: 'Origin / Host guard',
            eyebrow: 'Global trust boundary',
            kind: 'service',
            group: 'Host transport',
            position: { column: 2, row: 3 },
            height: 58,
            summary: 'Rejects untrusted hosts and origins before dispatch.',
            description:
                'The server is designed for loopback or a trusted perimeter, without app-level login. A single middleware protects static files, HTTP routes, preflight, and WebSocket upgrade.',
            responsibilities: [
                'Validate Host and Origin',
                'Allow exact desktop origins only under loopback rules',
                'Apply before any route-specific logic',
            ],
            builtWith: ['Effect HTTP middleware', 'Explicit allowlists'],
            citations: [
                citation(
                    'apps/web-server/src/origin-guard.ts',
                    27,
                    'Guard construction',
                ),
                citation(
                    'apps/web-server/src/server.ts',
                    85,
                    'Global middleware placement',
                ),
            ],
            status: 'active',
        },
        {
            id: 'runtime-handlers',
            label: 'RPC handlers',
            eyebrow: 'Thin translation layer',
            kind: 'service',
            group: 'Host process',
            position: { column: 3, row: 1 },
            height: 96,
            width: 106,
            summary:
                'Maps every wire tag to GitEngine without invoking Git itself.',
            description:
                'The toLayer mapping destructures request DTOs and delegates unary or streaming calls. Plugin methods are the deliberate exception: they enter PluginManager instead of GitEngine.',
            responsibilities: [
                'Translate RPC payloads to engine parameters',
                'Thread Effect and Stream values into the server runtime',
                'Keep Git process details out of transport code',
            ],
            builtWith: ['CbranchRpcs.toLayer', 'Effect', 'Stream'],
            citations: [
                citation(
                    'apps/web-server/src/rpc-handlers.ts',
                    23,
                    'Handler layer',
                ),
                citation(
                    'apps/web-server/src/rpc-handlers.ts',
                    197,
                    'Stage/commit mapping',
                ),
            ],
            status: 'active',
        },
        {
            id: 'runtime-engine',
            label: 'GitEngine facade',
            eyebrow: '@cbranch/core',
            kind: 'package',
            group: 'Host process',
            position: { column: 4, row: 1 },
            height: 92,
            width: 112,
            summary:
                'Resolves repositories and orchestrates focused Git modules.',
            description:
                'The live service holds maps for repository locations, locks, object pools, and watchers. Each public method returns contract DTOs or a typed stream.',
            responsibilities: [
                'Resolve RepoId to an active host path',
                'Apply mutation and resource lifecycle policy',
                'Delegate to staging, history, sync, conflict, and other modules',
            ],
            builtWith: [
                'Effect Context.Service',
                'Scoped maps',
                'Feature modules',
            ],
            citations: [
                citation(
                    'packages/core/src/engine/git-engine.ts',
                    99,
                    'Engine API',
                ),
                citation(
                    'packages/core/src/engine/live.ts',
                    259,
                    'Live resources',
                ),
            ],
            status: 'active',
        },
        {
            id: 'mutation-lock',
            label: 'Per-repo mutation lock',
            eyebrow: 'Fail-fast · in memory',
            kind: 'service',
            group: 'Engine resources',
            position: { column: 5, row: 0 },
            height: 44,
            width: 108,
            summary:
                'A busy boolean per RepoId; there is no waiting mutation queue.',
            description:
                'Acquisition atomically test-and-sets an in-memory cell. A second mutation fails with repoLocked. Scoped finalizers release on success, failure, or interruption; reads bypass it.',
            responsibilities: [
                'Prevent concurrent mutations of one repository',
                'Allow different repositories to mutate independently',
                'Hold pull and push permits for full stream lifetime',
            ],
            builtWith: ['Effect.acquireRelease', 'Map<RepoId, busy>'],
            citations: [
                citation(
                    'packages/core/src/git/locks.ts',
                    47,
                    'Actual fail-fast behavior',
                ),
                citation(
                    'packages/core/src/git/locks.test.ts',
                    11,
                    'Concurrency proof',
                ),
            ],
            status: 'active',
        },
        {
            id: 'git-process',
            label: 'Ephemeral Git child',
            eyebrow: 'runGit / streamGit',
            kind: 'worker',
            group: 'Host workers',
            position: { column: 6, row: 1 },
            height: 80,
            summary:
                'Argument-vector Git execution with cancellation and redacted logs.',
            description:
                'Normal operations spawn a host git child in the repository cwd. Reads add --no-optional-locks; the environment disables prompts and stabilizes locale. Interruption kills and reaps the child.',
            responsibilities: [
                'Execute one Git operation',
                'Capture child output or emit stream lines with interruption support',
                'Record safe command diagnostics',
            ],
            builtWith: [
                'node:child_process.spawn',
                'Abort through Effect scope',
            ],
            citations: [
                citation(
                    'packages/core/src/git/run-git.ts',
                    92,
                    'Unary runner',
                ),
                citation(
                    'packages/core/src/git/run-git.ts',
                    243,
                    'Streaming runner',
                ),
            ],
            status: 'active',
        },
        {
            id: 'cat-file-pool',
            label: 'Cat-file pool',
            eyebrow: '2 persistent Git children',
            kind: 'worker',
            group: 'Host workers',
            position: { column: 6, row: 3 },
            height: 68,
            width: 108,
            summary:
                'FIFO object bytes and metadata without per-object process startup.',
            description:
                'Each repository lazily owns git cat-file --batch and --batch-check. Requests and responses are matched in FIFO order; engine scope teardown kills both children.',
            responsibilities: [
                'Read immutable Git object bodies',
                'Check object type and size',
                'Reuse long-lived child processes safely',
            ],
            builtWith: ['git cat-file batch protocol', 'FIFO request arrays'],
            citations: [
                citation(
                    'packages/core/src/git/cat-file-pool.ts',
                    1,
                    'Pool design',
                ),
                citation(
                    'packages/core/src/git/cat-file-pool.ts',
                    157,
                    'Worker construction',
                ),
            ],
            status: 'active',
        },
        {
            id: 'repository-fs',
            label: 'Worktree + Git DB',
            eyebrow: 'Host filesystem truth',
            kind: 'database',
            group: 'Host resources',
            position: { column: 7, row: 2 },
            height: 52,
            width: 112,
            summary:
                'Index, refs, worktree files, and content-addressed objects.',
            description:
                'All operations target the user’s actual repository. Core caches only location and immutable object workers; mutable refs, status, and index state are reread after invalidation.',
            responsibilities: [
                'Persist all Git state',
                'Expose changes from cbranch and external terminal commands',
                'Provide the common directory used to derive RepoId',
            ],
            builtWith: ['Git filesystem layout', 'Host worktree'],
            citations: [
                citation(
                    'packages/core/src/repo/resolve.ts',
                    18,
                    'ResolvedRepo model',
                ),
            ],
            status: 'active',
        },
        {
            id: 'watcher-worker',
            label: 'Repository watcher',
            eyebrow: 'Shared Chokidar worker',
            kind: 'worker',
            group: 'Engine resources',
            position: { column: 5, row: 3 },
            height: 62,
            summary: 'Maps path churn into a closed set of semantic domains.',
            description:
                'A ref-counted watcher covers common Git dir and worktree, ignores object and generated churn, unions classified domains for 300 ms, then broadcasts to listeners.',
            responsibilities: [
                'Detect cbranch and out-of-band Git changes',
                'Classify refs/status/tags/stash/config/in-progress domains',
                'Tear down after the final subscriber leaves',
            ],
            builtWith: ['Chokidar 5', '300 ms union window'],
            citations: [
                citation(
                    'packages/core/src/git/watcher.ts',
                    1,
                    'Watcher behavior',
                ),
                citation(
                    'packages/core/src/git/watcher.ts',
                    163,
                    'Watcher lifecycle',
                ),
            ],
            status: 'active',
        },
        {
            id: 'stream-queue',
            label: 'Subscription queue',
            eyebrow: 'Per RepoSubscribe stream',
            kind: 'queue',
            group: 'Engine resources',
            position: { column: 4, row: 3 },
            height: 42,
            summary:
                'An in-process Effect queue bridging watcher callbacks to a stream.',
            description:
                'This queue is an implementation detail, not an external broker. Stream.callback offers watcher events into the queue and acquireRelease removes its listener on cancellation.',
            responsibilities: [
                'Bridge callback emissions into Effect Stream',
                'Tie listener cleanup to stream scope',
            ],
            builtWith: ['Effect Queue', 'Stream.callback', 'acquireRelease'],
            citations: [
                citation(
                    'packages/core/src/engine/live.ts',
                    554,
                    'RepoSubscribe queue bridge',
                ),
            ],
            status: 'active',
        },
        {
            id: 'git-remote',
            label: 'Git remote',
            eyebrow: 'External · SSH / HTTPS',
            kind: 'external',
            group: 'Outside host',
            position: { column: 7, row: 0 },
            height: 62,
            summary:
                'Receives fetch, pull, push, tag, and remote-ref operations.',
            description:
                'Network operations remain ordinary host Git commands, so existing SSH keys, agents, known_hosts, config, and credential helpers remain authoritative.',
            responsibilities: ['Exchange Git objects and refs with host Git'],
            builtWith: ['Configured Git transport', 'Host credential chain'],
            citations: [
                citation(
                    'packages/core/src/git/sync.ts',
                    166,
                    'Streaming remote operations',
                ),
            ],
            status: 'active',
        },
    ],
    edges: [
        {
            id: 'ui-ws',
            from: 'runtime-ui',
            to: 'runtime-ws',
            label: 'typed unary + streams',
            kind: 'rpc',
            bidirectional: true,
        },
        {
            id: 'contract-ui',
            from: 'runtime-contract',
            to: 'runtime-ui',
            label: 'client types',
            kind: 'dependency',
        },
        {
            id: 'contract-handlers',
            from: 'runtime-contract',
            to: 'runtime-handlers',
            label: 'server types',
            kind: 'dependency',
        },
        {
            id: 'guard-ws',
            from: 'runtime-guard',
            to: 'runtime-ws',
            label: 'guards upgrade',
            kind: 'call',
        },
        {
            id: 'ws-handlers',
            from: 'runtime-ws',
            to: 'runtime-handlers',
            label: 'decoded RPC',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'handlers-engine',
            from: 'runtime-handlers',
            to: 'runtime-engine',
            label: 'Effect / Stream',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'engine-lock',
            from: 'runtime-engine',
            to: 'mutation-lock',
            label: 'mutations only',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'engine-git-child',
            from: 'runtime-engine',
            to: 'git-process',
            label: 'spawn argv',
            kind: 'spawn',
            bidirectional: true,
        },
        {
            id: 'lock-git-child',
            from: 'mutation-lock',
            to: 'git-process',
            label: 'guarded mutation',
            kind: 'call',
        },
        {
            id: 'engine-cat-pool',
            from: 'runtime-engine',
            to: 'cat-file-pool',
            label: 'object requests',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'git-child-repo',
            from: 'git-process',
            to: 'repository-fs',
            label: 'read / write Git state',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'cat-pool-repo',
            from: 'cat-file-pool',
            to: 'repository-fs',
            label: 'immutable objects',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'repo-watcher',
            from: 'repository-fs',
            to: 'watcher-worker',
            label: 'path events',
            kind: 'filesystem',
        },
        {
            id: 'watcher-queue',
            from: 'watcher-worker',
            to: 'stream-queue',
            label: 'InvalidationEvent',
            kind: 'stream',
        },
        {
            id: 'queue-engine',
            from: 'stream-queue',
            to: 'runtime-engine',
            label: 'RepoSubscribe stream',
            kind: 'stream',
        },
        {
            id: 'git-child-remote',
            from: 'git-process',
            to: 'git-remote',
            label: 'host Git transport',
            kind: 'network',
            bidirectional: true,
        },
    ],
    flows: [
        {
            id: 'runtime-stage',
            label: 'Stage file → live reconciliation',
            shortLabel: 'Stage file',
            summary:
                'A typed StageFiles mutation passes the global guard, acquires the repository’s fail-fast lock, runs Git, then returns through the separate watcher stream.',
            color: '#f3b95f',
            steps: [
                {
                    edgeId: 'ui-ws',
                    label: 'Encode StageFiles',
                    detail: 'The request carries an ID and path array, not a command line.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "paths": ["a.ts"],\n  "all": false\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/hooks.status.test.tsx',
                            114,
                            'Observed UI call fixture',
                        ),
                    ],
                },
                {
                    edgeId: 'guard-ws',
                    phaseBreak:
                        'The request is shown again at the server trust boundary before dispatch.',
                    label: 'Authorize transport edge',
                    detail: 'Host and Origin checks run before the WebSocket request is dispatched.',
                    payload:
                        'Host: 127.0.0.1:7420\nOrigin: http://127.0.0.1:7420',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/origin-guard.ts',
                            69,
                            'Guard decision',
                        ),
                    ],
                },
                {
                    edgeId: 'ws-handlers',
                    label: 'Decode against RpcGroup',
                    detail: 'The StageFiles tag and payload are schema-checked.',
                    payload: 'tag: "StageFiles"',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            464,
                            'Catalog entry',
                        ),
                    ],
                },
                {
                    edgeId: 'handlers-engine',
                    label: 'Delegate to engine.stageFiles',
                    detail: 'The handler contains no Git implementation.',
                    payload: 'engine.stageFiles(repoId, paths, all)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            202,
                            'Stage handler',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-lock',
                    label: 'Try mutation permit',
                    detail: 'If busy, the effect fails immediately with repoLocked.',
                    payload: '{ "busy": false } → { "busy": true }',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/locks.ts',
                            63,
                            'Test-and-set acquisition',
                        ),
                    ],
                },
                {
                    edgeId: 'lock-git-child',
                    label: 'Run guarded Git mutation',
                    detail: 'The permit is held until the child effect completes or is interrupted.',
                    payload: 'git add -- a.ts',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/stage.ts',
                            16,
                            'Stage command',
                        ),
                    ],
                },
                {
                    edgeId: 'git-child-repo',
                    label: 'Write index',
                    detail: 'The host repository records the staged entry.',
                    payload: '.git/index',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/watcher.ts',
                            62,
                            'Index maps to status domain',
                        ),
                    ],
                },
                {
                    edgeId: 'repo-watcher',
                    label: 'Classify path event',
                    detail: 'The shared watcher sees the same disk change a terminal command would create.',
                    payload: 'index → ["status"]',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/watcher.ts',
                            49,
                            'Domain classifier',
                        ),
                    ],
                },
                {
                    edgeId: 'watcher-queue',
                    label: 'Offer invalidation',
                    detail: 'A per-subscription queue receives the coalesced DTO.',
                    payload: '{ "repoId": "7f4a…", "domains": ["status"] }',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/core/src/engine/live.ts',
                            554,
                            'Queue offer',
                        ),
                    ],
                },
                {
                    edgeId: 'queue-engine',
                    label: 'Yield RepoSubscribe item',
                    detail: 'The callback queue becomes a scoped Effect Stream.',
                    payload: 'Stream<InvalidationEvent, GitError>',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/engine/live.ts',
                            554,
                            'Stream bridge',
                        ),
                    ],
                },
                {
                    edgeId: 'handlers-engine',
                    direction: 'reverse',
                    label: 'Pass streaming item',
                    detail: 'The server handler unwraps the engine stream without changing the event.',
                    payload: 'RepoSubscribe item',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            172,
                            'Subscription handler',
                        ),
                    ],
                },
                {
                    edgeId: 'ui-ws',
                    direction: 'reverse',
                    phaseBreak:
                        'The engine stream item has reached the RPC transport and is forwarded to the UI.',
                    label: 'Invalidate status query',
                    detail: 'The browser refetches a full status snapshot.',
                    payload: 'invalidateQueries(domainKey(repoId, "status"))',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/use-invalidation-bus.ts',
                            36,
                            'Client invalidation',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'runtime-push',
            label: 'Push stream → remote',
            shortLabel: 'Push stream',
            summary:
                'Push keeps the repository lock for the entire cancelable child stream and sends only progress/refUpdate items back over the multiplexed socket.',
            color: '#9b8cff',
            steps: [
                {
                    edgeId: 'ui-ws',
                    label: 'Start PushStream',
                    detail: 'The client starts consuming a typed stream.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "remote": "origin",\n  "branch": "main",\n  "setUpstream": true,\n  "forceWithLease": false,\n  "tags": false\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            644,
                            'Push payload',
                        ),
                    ],
                },
                {
                    edgeId: 'ws-handlers',
                    label: 'Route PushStream',
                    detail: 'The RPC layer keeps stream cancellation correlated to its request.',
                    payload: 'requestId: "rpc-42"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            286,
                            'Push handler',
                        ),
                    ],
                },
                {
                    edgeId: 'handlers-engine',
                    label: 'Open engine stream',
                    detail: 'GitEngine resolves the repository before constructing its sync stream.',
                    payload: 'engine.pushStream(repoId, remote, branch, …)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/engine/live.ts',
                            913,
                            'Push stream composition',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-lock',
                    label: 'Acquire stream permit',
                    detail: 'The permit remains live until stream scope closure.',
                    payload: 'withRepoLockStream(repoId)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/locks.ts',
                            93,
                            'Stream lock wrapper',
                        ),
                    ],
                },
                {
                    edgeId: 'lock-git-child',
                    label: 'Spawn git push',
                    detail: 'The child uses porcelain/progress output and no interactive prompts.',
                    payload: 'git push --porcelain --progress origin main',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/sync.ts',
                            216,
                            'Push child',
                        ),
                    ],
                },
                {
                    edgeId: 'git-child-remote',
                    label: 'Exchange refs and objects',
                    detail: 'The Git child uses the host credential chain.',
                    payload: 'main → refs/heads/main',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/sync.test.ts',
                            147,
                            'Real remote test',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-git-child',
                    direction: 'reverse',
                    phaseBreak:
                        'Remote output returns through the Git child before the engine parses it.',
                    label: 'Parse child output',
                    detail: 'Each complete line becomes progress or refUpdate.',
                    payload:
                        '{\n  "_tag": "progress",\n  "text": "Writing objects: 100%"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/branches.ts',
                            66,
                            'Sync event schema',
                        ),
                    ],
                },
                {
                    edgeId: 'ui-ws',
                    direction: 'reverse',
                    phaseBreak:
                        'The parsed stream item has reached the WebSocket transport and is forwarded to the UI.',
                    label: 'Render progress',
                    detail: 'The event reaches the bounded session activity transcript.',
                    payload: 'activity.events += "Writing objects: 100%"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/components/SessionActivityPanel.tsx',
                            118,
                            'Progress display',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'runtime-object-read',
            label: 'Revision blob → persistent pool',
            shortLabel: 'Object read',
            summary:
                'Object-heavy reads reuse the repository’s two long-lived cat-file workers while ordinary mutable state still comes from fresh Git commands.',
            color: '#58d6c7',
            steps: [
                {
                    edgeId: 'ui-ws',
                    label: 'Request file at revision',
                    detail: 'A repository, revision, and path identify immutable blob data.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "path": "src/app.ts",\n  "rev": "HEAD"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            447,
                            'FileContentAtRev payload',
                        ),
                    ],
                },
                {
                    edgeId: 'handlers-engine',
                    phaseBreak:
                        'The decoded RPC has reached its handler; this scene omits the short WebSocket-to-handler relay.',
                    label: 'Delegate immutable read',
                    detail: 'The handler enters the same GitEngine facade.',
                    payload: 'engine.fileContentAtRev(repoId, path, rev)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            192,
                            'File content handler',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-cat-pool',
                    label: 'Enqueue object request',
                    detail: 'The repository-scoped pool preserves request/response order.',
                    payload: 'batch-check.write("HEAD:src/app.ts\\n")',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/cat-file-pool.ts',
                            51,
                            'FIFO protocol',
                        ),
                    ],
                },
                {
                    edgeId: 'cat-pool-repo',
                    label: 'Read content-addressed object',
                    detail: 'The persistent Git child reads the immutable object database.',
                    payload: 'HEAD:src/app.ts → blob 248',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/cat-file-pool.ts',
                            157,
                            'Batch worker startup',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-cat-pool',
                    direction: 'reverse',
                    phaseBreak:
                        'The persistent Git worker has read the blob; parsed bytes return from the pool to core.',
                    label: 'Return parsed bytes',
                    detail: 'Core classifies the bytes and constructs an inline FileContent result when it is below the cap.',
                    payload:
                        '{\n  "path": "src/app.ts",\n  "size": 248,\n  "isBinary": false,\n  "encoding": "utf8",\n  "content": "export …"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/domain.ts',
                            189,
                            'FileContent schema',
                        ),
                        citation(
                            'packages/core/src/git/content.ts',
                            52,
                            'Pool-backed content read',
                        ),
                    ],
                },
                {
                    edgeId: 'ui-ws',
                    direction: 'reverse',
                    phaseBreak:
                        'The typed result has reached the WebSocket transport and is returned to React Query.',
                    label: 'Cache revision blob',
                    detail: 'The immutable result is stored under its repository, revision, and path key.',
                    payload: '[repoId, "blob", rev, path]',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/query-keys.ts',
                            58,
                            'Revision blob query key',
                        ),
                    ],
                },
            ],
        },
    ],
};
