import type { RepoId } from '@cbranch/rpc-contract';

import { matchingDeterministicAnalyzers } from './analyzer-registry';

export interface WorkspaceIntelligenceSourceFile {
    readonly path: string;
    readonly text: string;
}

export interface WorkspaceIntelligenceAnalysis {
    readonly nodes: ReadonlyArray<Record<string, unknown>>;
    readonly edges: ReadonlyArray<Record<string, unknown>>;
    readonly unknowns: ReadonlyArray<Record<string, unknown>>;
    readonly report: ReadonlyArray<string>;
    readonly analyzerCount: number;
    /** IDs from the compile-time first-party analyzer registry. */
    readonly analyzerIds?: ReadonlyArray<string>;
    /** The host observed an input change or inventory degradation for this repository. */
    readonly isPartial?: boolean;
    /** Host inventory metadata intentionally excludes the private repository root. */
    readonly repository?: {
        readonly repoId: RepoId;
        readonly sourceFileCount: number;
        readonly sourceFingerprint: string;
        readonly analyzerVersion?: string;
    };
}

const sourceEvidence = (path: string, line = 1) => ({
    analyzer: 'workspace-intelligence.deterministic-source@4',
    kind: 'verified',
    path,
    line,
});

const node = (
    id: string,
    kind: string,
    label: string,
    repoId: RepoId,
    path: string,
) => ({
    id,
    kind,
    label,
    repoId,
    evidence: [sourceEvidence(path)],
});

const lineAt = (text: string, offset: number): number =>
    text.slice(0, offset).split('\n').length;

const directoryOf = (path: string): string => {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index + 1);
};

const normalizePath = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
    }
    return parts.join('/');
};

const normalizedHttpPath = (path: string): string => {
    const value = path.trim();
    if (value === '') return '/';
    return value.startsWith('/') ? value : `/${value}`;
};

const joinHttpPath = (prefix: string, path: string): string =>
    normalizedHttpPath(
        `${normalizedHttpPath(prefix).replace(/\/$/, '')}/${path.replace(/^\//, '')}`,
    );

const nextRoutePath = (path: string): string | undefined => {
    const appRoute = path.match(/(?:^|\/)app\/(.+)\/route\.[cm]?[jt]sx?$/);
    const pagesRoute = path.match(
        /(?:^|\/)pages\/api(?:\/(.+))?\.[cm]?[jt]sx?$/,
    );
    const route = appRoute?.[1] ?? pagesRoute?.[1];
    if (route === undefined) return undefined;
    const segments = route
        .split('/')
        .filter(segment => segment !== '' && !/^\(.+\)$/.test(segment))
        .filter(segment => !segment.startsWith('@'))
        .map(segment =>
            segment
                .replace(/^\[\.\.\.(.+)\]$/, '*$1')
                .replace(/^\[\[(?:\.\.\.)?(.+)\]\]$/, ':$1?')
                .replace(/^\[(.+)\]$/, ':$1'),
        );
    return normalizedHttpPath(segments.join('/'));
};

