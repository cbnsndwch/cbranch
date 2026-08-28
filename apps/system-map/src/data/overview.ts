import type { ArchitectureScene } from '../types';
import { citation, overviewCitations as c } from './shared';

export const overviewScene: ArchitectureScene = {
    id: 'overview',
    label: 'cbranch system',
    shortLabel: 'System',
    description:
        'The browser and desktop surfaces stay presentation-only. One guarded Node host owns transport, Git orchestration, trusted plugins, and access to the real repository.',
    scope: 'Semantic runtime overview · packages are shown only when they define a boundary',
    defaultNodeId: 'host-service',
    nodes: [
        {
            id: 'client-surfaces',
            label: 'Client surfaces',
            eyebrow: 'Browser · Tauri · VS Code scaffold',
            kind: 'client',
            group: 'Client',
            position: { column: 0, row: 1 },
            height: 92,
            width: 118,
            depth: 78,
            summary:
                'React presentation delivered through browser-shaped clients.',
            description:
                'The React SPA contains views and client state, but no Git implementation. Browsers connect directly; the Tauri shell forwards the same endpoint over owned OpenSSH. The VS Code package is still a placeholder.',
            responsibilities: [
                'Render repository, history, diff, branch, and plugin workflows',
                'Own server data in React Query and transient view state in Zustand',
                'Establish and dispose one connection-scoped RPC runtime',
            ],
            builtWith: [
                'React 19 + React Router',
                'TanStack Query',
                'Zustand',
                'Tauri WebView + Rust bridge',
            ],
            citations: [
                citation(
                    'packages/ui/src/rpc/client.ts',
                    1,
                    'One multiplexed RPC client',
                ),
                citation(
                    'packages/ui/src/state/store.ts',
                    1,
                    'Ephemeral UI state boundary',
                ),
                citation(
                    'apps/tauri/src-tauri/src/lib.rs',
                    1,
                    'Desktop transport ownership',
                ),
                citation(
                    'apps/vscode-ext/src/index.ts',
                    1,
                    'Placeholder status',
                ),
            ],
            childSceneId: 'clients',
            status: 'active',
        },
        {
            id: 'rpc-contract',
            label: 'Typed RPC contract',
            eyebrow: '@cbranch/rpc-contract',
            kind: 'contract',
            group: 'Shared boundary',
            position: { column: 1, row: 0 },
            height: 52,
            summary:
                'The one schema and method catalog compiled into both ends.',
            description:
                'This is a shared library, not a network hop. It owns RPC tags, request and success schemas, streaming declarations, and the canonical GitError union.',
            responsibilities: [
                'Define the CbranchRpcs method catalog',
                'Validate wire payloads with Effect Schema',
                'Quarantine unstable Effect transport imports behind one adapter',
            ],
            builtWith: [
                'Effect Schema',
                'Effect RPC adapter',
                'Branded wire IDs',
            ],
            citations: [
                c.rpcGroup,
                citation(
                    'packages/rpc-contract/src/effect-rpc-adapter.ts',
                    21,
                    'Unstable API quarantine',
                ),
            ],
            status: 'active',
        },
        {
            id: 'host-service',
            label: 'Node host service',
            eyebrow: '@cbranch/web-server · :7420',
            kind: 'service',
            group: 'Host runtime',
            position: { column: 2, row: 1 },
            height: 118,
            width: 116,
            depth: 82,
            summary:
                'The only listening process and the runtime composition root.',
            description:
                'One Effect-powered Node HTTP server serves the built SPA, the multiplexed /rpc WebSocket, /healthz, and bounded HTTP side channels behind a global Host/Origin guard.',
            responsibilities: [
                'Open the only listening socket in the workspace',
                'Decode RPC and delegate to GitEngine or PluginManager',
                'Serve guarded static and large-byte routes',
            ],
            builtWith: [
                '@effect/platform-node',
                'NDJSON WebSocket RPC',
                'Node HTTP server',
            ],
            citations: [c.server, c.handlers],
            childSceneId: 'git-runtime',
            status: 'active',
        },
        {
            id: 'git-engine',
            label: 'GitEngine',
            eyebrow: '@cbranch/core',
            kind: 'package',
            group: 'Host runtime',
            position: { column: 3, row: 1 },
            height: 88,
            width: 112,
            summary: 'The transport-agnostic facade for every Git capability.',
            description:
                'Handlers call a single Effect service. It resolves repository identity, fail-fast fences concurrent mutations, manages object workers and watchers, and delegates to focused Git feature modules.',
            responsibilities: [
                'Expose typed Effect and Stream operations',
                'Key repository resources by common Git directory identity',
                'Keep transport and browser concepts out of core',
            ],
            builtWith: [
                'Effect Context service',
                'Feature modules',
                'Scoped registries',
            ],
            citations: [c.engine, c.engineLive],
            childSceneId: 'git-runtime',
            status: 'active',
        },
        {
            id: 'host-git',
            label: 'Host Git workers',
            eyebrow: 'git child processes',
            kind: 'worker',
            group: 'Host resources',
            position: { column: 4, row: 1 },
            height: 76,
            summary:
                'Real host Git, including two persistent object-read workers.',
            description:
                'Commands run against the actual working directory with a non-interactive environment. Hot object reads use long-lived cat-file --batch and --batch-check children.',
            responsibilities: [
                'Execute local Git reads and mutations',
                'Use host SSH agents and credential helpers for remotes',
                'Terminate child work when its Effect scope is interrupted',
            ],
            builtWith: [
                'node:child_process',
                'git CLI',
                'cat-file batch protocol',
            ],
            citations: [
                c.runner,
                citation(
                    'packages/core/src/git/cat-file-pool.ts',
                    1,
                    'Persistent object readers',
                ),
            ],
            childSceneId: 'git-runtime',
            status: 'active',
        },
        {
            id: 'repository',
            label: 'Repository + .git',
            eyebrow: 'Real host filesystem',
            kind: 'database',
            group: 'Host resources',
            position: { column: 5, row: 2 },
            height: 48,
            width: 112,
            depth: 72,
            summary:
                'The source of truth: worktree, refs, index, and object database.',
            description:
                'cbranch operates on the real on-disk repository. A SHA-256 identity of the canonical common Git directory makes sibling worktrees share locks, pools, and watchers.',
            responsibilities: [
                'Persist Git objects, refs, index, and worktree files',
                'Emit filesystem changes visible to both cbranch and terminal Git',
                'Remain authoritative; the browser never owns a repository copy',
            ],
            builtWith: [
                'Git object database',
                'Host filesystem',
                'Common-dir identity',
            ],
            citations: [
                citation(
                    'packages/core/src/repo/resolve.ts',
                    33,
                    'Repository resolution',
                ),
                citation(
                    'packages/core/src/git/repo-id.ts',
                    20,
                    'Common-dir identity',
                ),
                c.watcher,
            ],
            childSceneId: 'git-runtime',
            status: 'active',
        },
        {
            id: 'runtime-plugins',
            label: 'Runtime plugins',
            eyebrow: 'Trusted in-process ESM',
            kind: 'service',
            group: 'Host runtime',
            position: { column: 2, row: 3 },
            height: 82,
            summary:
                'Reviewed extensions loaded with the host user’s authority.',
            description:
                'Plugin RPCs bypass GitEngine and enter PluginManager. Signed metadata, hashes, grants, artifacts, and lock state are checked before a reviewed ESM module is dynamically imported in the host process.',
            responsibilities: [
                'Refresh TUF catalogs and review artifacts before install',
                'Persist grants, lock records, artifacts, and audit events',
                'Invoke declarative commands through trusted plugin hooks',
            ],
            builtWith: [
                '@cbranch/plugin-contract',
                '@cbranch/plugin-runtime',
                'TUF metadata',
                'Dynamic ESM import',
            ],
            citations: [
                c.pluginManager,
                citation(
                    'apps/web-server/src/trusted-plugin-host.ts',
                    1,
                    'Explicit trust model',
                ),
            ],
            childSceneId: 'plugins',
            status: 'active',
        },
        {
            id: 'goal-supervisor',
            label: 'Goal supervisor',
            eyebrow: 'Adjacent workspace tool',
            kind: 'service',
            group: 'Adjacent tooling',
            position: { column: 0, row: 3 },
            height: 84,
            width: 114,
            summary:
                'A separate durable control loop for supervised OpenCode goals.',
            description:
                'This publishable package is not on the cbranch Git request path. It exposes CLI, TUI, daemon, and MCP surfaces over a durable SQLite store and an OpenCode session adapter.',
            responsibilities: [
                'Lease, dispatch, reconcile, and verify goal work',
                'Persist goal, attempt, outbox, evidence, and approval state',
                'Fence operator-only approvals from model-facing MCP tools',
            ],
            builtWith: [
                'Node.js',
                'better-sqlite3',
                'Zod',
                'MCP SDK',
                'OpenCode SDK',
            ],
            citations: [
                c.supervisor,
                citation(
                    'packages/opencode-goal-supervisor/package.json',
                    1,
                    'Independent package boundary',
                ),
            ],
            childSceneId: 'supervisor',
            status: 'adjacent',
        },
        {
            id: 'host-config',
            label: 'Host config files',
            eyebrow: 'config.json · plugin data',
            kind: 'storage',
            group: 'Host resources',
            position: { column: 4, row: 3 },
            height: 42,
            width: 104,
            summary: 'Human-readable settings and host-private plugin state.',
            description:
                'Core persists recents, workspaces, settings, and keybindings in atomic JSON. The host service keeps plugin repositories, audit records, lock records, and verified artifacts in a private data directory.',
            responsibilities: [
                'Persist app settings and recent repositories',
                'Persist plugin metadata without storing repository secrets',
                'Use atomic replacement for mutable JSON state',
            ],
            builtWith: ['JSON files', 'Atomic rename', 'Host data directory'],
            citations: [
                citation(
                    'packages/core/src/config/config-store.ts',
                    1,
                    'Core configuration store',
                ),
                citation(
                    'apps/web-server/src/plugin-lock-store.ts',
                    19,
                    'Plugin lock persistence',
                ),
            ],
            status: 'active',
        },
        {
            id: 'external-systems',
            label: 'External systems',
            eyebrow: 'Git remotes · registries · OpenCode',
            kind: 'external',
            group: 'Outside host',
            position: { column: 5, row: 0 },
            height: 64,
            width: 122,
            summary: 'Systems reached by explicit host-owned adapters.',
            description:
                'Host Git reaches configured remotes; the plugin manager reaches signed HTTPS repositories; the adjacent supervisor talks to OpenCode. Credentials remain with host tooling and transport-specific stores.',
            responsibilities: [
                'Accept Git fetch/push traffic',
                'Serve signed plugin metadata and immutable artifacts',
                'Run externally referenced OpenCode sessions',
            ],
            builtWith: ['SSH / HTTPS', 'TUF repository', 'OpenCode API'],
            citations: [
                citation(
                    'packages/core/src/git/sync.ts',
                    166,
                    'Remote Git operations',
                ),
                citation(
                    'apps/web-server/src/plugin-repository-transport.ts',
                    1,
                    'Plugin repository transport',
                ),
                c.supervisor,
            ],
            status: 'active',
        },
    ],
    edges: [
        {
            id: 'clients-host',
            from: 'client-surfaces',
            to: 'host-service',
            label: 'NDJSON /rpc + HTTP side channels',
            kind: 'rpc',
            bidirectional: true,
        },
        {
            id: 'contract-clients',
            from: 'rpc-contract',
            to: 'client-surfaces',
            label: 'typed client catalog',
            kind: 'dependency',
        },
        {
            id: 'contract-host',
            from: 'rpc-contract',
            to: 'host-service',
            label: 'typed server catalog',
            kind: 'dependency',
        },
        {
            id: 'host-engine',
            from: 'host-service',
            to: 'git-engine',
            label: 'Effect calls / streams',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'engine-git',
            from: 'git-engine',
            to: 'host-git',
            label: 'spawn / batch protocol',
            kind: 'spawn',
            bidirectional: true,
        },
        {
            id: 'git-repository',
            from: 'host-git',
            to: 'repository',
            label: 'read / mutate',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'repository-engine-watch',
            from: 'repository',
            to: 'git-engine',
            label: 'coalesced invalidation',
            kind: 'stream',
            bend: 64,
        },
        {
            id: 'git-external',
            from: 'host-git',
            to: 'external-systems',
            label: 'host SSH / credentials',
            kind: 'network',
            bidirectional: true,
        },
        {
            id: 'host-plugins',
            from: 'host-service',
            to: 'runtime-plugins',
            label: 'plugin RPC delegation',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'plugins-external',
            from: 'runtime-plugins',
            to: 'external-systems',
            label: 'signed metadata + artifacts',
            kind: 'network',
            bidirectional: true,
            bend: -38,
        },
        {
            id: 'supervisor-external',
            from: 'goal-supervisor',
            to: 'external-systems',
            label: 'OpenCode sessions',
            kind: 'network',
            bidirectional: true,
            bend: 72,
        },
        {
            id: 'engine-config',
            from: 'git-engine',
            to: 'host-config',
            label: 'settings / recents',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'plugins-config',
            from: 'runtime-plugins',
            to: 'host-config',
            label: 'locks / audit / artifacts',
            kind: 'filesystem',
            bidirectional: true,
        },
    ],
    flows: [
        {
            id: 'open-live-state',
            label: 'Open repository → live state',
            shortLabel: 'Open + live',
            summary:
                'Open a host path, resolve its Git identity, return a typed handle, then keep cached views fresh with domain invalidations.',
            color: '#58d6c7',
            steps: [
                {
                    edgeId: 'clients-host',
                    label: 'RepoOpen request',
                    detail: 'The SPA asks the guarded host to open an existing path.',
                    payload: '{\n  "path": "/repos/demo"\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/api.test.ts',
                            24,
                            'Repository-open fixture',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    label: 'Delegate to GitEngine.open',
                    detail: 'The RPC handler crosses the sole Git orchestration boundary.',
                    payload: 'engine.open("/repos/demo")',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            75,
                            'RepoOpen handler',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-git',
                    label: 'Resolve repository',
                    detail: 'Core classifies the repository, then resolves the worktree root with a second probe when applicable.',
                    payload:
                        'git --no-optional-locks rev-parse --is-bare-repository --is-inside-work-tree --absolute-git-dir --git-common-dir\ngit --no-optional-locks rev-parse --show-toplevel',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/repo/resolve.ts',
                            51,
                            'Repository probes',
                        ),
                    ],
                },
                {
                    edgeId: 'git-repository',
                    label: 'Read worktree and Git metadata',
                    detail: 'Git resolves HEAD, the working root, and shared common directory.',
                    payload: '.git/HEAD\n.git/index\nrefs/heads/main',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/repo/state.ts',
                            24,
                            'Repository state reads',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    direction: 'reverse',
                    phaseBreak:
                        'Host Git has completed; the trace resumes where its result enters GitEngine.',
                    label: 'RepoHandle result',
                    detail: 'The engine returns the resolved identity and state as contract data.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "root": "/repos/demo",\n  "gitDir": "/repos/demo/.git",\n  "state": { "currentBranch": "main", "inProgress": "none" }\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/domain.ts',
                            99,
                            'RepoState and RepoHandle schemas',
                        ),
                    ],
                },
                {
                    edgeId: 'clients-host',
                    direction: 'reverse',
                    label: 'Render host state',
                    detail: 'React Query stores the server snapshot under repository-scoped keys.',
                    payload:
                        '{\n  "currentBranch": "main",\n  "isDetached": false,\n  "isBare": false\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/connection-provider.tsx',
                            139,
                            'Connection-scoped query cache',
                        ),
                    ],
                },
                {
                    edgeId: 'repository-engine-watch',
                    phaseBreak:
                        'A later filesystem change starts the independent live-invalidation phase.',
                    label: 'Filesystem change',
                    detail: 'A terminal or cbranch mutation changes refs, index, or worktree files.',
                    payload: '.git/index → ["status"]',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/watcher.ts',
                            49,
                            'Changed-path classification',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    direction: 'reverse',
                    label: 'RepoSubscribe event',
                    detail: 'The scoped stream queue carries semantic domains, not row deltas.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "domains": ["status", "commits", "refs"]\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/live.ts',
                            28,
                            'InvalidationEvent schema',
                        ),
                    ],
                },
                {
                    edgeId: 'clients-host',
                    direction: 'reverse',
                    label: 'Invalidate and refetch',
                    detail: 'The UI invalidates each affected domain key and reruns mounted queries.',
                    payload: 'invalidateQueries([repoId, "status"])',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/use-invalidation-bus.ts',
                            36,
                            'Domain invalidation loop',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'stage-commit',
            label: 'Stage → commit → reconcile',
            shortLabel: 'Stage + commit',
            summary:
                'Two structured mutations cross the RPC boundary, independently acquire the fail-fast repository lock, and let disk events trigger canonical refetch.',
            color: '#f3b95f',
            steps: [
                {
                    edgeId: 'clients-host',
                    label: 'StageFiles request',
                    detail: 'The UI sends paths, never shell text.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "paths": ["src/app.ts"],\n  "all": false\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            464,
                            'StageFiles payload',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    label: 'Acquire stage scope',
                    detail: 'GitEngine resolves the repository and fail-fast acquires its lock for the stage call.',
                    payload: 'stageFiles → withRepoLock(repoId) → acquired',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/engine/live.ts',
                            734,
                            'Stage mutation lock',
                        ),
                        citation(
                            'packages/core/src/git/locks.ts',
                            47,
                            'Fail-fast lock implementation',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-git',
                    label: 'Run git add',
                    detail: 'The stage operation passes a path-safe argument vector to host Git.',
                    payload: 'git add -- src/app.ts',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/stage.ts',
                            16,
                            'Stage arguments',
                        ),
                    ],
                },
                {
                    edgeId: 'git-repository',
                    label: 'Update index',
                    detail: 'The first mutation changes only the real repository index.',
                    payload: '.git/index',
                    evidence: 'implementation-derived',
                    citations: [c.architecture],
                },
                {
                    edgeId: 'clients-host',
                    direction: 'reverse',
                    phaseBreak:
                        'The stage child has completed; the trace resumes at the unary RPC return.',
                    label: 'StageFiles completes',
                    detail: 'The first unary RPC returns void after the stage lock is released.',
                    payload: 'void',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            464,
                            'StageFiles success schema',
                        ),
                    ],
                },
                {
                    edgeId: 'clients-host',
                    label: 'CommitCreate request',
                    detail: 'Commit creation is a separate typed RPC call with explicit flags.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "subject": "feat: map architecture",\n  "amend": false,\n  "signoff": false,\n  "allowEmpty": false,\n  "noVerify": false\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/working-tree.ts',
                            91,
                            'CommitInput schema',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    label: 'Acquire commit scope',
                    detail: 'The distinct commit call independently acquires the same fail-fast repository lock.',
                    payload: 'commitCreate → withRepoLock(repoId) → acquired',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/engine/live.ts',
                            782,
                            'Commit mutation lock',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-git',
                    label: 'Create commit',
                    detail: 'Host Git receives an argument array and the composed message bytes on stdin.',
                    payload: 'git commit -F -\nstdin: "feat: map architecture"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/commit-write.ts',
                            39,
                            'Commit execution',
                        ),
                    ],
                },
                {
                    edgeId: 'git-repository',
                    label: 'Write object and ref',
                    detail: 'The second mutation writes commit objects and advances the current ref.',
                    payload: '.git/objects/…\nrefs/heads/main',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/commit-write.ts',
                            66,
                            'Commit write and result reads',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    direction: 'reverse',
                    phaseBreak:
                        'The commit child has completed; the trace resumes at the engine result.',
                    label: 'Build CommitCreated',
                    detail: 'The engine returns the new full and abbreviated object IDs to the handler.',
                    payload:
                        '{\n  "oid": "1111111111111111111111111111111111111111",\n  "shortOid": "1111111",\n  "subject": "feat: map architecture"\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/working-tree.test.ts',
                            68,
                            'Commit fixture',
                        ),
                    ],
                },
                {
                    edgeId: 'clients-host',
                    direction: 'reverse',
                    label: 'Deliver CommitCreated',
                    detail: 'The second unary RPC carries the typed success back to the client.',
                    payload:
                        '{\n  "oid": "1111111111111111111111111111111111111111",\n  "shortOid": "1111111",\n  "subject": "feat: map architecture"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/working-tree.ts',
                            118,
                            'CommitCreated schema',
                        ),
                    ],
                },
                {
                    edgeId: 'repository-engine-watch',
                    phaseBreak:
                        'A later filesystem notification starts the independent watcher phase.',
                    label: 'Coalesce repository changes',
                    detail: 'The watcher unions a burst of index and ref events over 300 ms.',
                    payload:
                        '{\n  "domains": ["status", "refs", "commits", "inProgress"]\n}',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/watcher.ts',
                            202,
                            'Coalescing and broadcast',
                        ),
                    ],
                },
                {
                    edgeId: 'clients-host',
                    direction: 'reverse',
                    phaseBreak:
                        'The subscription item has reached the host transport and is forwarded to the client.',
                    label: 'Canonical reconciliation',
                    detail: 'Invalidated queries replace any optimistic status state with host truth.',
                    payload: 'domains → status/log/refs query refetch',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/rpc/use-invalidation-bus.ts',
                            36,
                            'Client reconciliation',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'push-remote',
            label: 'Push → live remote progress',
            shortLabel: 'Push remote',
            summary:
                'A cancelable stream keeps the mutation lock for its lifetime while host Git uses the user’s remote configuration and streams progress back.',
            color: '#9b8cff',
            steps: [
                {
                    edgeId: 'clients-host',
                    label: 'PushStream request',
                    detail: 'The toolbar starts a typed stream and retains an unsubscribe callback.',
                    payload:
                        '{\n  "repoId": "7f4a…",\n  "remote": "origin",\n  "branch": "main",\n  "setUpstream": true,\n  "forceWithLease": false,\n  "tags": false\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/rpc/group.ts',
                            644,
                            'PushStream payload',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    label: 'Hold lock for stream lifetime',
                    detail: 'Pull and push use the stream-scoped lock wrapper.',
                    payload: 'withRepoLockStream(repoId)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/engine/live.ts',
                            913,
                            'Push stream orchestration',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-git',
                    label: 'Spawn streaming Git',
                    detail: 'Core starts a line-buffered, interruption-safe child.',
                    payload:
                        'git push --porcelain --progress --set-upstream origin main',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/sync.ts',
                            216,
                            'Push stream arguments',
                        ),
                    ],
                },
                {
                    edgeId: 'git-external',
                    label: 'Use host remote credentials',
                    detail: 'Git reaches the configured remote through the host’s SSH agent or helper.',
                    payload: 'refs/heads/main → origin',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/run-git.ts',
                            68,
                            'Non-interactive host environment',
                        ),
                    ],
                },
                {
                    edgeId: 'engine-git',
                    direction: 'reverse',
                    phaseBreak:
                        'Remote output re-enters through the Git child before core parses it.',
                    label: 'Parse progress line',
                    detail: 'stdout and stderr lines become one of two SyncEvent shapes.',
                    payload:
                        '{\n  "_tag": "progress",\n  "text": "Writing objects: 100%"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/rpc-contract/src/schemas/branches.ts',
                            66,
                            'SyncEvent union',
                        ),
                    ],
                },
                {
                    edgeId: 'host-engine',
                    direction: 'reverse',
                    label: 'Stream typed update',
                    detail: 'A successful ref update is emitted before normal stream completion.',
                    payload:
                        '{\n  "_tag": "refUpdate",\n  "summary": "[new branch]",\n  "localRef": "main",\n  "remoteRef": "refs/heads/main"\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'packages/core/src/git/sync.test.ts',
                            147,
                            'Real remote push test',
                        ),
                    ],
                },
                {
                    edgeId: 'clients-host',
                    direction: 'reverse',
                    label: 'Update session activity',
                    detail: 'The UI appends the event to its bounded tab-local transcript.',
                    payload: 'activity.status = "success"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/ui/src/components/Toolbar.tsx',
                            192,
                            'Cancelable sync orchestration',
                        ),
                    ],
                },
            ],
        },
    ],
};
