import type { WorkspaceIntelligenceSourceFile } from './analysis';

/** Compile-time first-party analyzer metadata; runtime plugins are unsupported. */
export interface WorkspaceIntelligenceAnalyzerDefinition {
    readonly id: string;
    readonly version: string;
    readonly supportedPath: (path: string) => boolean;
    readonly capabilities: ReadonlyArray<string>;
    readonly limitations: ReadonlyArray<string>;
}

export const deterministicAnalyzerRegistry: ReadonlyArray<WorkspaceIntelligenceAnalyzerDefinition> =
    [
        {
            id: 'workspace-intelligence.typescript',
            version: '3',
            supportedPath: path =>
                /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json)$|\.[cm]?[jt]sx?$/.test(
                    path,
                ),
            capabilities: [
                'package-workspaces',
                'manifest-dependencies',
                'static-import-export-links',
                'static-framework-http-route-request-links',
            ],
            limitations: ['compiler-semantics-unavailable'],
        },
        {
            id: 'workspace-intelligence.rust',
            version: '3',
            supportedPath: path =>
                path.endsWith('Cargo.toml') || path.endsWith('.rs'),
            capabilities: [
                'cargo-packages',
                'cargo-targets',
                'modules',
                'static-use-links',
                'static-framework-http-route-request-links',
            ],
            limitations: [
                'cfg-macro-build-script-generated-code-semantics-unavailable',
            ],
        },
        {
            id: 'workspace-intelligence.go',
            version: '3',
            supportedPath: path =>
                path.endsWith('go.mod') ||
                path.endsWith('go.work') ||
                path.endsWith('.go'),
            capabilities: [
                'modules',
                'packages',
                'static-import-links',
                'static-framework-http-route-request-links',
            ],
            limitations: [
                'build-constraints-reflection-generated-code-call-semantics-unavailable',
            ],
        },
        {
            id: 'workspace-intelligence.terraform',
            version: '2',
            supportedPath: path =>
                path.endsWith('.tf') || path.endsWith('.tf.json'),
            capabilities: [
                'static-resource-data-module-declarations',
                'cross-file-static-reference-links',
            ],
            limitations: [
                'dynamic-expression-provider-state-semantics-unavailable',
            ],
        },
        {
            id: 'workspace-intelligence.xml',
            version: '1',
            supportedPath: path => path.endsWith('.xml'),
            capabilities: ['document-root-namespace-file-reference-structure'],
            limitations: ['unrecognized-dialect-semantics-unavailable'],
        },
        {
            id: 'workspace-intelligence.openapi-json',
            version: '1',
            supportedPath: path =>
                /(?:^|\/)(?:openapi|swagger)\.json$/.test(path),
            capabilities: ['document-operation-schema-contracts'],
            limitations: ['yaml-framework-handler-linking-unavailable'],
        },
        {
            id: 'workspace-intelligence.contracts',
            version: '1',
            supportedPath: path => /\.(?:graphql|gql|proto)$/.test(path),
            capabilities: [
                'graphql-document-operation-structure',
                'protobuf-service-method-message-structure',
            ],
            limitations: [
                'graphql-resolver-generated-client-semantics-unavailable',
                'protobuf-generated-stub-semantics-unavailable',
            ],
        },
        {
            id: 'workspace-intelligence.recognized-config',
            version: '1',
            supportedPath: path =>
                /(?:^|\/)(?:turbo|wrangler)\.(?:json|toml)$|(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$|(?:^|\/)(?:kustomization|deployment|service|configmap|ingress|statefulset|daemonset|job|cronjob|namespace|secret)\.ya?ml$|(?:^|\/)(?:asyncapi)\.(?:json|ya?ml)$|(?:^|\/)(?:[^/]+\.schema|schema)\.json$/.test(
                    path,
                ),
            capabilities: [
                'recognized-config-components',
                'asyncapi-json-channels',
                'static-infrastructure-bindings',
            ],
            limitations: ['general-yaml-toml-expression-semantics-unavailable'],
        },
    ];

export const matchingDeterministicAnalyzers = (
    files: ReadonlyArray<WorkspaceIntelligenceSourceFile>,
): ReadonlyArray<WorkspaceIntelligenceAnalyzerDefinition> =>
    deterministicAnalyzerRegistry.filter(analyzer =>
        files.some(file => analyzer.supportedPath(file.path)),
    );