const messagingTransport = (text: string): string | undefined => {
    if (
        /['"]nats(?:\.ws)?['"]|nats(?:[.-]io)?\/nats\.go|async_nats|\bnats\.[Cc]onnect\b/.test(
            text,
        )
    )
        return 'nats';
    if (/['"]kafkajs['"]|kafka-go|rdkafka|\bkafka\./.test(text)) return 'kafka';
    if (/['"]amqplib['"]|lapin|streadway\/amqp|\bamqp\b/.test(text))
        return 'amqp';
    if (/['"]redis['"]|go-redis|\bredis(?::|\.)/.test(text)) return 'redis';
    if (/@aws-sdk\/client-sns|\bSNSClient\b/.test(text)) return 'aws.sns';
    if (/@aws-sdk\/client-sqs|\bSQSClient\b/.test(text)) return 'aws.sqs';
    if (/@aws-sdk\/client-eventbridge|\bEventBridgeClient\b/.test(text))
        return 'aws.eventbridge';
    if (/@google-cloud\/pubsub|\bPubSub\b/.test(text)) return 'gcp.pubsub';
    return undefined;
};

const channelKind = (verb: string): 'publishes' | 'subscribes' =>
    /^(?:publish|send|emit|putEvents)$/i.test(verb)
        ? 'publishes'
        : 'subscribes';

const terraformMessagingTransports: Readonly<Record<string, string>> = {
    aws_sns_topic: 'aws.sns',
    aws_sqs_queue: 'aws.sqs',
    aws_cloudwatch_event_bus: 'aws.eventbridge',
    google_pubsub_topic: 'gcp.pubsub',
    google_pubsub_subscription: 'gcp.pubsub',
};

const terraformMessagingTransport = (
    resourceType: string,
): string | undefined => terraformMessagingTransports[resourceType];

const graphqlOperationId = (
    repoId: string,
    operationType: string,
    name: string,
): string => `${repoId}:graphql.operation:${operationType}:${name}`;

const grpcServiceId = (repoId: string, service: string): string =>
    `${repoId}:grpc.service:${service}`;

const grpcMethodId = (
    repoId: string,
    service: string,
    method: string,
): string => `${grpcServiceId(repoId, service)}:method:${method}`;

const sortRecords = <T extends Record<string, unknown>>(
    records: ReadonlyArray<T>,
): T[] =>
    [...records].toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

const mergeEvidence = (
    ...values: ReadonlyArray<unknown>
): ReadonlyArray<Record<string, unknown>> =>
    [
        ...new Map(
            values
                .flatMap(value => (Array.isArray(value) ? value : []))
                .filter(
                    (evidence): evidence is Record<string, unknown> =>
                        typeof evidence === 'object' && evidence !== null,
                )
                .map(evidence => [JSON.stringify(evidence), evidence]),
        ).values(),
    ].toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

const mergeCanonicalRecords = (
    records: ReadonlyArray<Record<string, unknown>>,
    identity: (record: Record<string, unknown>) => string,
): ReadonlyArray<Record<string, unknown>> => {
    const merged = new Map<string, Record<string, unknown>>();
    for (const record of records) {
        const key = identity(record);
        const existing = merged.get(key);
        const existingLabel =
            typeof existing?.label === 'string' ? existing.label : '';
        const incomingLabel =
            typeof record.label === 'string' ? record.label : '';
        const preferred =
            existing === undefined ||
            incomingLabel.length > existingLabel.length
                ? record
                : existing;
        merged.set(
            key,
            existing === undefined
                ? record
                : {
                      ...preferred,
                      evidence: mergeEvidence(
                          existing.evidence,
                          record.evidence,
                      ),
                  },
        );
    }
    return sortRecords([...merged.values()]);
};

const workspacePatterns = (value: unknown): ReadonlyArray<string> => {
    if (Array.isArray(value))
        return value.filter(
            (pattern): pattern is string => typeof pattern === 'string',
        );
    if (
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { packages?: unknown }).packages)
    )
        return (value as { packages: ReadonlyArray<unknown> }).packages.filter(
            (pattern): pattern is string => typeof pattern === 'string',
        );
    return [];
};

/** Deterministic, parser-free baseline for manifest/package/module architecture. */
export const analyzeDeterministicSource = (
    repoId: RepoId,
    files: ReadonlyArray<WorkspaceIntelligenceSourceFile>,
): WorkspaceIntelligenceAnalysis => {
    const nodes: Record<string, unknown>[] = [];
    const edges: Record<string, unknown>[] = [];
    const unknowns: Record<string, unknown>[] = [];
    const report: string[] = [];
    const sortedFiles = [...files].sort((left, right) =>
        left.path.localeCompare(right.path),
    );
    const packages = sortedFiles.filter(file =>
        file.path.endsWith('package.json'),
    );
    const ownerComponentId = (path: string): string | undefined =>
        packages
            .map(packageFile => ({
                componentId: `${repoId}:component:${packageFile.path}`,
                directory: directoryOf(packageFile.path),
            }))
            .filter(candidate => path.startsWith(candidate.directory))
            .toSorted(
                (left, right) => right.directory.length - left.directory.length,
            )[0]?.componentId;
    const pnpmWorkspaces = sortedFiles.filter(file =>
        file.path.endsWith('pnpm-workspace.yaml'),
    );
    const cargos = sortedFiles.filter(file => file.path.endsWith('Cargo.toml'));
    const goModules = sortedFiles.filter(file => file.path.endsWith('go.mod'));
    const goWorkspaces = sortedFiles.filter(file =>
        file.path.endsWith('go.work'),
    );
    const terraformFiles = sortedFiles.filter(
        file => file.path.endsWith('.tf') || file.path.endsWith('.tf.json'),
    );
    const xmlFiles = sortedFiles.filter(file => file.path.endsWith('.xml'));
    const openApiFiles = sortedFiles.filter(file =>
        /(?:^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/.test(file.path),
    );
    const asyncApiFiles = sortedFiles.filter(file =>
        /(?:^|\/)asyncapi\.(?:json|ya?ml)$/.test(file.path),
    );
    const graphqlFiles = sortedFiles.filter(file =>
        /\.(?:graphql|gql)$/.test(file.path),
    );
    const protobufFiles = sortedFiles.filter(file =>
        file.path.endsWith('.proto'),
    );
    const jsonSchemaFiles = sortedFiles.filter(file =>
        /(?:^|\/)(?:[^/]+\.schema|schema)\.json$/.test(file.path),
    );
    const turboFiles = sortedFiles.filter(file =>
        /(?:^|\/)turbo\.json$/.test(file.path),
    );
    const wranglerFiles = sortedFiles.filter(file =>
        /(?:^|\/)wrangler\.(?:json|toml)$/.test(file.path),
    );
    const composeFiles = sortedFiles.filter(file =>
        /(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/.test(file.path),
    );
    const kubernetesFiles = sortedFiles.filter(file =>
        /(?:^|\/)(?:kustomization|deployment|service|configmap|ingress|statefulset|daemonset|job|cronjob|namespace|secret)\.ya?ml$/.test(
            file.path,
        ),
    );
    const analyzers = matchingDeterministicAnalyzers(sortedFiles);
    for (const file of packages) {
        try {
            const manifest = JSON.parse(file.text) as {
                name?: string;
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
                peerDependencies?: Record<string, string>;
                optionalDependencies?: Record<string, string>;
                workspaces?: unknown;
            };
            const id = `${repoId}:package:${file.path}`;
            nodes.push(
                node(
                    id,
                    'typescript.package',
                    manifest.name ?? file.path,
                    repoId,
                    file.path,
                ),
            );
            const componentId = `${repoId}:component:${file.path}`;
            nodes.push(
                node(
                    componentId,
                    'component',
                    manifest.name ?? file.path,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: componentId,
                to: id,
                kind: 'contains',
                evidence: [sourceEvidence(file.path)],
            });
            const dependencies = {
                ...manifest.dependencies,
                ...manifest.devDependencies,
                ...manifest.peerDependencies,
                ...manifest.optionalDependencies,
            };
            for (const dependency of Object.keys(dependencies).sort())
                nodes.push(
                    node(
                        `npm:${dependency}`,
                        'external.dependency',
                        dependency,
                        repoId,
                        file.path,
                    ),
                );
            for (const dependency of Object.keys(dependencies).sort())
                edges.push({
                    from: id,
                    to: `npm:${dependency}`,
                    kind: 'depends-on',
                    evidence: [sourceEvidence(file.path)],
                });
            for (const [dependency, framework] of [
                ['effect', 'effect'],
                ['@cbranch/rpc-contract', 'cbranch.rpc'],
                ['@tauri-apps/api', 'tauri'],
                ['react', 'react'],
                ['react-router', 'react-router'],
                ['vite', 'vite'],
                ['next', 'next'],
                ['wrangler', 'cloudflare.workers'],
                ['@cloudflare/workers-types', 'cloudflare.workers'],
                ['turbo', 'turborepo'],
            ] as const) {
                if (!(dependency in dependencies)) continue;
                const frameworkId = `framework:${framework}`;
                nodes.push(
                    node(
                        frameworkId,
                        'framework',
                        framework,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: componentId,
                    to: frameworkId,
                    kind: 'uses-framework',
                    evidence: [sourceEvidence(file.path)],
                });
            }
            if (
                Object.keys(dependencies).some(dependency =>
                    /^(?:@napi-rs\/|node-addon-api$|ffi-napi$|node-gyp$)/.test(
                        dependency,
                    ),
                )
            ) {
                const ffiId = `${repoId}:ffi.node-api:${file.path}`;
                nodes.push(
                    node(
                        ffiId,
                        'ffi.node-api',
                        'Node-API native boundary',
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: componentId,
                    to: ffiId,
                    kind: 'uses-ffi',
                    evidence: [sourceEvidence(file.path)],
                });
            }
            const patterns = workspacePatterns(manifest.workspaces);
            if (patterns.length > 0) {
                const workspaceId = `${repoId}:workspace:${file.path}`;
                nodes.push(
                    node(
                        workspaceId,
                        'typescript.workspace',
                        manifest.name ?? file.path,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: workspaceId,
                    to: id,
                    kind: 'contains',
                    evidence: [sourceEvidence(file.path)],
                    patterns,
                });
            }
            for (const dependency of [
                'meteor',
                'moleculer',
                'preact',
                '@storybook/react',
                'webpack',
                'fumadocs-core',
                '@changesets/cli',
            ]) {
                if (!(dependency in dependencies)) continue;
                unknowns.push({
                    path: file.path,
                    kind: 'typescript.framework-semantics-unavailable',
                    dependency,
                    message:
                        'The deterministic pilot records the package boundary but has no framework-specific semantics.',
                });
            }
        } catch {
            unknowns.push({
                path: file.path,
                kind: 'typescript.invalid-package-json',
            });
        }
    }
    for (const file of pnpmWorkspaces) {
        const patterns = [
            ...file.text.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/gm),
        ]
            .map(match => String(match[1]))
            .sort();
        const id = `${repoId}:workspace:${file.path}`;
        nodes.push(
            node(
                id,
                'typescript.workspace',
                'pnpm workspace',
                repoId,
                file.path,
            ),
        );
        for (const pattern of patterns)
            edges.push({
                from: id,
                to: `workspace-pattern:${pattern}`,
                kind: 'includes',
                evidence: [sourceEvidence(file.path)],
            });
    }
    for (const configFile of sortedFiles.filter(candidate =>
        /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(candidate.path),
    )) {
        try {
            const config = JSON.parse(configFile.text) as { extends?: string };
            const id = `${repoId}:project:${configFile.path}`;
            nodes.push(
                node(
                    id,
                    'typescript.project',
                    configFile.path,
                    repoId,
                    configFile.path,
                ),
            );
            if (config.extends)
                edges.push({
                    from: id,
                    to: config.extends,
                    kind: 'extends',
                    evidence: [sourceEvidence(configFile.path)],
                });
        } catch {
            unknowns.push({
                path: configFile.path,
                kind: 'typescript.invalid-tsconfig',
            });
        }
    }
    const typeScriptFiles = sortedFiles.filter(file =>
        /\.[cm]?[jt]sx?$/.test(file.path),
    );
    const typeScriptPaths = new Set(typeScriptFiles.map(file => file.path));
    const sourcePaths = new Set(sortedFiles.map(source => source.path));
    const addHttpRoute = (
        ownerId: string,
        method: string,
        path: string,
        file: WorkspaceIntelligenceSourceFile,
        offset: number,
    ): void => {
        const normalizedPath = normalizedHttpPath(path);
        const normalizedMethod = method.toUpperCase();
        const contractId = `${repoId}:http.route:${normalizedMethod}:${normalizedPath}`;
        nodes.push(
            node(
                contractId,
                'contract.http.route',
                `${normalizedMethod} ${normalizedPath}`,
                repoId,
                file.path,
            ),
        );
        edges.push({
            from: ownerId,
            to: contractId,
            kind: 'exposes-contract',
            evidence: [sourceEvidence(file.path, lineAt(file.text, offset))],
        });
    };
    const addHttpRequest = (
        ownerId: string,
        target: string,
        file: WorkspaceIntelligenceSourceFile,
        offset: number,
        method?: string,
    ): void => {
        const label = method === undefined ? target : `${method} ${target}`;
        const contractId = `${repoId}:http.request:${method === undefined ? target : `${method}:${target}`}`;
        nodes.push(
            node(contractId, 'contract.http.request', label, repoId, file.path),
        );
        edges.push({
            from: ownerId,
            to: contractId,
            kind: 'consumes-contract',
            evidence: [sourceEvidence(file.path, lineAt(file.text, offset))],
        });
    };
    const resolveTypeScriptImport = (from: string, target: string): string => {
        if (!target.startsWith('.')) return target;
        const base = normalizePath(`${directoryOf(from)}${target}`);
        const candidates = [
            base,
            `${base}.ts`,
            `${base}.tsx`,
            `${base}.js`,
            `${base}.jsx`,
            `${base}/index.ts`,
            `${base}/index.tsx`,
            `${base}/index.js`,
        ];
        const resolved = candidates.find(path => typeScriptPaths.has(path));
        return resolved === undefined ? target : `${repoId}:module:${resolved}`;
    };
    for (const file of typeScriptFiles) {
        const id = `${repoId}:module:${file.path}`;
        const ownerId = ownerComponentId(file.path) ?? id;
        nodes.push(node(id, 'typescript.module', file.path, repoId, file.path));
        for (const match of file.text.matchAll(
            /(?:import|export)[^'";]*['"]([^'"]+)['"]/g,
        ))
            edges.push({
                from: id,
                to: resolveTypeScriptImport(file.path, String(match[1])),
                kind: 'imports',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        for (const match of file.text.matchAll(
            /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+(\w+)/g,
        )) {
            const name = String(match[1]);
            const exportId = `${repoId}:typescript.export:${file.path}:${name}`;
            nodes.push(
                node(exportId, 'typescript.export', name, repoId, file.path),
            );
            edges.push({
                from: id,
                to: exportId,
                kind: 'declares-export',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(
            /\bfetch\s*\(\s*['"]([^'"]+)['"]/g,
        )) {
            const target = String(match[1]);
            const contractId = `${repoId}:http.request:${target}`;
            nodes.push(
                node(
                    contractId,
                    'contract.http.request',
                    target,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: ownerId,
                to: contractId,
                kind: 'consumes-contract',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(
            /\b(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/gi,
        )) {
            const method = String(match[1]).toUpperCase();
            const path = String(match[2]);
            const contractId = `${repoId}:http.route:${method}:${path}`;
            nodes.push(
                node(
                    contractId,
                    'contract.http.route',
                    `${method} ${path}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: ownerId,
                to: contractId,
                kind: 'exposes-contract',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        const controllerPrefix =
            file.text.match(
                /@Controller\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/,
            )?.[1] ?? '';
        for (const match of file.text.matchAll(
            /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/g,
        ))
            addHttpRoute(
                ownerId,
                String(match[1]),
                joinHttpPath(controllerPrefix, String(match[2] ?? '')),
                file,
                match.index ?? 0,
            );
        const routePath = nextRoutePath(file.path);
        if (routePath !== undefined)
            for (const match of file.text.matchAll(
                /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
            ))
                addHttpRoute(
                    ownerId,
                    String(match[1]),
                    routePath,
                    file,
                    match.index ?? 0,
                );
        if (/\bexport\s+default\s*\{[\s\S]*?\bfetch\s*\(/.test(file.text))
            addHttpRoute(ownerId, 'ANY', '/', file, 0);
        for (const match of file.text.matchAll(
            /\baxios\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/gi,
        ))
            addHttpRequest(
                ownerId,
                String(match[2]),
                file,
                match.index ?? 0,
                String(match[1]).toUpperCase(),
            );
        for (const documentMatch of file.text.matchAll(
            /\b(?:gql|graphql)\s*`([\s\S]*?)`/g,
        ))
            for (const operationMatch of String(documentMatch[1]).matchAll(
                /\b(query|mutation|subscription)\s+(\w+)/g,
            )) {
                const operationType = String(operationMatch[1]);
                const name = String(operationMatch[2]);
                const operationId = graphqlOperationId(
                    repoId,
                    operationType,
                    name,
                );
                nodes.push(
                    node(
                        operationId,
                        'contract.graphql.operation',
                        `${operationType} ${name}`,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: ownerId,
                    to: operationId,
                    kind: 'consumes-contract',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, documentMatch.index ?? 0),
                        ),
                    ],
                });
            }
        if (/@grpc\/grpc-js|grpc-js/.test(file.text))
            for (const match of file.text.matchAll(/\bnew\s+(\w+)Client\b/g)) {
                const service = String(match[1]);
                const serviceId = grpcServiceId(repoId, service);
                nodes.push(
                    node(
                        serviceId,
                        'contract.grpc.service',
                        service,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: ownerId,
                    to: serviceId,
                    kind: 'consumes-contract',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        const transport = messagingTransport(file.text);
        if (transport !== undefined)
            for (const match of file.text.matchAll(
                /\.(publish|subscribe|send|consume|emit|putEvents)\s*\(\s*['"]([^'"]+)['"]/g,
            )) {
                const verb = String(match[1]);
                const subject = String(match[2]);
                const channelId = `${repoId}:messaging:${transport}:${subject}`;
                nodes.push(
                    node(
                        channelId,
                        'channel.messaging',
                        `${transport}: ${subject}`,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: ownerId,
                    to: channelId,
                    kind: channelKind(verb),
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        if (/@napi-rs|ffi-napi|node-gyp/.test(file.text)) {
            const ffiId = `${repoId}:ffi.node-api:${file.path}`;
            nodes.push(
                node(
                    ffiId,
                    'ffi.node-api',
                    'Node-API native boundary',
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: ownerId,
                to: ffiId,
                kind: 'uses-ffi',
                evidence: [sourceEvidence(file.path)],
            });
        }
        if (
            /\bWebAssembly\.(?:compile|instantiate|instantiateStreaming)\b/.test(
                file.text,
            )
        ) {
            const ffiId = `${repoId}:ffi.wasm:${file.path}`;
            nodes.push(
                node(
                    ffiId,
                    'ffi.wasm',
                    'WebAssembly boundary',
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: ownerId,
                to: ffiId,
                kind: 'uses-ffi',
                evidence: [sourceEvidence(file.path)],
            });
        }
    }
    for (const file of cargos) {
        const name =
            file.text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? file.path;
        const id = `${repoId}:crate:${file.path}`;
        const crateDirectory = directoryOf(file.path);
        nodes.push(node(id, 'rust.crate', name, repoId, file.path));
        const componentId = `${repoId}:component:${file.path}`;
        nodes.push(node(componentId, 'component', name, repoId, file.path));
        edges.push({
            from: componentId,
            to: id,
            kind: 'contains',
            evidence: [sourceEvidence(file.path)],
        });
        if (/^\[workspace\]$/m.test(file.text))
            nodes.push(
                node(
                    `${repoId}:workspace:${file.path}`,
                    'rust.workspace',
                    file.path,
                    repoId,
                    file.path,
                ),
            );
        const dependencies =
            file.text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
        for (const match of dependencies.matchAll(/^([\w-]+)\s*=/gm))
            nodes.push(
                node(
                    `cargo:${match[1]}`,
                    'external.dependency',
                    String(match[1]),
                    repoId,
                    file.path,
                ),
            );
        for (const match of dependencies.matchAll(/^([\w-]+)\s*=/gm))
            edges.push({
                from: id,
                to: `cargo:${match[1]}`,
                kind: 'depends-on',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        if (/^tauri\s*=/m.test(dependencies)) {
            const frameworkId = 'framework:tauri';
            nodes.push(
                node(frameworkId, 'framework', 'tauri', repoId, file.path),
            );
            edges.push({
                from: componentId,
                to: frameworkId,
                kind: 'uses-framework',
                evidence: [sourceEvidence(file.path)],
            });
        }
        if (/^\s*build\s*=/m.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'rust.build-script-unavailable',
                message:
                    'Build scripts are not executed by deterministic analysis.',
            });

        const targets = new Map<string, { kind: string; label: string }>();
        for (const targetMatch of file.text.matchAll(
            /^\s*\[(lib)\]\s*\n([\s\S]*?)(?=^\s*\[|\s*$)/gm,
        )) {
            const kind = String(targetMatch[1]);
            const body = String(targetMatch[2]);
            const targetName =
                body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? name;
            targets.set(`${kind}:${targetName}`, {
                kind,
                label: `${kind} ${targetName}`,
            });
        }
        for (const targetMatch of file.text.matchAll(
            /^\s*\[\[(bin|example|test|bench)\]\]\s*\n([\s\S]*?)(?=^\s*\[\[|\s*$)/gm,
        )) {
            const kind = String(targetMatch[1]);
            const body = String(targetMatch[2]);
            const targetName =
                body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? kind;
            targets.set(`${kind}:${targetName}`, {
                kind,
                label: `${kind} ${targetName}`,
            });
        }
        if (
            sourcePaths.has(`${crateDirectory}src/lib.rs`) &&
            ![...targets.values()].some(target => target.kind === 'lib')
        )
            targets.set(`lib:${name}`, {
                kind: 'lib',
                label: `lib ${name}`,
            });
        if (sourcePaths.has(`${crateDirectory}src/main.rs`))
            targets.set(`bin:${name}`, {
                kind: 'bin',
                label: `bin ${name}`,
            });
        for (const [targetKey, target] of targets) {
            const targetId = `${repoId}:rust.target:${file.path}:${targetKey}`;
            nodes.push(
                node(targetId, 'rust.target', target.label, repoId, file.path),
            );
            edges.push({
                from: id,
                to: targetId,
                kind: 'declares-target',
                evidence: [sourceEvidence(file.path)],
            });
        }
    }
    for (const file of goWorkspaces) {
        const id = `${repoId}:workspace:${file.path}`;
        nodes.push(node(id, 'go.workspace', 'Go workspace', repoId, file.path));
        const uses = [
            ...file.text.matchAll(/^\s*use\s+([^\s()]+)/gm),
            ...(
                file.text.match(/^\s*use\s*\(([\s\S]*?)^\s*\)/m)?.[1] ?? ''
            ).matchAll(/^\s*([^\s()]+)\s*$/gm),
        ].map(match => String(match[1]));
        for (const use of uses)
            edges.push({
                from: id,
                to: `go-workspace-path:${use}`,
                kind: 'uses',
                evidence: [sourceEvidence(file.path)],
            });
    }
    for (const file of goModules) {
        const module =
            file.text.match(/^\s*module\s+([^\s]+)/m)?.[1] ?? file.path;
        const id = `${repoId}:go-module:${file.path}`;
        const componentId = `${repoId}:component:${file.path}`;
        nodes.push(node(id, 'go.module', module, repoId, file.path));
        nodes.push(node(componentId, 'component', module, repoId, file.path));
        edges.push({
            from: componentId,
            to: id,
            kind: 'contains',
            evidence: [sourceEvidence(file.path)],
        });
        const requirements = [
            ...file.text.matchAll(/^\s*require\s+([^\s(][^\s]*)\s+/gm),
            ...file.text.matchAll(/^\s*([^\s/][^\s]*)\s+v\S+/gm),
        ]
            .map(match => String(match[1]))
            .filter(
                dependency => dependency !== 'module' && dependency !== 'go',
            );
        for (const dependency of [...new Set(requirements)].sort())
            nodes.push(
                node(
                    `go:${dependency}`,
                    'external.dependency',
                    dependency,
                    repoId,
                    file.path,
                ),
            );
        for (const dependency of [...new Set(requirements)].sort())
            edges.push({
                from: id,
                to: `go:${dependency}`,
                kind: 'depends-on',
                evidence: [sourceEvidence(file.path)],
            });
    }
    for (const file of sortedFiles.filter(candidate =>
        candidate.path.endsWith('.go'),
    )) {
        const packageName =
            file.text.match(/^\s*package\s+(\w+)/m)?.[1] ?? file.path;
        const id = `${repoId}:go-package:${file.path}`;
        nodes.push(node(id, 'go.package', packageName, repoId, file.path));
        const imports = [
            ...file.text.matchAll(/^\s*import\s+"([^"]+)"/gm),
            ...file.text.matchAll(/^\s*"([^"]+)"\s*(?:(?:\/\/.*)?$)/gm),
        ].map(match => ({
            value: String(match[1]),
            line: lineAt(file.text, match.index ?? 0),
        }));
        for (const imported of imports)
            edges.push({
                from: id,
                to: `go-import:${imported.value}`,
                kind: 'imports',
                evidence: [sourceEvidence(file.path, imported.line)],
            });
        for (const match of file.text.matchAll(
            /\bhttp\.HandleFunc\s*\(\s*"([^"]+)"/g,
        )) {
            const path = String(match[1]);
            const contractId = `${repoId}:http.route:ANY:${path}`;
            nodes.push(
                node(
                    contractId,
                    'contract.http.route',
                    `ANY ${path}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: id,
                to: contractId,
                kind: 'exposes-contract',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(
            /\b(?:r|router|engine|e)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g,
        ))
            addHttpRoute(
                id,
                String(match[1]),
                String(match[2]),
                file,
                match.index ?? 0,
            );
        for (const match of file.text.matchAll(
            /\bhttp\.(Get|Post)\s*\(\s*"([^"]+)"/g,
        )) {
            const method = String(match[1]).toUpperCase();
            const target = String(match[2]);
            const contractId = `${repoId}:http.request:${method}:${target}`;
            nodes.push(
                node(
                    contractId,
                    'contract.http.request',
                    `${method} ${target}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: id,
                to: contractId,
                kind: 'consumes-contract',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(
            /\bhttp\.NewRequest(?:WithContext)?\s*\(\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\s*,\s*"([^"]+)"/g,
        ))
            addHttpRequest(
                id,
                String(match[2]),
                file,
                match.index ?? 0,
                String(match[1]),
            );
        if (/google\.golang\.org\/grpc/.test(file.text)) {
            for (const match of file.text.matchAll(
                /\bRegister(\w+)Server\s*\(/g,
            )) {
                const service = String(match[1]);
                const serviceId = grpcServiceId(repoId, service);
                nodes.push(
                    node(
                        serviceId,
                        'contract.grpc.service',
                        service,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: serviceId,
                    kind: 'exposes-contract',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
            for (const match of file.text.matchAll(/\bNew(\w+)Client\s*\(/g)) {
                const service = String(match[1]);
                const serviceId = grpcServiceId(repoId, service);
                nodes.push(
                    node(
                        serviceId,
                        'contract.grpc.service',
                        service,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: serviceId,
                    kind: 'consumes-contract',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        }
        const transport = messagingTransport(file.text);
        if (transport !== undefined)
            for (const match of file.text.matchAll(
                /\.(Publish|Subscribe|Send|Consume)\s*\(\s*"([^"]+)"/g,
            )) {
                const verb = String(match[1]);
                const subject = String(match[2]);
                const channelId = `${repoId}:messaging:${transport}:${subject}`;
                nodes.push(
                    node(
                        channelId,
                        'channel.messaging',
                        `${transport}: ${subject}`,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: channelId,
                    kind: channelKind(verb),
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        if (/import\s+"C"/.test(file.text)) {
            const ffiId = `${repoId}:ffi.cgo:${file.path}`;
            nodes.push(
                node(ffiId, 'ffi.c-abi', 'cgo C ABI', repoId, file.path),
            );
            edges.push({
                from: id,
                to: ffiId,
                kind: 'uses-ffi',
                evidence: [sourceEvidence(file.path)],
            });
        }
        if (/^\s*\/\/go:build/m.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'go.build-constraints-unavailable',
            });
        if (/"reflect"/.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'go.reflection-semantics-unavailable',
            });
        if (/^\s*\/\/\s*Code generated .* DO NOT EDIT\.?\s*$/m.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'go.generated-code-semantics-unavailable',
                message:
                    'Generated Go source is inventoried structurally but not given semantic interpretation.',
            });
    }
    for (const file of terraformFiles) {
        const componentId = `${repoId}:component:terraform:${file.path}`;
        const moduleId = `${repoId}:terraform.module:${file.path}`;
        nodes.push(
            node(componentId, 'component', file.path, repoId, file.path),
        );
        nodes.push(
            node(moduleId, 'terraform.module', file.path, repoId, file.path),
        );
        edges.push({
            from: componentId,
            to: moduleId,
            kind: 'contains',
            evidence: [sourceEvidence(file.path)],
        });
        if (file.path.endsWith('.tf.json')) {
            try {
                const document = JSON.parse(file.text) as Record<
                    string,
                    unknown
                >;
                for (const blockType of [
                    'resource',
                    'data',
                    'module',
                    'variable',
                    'output',
                    'provider',
                ]) {
                    const blocks = document[blockType];
                    if (typeof blocks !== 'object' || blocks === null) continue;
                    for (const [type, values] of Object.entries(blocks)) {
                        const names =
                            typeof values === 'object' && values !== null
                                ? Object.keys(values)
                                : ['default'];
                        for (const name of names) {
                            const id = `${repoId}:terraform.${blockType}:${file.path}:${type}.${name}`;
                            nodes.push(
                                node(
                                    id,
                                    `terraform.${blockType}`,
                                    `${type}.${name}`,
                                    repoId,
                                    file.path,
                                ),
                            );
                            edges.push({
                                from: moduleId,
                                to: id,
                                kind: 'contains',
                                evidence: [sourceEvidence(file.path)],
                            });
                        }
                    }
                }
            } catch {
                unknowns.push({
                    path: file.path,
                    kind: 'terraform.invalid-json',
                });
            }
            continue;
        }
        for (const match of file.text.matchAll(
            /^\s*(resource|data|module|variable|output|provider)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm,
        )) {
            const blockType = String(match[1]);
            const type = String(match[2]);
            const name = match[3] === undefined ? 'default' : String(match[3]);
            const id = `${repoId}:terraform.${blockType}:${file.path}:${type}.${name}`;
            nodes.push(
                node(
                    id,
                    `terraform.${blockType}`,
                    `${type}.${name}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: moduleId,
                to: id,
                kind: 'contains',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
            const transport =
                blockType === 'resource'
                    ? terraformMessagingTransport(type)
                    : undefined;
            if (transport !== undefined) {
                const channelId = `${repoId}:messaging:${transport}:${type}.${name}`;
                nodes.push(
                    node(
                        channelId,
                        'channel.messaging',
                        `${transport}: ${type}.${name}`,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: channelId,
                    kind: 'provisions-channel',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        }
        if (/\b(?:for_each|count|dynamic)\b/.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'terraform.dynamic-expression-unavailable',
                message:
                    'Dynamic Terraform expressions are not evaluated by deterministic analysis.',
            });
    }
    const terraformNodeIds = new Set(
        nodes.flatMap(graphNode =>
            typeof graphNode.id === 'string' &&
            graphNode.id.startsWith(`${repoId}:terraform.`)
                ? [graphNode.id]
                : [],
        ),
    );
    const terraformTargets = new Map<string, string[]>();
    for (const blockType of ['resource', 'data', 'module', 'variable'])
        for (const nodeId of terraformNodeIds) {
            const prefix = `${repoId}:terraform.${blockType}:`;
            if (!nodeId.startsWith(prefix)) continue;
            const definition = nodeId.slice(prefix.length);
            const pathSeparator = definition.lastIndexOf(':');
            if (pathSeparator === -1) continue;
            const typeAndName = definition.slice(pathSeparator + 1);
            const nameSeparator = typeAndName.lastIndexOf('.');
            if (nameSeparator === -1) continue;
            const key = `${blockType}\0${typeAndName.slice(0, nameSeparator)}\0${typeAndName.slice(nameSeparator + 1)}`;
            terraformTargets.set(key, [
                ...(terraformTargets.get(key) ?? []),
                nodeId,
            ]);
        }
    for (const terraformFile of terraformFiles.filter(candidate =>
        candidate.path.endsWith('.tf'),
    ))
        for (const blockMatch of terraformFile.text.matchAll(
            /^\s*(resource|data|module|variable|output)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{([^{}]*)\}/gm,
        )) {
            const blockType = String(blockMatch[1]);
            const type = String(blockMatch[2]);
            const name =
                blockMatch[3] === undefined ? 'default' : String(blockMatch[3]);
            const body = String(blockMatch[4]);
            const bodyOffset = String(blockMatch[0]).indexOf(body);
            const sourceId = `${repoId}:terraform.${blockType}:${terraformFile.path}:${type}.${name}`;
            if (!terraformNodeIds.has(sourceId)) continue;
            for (const referenceMatch of body.matchAll(
                /\b(?:(data)\.)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g,
            )) {
                const namespace = referenceMatch[1];
                const referenceType = String(referenceMatch[2]);
                const referenceName = String(referenceMatch[3]);
                const targetKey =
                    namespace === 'data'
                        ? `data\0${referenceType}\0${referenceName}`
                        : referenceType === 'var'
                          ? `variable\0${referenceName}\0default`
                          : referenceType === 'module'
                            ? `module\0${referenceName}\0default`
                            : `resource\0${referenceType}\0${referenceName}`;
                const targetIds = terraformTargets.get(targetKey) ?? [];
                if (targetIds.length !== 1) {
                    unknowns.push({
                        path: terraformFile.path,
                        kind:
                            targetIds.length === 0
                                ? 'terraform.reference-unresolved'
                                : 'terraform.reference-ambiguous',
                        reference: referenceMatch[0],
                    });
                    continue;
                }
                edges.push({
                    from: sourceId,
                    to: targetIds[0]!,
                    kind: 'references',
                    evidence: [
                        sourceEvidence(
                            terraformFile.path,
                            lineAt(
                                terraformFile.text,
                                (blockMatch.index ?? 0) +
                                    bodyOffset +
                                    (referenceMatch.index ?? 0),
                            ),
                        ),
                    ],
                });
            }
            if (blockType !== 'module') continue;
            const moduleSource = body.match(
                /\bsource\s*=\s*["']([^"']+)["'](?:\s|$)/,
            )?.[1];
            if (moduleSource === undefined) continue;
            const moduleSourceId = `${repoId}:terraform.module-source:${terraformFile.path}:${type}`;
            nodes.push(
                node(
                    moduleSourceId,
                    'infrastructure.terraform.module-source',
                    moduleSource,
                    repoId,
                    terraformFile.path,
                ),
            );
            edges.push({
                from: sourceId,
                to: moduleSourceId,
                kind: 'uses-module-source',
                evidence: [
                    sourceEvidence(
                        terraformFile.path,
                        lineAt(terraformFile.text, blockMatch.index ?? 0),
                    ),
                ],
            });
        }
    for (const file of xmlFiles) {
        const root = file.text.match(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/);
        if (root === null) {
            unknowns.push({ path: file.path, kind: 'xml.invalid-or-empty' });
            continue;
        }
        const documentId = `${repoId}:xml.document:${file.path}`;
        nodes.push(
            node(
                documentId,
                'xml.document',
                String(root[1]),
                repoId,
                file.path,
            ),
        );
        for (const namespace of file.text.matchAll(
            /\sxmlns(?::[\w.-]+)?\s*=\s*["']([^"']+)["']/g,
        ))
            edges.push({
                from: documentId,
                to: `xml-namespace:${namespace[1]}`,
                kind: 'declares-namespace',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, namespace.index ?? 0),
                    ),
                ],
            });
        for (const reference of file.text.matchAll(
            /\s(?:src|href|schemaLocation|location)\s*=\s*["']([^"']+)["']/g,
        ))
            edges.push({
                from: documentId,
                to: `xml-reference:${reference[1]}`,
                kind: 'references-file',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, reference.index ?? 0),
                    ),
                ],
            });
        if (/(?:^|\/)browserconfig\.xml$/i.test(file.path))
            for (const tile of file.text.matchAll(
                /<([A-Za-z0-9]+logo)\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi,
            )) {
                const id = `${repoId}:xml.browserconfig.tile:${file.path}:${tile[1]}`;
                nodes.push(
                    node(
                        id,
                        'xml.browserconfig.tile',
                        String(tile[1]),
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: documentId,
                    to: id,
                    kind: 'contains',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, tile.index ?? 0),
                        ),
                    ],
                });
                edges.push({
                    from: id,
                    to: `xml-reference:${tile[2]}`,
                    kind: 'references-file',
                    evidence: [sourceEvidence(file.path)],
                });
            }
        unknowns.push({
            path: file.path,
            kind: 'xml.dialect-semantics-unavailable',
            message:
                'The deterministic baseline records only structural XML semantics.',
        });
    }
    for (const file of openApiFiles) {
        if (!file.path.endsWith('.json')) {
            unknowns.push({
                path: file.path,
                kind: 'openapi.yaml-parser-unavailable',
            });
            continue;
        }
        try {
            const document = JSON.parse(file.text) as {
                readonly openapi?: string;
                readonly swagger?: string;
                readonly paths?: Record<string, Record<string, unknown>>;
            };
            if (
                document.openapi === undefined &&
                document.swagger === undefined
            )
                throw new Error('Not an OpenAPI document.');
            const contractId = `${repoId}:openapi.document:${file.path}`;
            nodes.push(
                node(
                    contractId,
                    'contract.openapi.document',
                    file.path,
                    repoId,
                    file.path,
                ),
            );
            const owner = packages
                .map(packageFile => ({
                    path: packageFile.path,
                    directory: directoryOf(packageFile.path),
                }))
                .filter(candidate => file.path.startsWith(candidate.directory))
                .toSorted(
                    (left, right) =>
                        right.directory.length - left.directory.length,
                )[0];
            if (owner !== undefined)
                edges.push({
                    from: `${repoId}:component:${owner.path}`,
                    to: contractId,
                    kind: 'exposes-contract',
                    evidence: [sourceEvidence(file.path)],
                });
            for (const [path, methods] of Object.entries(document.paths ?? {}))
                for (const [method, operation] of Object.entries(methods)) {
                    if (
                        !/^(get|put|post|delete|patch|head|options)$/i.test(
                            method,
                        )
                    )
                        continue;
                    const operationId =
                        typeof operation === 'object' && operation !== null
                            ? (operation as { operationId?: unknown })
                                  .operationId
                            : undefined;
                    const id = `${repoId}:openapi.operation:${file.path}:${method.toUpperCase()} ${path}`;
                    nodes.push(
                        node(
                            id,
                            'contract.openapi.operation',
                            typeof operationId === 'string'
                                ? operationId
                                : `${method.toUpperCase()} ${path}`,
                            repoId,
                            file.path,
                        ),
                    );
                    edges.push({
                        from: contractId,
                        to: id,
                        kind: 'contains',
                        evidence: [sourceEvidence(file.path)],
                    });
                }
        } catch {
            unknowns.push({ path: file.path, kind: 'openapi.invalid-json' });
        }
    }
    for (const file of graphqlFiles) {
        const documentId = `${repoId}:graphql.document:${file.path}`;
        nodes.push(
            node(
                documentId,
                'contract.graphql.document',
                file.path,
                repoId,
                file.path,
            ),
        );
        for (const match of file.text.matchAll(
            /\b(?:type|interface|input|enum|union|scalar)\s+(\w+)/g,
        )) {
            const name = String(match[1]);
            const typeId = `${repoId}:graphql.type:${name}`;
            nodes.push(
                node(typeId, 'contract.graphql.type', name, repoId, file.path),
            );
            edges.push({
                from: documentId,
                to: typeId,
                kind: 'contains',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(
            /\b(query|mutation|subscription)\s+(\w+)/g,
        )) {
            const operationType = String(match[1]);
            const name = String(match[2]);
            const operationId = graphqlOperationId(repoId, operationType, name);
            nodes.push(
                node(
                    operationId,
                    'contract.graphql.operation',
                    `${operationType} ${name}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: documentId,
                to: operationId,
                kind: 'contains',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        if (/\b(query|mutation|subscription)\s*\{/.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'graphql.anonymous-operation-identity-unavailable',
                message:
                    'Anonymous GraphQL operations have no stable cross-file identity.',
            });
    }
    for (const file of protobufFiles) {
        const documentId = `${repoId}:protobuf.document:${file.path}`;
        const packageName =
            file.text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ??
            'unqualified';
        nodes.push(
            node(
                documentId,
                'contract.protobuf.document',
                file.path,
                repoId,
                file.path,
            ),
        );
        for (const match of file.text.matchAll(/\bmessage\s+(\w+)\s*\{/g)) {
            const name = String(match[1]);
            const messageId = `${repoId}:protobuf.message:${packageName}:${name}`;
            nodes.push(
                node(
                    messageId,
                    'contract.protobuf.message',
                    `${packageName}.${name}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: documentId,
                to: messageId,
                kind: 'contains',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const serviceMatch of file.text.matchAll(
            /\bservice\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm,
        )) {
            const service = String(serviceMatch[1]);
            const body = String(serviceMatch[2]);
            const serviceId = grpcServiceId(repoId, service);
            nodes.push(
                node(
                    serviceId,
                    'contract.grpc.service',
                    `${packageName}.${service}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: documentId,
                to: serviceId,
                kind: 'contains',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, serviceMatch.index ?? 0),
                    ),
                ],
            });
            for (const methodMatch of body.matchAll(/\brpc\s+(\w+)\s*\(/g)) {
                const method = String(methodMatch[1]);
                const methodId = grpcMethodId(repoId, service, method);
                nodes.push(
                    node(
                        methodId,
                        'contract.grpc.method',
                        `${service}.${method}`,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: serviceId,
                    to: methodId,
                    kind: 'contains',
                    evidence: [sourceEvidence(file.path)],
                });
            }
        }
        if (!/^\s*syntax\s*=\s*"proto[23]"\s*;/m.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'protobuf.syntax-version-unavailable',
            });
    }
    for (const file of asyncApiFiles) {
        if (!file.path.endsWith('.json')) {
            unknowns.push({
                path: file.path,
                kind: 'asyncapi.yaml-parser-unavailable',
            });
            continue;
        }
        try {
            const document = JSON.parse(file.text) as {
                readonly asyncapi?: string;
                readonly channels?: Record<string, unknown>;
            };
            if (document.asyncapi === undefined)
                throw new Error('Not an AsyncAPI document.');
            const contractId = `${repoId}:asyncapi.document:${file.path}`;
            nodes.push(
                node(
                    contractId,
                    'contract.asyncapi.document',
                    file.path,
                    repoId,
                    file.path,
                ),
            );
            for (const channel of Object.keys(
                document.channels ?? {},
            ).toSorted()) {
                const channelId = `${repoId}:asyncapi.channel:${file.path}:${channel}`;
                nodes.push(
                    node(
                        channelId,
                        'channel.asyncapi',
                        channel,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: contractId,
                    to: channelId,
                    kind: 'contains',
                    evidence: [sourceEvidence(file.path)],
                });
            }
        } catch {
            unknowns.push({ path: file.path, kind: 'asyncapi.invalid-json' });
        }
    }
    for (const file of jsonSchemaFiles) {
        try {
            const document = JSON.parse(file.text) as {
                readonly $id?: unknown;
                readonly title?: unknown;
            };
            const schemaId = `${repoId}:json-schema:${file.path}`;
            const label =
                typeof document.$id === 'string'
                    ? document.$id
                    : typeof document.title === 'string'
                      ? document.title
                      : file.path;
            nodes.push(
                node(
                    schemaId,
                    'contract.json-schema',
                    label,
                    repoId,
                    file.path,
                ),
            );
        } catch {
            unknowns.push({
                path: file.path,
                kind: 'json-schema.invalid-json',
            });
        }
    }
    for (const file of turboFiles) {
        try {
            const document = JSON.parse(file.text) as {
                readonly tasks?: Record<string, unknown>;
                readonly pipeline?: Record<string, unknown>;
            };
            const turboId = `${repoId}:turborepo:${file.path}`;
            nodes.push(
                node(
                    turboId,
                    'infrastructure.turborepo',
                    'Turborepo',
                    repoId,
                    file.path,
                ),
            );
            for (const task of Object.keys(
                document.tasks ?? document.pipeline ?? {},
            ).toSorted()) {
                const taskId = `${repoId}:turborepo.task:${file.path}:${task}`;
                nodes.push(
                    node(
                        taskId,
                        'infrastructure.turborepo.task',
                        task,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: turboId,
                    to: taskId,
                    kind: 'contains',
                    evidence: [sourceEvidence(file.path)],
                });
            }
        } catch {
            unknowns.push({ path: file.path, kind: 'turborepo.invalid-json' });
        }
    }
    for (const file of wranglerFiles) {
        let name: string | undefined;
        let d1Bindings: string[] = [];
        if (file.path.endsWith('.json')) {
            try {
                const document = JSON.parse(file.text) as {
                    readonly name?: unknown;
                    readonly d1_databases?: unknown;
                };
                name =
                    typeof document.name === 'string'
                        ? document.name
                        : undefined;
                d1Bindings = Array.isArray(document.d1_databases)
                    ? document.d1_databases.flatMap(value =>
                          typeof value === 'object' &&
                          value !== null &&
                          typeof (value as { binding?: unknown }).binding ===
                              'string'
                              ? [String((value as { binding: string }).binding)]
                              : [],
                      )
                    : [];
            } catch {
                unknowns.push({
                    path: file.path,
                    kind: 'wrangler.invalid-json',
                });
                continue;
            }
        } else {
            name = file.text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
            d1Bindings = [
                ...file.text.matchAll(/^\s*binding\s*=\s*["']([^"']+)["']/gm),
            ].map(match => String(match[1]));
        }
        const componentId = `${repoId}:component:wrangler:${file.path}`;
        const workerId = `${repoId}:cloudflare.worker:${file.path}`;
        nodes.push(
            node(
                componentId,
                'component',
                name ?? file.path,
                repoId,
                file.path,
            ),
        );
        nodes.push(
            node(
                workerId,
                'infrastructure.cloudflare.worker',
                name ?? file.path,
                repoId,
                file.path,
            ),
        );
        edges.push({
            from: componentId,
            to: workerId,
            kind: 'contains',
            evidence: [sourceEvidence(file.path)],
        });
        for (const binding of d1Bindings.toSorted()) {
            const bindingId = `${repoId}:cloudflare.d1-binding:${file.path}:${binding}`;
            nodes.push(
                node(
                    bindingId,
                    'infrastructure.cloudflare.d1-binding',
                    binding,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: workerId,
                to: bindingId,
                kind: 'binds-database',
                evidence: [sourceEvidence(file.path)],
            });
        }
    }
    for (const file of composeFiles) {
        const composeId = `${repoId}:compose.document:${file.path}`;
        nodes.push(
            node(
                composeId,
                'infrastructure.compose.document',
                file.path,
                repoId,
                file.path,
            ),
        );
        for (const service of file.text.matchAll(/^\s{2}([\w.-]+)\s*:\s*$/gm)) {
            const name = String(service[1]);
            const componentId = `${repoId}:component:compose:${file.path}:${name}`;
            nodes.push(node(componentId, 'component', name, repoId, file.path));
            edges.push({
                from: composeId,
                to: componentId,
                kind: 'contains',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, service.index ?? 0),
                    ),
                ],
            });
        }
        unknowns.push({
            path: file.path,
            kind: 'compose.yaml-structure-only',
            message:
                'Docker Compose was read structurally; interpolation and full service semantics were not evaluated.',
        });
    }
    for (const file of kubernetesFiles) {
        for (const [index, document] of file.text
            .split(/^---\s*$/m)
            .entries()) {
            const kind = document.match(/^\s*kind\s*:\s*([^\s#]+)/m)?.[1];
            const name = document.match(
                /^\s*metadata\s*:\s*\n\s*name\s*:\s*([^\s#]+)/m,
            )?.[1];
            if (kind === undefined) continue;
            const id = `${repoId}:kubernetes.object:${file.path}:${index}:${kind}:${name ?? 'unnamed'}`;
            nodes.push(
                node(
                    id,
                    'infrastructure.kubernetes.object',
                    name === undefined ? kind : `${kind}/${name}`,
                    repoId,
                    file.path,
                ),
            );
        }
        unknowns.push({
            path: file.path,
            kind: 'kubernetes.yaml-structure-only',
            message:
                'Kubernetes YAML was read structurally; templating and workload binding semantics were not evaluated.',
        });
    }
    const rustFiles = sortedFiles.filter(file => file.path.endsWith('.rs'));
    const rustPaths = new Set(rustFiles.map(file => file.path));
    const resolveRustPath = (from: string, target: string): string => {
        if (!target.startsWith('crate::')) return target;
        const suffix = target
            .slice('crate::'.length)
            .split('::')[0]
            .replaceAll('r#', '');
        const root = from.startsWith('src/') ? 'src/' : `${directoryOf(from)}`;
        const candidates = [`${root}${suffix}.rs`, `${root}${suffix}/mod.rs`];
        const resolved = candidates.find(path => rustPaths.has(path));
        return resolved === undefined ? target : `${repoId}:module:${resolved}`;
    };
    for (const file of rustFiles) {
        const id = `${repoId}:module:${file.path}`;
        nodes.push(node(id, 'rust.module', file.path, repoId, file.path));
        for (const match of file.text.matchAll(/^\s*use\s+([^;]+);/gm))
            edges.push({
                from: id,
                to: resolveRustPath(file.path, String(match[1])),
                kind: 'uses',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        for (const match of file.text.matchAll(/^\s*mod\s+(\w+)\s*;/gm)) {
            const module = String(match[1]);
            const base = directoryOf(file.path);
            const candidates = [
                `${base}${module}.rs`,
                `${base}${module}/mod.rs`,
            ];
            const resolved = candidates.find(path => rustPaths.has(path));
            edges.push({
                from: id,
                to:
                    resolved === undefined
                        ? `rust-module:${module}`
                        : `${repoId}:module:${resolved}`,
                kind: 'declares-module',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(/\broute\s*\(\s*"([^"]+)"/g)) {
            const path = String(match[1]);
            const contractId = `${repoId}:http.route:ANY:${path}`;
            nodes.push(
                node(
                    contractId,
                    'contract.http.route',
                    `ANY ${path}`,
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: id,
                to: contractId,
                kind: 'exposes-contract',
                evidence: [
                    sourceEvidence(
                        file.path,
                        lineAt(file.text, match.index ?? 0),
                    ),
                ],
            });
        }
        for (const match of file.text.matchAll(
            /\broute\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete|head|options)\b/gi,
        ))
            addHttpRoute(
                id,
                String(match[2]),
                String(match[1]),
                file,
                match.index ?? 0,
            );
        for (const match of file.text.matchAll(
            /#\[(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"/gi,
        ))
            addHttpRoute(
                id,
                String(match[1]),
                String(match[2]),
                file,
                match.index ?? 0,
            );
        for (const match of file.text.matchAll(
            /\b(?:client|Client)\.(get|post|put|patch|delete|head)\s*\(\s*"([^"]+)"/gi,
        ))
            addHttpRequest(
                id,
                String(match[2]),
                file,
                match.index ?? 0,
                String(match[1]).toUpperCase(),
            );
        if (/\btonic\b/.test(file.text)) {
            for (const match of file.text.matchAll(
                /\b(\w+)Server::new\s*\(/g,
            )) {
                const service = String(match[1]);
                const serviceId = grpcServiceId(repoId, service);
                nodes.push(
                    node(
                        serviceId,
                        'contract.grpc.service',
                        service,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: serviceId,
                    kind: 'exposes-contract',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
            for (const match of file.text.matchAll(
                /\b(\w+)Client::connect\s*\(/g,
            )) {
                const service = String(match[1]);
                const serviceId = grpcServiceId(repoId, service);
                nodes.push(
                    node(
                        serviceId,
                        'contract.grpc.service',
                        service,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: serviceId,
                    kind: 'consumes-contract',
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        }
        const transport = messagingTransport(file.text);
        if (transport !== undefined)
            for (const match of file.text.matchAll(
                /\.(publish|subscribe|send|consume)\s*\(\s*"([^"]+)"/g,
            )) {
                const verb = String(match[1]);
                const subject = String(match[2]);
                const channelId = `${repoId}:messaging:${transport}:${subject}`;
                nodes.push(
                    node(
                        channelId,
                        'channel.messaging',
                        `${transport}: ${subject}`,
                        repoId,
                        file.path,
                    ),
                );
                edges.push({
                    from: id,
                    to: channelId,
                    kind: channelKind(verb),
                    evidence: [
                        sourceEvidence(
                            file.path,
                            lineAt(file.text, match.index ?? 0),
                        ),
                    ],
                });
            }
        if (/\bextern\s+["']C["']/.test(file.text)) {
            const ffiId = `${repoId}:ffi.c-abi:${file.path}`;
            nodes.push(node(ffiId, 'ffi.c-abi', 'C ABI', repoId, file.path));
            edges.push({
                from: id,
                to: ffiId,
                kind: 'exports-ffi',
                evidence: [sourceEvidence(file.path)],
            });
        }
        if (/\b(?:wasm_bindgen|wasm-bindgen)\b/.test(file.text)) {
            const ffiId = `${repoId}:ffi.wasm:${file.path}`;
            nodes.push(
                node(
                    ffiId,
                    'ffi.wasm',
                    'WebAssembly boundary',
                    repoId,
                    file.path,
                ),
            );
            edges.push({
                from: id,
                to: ffiId,
                kind: 'exports-ffi',
                evidence: [sourceEvidence(file.path)],
            });
        }
        if (/^\s*#\[cfg/m.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'rust.cfg-semantics-unavailable',
            });
        if (/\w+!\s*[({[]/.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'rust.macro-semantics-unavailable',
            });
        if (/^\s*\/\/\s*Code generated .* DO NOT EDIT\.?\s*$/m.test(file.text))
            unknowns.push({
                path: file.path,
                kind: 'rust.generated-code-semantics-unavailable',
                message:
                    'Generated Rust source is inventoried structurally but not given semantic interpretation.',
            });
    }
    if (packages.length > 0)
        report.push(`- TypeScript package manifests: ${packages.length}`);
    if (pnpmWorkspaces.length > 0)
        report.push(`- pnpm workspace manifests: ${pnpmWorkspaces.length}`);
    if (cargos.length > 0)
        report.push(`- Rust Cargo manifests: ${cargos.length}`);
    if (goModules.length > 0)
        report.push(`- Go module manifests: ${goModules.length}`);
    if (terraformFiles.length > 0)
        report.push(
            `- Terraform configuration files: ${terraformFiles.length}`,
        );
    if (xmlFiles.length > 0) report.push(`- XML documents: ${xmlFiles.length}`);
    if (openApiFiles.length > 0)
        report.push(`- OpenAPI documents: ${openApiFiles.length}`);
    if (graphqlFiles.length > 0)
        report.push(`- GraphQL documents: ${graphqlFiles.length}`);
    if (protobufFiles.length > 0)
        report.push(`- Protobuf documents: ${protobufFiles.length}`);
    if (asyncApiFiles.length > 0)
        report.push(`- AsyncAPI documents: ${asyncApiFiles.length}`);
    if (jsonSchemaFiles.length > 0)
        report.push(`- JSON Schema documents: ${jsonSchemaFiles.length}`);
    if (turboFiles.length > 0)
        report.push(`- Turborepo configuration files: ${turboFiles.length}`);
    if (wranglerFiles.length > 0)
        report.push(`- Wrangler configuration files: ${wranglerFiles.length}`);
    if (composeFiles.length > 0)
        report.push(`- Docker Compose files: ${composeFiles.length}`);
    if (kubernetesFiles.length > 0)
        report.push(`- Kubernetes YAML files: ${kubernetesFiles.length}`);
    if (analyzers.length > 0)
        report.push(
            `- Deterministic analyzers: ${analyzers.map(analyzer => `${analyzer.id}@${analyzer.version}`).join(', ')}`,
        );
    unknowns.push({
        kind: 'm2.semantic-limit',
        message:
            'Compiler and language-server enrichment is unavailable in this fallback.',
    });
    return {
        nodes: mergeCanonicalRecords(nodes, record =>
            String(record.id ?? JSON.stringify(record)),
        ),
        edges: mergeCanonicalRecords(edges, record => {
            const { evidence: _evidence, ...relationship } = record;
            return JSON.stringify(relationship);
        }),
        unknowns: sortRecords(unknowns),
        report,
        analyzerCount: analyzers.length,
        analyzerIds: analyzers.map(
            analyzer => `${analyzer.id}@${analyzer.version}`,
        ),
    };
};

/** @deprecated Use analyzeDeterministicSource for the multi-language baseline. */
export const analyzeTypeScriptAndRust = analyzeDeterministicSource;
