import type { Citation, EvidenceKind } from '../types';

export const SOURCE_SNAPSHOT = {
    revision: 'be09896',
    label: 'HEAD be09896',
    reviewedAt: '2026-08-15',
} as const;

export const citation = (
    path: string,
    line: number,
    label: string,
): Citation => ({ path, line, label });

export const evidenceLabel: Readonly<Record<EvidenceKind, string>> = {
    'implementation-derived': 'Representative · implementation-derived',
    'schema-derived': 'Representative · schema-derived',
    'test-derived': 'Representative · test-derived',
};

export const overviewCitations = {
    architecture: citation(
        'docs/spec/02-architecture.md',
        12,
        'Host/client architecture',
    ),
    server: citation(
        'apps/web-server/src/server.ts',
        39,
        'Single Node listener assembly',
    ),
    rpcGroup: citation(
        'packages/rpc-contract/src/rpc/group.ts',
        130,
        'Shared RPC catalog',
    ),
    handlers: citation(
        'apps/web-server/src/rpc-handlers.ts',
        23,
        'RPC handler layer',
    ),
    engine: citation(
        'packages/core/src/engine/git-engine.ts',
        1,
        'GitEngine boundary',
    ),
    engineLive: citation(
        'packages/core/src/engine/live.ts',
        259,
        'Live engine composition',
    ),
    runner: citation(
        'packages/core/src/git/run-git.ts',
        92,
        'Host Git process runner',
    ),
    watcher: citation(
        'packages/core/src/git/watcher.ts',
        136,
        'Shared watcher registry',
    ),
    pluginManager: citation(
        'apps/web-server/src/plugin-manager.ts',
        188,
        'Trusted plugin manager',
    ),
    supervisor: citation(
        'packages/opencode-goal-supervisor/src/supervisor.ts',
        115,
        'External session adapter boundary',
    ),
} as const;
