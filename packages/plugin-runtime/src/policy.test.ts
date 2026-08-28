import { describe, expect, test } from 'vitest';

import {
    PluginId,
    type PluginGrant,
    type PluginManifest,
} from '@cbranch/plugin-contract';

import {
    digestAutomationDeclarations,
    digestGrant,
    digestManifestCapabilities,
    isEligibleSecurityUpdate,
    isSafeArchiveEntry,
    redactSecrets,
    satisfiesCbranchRange,
    validateArtifact,
    validateGrant,
    validateManifest,
    validateManifestTargetConsistency,
    validatePluginArchive,
    validateRepositoryUrl,
    validateTufMetadata,
} from './policy';

const pluginId = PluginId.make('com.example.release');
const hostVersion = '0.2.4';

const manifest: PluginManifest = {
    schemaVersion: 1,
    id: pluginId,
    version: '1.2.3',
    displayName: 'Release',
    publisherFingerprint: 'sha256:publisher',
    engines: { cbranch: '>=0.2.0 <1.0.0', pluginContract: 1 },
    runtime: 'trusted-esm',
    entrypoint: 'plugin.mjs',
    capabilities: ['automation.exec', 'network.connect'],
    automation: [
        {
            id: 'check',
            executable: '/usr/bin/make',
            arguments: ['check'],
            workingDirectory: 'repository',
        },
    ],
    contributes: { commands: [], panels: [] },
};

const grant: PluginGrant = {
    capabilities: ['automation.exec'],
    repositoryIds: ['repo-1'],
    networkOrigins: [],
    automationActionIds: ['check'],
    hostAutomationApproved: false,
};

