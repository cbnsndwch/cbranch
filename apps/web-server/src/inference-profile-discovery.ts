// Host-only, bounded discovery for local inference CLIs. Discovery never sends
// workspace evidence, reads a repository, or starts an inference session.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import {
    type InferenceProviderKind,
    InferenceProfileDiscovery,
} from '@cbranch/rpc-contract';
import type { InferenceProfile } from '@cbranch/inference';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 2_000;
const VERSION_MAX_BUFFER_BYTES = 8 * 1024;

interface DiscoveryCandidate {
    readonly provider: Extract<
        InferenceProviderKind,
        'claude-code' | 'codex' | 'opencode' | 'local-embeddings'
    >;
    readonly executable: string;
}

const candidates: ReadonlyArray<DiscoveryCandidate> = [
    { provider: 'claude-code', executable: 'claude' },
    { provider: 'codex', executable: 'codex' },
    { provider: 'opencode', executable: 'opencode' },
    { provider: 'local-embeddings', executable: 'ollama' },
];

export interface InferenceProfileDiscoveryOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly runVersion?: (executable: string) => Promise<string>;
}

const executableNames = (
    candidate: string,
    platform: NodeJS.Platform,
): ReadonlyArray<string> =>
    platform === 'win32'
        ? [`${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]
        : [candidate];

const findOnPath = async (
    candidate: string,
    pathValue: string | undefined,
    platform: NodeJS.Platform,
): Promise<string | undefined> => {
    if (pathValue === undefined || pathValue.trim() === '') return undefined;

    for (const directory of pathValue.split(delimiter)) {
        if (directory === '') continue;
        for (const name of executableNames(candidate, platform)) {
            const executable = join(directory, name);
            try {
                await access(executable, constants.X_OK);
                return executable;
            } catch {
                // Continue to the next directory; unavailable entries are normal.
            }
        }
    }
    return undefined;
};

const reducedEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    PATH: env.PATH,
    HOME: env.HOME,
    USER: env.USER,
    USERPROFILE: env.USERPROFILE,
    SystemRoot: env.SystemRoot,
});

const runVersion = async (
    executable: string,
    env: NodeJS.ProcessEnv,
): Promise<string> => {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
        cwd: tmpdir(),
        env: reducedEnvironment(env),
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: VERSION_MAX_BUFFER_BYTES,
        windowsHide: true,
    });
    const version = `${stdout}\n${stderr}`.replace(/\s+/g, ' ').trim();
    if (version === '')
        throw new Error('The executable did not report a version.');
    return version.slice(0, 512);
};

/**
 * Detect eligible local CLIs by resolving a known command on PATH and running
 * only its bounded `--version` command from the system temp directory.
 */
export const discoverInferenceProfiles = async (
    options: InferenceProfileDiscoveryOptions = {},
): Promise<ReadonlyArray<InferenceProfileDiscovery>> => {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const discoverVersion =
        options.runVersion ??
        ((executable: string) => runVersion(executable, env));
    const discoveries: InferenceProfileDiscovery[] = [];

    for (const candidate of candidates) {
        const executable = await findOnPath(
            candidate.executable,
            env.PATH,
            platform,
        );
        if (executable === undefined) continue;
        try {
            discoveries.push(
                new InferenceProfileDiscovery({
                    provider: candidate.provider,
                    executable,
                    version: await discoverVersion(executable),
                }),
            );
        } catch {
            // An incompatible, broken, or slow binary is not a usable discovery.
        }
    }

    return discoveries;
};

/**
 * Only enabled local execution profiles must point at a binary discovered in
 * the current host PATH. Disabled records remain editable so a missing local
 * tool does not strand unrelated host configuration.
 */
export const validateEnabledLocalInferenceProfiles = (
    profiles: ReadonlyArray<InferenceProfile>,
    discoveries: ReadonlyArray<InferenceProfileDiscovery>,
): void => {
    for (const profile of profiles) {
        if (!profile.enabled || profile.provider === 'openai-compatible')
            continue;
        if (
            !discoveries.some(
                discovery =>
                    discovery.provider === profile.provider &&
                    discovery.executable === profile.executable,
            )
        )
            throw new Error(
                'An enabled local inference profile must use a currently discovered executable.',
            );
    }
};
