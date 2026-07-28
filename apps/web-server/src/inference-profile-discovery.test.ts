import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { InferenceProfile } from '@cbranch/inference';

import {
    discoverInferenceProfiles,
    validateEnabledLocalInferenceProfiles,
} from './inference-profile-discovery';

let directory: string | undefined;

afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true });
    directory = undefined;
});

describe('discoverInferenceProfiles', () => {
    test('discovers only known executable names and captures bounded versions', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-inference-cli-'));
        const codex = join(directory, 'codex');
        await writeFile(codex, '#!/bin/sh\necho codex\n');
        await chmod(codex, 0o755);
        await writeFile(join(directory, 'unrelated-tool'), '#!/bin/sh\n');

        const runVersion = vi.fn(async () => 'codex 1.2.3\n');
        const discovered = await discoverInferenceProfiles({
            env: { PATH: directory },
            platform: 'linux',
            runVersion,
        });

        expect(discovered).toEqual([
            expect.objectContaining({
                provider: 'codex',
                executable: codex,
                version: 'codex 1.2.3\n',
            }),
        ]);
        expect(runVersion).toHaveBeenCalledWith(codex);
    });

    test('ignores a candidate when its bounded version check fails', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-inference-cli-'));
        const claude = join(directory, 'claude');
        await writeFile(claude, '#!/bin/sh\nexit 1\n');
        await chmod(claude, 0o755);

        await expect(
            discoverInferenceProfiles({
                env: { PATH: directory },
                platform: 'linux',
                runVersion: async () => {
                    throw new Error('not usable');
                },
            }),
        ).resolves.toEqual([]);
    });

    test('discovers Ollama only as a local embedding runtime', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-inference-cli-'));
        const ollama = join(directory, 'ollama');
        await writeFile(ollama, '#!/bin/sh\necho ollama\n');
        await chmod(ollama, 0o755);

        await expect(
            discoverInferenceProfiles({
                env: { PATH: directory },
                platform: 'linux',
                runVersion: async () => 'ollama 0.23.2',
            }),
        ).resolves.toEqual([
            expect.objectContaining({
                provider: 'local-embeddings',
                executable: ollama,
            }),
        ]);
    });

    test('allows enabled local execution only for a currently discovered executable', () => {
        const profile = InferenceProfile.parse({
            id: 'local-claude',
            label: 'Local Claude',
            provider: 'claude-code',
            enabled: true,
            capabilities: ['generation'],
            executable: '/usr/local/bin/claude',
            modelId: 'claude-sonnet-test',
            secretReference: {
                kind: 'environment',
                name: 'ANTHROPIC_API_KEY',
            },
        });
        expect(() =>
            validateEnabledLocalInferenceProfiles(
                [profile],
                [
                    {
                        provider: 'claude-code',
                        executable: '/usr/local/bin/claude',
                        version: 'Claude Code 2.1.220',
                    },
                ],
            ),
        ).not.toThrow();
        expect(() =>
            validateEnabledLocalInferenceProfiles([profile], []),
        ).toThrow('currently discovered executable');
    });
});