describe('plugin runtime policy', () => {
    test('accepts only safe repository source URLs', () => {
        expect(
            validateRepositoryUrl('https', 'https://plugins.example.test/base')
                .hostname,
        ).toBe('plugins.example.test');
        expect(() =>
            validateRepositoryUrl('https', 'http://plugins.example.test'),
        ).toThrow();
        expect(() =>
            validateRepositoryUrl('git', 'ssh://key@plugins.example.test/repo'),
        ).toThrow();
        expect(() =>
            validateRepositoryUrl('git', 'file:///tmp/plugins'),
        ).toThrow();
    });

    test('rejects shell automation and broad grants', () => {
        expect(() =>
            validateManifest(
                {
                    ...manifest,
                    automation: [
                        { ...manifest.automation[0]!, executable: '/bin/sh' },
                    ],
                },
                hostVersion,
            ),
        ).toThrow('non-shell');
        expect(() =>
            validateGrant(
                manifest,
                {
                    ...grant,
                    capabilities: ['automation.exec', 'workspace.write'],
                },
                hostVersion,
            ),
        ).toThrow('not requested');
        expect(() =>
            validateGrant(
                manifest,
                {
                    ...grant,
                    hostAutomationApproved: true,
                },
                hostVersion,
            ),
        ).toThrow('separate explicit approval');
    });

    test('compares SemVer prereleases without treating them as stable releases', () => {
        expect(satisfiesCbranchRange('0.2.4', '0.2.4-beta.1')).toBe(false);
        expect(satisfiesCbranchRange('0.2.4-beta.2', '>0.2.4-beta.1')).toBe(
            true,
        );
        expect(satisfiesCbranchRange('0.2.4-beta.1', '<0.2.4')).toBe(false);
        expect(
            satisfiesCbranchRange('0.2.4-beta.2', '>=0.2.4-beta.1 <0.2.4'),
        ).toBe(true);
        expect(satisfiesCbranchRange('0.2.5-rc.1', '>=0.2.4 <1.0.0')).toBe(
            false,
        );
        expect(satisfiesCbranchRange('0.2.4-01', '>=0.2.0')).toBe(false);
    });

    test('rejects incompatible or malformed cbranch host ranges', () => {
        expect(() =>
            validateManifest(
                {
                    ...manifest,
                    engines: { ...manifest.engines, cbranch: '>=1.0.0 <2.0.0' },
                },
                hostVersion,
            ),
        ).toThrow('requires cbranch');
        expect(() =>
            validateManifest(
                {
                    ...manifest,
                    engines: { ...manifest.engines, cbranch: 'not-a-range' },
                },
                hostVersion,
            ),
        ).toThrow('requires cbranch');
        expect(() =>
            validateManifest(
                {
                    ...manifest,
                    engines: { ...manifest.engines, cbranch: '>=0.2.4' },
                },
                '0.2.4-rc.1',
            ),
        ).toThrow('this host is 0.2.4-rc.1');
    });

    test('rejects extraction escapes and redacts every token occurrence', () => {
        expect(isSafeArchiveEntry('plugin.mjs', 'file')).toBe(true);
        expect(isSafeArchiveEntry('../plugin.mjs', 'file')).toBe(false);
        expect(isSafeArchiveEntry('/plugin.mjs', 'file')).toBe(false);
        expect(isSafeArchiveEntry('link', 'symlink')).toBe(false);
        expect(redactSecrets('token=abc abc', ['abc'])).toBe(
            'token=[REDACTED] [REDACTED]',
        );
    });

    test('allows only authority-preserving signed security updates', () => {
        const installed = {
            pluginId: 'com.example.release',
            version: '1.2.3',
            publisherFingerprint: 'sha256:publisher',
            capabilityDigest: 'sha256:capabilities',
            automationDigest: 'sha256:automation',
            hasHostAutomation: false,
            securityOnlyAutoUpdates: true,
        };
        const candidate = {
            pluginId,
            version: '1.2.4',
            publisherFingerprint: 'sha256:publisher',
            capabilityDigest: 'sha256:capabilities',
            automationDigest: 'sha256:automation',
            advisoryIds: ['CVE-2026-1'],
        };

        expect(isEligibleSecurityUpdate(installed, candidate)).toBe(true);
        expect(
            isEligibleSecurityUpdate(installed, {
                ...candidate,
                capabilityDigest: 'sha256:broader',
            }),
        ).toBe(false);
        expect(
            isEligibleSecurityUpdate(installed, {
                ...candidate,
                version: '2.0.0',
            }),
        ).toBe(false);
    });

    test('rejects expired, replayed, or incomplete TUF metadata', () => {
        const roles = [
            { role: 'root', version: 2, expiresAt: 2_000, trustedVersion: 1 },
            {
                role: 'timestamp',
                version: 4,
                expiresAt: 2_000,
                trustedVersion: 4,
            },
            {
                role: 'snapshot',
                version: 3,
                expiresAt: 2_000,
                trustedVersion: 2,
            },
            {
                role: 'targets',
                version: 8,
                expiresAt: 2_000,
                trustedVersion: 7,
            },
        ] as const;
        expect(() => validateTufMetadata(roles, 1_000)).not.toThrow();
        expect(() =>
            validateTufMetadata(
                roles.map(role =>
                    role.role === 'timestamp'
                        ? { ...role, expiresAt: 1_000 }
                        : role,
                ),
                1_000,
            ),
        ).toThrow('expired');
        expect(() =>
            validateTufMetadata(
                roles.map(role =>
                    role.role === 'targets' ? { ...role, version: 6 } : role,
                ),
                1_000,
            ),
        ).toThrow('rolled back');
        expect(() => validateTufMetadata(roles.slice(1), 1_000)).toThrow(
            'missing',
        );
    });

    test('requires the archive manifest and downloaded bytes to match signed target metadata', async () => {
        const artifactSha256 = `sha256:${'a'.repeat(64)}`;
        const capabilityDigest = await digestManifestCapabilities(manifest);
        const target = {
            pluginId,
            version: manifest.version,
            publisherFingerprint: manifest.publisherFingerprint,
            pluginContractVersion: 1,
            minimumCbranchVersion: '0.2.0',
            capabilityDigest,
            artifactLength: 4,
            artifactSha256,
        };
        await expect(
            validateManifestTargetConsistency(manifest, target, hostVersion),
        ).resolves.toBeUndefined();
        expect(() => validateArtifact(target, 4, artifactSha256)).not.toThrow();
        expect(() => validateArtifact(target, 5, artifactSha256)).toThrow(
            'digest',
        );
        await expect(
            validateManifestTargetConsistency(
                manifest,
                {
                    ...target,
                    version: '1.2.4',
                },
                hostVersion,
            ),
        ).rejects.toThrow('does not match');
        await expect(
            validateManifestTargetConsistency(
                manifest,
                {
                    ...target,
                    minimumCbranchVersion: '9.0.0',
                },
                hostVersion,
            ),
        ).rejects.toMatchObject({ code: 'pluginIncompatible' });
        await expect(
            validateManifestTargetConsistency(
                manifest,
                {
                    ...target,
                    minimumCbranchVersion: 'invalid',
                },
                hostVersion,
            ),
        ).rejects.toMatchObject({ code: 'pluginMetadataInvalid' });
        await expect(
            validateManifestTargetConsistency(
                manifest,
                {
                    ...target,
                    minimumCbranchVersion: '0.1.0',
                },
                hostVersion,
            ),
        ).rejects.toMatchObject({ code: 'pluginArtifactInvalid' });
    });

    test('rejects unsafe or oversized plugin archives before extraction', () => {
        const validEntries = [
            { path: 'plugin.json', kind: 'file' as const, size: 100 },
            { path: 'plugin.mjs', kind: 'file' as const, size: 200 },
        ];
        expect(() => validatePluginArchive(300, validEntries)).not.toThrow();
        expect(() =>
            validatePluginArchive(300, [
                ...validEntries,
                { path: 'plugin.mjs', kind: 'file', size: 1 },
            ]),
        ).toThrow('unsafe entry');
        expect(() =>
            validatePluginArchive(300, [
                { path: 'plugin.json', kind: 'file', size: 1 },
                { path: 'link', kind: 'symlink', size: 0 },
            ]),
        ).toThrow('unsafe entry');
        expect(() =>
            validatePluginArchive(300, [
                { path: 'plugin.mjs', kind: 'file', size: 1 },
            ]),
        ).toThrow('exactly one');
    });

    test('canonical digests ignore declaration ordering but preserve authority changes', async () => {
        const capabilityDigest = await digestManifestCapabilities(manifest);
        const reorderedCapabilityDigest = await digestManifestCapabilities({
            capabilities: manifest.capabilities.toReversed(),
        });
        const automationDigest = await digestAutomationDeclarations(manifest);
        const reorderedAutomationDigest = await digestAutomationDeclarations({
            automation: manifest.automation.toReversed(),
        });
        const grantDigest = await digestGrant(grant);

        expect(capabilityDigest).toBe(reorderedCapabilityDigest);
        expect(automationDigest).toBe(reorderedAutomationDigest);
        expect(grantDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(
            await digestGrant({ ...grant, repositoryIds: ['repo-2'] }),
        ).not.toBe(grantDigest);
    });
});
