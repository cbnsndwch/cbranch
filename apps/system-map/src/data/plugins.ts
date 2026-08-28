import type { ArchitectureScene } from '../types';
import { citation } from './shared';

export const pluginsScene: ArchitectureScene = {
    id: 'plugins',
    label: 'Trusted plugin lifecycle',
    shortLabel: 'Plugins',
    description:
        'Plugin discovery is signed and capability-reviewed; execution is an explicit in-process trust decision. The current runtime is not a sandbox and does not run a separate plugin worker.',
    scope: 'Committed HEAD lifecycle · trusted ESM executes inside the Node host',
    defaultNodeId: 'plugin-manager',
    nodes: [
        {
            id: 'plugin-ui',
            label: 'Plugins dialog',
            eyebrow: '@cbranch/ui',
            kind: 'client',
            group: 'Client process',
            position: { column: 0, row: 1 },
            height: 68,
            summary:
                'Browses repositories, reviews requested authority, and invokes contributions.',
            description:
                'The host renders all plugin UI. Plugins contribute declarative command and panel records; they do not inject markup, script, CSS, or arbitrary URLs into the React application.',
            responsibilities: [
                'Display repository trust and catalog state',
                'Collect explicit grants before installation',
                'Render host-owned command results and panels',
            ],
            builtWith: [
                'React',
                'CbranchApi plugin methods',
                'Declarative contributions',
            ],
            citations: [
                citation(
                    'packages/ui/src/components/PluginsDialog.tsx',
                    1,
                    'Host-rendered plugin surface',
                ),
                citation(
                    'packages/plugin-contract/src/schemas.ts',
                    79,
                    'Contribution schemas',
                ),
            ],
            status: 'active',
        },
        {
            id: 'plugin-rpc',
            label: 'Plugin RPC handlers',
            eyebrow: 'Same /rpc socket',
            kind: 'service',
            group: 'Host process',
            position: { column: 1, row: 1 },
            height: 80,
            summary:
                'Routes plugin tags directly to PluginManager, beside GitEngine.',
            description:
                'PluginRepository*, PluginInstall*, PluginEnable/Disable, PluginInvoke, and PluginAuditList are part of the same RpcGroup and WebSocket, but their handlers enter a separate host service.',
            responsibilities: [
                'Decode plugin contract records',
                'Delegate to PluginManager Effect methods',
                'Return canonical GitError-shaped failures',
            ],
            builtWith: [
                'CbranchRpcs',
                'Effect Layer',
                'Plugin contract schemas',
            ],
            citations: [
                citation(
                    'packages/rpc-contract/src/rpc/group.ts',
                    137,
                    'Plugin RPC catalog',
                ),
                citation(
                    'apps/web-server/src/rpc-handlers.ts',
                    39,
                    'Plugin handler delegation',
                ),
            ],
            status: 'active',
        },
        {
            id: 'plugin-manager',
            label: 'PluginManager',
            eyebrow: 'Host lifecycle coordinator',
            kind: 'service',
            group: 'Host process',
            position: { column: 2, row: 1 },
            height: 108,
            width: 116,
            summary:
                'Coordinates trust, verification, activation, loading, invocation, and audit.',
            description:
                'The manager composes repositories, artifact/lock/audit stores, a host credential adapter, policy checks, and loaded hook records. Plugin failures are classified into the shared error model.',
            responsibilities: [
                'Maintain trusted repository and loaded plugin maps',
                'Require verified target identity to match install input',
                'Record allowed, denied, and failed lifecycle events',
            ],
            builtWith: [
                'Effect service layer',
                'Host-private stores',
                'Crypto digests',
            ],
            citations: [
                citation(
                    'apps/web-server/src/plugin-manager.ts',
                    175,
                    'Manager composition at HEAD',
                ),
                citation(
                    'apps/web-server/src/plugin-manager.ts',
                    515,
                    'Install orchestration at HEAD',
                ),
            ],
            status: 'active',
        },
        {
            id: 'plugin-policy',
            label: 'Contract + policy',
            eyebrow: 'Schema, grants, compatibility',
            kind: 'contract',
            group: 'Shared libraries',
            position: { column: 2, row: 3 },
            height: 54,
            width: 108,
            summary:
                'Defines manifests and proves grants never exceed requested authority.',
            description:
                'The contract defines plugin IDs, manifests, capabilities, grants, contributions, install/invoke DTOs, and audit records. Runtime policy validates IDs, versions, entrypoints, automation, origins, and TUF freshness.',
            responsibilities: [
                'Decode plugin metadata and wire records',
                'Validate manifest/host compatibility',
                'Reject over-broad or malformed grants',
            ],
            builtWith: ['Effect Schema', '@cbranch/plugin-runtime'],
            citations: [
                citation(
                    'packages/plugin-contract/src/schemas.ts',
                    141,
                    'Manifest and grant schemas',
                ),
                citation(
                    'packages/plugin-runtime/src/policy.ts',
                    77,
                    'Manifest policy',
                ),
                citation(
                    'packages/plugin-runtime/src/policy.ts',
                    183,
                    'Grant proof',
                ),
            ],
            status: 'active',
        },
        {
            id: 'tuf-repository',
            label: 'TUF verifier',
            eyebrow: 'Signed metadata adapter',
            kind: 'service',
            group: 'Supply chain',
            position: { column: 3, row: 0 },
            height: 72,
            summary:
                'Refreshes trusted metadata and stages digest-verified artifacts.',
            description:
                'The TUF repository follows root, timestamp, snapshot, and targets metadata, verifies signatures/hashes/lengths/freshness, and yields catalog and reviewed artifact records.',
            responsibilities: [
                'Prevent rollback and expired metadata acceptance',
                'Bind target metadata to plugin manifest fields',
                'Verify artifact bytes before activation',
            ],
            builtWith: ['TUF roles', 'Ed25519 verification', 'SHA-256'],
            citations: [
                citation(
                    'apps/web-server/src/tuf-plugin-repository.ts',
                    1,
                    'TUF repository implementation',
                ),
                citation(
                    'packages/plugin-runtime/src/policy.ts',
                    244,
                    'Freshness and rollback policy',
                ),
            ],
            status: 'active',
        },
        {
            id: 'repository-transport',
            label: 'HTTPS transport',
            eyebrow: 'Bounded repository client',
            kind: 'service',
            group: 'Supply chain',
            position: { column: 4, row: 0 },
            height: 58,
            summary:
                'Fetches metadata and artifacts from one validated base URL.',
            description:
                'Repository access accepts HTTPS sources, constructs confined paths, applies response bounds, and requests credentials only through the host credential adapter.',
            responsibilities: [
                'Fetch repository metadata and targets',
                'Reject redirects or paths outside policy',
                'Bound response length and surface classified errors',
            ],
            builtWith: ['Node fetch', 'Validated URL policy'],
            citations: [
                citation(
                    'apps/web-server/src/plugin-repository-transport.ts',
                    1,
                    'Repository transport',
                ),
            ],
            status: 'active',
        },
        {
            id: 'plugin-registry',
            label: 'Plugin registry',
            eyebrow: 'External HTTPS + TUF',
            kind: 'external',
            group: 'Outside host',
            position: { column: 5, row: 0 },
            height: 64,
            summary: 'Publishes signed metadata and immutable plugin archives.',
            description:
                'The registry is external to cbranch. A publisher root must be explicitly trusted before its catalog is accepted; Git-backed repositories are declared but not implemented at this HEAD.',
            responsibilities: [
                'Serve TUF role metadata',
                'Serve addressed plugin artifacts',
            ],
            builtWith: ['HTTPS', 'TUF repository layout'],
            citations: [
                citation(
                    'apps/web-server/src/plugin-manager.ts',
                    472,
                    'HTTPS-only refresh at HEAD',
                ),
            ],
            status: 'active',
        },
        {
            id: 'credential-helper',
            label: 'Git credential helper',
            eyebrow: 'Host-owned secret boundary',
            kind: 'external',
            group: 'Host resources',
            position: { column: 4, row: 2 },
            height: 50,
            summary:
                'Fills, approves, or rejects repository credentials outside app storage.',
            description:
                'Credentials are accepted once or requested through host git credential commands. Success schemas and persisted repository records carry only redacted credential state.',
            responsibilities: [
                'Resolve credentials using host configuration',
                'Store or reject secrets through the normal Git helper chain',
            ],
            builtWith: ['git credential fill/approve/reject'],
            citations: [
                citation(
                    'apps/web-server/src/plugin-credentials.ts',
                    26,
                    'Credential adapter',
                ),
                citation(
                    'packages/plugin-contract/src/schemas.ts',
                    65,
                    'Redacted repository descriptor',
                ),
            ],
            status: 'active',
        },
        {
            id: 'plugin-data',
            label: 'Plugin data directory',
            eyebrow: 'Locks · audit · artifacts · repos',
            kind: 'storage',
            group: 'Host resources',
            position: { column: 3, row: 3 },
            height: 46,
            width: 116,
            summary:
                'Host-private files for verified lifecycle state, never credential values.',
            description:
                'Dedicated adapters persist installed lock records, repository trust state, append-only audit data, staged downloads, and immutable activated plugin versions.',
            responsibilities: [
                'Make reviewed installs restart-safe',
                'Keep audit records and repository metadata',
                'Activate only verified artifact identities',
            ],
            builtWith: [
                'Atomic JSON',
                'Private file modes',
                'Immutable artifact directories',
            ],
            citations: [
                citation(
                    'apps/web-server/src/plugin-lock-store.ts',
                    19,
                    'Lock store',
                ),
                citation(
                    'apps/web-server/src/plugin-audit-store.ts',
                    20,
                    'Audit store',
                ),
                citation(
                    'apps/web-server/src/plugin-artifact-store.ts',
                    65,
                    'Artifact store',
                ),
            ],
            status: 'active',
        },
        {
            id: 'trusted-host',
            label: 'Trusted ESM host',
            eyebrow: 'Dynamic import in Node process',
            kind: 'service',
            group: 'Execution',
            position: { column: 4, row: 3 },
            height: 70,
            summary:
                'Loads reviewed local JavaScript with the host account’s authority.',
            description:
                'The loader confines the entrypoint to its activated root, imports it with an identity cache key, calls the default factory, and validates the returned hook and command functions.',
            responsibilities: [
                'Confine the reviewed entrypoint path',
                'Load and validate hooks',
                'Run commands and lifecycle hooks in process',
            ],
            builtWith: ['Node dynamic import()', 'Realpath confinement'],
            citations: [
                citation(
                    'apps/web-server/src/trusted-plugin-host.ts',
                    1,
                    'Explicit non-sandbox trust',
                ),
                citation(
                    'apps/web-server/src/trusted-plugin-host.ts',
                    27,
                    'Loader',
                ),
            ],
            status: 'active',
        },
        {
            id: 'reviewed-plugin',
            label: 'Reviewed plugin module',
            eyebrow: 'Compatible test-backed ESM',
            kind: 'package',
            group: 'Execution',
            position: { column: 5, row: 3 },
            height: 58,
            summary:
                'A compatible packaged trusted-ESM example exercised by host integration tests.',
            description:
                'The host test fixture packages com.example.release with a compatible engine range, reviews and installs it through HTTPS/TUF, then loads its ESM command from durable state. Payloads in this scene use that fixture rather than the incompatible Hello World manifest at this HEAD.',
            responsibilities: [
                'Provide a minimal reviewed command contribution',
                'Exercise packaging',
            ],
            builtWith: [
                'PluginManifest fixture',
                'Packaged ESM',
                'Trusted host',
            ],
            citations: [
                citation(
                    'apps/web-server/src/plugin-manager.test.ts',
                    363,
                    'Compatible review fixture',
                ),
                citation(
                    'apps/web-server/src/plugin-manager.test.ts',
                    485,
                    'Enabled module fixture',
                ),
            ],
            status: 'active',
        },
    ],
    edges: [
        {
            id: 'plugin-ui-rpc',
            from: 'plugin-ui',
            to: 'plugin-rpc',
            label: 'plugin RPC methods',
            kind: 'rpc',
            bidirectional: true,
        },
        {
            id: 'plugin-rpc-manager',
            from: 'plugin-rpc',
            to: 'plugin-manager',
            label: 'Effect calls',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'policy-manager',
            from: 'plugin-policy',
            to: 'plugin-manager',
            label: 'schemas + validation',
            kind: 'dependency',
        },
        {
            id: 'manager-tuf',
            from: 'plugin-manager',
            to: 'tuf-repository',
            label: 'refresh / review / stage',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'tuf-transport',
            from: 'tuf-repository',
            to: 'repository-transport',
            label: 'metadata / artifact fetch',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'transport-registry',
            from: 'repository-transport',
            to: 'plugin-registry',
            label: 'HTTPS',
            kind: 'network',
            bidirectional: true,
        },
        {
            id: 'transport-credential',
            from: 'repository-transport',
            to: 'credential-helper',
            label: 'fill / reject',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'manager-data',
            from: 'plugin-manager',
            to: 'plugin-data',
            label: 'persist / activate / audit',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'manager-host',
            from: 'plugin-manager',
            to: 'trusted-host',
            label: 'load / invoke hooks',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'data-host',
            from: 'plugin-data',
            to: 'trusted-host',
            label: 'activated entrypoint',
            kind: 'filesystem',
        },
        {
            id: 'host-plugin',
            from: 'trusted-host',
            to: 'reviewed-plugin',
            label: 'factory + commands',
            kind: 'call',
            bidirectional: true,
        },
    ],
    flows: [
        {
            id: 'plugin-install',
            label: 'Review → verify → install',
            shortLabel: 'Install plugin',
            summary:
                'A user reviews signed manifest authority, approves a bounded grant, and installs only when the staged artifact identity still matches the reviewed catalog target.',
            color: '#58d6c7',
            steps: [
                {
                    edgeId: 'plugin-ui-rpc',
                    label: 'Request install review',
                    detail: 'The UI identifies one catalog version to inspect without executing it.',
                    payload:
                        '{\n  "repositoryId": "repo-main",\n  "pluginId": "com.example.release",\n  "version": "1.2.3"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/plugin-contract/src/schemas.ts',
                            310,
                            'InstallReview input at HEAD',
                        ),
                    ],
                },
                {
                    edgeId: 'plugin-rpc-manager',
                    label: 'Delegate review',
                    detail: 'The plugin handler calls its separate lifecycle service.',
                    payload: 'manager.installReview(input)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/rpc-handlers.ts',
                            60,
                            'Review handler',
                        ),
                    ],
                },
                {
                    edgeId: 'manager-tuf',
                    label: 'Review signed target',
                    detail: 'The repository resolves target metadata and a decoded, non-executed manifest.',
                    payload: 'repository.review(pluginId, version)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.ts',
                            541,
                            'Review operation at HEAD',
                        ),
                    ],
                },
                {
                    edgeId: 'tuf-transport',
                    label: 'Fetch metadata and archive',
                    detail: 'TUF controls the exact paths, hashes, lengths, and trusted versions.',
                    payload:
                        'metadata/timestamp.json\nmetadata/snapshot.json\nmetadata/targets.json',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/tuf-plugin-repository.ts',
                            1,
                            'TUF role flow',
                        ),
                    ],
                },
                {
                    edgeId: 'transport-registry',
                    label: 'Download signed bytes',
                    detail: 'The external registry returns bounded metadata and artifact bodies.',
                    payload:
                        'GET /metadata/targets.json\nGET /targets/com.example.release/1.2.3/release.cbranch-plugin',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-repository-transport.ts',
                            1,
                            'HTTPS reads',
                        ),
                    ],
                },
                {
                    edgeId: 'manager-tuf',
                    direction: 'reverse',
                    phaseBreak:
                        'Verified bytes unwind through transport and TUF; the trace resumes at PluginManager.',
                    label: 'Return non-executing review',
                    detail: 'The result exposes target metadata and the decoded manifest.',
                    payload:
                        '{\n  "target": {\n    "pluginId": "com.example.release",\n    "version": "1.2.3",\n    "artifactSha256": "sha256:…"\n  },\n  "manifest": {\n    "runtime": "trusted-esm",\n    "capabilities": ["ui.contribute"]\n  }\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.test.ts',
                            359,
                            'HTTPS/TUF lifecycle fixture',
                        ),
                    ],
                },
                {
                    edgeId: 'plugin-ui-rpc',
                    phaseBreak:
                        'After human review, a separate install request starts from the dialog.',
                    label: 'Submit reviewed install + grant',
                    detail: 'The request repeats the reviewed artifact digest and explicitly bounded authority.',
                    payload:
                        '{\n  "repositoryId": "repo-main",\n  "pluginId": "com.example.release",\n  "version": "1.2.3",\n  "artifactSha256": "sha256:…",\n  "grant": {\n    "capabilities": [],\n    "repositoryIds": [],\n    "networkOrigins": [],\n    "automationActionIds": [],\n    "hostAutomationApproved": false\n  }\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.test.ts',
                            452,
                            'Reviewed install request',
                        ),
                    ],
                },
                {
                    edgeId: 'manager-data',
                    phaseBreak:
                        'The RPC handler has delegated the accepted install request to PluginManager.',
                    label: 'Activate and persist lock',
                    detail: 'Verified files move into an immutable identity path; a disabled lock record and audit event are written.',
                    payload:
                        '{\n  "pluginId": "com.example.release",\n  "version": "1.2.3",\n  "enabled": false,\n  "entrypoint": "plugin.mjs"\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.ts',
                            561,
                            'Verified installation at HEAD',
                        ),
                    ],
                },
                {
                    edgeId: 'plugin-ui-rpc',
                    direction: 'reverse',
                    phaseBreak:
                        'Persistence has completed; the manager result is returned through the RPC handler.',
                    label: 'InstalledPlugin result',
                    detail: 'Installation does not imply enablement or execution.',
                    payload:
                        '{\n  "enabled": false,\n  "availableVersions": ["1.2.3"]\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.test.ts',
                            471,
                            'Installed fixture result',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'plugin-invoke',
            label: 'Invoke trusted command',
            shortLabel: 'Invoke command',
            summary:
                'A declared command on an enabled plugin executes inside the host process, surrounded by ordered hooks and durable audit records.',
            color: '#f3b95f',
            steps: [
                {
                    edgeId: 'plugin-ui-rpc',
                    label: 'PluginInvoke request',
                    detail: 'The request names a declared contribution and scoped repository context.',
                    payload:
                        '{\n  "pluginId": "com.example.release",\n  "commandId": "com.example.release.run",\n  "repoId": "repo-1",\n  "engagementId": "engagement-1",\n  "input": "check"\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.test.ts',
                            515,
                            'Invocation fixture',
                        ),
                    ],
                },
                {
                    edgeId: 'plugin-rpc-manager',
                    label: 'Check installed command',
                    detail: 'The manager requires the plugin to be loaded and the command to be declared.',
                    payload:
                        'loaded.has(pluginId) && contributions.commands.includes(commandId)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.ts',
                            670,
                            'Invocation checks at HEAD',
                        ),
                    ],
                },
                {
                    edgeId: 'manager-host',
                    label: 'Dispatch trusted hook',
                    detail: 'The host calls before hooks, then the command function, then after hooks.',
                    payload:
                        'command("check", { repoId: "repo-1", engagementId: "engagement-1" })',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.ts',
                            728,
                            'Ordered hook dispatch at HEAD',
                        ),
                    ],
                },
                {
                    edgeId: 'host-plugin',
                    label: 'Run ESM command',
                    detail: 'The reviewed module runs with host-user authority; grants limit only cbranch-provided APIs.',
                    payload: '"ran:check"',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.test.ts',
                            493,
                            'Fixture command implementation',
                        ),
                    ],
                },
                {
                    edgeId: 'manager-data',
                    phaseBreak:
                        'The command has resolved back into PluginManager, which records the outcome.',
                    label: 'Record audit outcome',
                    detail: 'Allowed, denied, and failed operations are persisted with scoped identifiers.',
                    payload:
                        '{\n  "action": "invoke",\n  "capability": "ui.contribute",\n  "repoId": "repo-1",\n  "outcome": "allowed"\n}',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.ts',
                            793,
                            'Invocation audit at HEAD',
                        ),
                    ],
                },
                {
                    edgeId: 'plugin-ui-rpc',
                    direction: 'reverse',
                    phaseBreak:
                        'Audit persistence has completed; the invocation returns through the RPC handler.',
                    label: 'Render command result',
                    detail: 'The fixture returns a plain string, so the manager carries it in PluginInvocation.output.',
                    payload:
                        '{\n  "operationId": "op-…",\n  "state": "completed",\n  "output": "ran:check"\n}',
                    evidence: 'test-derived',
                    citations: [
                        citation(
                            'apps/web-server/src/plugin-manager.test.ts',
                            515,
                            'Completed invocation result',
                        ),
                    ],
                },
            ],
        },
    ],
};
