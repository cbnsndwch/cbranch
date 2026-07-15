import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import {
    InstalledPlugin,
    PluginBrokerRequest,
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
            entrypoint: 'worker.wasm',
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
                commands: [{ id: 'check', title: 'Run check', menu: 'tools' }],
                panels: [{ id: 'status', title: 'Status' }],
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
});
