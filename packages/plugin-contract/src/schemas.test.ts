import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import {
    InstalledPlugin,
    PluginBrokerRequest,
    PluginCommandResult,
    PluginInvocation,
    PluginManifest,
    PluginRepository,
} from './schemas';

describe('plugin contract schemas', () => {
    test('decodes a manifest with declarative contributions only', () => {
        const manifest = Schema.decodeUnknownSync(PluginManifest)({
            schemaVersion: 1,
            id: 'com.example.release',
            version: '1.2.3',
            displayName: 'Release',
            publisherFingerprint: 'sha256:publisher',
            engines: { cbranch: '>=0.2.0 <1.0.0', pluginContract: 1 },
            runtime: 'trusted-esm',
            entrypoint: 'plugin.mjs',
            capabilities: ['ui.contribute', 'automation.exec'],
            automation: [
                {
                    id: 'check',
                    executable: '/usr/bin/make',
                    arguments: ['check'],
                    workingDirectory: 'repository',
                },
            ],
            contributes: {
                commands: [
                    {
                        id: 'com.example.release.check',
                        title: 'Run check',
                        placement: 'tools',
                    },
                ],
                panels: [
                    {
                        id: 'status',
                        title: 'Status',
                        placement: 'plugins',
                        content: { _tag: 'text', text: 'Ready' },
                    },
                ],
            },
        });

        expect(manifest.id).toBe('com.example.release');
        expect(manifest.contributes.commands[0]?.title).toBe('Run check');
    });

    test('repository and installed-plugin descriptors exclude credential fields', () => {
        const repository = Schema.decodeUnknownSync(PluginRepository)({
            id: 'repo-1',
            kind: 'https',
            url: 'https://plugins.example.test',
            trustState: 'untrusted',
            freshness: 'unknown',
            credentialState: 'not needed',
            credential: 'secret',
        });
        expect('credential' in repository).toBe(false);

        const installed = Schema.decodeUnknownSync(InstalledPlugin)({
            lock: {
                pluginId: 'com.example.release',
                version: '1.2.3',
                artifactSha256: 'sha256:artifact',
                repositoryId: 'repo-1',
                tufTargetVersion: 2,
                publisherFingerprint: 'sha256:publisher',
                manifestCapabilityDigest: 'sha256:capabilities',
                grantDigest: 'sha256:grant',
                entrypoint: 'plugin.mjs',
                enabled: false,
                grant: {
                    capabilities: [],
                    repositoryIds: [],
                    networkOrigins: [],
                    automationActionIds: [],
                    hostAutomationApproved: false,
                },
                contributions: { commands: [], panels: [] },
            },
            enabled: false,
            grant: {
                capabilities: [],
                repositoryIds: [],
                networkOrigins: [],
                automationActionIds: [],
                hostAutomationApproved: false,
            },
            contributions: { commands: [], panels: [] },
            availableVersions: [],
        });

        expect(installed.enabled).toBe(false);
    });

    test('rejects arbitrary command and panel placements', () => {
        const manifest = {
            schemaVersion: 1,
            id: 'com.example.release',
            version: '1.2.3',
            displayName: 'Release',
            publisherFingerprint: 'sha256:publisher',
            engines: { cbranch: '>=0.2.0 <1.0.0', pluginContract: 1 },
            runtime: 'trusted-esm',
            entrypoint: 'plugin.mjs',
            capabilities: [],
            automation: [],
            contributes: {
                commands: [
                    {
                        id: 'com.example.release.check',
                        title: 'Run check',
                        placement: 'arbitrary-menu',
                    },
                ],
                panels: [],
            },
        };

        expect(() =>
            Schema.decodeUnknownSync(PluginManifest)(manifest),
        ).toThrow();
    });

    test('accepts only named broker operations', () => {
        const request = Schema.decodeUnknownSync(PluginBrokerRequest)({
            protocolVersion: 1,
            operationId: 'operation-1',
            kind: 'git.read',
            repositoryId: 'repo-1',
            operation: 'status',
        });
        expect(request.kind).toBe('git.read');
        expect(() =>
            Schema.decodeUnknownSync(PluginBrokerRequest)({
                protocolVersion: 1,
                operationId: 'operation-1',
                kind: 'git.exec',
                arguments: ['reset', '--hard'],
            }),
        ).toThrow();
    });

    test('defines only host-rendered structured command results', () => {
        const invocation = Schema.decodeUnknownSync(PluginInvocation)({
            operationId: 'operation-1',
            state: 'completed',
            result: { _tag: 'dialog', title: 'Release', body: 'Ready' },
        });

        expect(invocation.result).toEqual({
            _tag: 'dialog',
            title: 'Release',
            body: 'Ready',
        });
        expect(() =>
            Schema.decodeUnknownSync(PluginInvocation)({
                operationId: 'operation-1',
                state: 'completed',
                result: { _tag: 'html', markup: '<script>alert(1)</script>' },
            }),
        ).toThrow();
        expect(() =>
            Schema.decodeUnknownSync(PluginCommandResult)({
                _tag: 'html',
                markup: '<script>alert(1)</script>',
            }),
        ).toThrow();
    });
});
