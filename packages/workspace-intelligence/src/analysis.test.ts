import { RepoId } from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { analyzeDeterministicSource } from './analysis';

describe('analyzeDeterministicSource', () => {
    test('extracts TypeScript/Rust manifests and module relationships deterministically', () => {
        const result = analyzeDeterministicSource(RepoId.make('repo-a'), [
            {
                path: 'package.json',
                text: JSON.stringify({
                    name: '@example/web',
                    dependencies: {
                        effect: '4.0.0',
                        '@cbranch/rpc-contract': 'workspace:*',
                        react: '19.0.0',
                        vite: '7.0.0',
                        wrangler: '4.0.0',
                        '@napi-rs/canvas': '0.1.0',
                    },
                }),
            },
            {
                path: 'pnpm-workspace.yaml',
                text: "packages:\n  - 'packages/*'\n  - apps/*\n",
            },
            {
                path: 'src/main.ts',
                text: 'import { Effect } from "effect"; import { connect } from "nats"; import { UserClient } from "@grpc/grpc-js"; import { helper } from "./util"; router.get("/health", helper); fetch("https://example.test/users"); connect().publish("orders.created"); gql`query GetUser { user { id } }`; new UserClient(); WebAssembly.instantiate(bytes); export { Effect, helper };',
            },
            { path: 'src/util.ts', text: 'export const helper = 1;' },
            { path: 'tsconfig.json', text: '{"extends":"./base.json"}' },
            {
                path: 'Cargo.toml',
                text: '[package]\nname = "desktop"\n[dependencies]\ntauri = "2"\n',
            },
            {
                path: 'src/main.rs',
                text: 'mod helpers;\nuse crate::helpers::run;\nuse tauri::Manager;\nuse async_nats::connect;\nuse tonic;\nextern "C" { fn host_call(); }\nrouter.route("/status", get(status));\nclient.publish("orders.created", payload);\nUserServer::new(service);\nUserClient::connect("http://localhost");\n#[wasm_bindgen]\nfn render() {}\n',
            },
            { path: 'src/helpers.rs', text: 'pub fn run() {}\n' },
            {
                path: 'go.work',
                text: 'go 1.24\n\nuse (\n  ./cmd/api\n)\n',
            },
            {
                path: 'go.mod',
                text: 'module example.com/api\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n',
            },
            {
                path: 'cmd/api/main.go',
                text: 'package main\n\nimport (\n  "net/http"\n  nats "github.com/nats-io/nats.go"\n  "google.golang.org/grpc"\n)\n\nfunc main() {\n  http.HandleFunc("/ready", nil)\n  http.Get("https://example.test/health")\n  nats.Publish("billing.paid", nil)\n  pb.RegisterUserServer(server, service)\n  pb.NewUserClient(conn)\n}\n',
            },
            {
                path: 'infra/main.tf',
                text: 'provider "aws" {}\nresource "aws_s3_bucket" "logs" {\n  count = 1\n}\nresource "aws_sns_topic" "orders" {}\nmodule "shared" { source = "./modules/shared" }\noutput "bucket" { value = aws_s3_bucket.logs.id }\n',
            },
            {
                path: 'infra/data.tf.json',
                text: JSON.stringify({
                    data: { aws_region: { current: {} } },
                }),
            },
            {
                path: 'public/browserconfig.xml',
                text: '<browserconfig xmlns="urn:browser"><msapplication><tile><square150x150logo src="/tile.png" /></tile></msapplication></browserconfig>',
            },
            {
                path: 'openapi.json',
                text: JSON.stringify({
                    openapi: '3.1.0',
                    paths: {
                        '/users': { get: { operationId: 'listUsers' } },
                    },
                }),
            },
            {
                path: 'contracts/schema.graphql',
                text: 'type Query { user: User }\ntype User { id: ID! }\nquery GetUser { user { id } }\n',
            },
            {
                path: 'contracts/users.proto',
                text: 'syntax = "proto3";\npackage example.users;\nmessage GetUserRequest {}\nmessage GetUserResponse {}\nservice User {\n  rpc GetUser (GetUserRequest) returns (GetUserResponse);\n}\n',
            },
            {
                path: 'asyncapi.json',
                text: JSON.stringify({
                    asyncapi: '3.0.0',
                    channels: { 'orders.created': {} },
                }),
            },
            {
                path: 'schemas/user.schema.json',
                text: JSON.stringify({
                    $id: 'https://example.test/User',
                    title: 'User',
                }),
            },
            {
                path: 'turbo.json',
                text: JSON.stringify({ tasks: { build: {} } }),
            },
            {
                path: 'wrangler.toml',
                text: 'name = "edge-api"\n[[d1_databases]]\nbinding = "DB"\n',
            },
            {
                path: 'docker-compose.yml',
                text: 'services:\n  api:\n    image: example/api\n',
            },
            {
                path: 'deployment.yaml',
                text: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n',
            },
        ]);

        expect(result.analyzerCount).toBe(8);
        expect(result.analyzerIds).toEqual([
            'workspace-intelligence.typescript@3',
            'workspace-intelligence.rust@3',
            'workspace-intelligence.go@3',
            'workspace-intelligence.terraform@2',
            'workspace-intelligence.xml@1',
            'workspace-intelligence.openapi-json@1',
            'workspace-intelligence.contracts@1',
            'workspace-intelligence.recognized-config@1',
        ]);
        expect(result.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'typescript.package' }),
                expect.objectContaining({ kind: 'typescript.project' }),
                expect.objectContaining({
                    kind: 'typescript.export',
                    label: 'helper',
                }),
                expect.objectContaining({ kind: 'component' }),
                expect.objectContaining({ kind: 'framework', label: 'effect' }),
                expect.objectContaining({ kind: 'framework', label: 'react' }),
                expect.objectContaining({
                    kind: 'framework',
                    label: 'cloudflare.workers',
                }),
                expect.objectContaining({
                    id: 'npm:effect',
                    kind: 'external.dependency',
                }),
                expect.objectContaining({
                    id: 'cargo:tauri',
                    kind: 'external.dependency',
                }),
                expect.objectContaining({
                    kind: 'typescript.workspace',
                    label: 'pnpm workspace',
                }),
                expect.objectContaining({
                    kind: 'rust.crate',
                    label: 'desktop',
                }),
                expect.objectContaining({
                    kind: 'go.module',
                    label: 'example.com/api',
                }),
                expect.objectContaining({
                    kind: 'go.package',
                    label: 'main',
                }),
                expect.objectContaining({
                    kind: 'terraform.resource',
                    label: 'aws_s3_bucket.logs',
                }),
                expect.objectContaining({
                    kind: 'terraform.data',
                    label: 'aws_region.current',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'GET /health',
                }),
                expect.objectContaining({
                    kind: 'contract.http.request',
                    label: 'https://example.test/users',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'ANY /ready',
                }),
                expect.objectContaining({
                    kind: 'contract.http.request',
                    label: 'GET https://example.test/health',
                }),
                expect.objectContaining({
                    kind: 'channel.messaging',
                    label: 'nats: orders.created',
                }),
                expect.objectContaining({
                    kind: 'channel.messaging',
                    label: 'nats: billing.paid',
                }),
                expect.objectContaining({
                    kind: 'channel.messaging',
                    label: 'aws.sns: aws_sns_topic.orders',
                }),
                expect.objectContaining({
                    kind: 'infrastructure.terraform.module-source',
                    label: './modules/shared',
                }),
                expect.objectContaining({ kind: 'ffi.c-abi', label: 'C ABI' }),
                expect.objectContaining({
                    kind: 'xml.browserconfig.tile',
                    label: 'square150x150logo',
                }),
                expect.objectContaining({
                    kind: 'contract.openapi.operation',
                    label: 'listUsers',
                }),
                expect.objectContaining({
                    kind: 'contract.graphql.operation',
                    label: 'query GetUser',
                }),
                expect.objectContaining({
                    kind: 'contract.grpc.service',
                    label: 'example.users.User',
                }),
                expect.objectContaining({
                    kind: 'contract.grpc.method',
                    label: 'User.GetUser',
                }),
                expect.objectContaining({
                    kind: 'contract.protobuf.message',
                    label: 'example.users.GetUserRequest',
                }),
                expect.objectContaining({ kind: 'ffi.node-api' }),
                expect.objectContaining({ kind: 'ffi.wasm' }),
                expect.objectContaining({ kind: 'channel.asyncapi' }),
                expect.objectContaining({
                    kind: 'contract.json-schema',
                    label: 'https://example.test/User',
                }),
                expect.objectContaining({
                    kind: 'infrastructure.turborepo.task',
                    label: 'build',
                }),
                expect.objectContaining({
                    kind: 'infrastructure.cloudflare.d1-binding',
                    label: 'DB',
                }),
                expect.objectContaining({
                    id: 'repo-a:component:compose:docker-compose.yml:api',
                }),
                expect.objectContaining({
                    kind: 'infrastructure.kubernetes.object',
                    label: 'Deployment/api',
                }),
            ]),
        );
        expect(result.edges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    to: 'npm:effect',
                    kind: 'depends-on',
                }),
                expect.objectContaining({
                    to: 'framework:cbranch.rpc',
                    kind: 'uses-framework',
                }),
                expect.objectContaining({ to: 'effect', kind: 'imports' }),
                expect.objectContaining({
                    from: `${RepoId.make('repo-a')}:module:src/util.ts`,
                    kind: 'declares-export',
                    to: `${RepoId.make('repo-a')}:typescript.export:src/util.ts:helper`,
                }),
                expect.objectContaining({
                    to: `${RepoId.make('repo-a')}:module:src/util.ts`,
                    kind: 'imports',
                }),
                expect.objectContaining({
                    to: 'cargo:tauri',
                    kind: 'depends-on',
                }),
                expect.objectContaining({
                    to: `${RepoId.make('repo-a')}:module:src/helpers.rs`,
                    kind: 'declares-module',
                }),
                expect.objectContaining({
                    to: `${RepoId.make('repo-a')}:module:src/helpers.rs`,
                    kind: 'uses',
                }),
                expect.objectContaining({
                    to: 'workspace-pattern:packages/*',
                    kind: 'includes',
                }),
                expect.objectContaining({
                    to: 'framework:tauri',
                    kind: 'uses-framework',
                }),
                expect.objectContaining({
                    to: 'go:github.com/go-chi/chi/v5',
                    kind: 'depends-on',
                }),
                expect.objectContaining({
                    to: 'go-import:net/http',
                    kind: 'imports',
                }),
                expect.objectContaining({
                    to: 'xml-reference:/tile.png',
                    kind: 'references-file',
                }),
                expect.objectContaining({
                    kind: 'exposes-contract',
                    to: `${RepoId.make('repo-a')}:openapi.document:openapi.json`,
                }),
                expect.objectContaining({
                    kind: 'consumes-contract',
                    to: `${RepoId.make('repo-a')}:graphql.operation:query:GetUser`,
                }),
                expect.objectContaining({
                    kind: 'exposes-contract',
                    from: `${RepoId.make('repo-a')}:go-package:cmd/api/main.go`,
                    to: `${RepoId.make('repo-a')}:grpc.service:User`,
                }),
                expect.objectContaining({
                    kind: 'uses-ffi',
                    to: `${RepoId.make('repo-a')}:ffi.wasm:src/main.ts`,
                }),
                expect.objectContaining({
                    kind: 'publishes',
                    to: `${RepoId.make('repo-a')}:messaging:nats:orders.created`,
                }),
                expect.objectContaining({
                    kind: 'publishes',
                    to: `${RepoId.make('repo-a')}:messaging:nats:billing.paid`,
                }),
                expect.objectContaining({
                    kind: 'provisions-channel',
                    from: `${RepoId.make('repo-a')}:terraform.resource:infra/main.tf:aws_sns_topic.orders`,
                    to: `${RepoId.make('repo-a')}:messaging:aws.sns:aws_sns_topic.orders`,
                }),
                expect.objectContaining({
                    kind: 'references',
                    from: `${RepoId.make('repo-a')}:terraform.output:infra/main.tf:bucket.default`,
                    to: `${RepoId.make('repo-a')}:terraform.resource:infra/main.tf:aws_s3_bucket.logs`,
                }),
                expect.objectContaining({
                    kind: 'uses-module-source',
                    from: `${RepoId.make('repo-a')}:terraform.module:infra/main.tf:shared.default`,
                    to: `${RepoId.make('repo-a')}:terraform.module-source:infra/main.tf:shared`,
                }),
                expect.objectContaining({
                    kind: 'exports-ffi',
                    to: `${RepoId.make('repo-a')}:ffi.c-abi:src/main.rs`,
                }),
            ]),
        );
        const graphqlOperation = result.nodes.find(
            node =>
                node.id ===
                `${RepoId.make('repo-a')}:graphql.operation:query:GetUser`,
        );
        expect(
            result.nodes.filter(
                node =>
                    node.id ===
                    `${RepoId.make('repo-a')}:graphql.operation:query:GetUser`,
            ),
        ).toHaveLength(1);
        expect(graphqlOperation?.evidence).toHaveLength(2);
        expect(result.unknowns).toContainEqual(
            expect.objectContaining({ kind: 'm2.semantic-limit' }),
        );
        expect(result.unknowns).toContainEqual(
            expect.objectContaining({
                kind: 'terraform.dynamic-expression-unavailable',
            }),
        );
        expect(result.unknowns).toContainEqual(
            expect.objectContaining({
                kind: 'xml.dialect-semantics-unavailable',
            }),
        );
    });

    test('keeps every supported messaging transport as an evidence-backed channel', () => {
        const repoId = RepoId.make('messaging-fixture');
        const result = analyzeDeterministicSource(repoId, [
            {
                path: 'src/kafka.ts',
                text: 'import "kafkajs"; producer.send("orders.kafka");',
            },
            {
                path: 'src/amqp.ts',
                text: 'import "amqplib"; channel.consume("orders.amqp");',
            },
            {
                path: 'src/redis.ts',
                text: 'import "redis"; client.subscribe("orders.redis");',
            },
            {
                path: 'src/sqs.ts',
                text: 'import "@aws-sdk/client-sqs"; client.send("orders.sqs");',
            },
            {
                path: 'src/eventbridge.ts',
                text: 'import "@aws-sdk/client-eventbridge"; client.putEvents("orders.events");',
            },
            {
                path: 'src/pubsub.ts',
                text: 'import "@google-cloud/pubsub"; topic.publish("orders.gcp");',
            },
            {
                path: 'infra/channels.tf',
                text: [
                    'resource "aws_sqs_queue" "jobs" {}',
                    'resource "aws_cloudwatch_event_bus" "events" {}',
                    'resource "google_pubsub_topic" "updates" {}',
                ].join('\n'),
            },
        ]);

        expect(result.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: `${repoId}:messaging:kafka:orders.kafka`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:amqp:orders.amqp`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:redis:orders.redis`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:aws.sqs:orders.sqs`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:aws.eventbridge:orders.events`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:gcp.pubsub:orders.gcp`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:aws.sqs:aws_sqs_queue.jobs`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:aws.eventbridge:aws_cloudwatch_event_bus.events`,
                }),
                expect.objectContaining({
                    id: `${repoId}:messaging:gcp.pubsub:google_pubsub_topic.updates`,
                }),
            ]),
        );
        expect(result.edges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'publishes',
                    to: `${repoId}:messaging:kafka:orders.kafka`,
                }),
                expect.objectContaining({
                    kind: 'subscribes',
                    to: `${repoId}:messaging:amqp:orders.amqp`,
                }),
                expect.objectContaining({
                    kind: 'subscribes',
                    to: `${repoId}:messaging:redis:orders.redis`,
                }),
                expect.objectContaining({
                    kind: 'publishes',
                    to: `${repoId}:messaging:aws.sqs:orders.sqs`,
                }),
                expect.objectContaining({
                    kind: 'publishes',
                    to: `${repoId}:messaging:aws.eventbridge:orders.events`,
                }),
                expect.objectContaining({
                    kind: 'publishes',
                    to: `${repoId}:messaging:gcp.pubsub:orders.gcp`,
                }),
                expect.objectContaining({
                    kind: 'provisions-channel',
                    to: `${repoId}:messaging:aws.sqs:aws_sqs_queue.jobs`,
                }),
                expect.objectContaining({
                    kind: 'provisions-channel',
                    to: `${repoId}:messaging:aws.eventbridge:aws_cloudwatch_event_bus.events`,
                }),
                expect.objectContaining({
                    kind: 'provisions-channel',
                    to: `${repoId}:messaging:gcp.pubsub:google_pubsub_topic.updates`,
                }),
            ]),
        );
    });

    test('recognizes static framework HTTP conventions and cross-file Terraform references', () => {
        const repoId = RepoId.make('framework-fixture');
        const result = analyzeDeterministicSource(repoId, [
            {
                path: 'package.json',
                text: JSON.stringify({ name: 'api' }),
            },
            {
                path: 'src/users.controller.ts',
                text: '@Controller("users")\nclass UsersController { @Get(":id") getUser() {} }',
            },
            {
                path: 'app/api/widgets/[id]/route.ts',
                text: 'export async function GET() { return Response.json({}); }',
            },
            {
                path: 'src/client.ts',
                text: 'axios.post("https://example.test/orders", {});',
            },
            {
                path: 'src/worker.ts',
                text: 'export default { fetch() { return new Response("ok"); } };',
            },
            {
                path: 'cmd/api/main.go',
                text: 'router.GET("/orders", list); http.NewRequest("POST", "https://example.test/orders", nil)',
            },
            {
                path: 'src/main.rs',
                text: 'Router::new().route("/events", post(events)); #[get("/health")] fn health() {} client.get("https://example.test/health");',
            },
            {
                path: 'infra/resources.tf',
                text: 'resource "aws_s3_bucket" "assets" {}',
            },
            {
                path: 'infra/outputs.tf',
                text: 'output "bucket" { value = aws_s3_bucket.assets.id }',
            },
        ]);

        expect(result.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'GET /users/:id',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'GET /api/widgets/:id',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'ANY /',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'GET /orders',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'POST /events',
                }),
                expect.objectContaining({
                    kind: 'contract.http.route',
                    label: 'GET /health',
                }),
                expect.objectContaining({
                    kind: 'contract.http.request',
                    label: 'POST https://example.test/orders',
                }),
                expect.objectContaining({
                    kind: 'contract.http.request',
                    label: 'GET https://example.test/health',
                }),
            ]),
        );
        expect(result.edges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    from: `${repoId}:terraform.output:infra/outputs.tf:bucket.default`,
                    kind: 'references',
                    to: `${repoId}:terraform.resource:infra/resources.tf:aws_s3_bucket.assets`,
                }),
            ]),
        );
    });

    test('inventories explicit and conventional Rust targets while retaining generated-source limits', () => {
        const repoId = RepoId.make('rust-targets');
        const result = analyzeDeterministicSource(repoId, [
            {
                path: 'Cargo.toml',
                text: [
                    '[package]',
                    'name = "workspace-engine"',
                    '',
                    '[lib]',
                    'name = "engine_core"',
                    '',
                    '[[bin]]',
                    'name = "workspace-cli"',
                    '',
                    '[[example]]',
                    'name = "inspect"',
                ].join('\n'),
            },
            { path: 'src/lib.rs', text: 'pub fn analyze() {}' },
            { path: 'src/main.rs', text: 'fn main() {}' },
            {
                path: 'tools/Cargo.toml',
                text: '[package]\nname = "utilities"',
            },
            { path: 'tools/src/lib.rs', text: 'pub fn sanitize() {}' },
            {
                path: 'src/generated.rs',
                text: '// Code generated by prost. DO NOT EDIT.\npub struct Event;',
            },
        ]);

        expect(result.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: `${repoId}:rust.target:Cargo.toml:lib:engine_core`,
                    kind: 'rust.target',
                }),
                expect.objectContaining({
                    id: `${repoId}:rust.target:Cargo.toml:bin:workspace-cli`,
                    kind: 'rust.target',
                }),
                expect.objectContaining({
                    id: `${repoId}:rust.target:Cargo.toml:example:inspect`,
                    kind: 'rust.target',
                }),
                expect.objectContaining({
                    id: `${repoId}:rust.target:Cargo.toml:bin:workspace-engine`,
                    kind: 'rust.target',
                }),
                expect.objectContaining({
                    id: `${repoId}:rust.target:tools/Cargo.toml:lib:utilities`,
                    kind: 'rust.target',
                }),
            ]),
        );
        expect(result.edges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    from: `${repoId}:crate:Cargo.toml`,
                    kind: 'declares-target',
                    to: `${repoId}:rust.target:Cargo.toml:bin:workspace-cli`,
                }),
            ]),
        );
        expect(result.unknowns).toContainEqual(
            expect.objectContaining({
                path: 'src/generated.rs',
                kind: 'rust.generated-code-semantics-unavailable',
            }),
        );
    });

    test('reports malformed or intentionally unsupported input as unknown without inventing facts', () => {
        const result = analyzeDeterministicSource(RepoId.make('gaps'), [
            { path: 'package.json', text: '{' },
            { path: 'tsconfig.json', text: '{' },
            { path: 'infra/main.tf.json', text: '{' },
            { path: 'browser.xml', text: '' },
            { path: 'openapi.yaml', text: 'openapi: 3.1.0' },
            { path: 'openapi.json', text: '{' },
            { path: 'schema.graphql', text: 'query { currentUser { id } }' },
            { path: 'api.proto', text: 'message User {}' },
            { path: 'asyncapi.yaml', text: 'asyncapi: 3.0.0' },
            { path: 'turbo.json', text: '{' },
            { path: 'wrangler.json', text: '{' },
            {
                path: 'generated.go',
                text: '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage generated',
            },
        ]);

        expect(result.unknowns).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'typescript.invalid-package-json',
                }),
                expect.objectContaining({
                    kind: 'typescript.invalid-tsconfig',
                }),
                expect.objectContaining({ kind: 'terraform.invalid-json' }),
                expect.objectContaining({ kind: 'xml.invalid-or-empty' }),
                expect.objectContaining({
                    kind: 'openapi.yaml-parser-unavailable',
                }),
                expect.objectContaining({ kind: 'openapi.invalid-json' }),
                expect.objectContaining({
                    kind: 'graphql.anonymous-operation-identity-unavailable',
                }),
                expect.objectContaining({
                    kind: 'protobuf.syntax-version-unavailable',
                }),
                expect.objectContaining({
                    kind: 'asyncapi.yaml-parser-unavailable',
                }),
                expect.objectContaining({ kind: 'turborepo.invalid-json' }),
                expect.objectContaining({ kind: 'wrangler.invalid-json' }),
                expect.objectContaining({
                    kind: 'go.generated-code-semantics-unavailable',
                }),
                expect.objectContaining({ kind: 'm2.semantic-limit' }),
            ]),
        );
        expect(result.nodes).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'contract.openapi.document' }),
            ]),
        );
    });

    test('is insensitive to inventory order and canonically merges repeated contract evidence', () => {
        const repoId = RepoId.make('stable');
        const fixture = [
            {
                path: 'package.json',
                text: JSON.stringify({ name: 'web' }),
            },
            {
                path: 'src/client.ts',
                text: 'gql`query FindUser { user { id } }`;',
            },
            {
                path: 'contracts/user.graphql',
                text: 'query FindUser { user { id } }',
            },
            {
                path: 'infra/main.tf',
                text: 'resource "aws_s3_bucket" "assets" {}\noutput "bucket" { value = aws_s3_bucket.assets.id }',
            },
        ];

        const first = analyzeDeterministicSource(repoId, fixture);
        const second = analyzeDeterministicSource(repoId, fixture.toReversed());

        expect(second).toEqual(first);
        const operation = first.nodes.filter(
            node => node.id === `${repoId}:graphql.operation:query:FindUser`,
        );
        expect(operation).toHaveLength(1);
        expect(operation[0]?.evidence).toHaveLength(2);
    });
});
