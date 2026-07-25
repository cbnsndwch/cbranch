// Host-only plugin repository credential boundary. Git owns the configured
// credential helper, so cbranch never persists a registry token itself.

import { spawn } from 'node:child_process';

export interface PluginCredentialStore {
    /** Reads the token Git's configured credential helper supplies for this origin. */
    readonly get: (repositoryUrl: string) => Promise<string | undefined>;
    /** Offers a user-supplied token to Git's configured credential helper. */
    readonly replace: (
        repositoryUrl: string,
        credential: string,
    ) => Promise<void>;
    /** Invalidates a rejected token in Git's configured credential helper. */
    readonly reject: (
        repositoryUrl: string,
        credential: string,
    ) => Promise<void>;
}

export type GitCredentialRunner = (
    operation: 'fill' | 'approve' | 'reject',
    input: string,
) => Promise<string>;

export const makeGitCredentialStore = (
    run: GitCredentialRunner = runGitCredential,
): PluginCredentialStore => ({
    get: async repositoryUrl => {
        const output = await run(
            'fill',
            credentialInput(repositoryUrl, undefined, true),
        );
        return credentialOutput(output).password;
    },
    replace: async (repositoryUrl, credential) => {
        await run('approve', credentialInput(repositoryUrl, credential, true));
    },
    reject: async (repositoryUrl, credential) => {
        await run('reject', credentialInput(repositoryUrl, credential, true));
    },
});

const credentialInput = (
    repositoryUrl: string,
    password?: string,
    includeIdentity = false,
): string => {
    const url = new URL(repositoryUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error(
            'Plugin credentials require a clean HTTPS repository URL.',
        );
    if (
        password !== undefined &&
        Array.from(password).some(character => {
            const code = character.charCodeAt(0);
            return code === 0 || code === 10 || code === 13;
        })
    )
        throw new Error(
            'Plugin credentials cannot contain control characters.',
        );
    const lines = [`protocol=https`, `host=${url.host}`];
    // This namespaces cbranch registry credentials in helpers that key on username.
    if (includeIdentity) lines.push('username=cbranch-plugin-registry');
    if (password !== undefined) lines.push(`password=${password}`);
    return `${lines.join('\n')}\n\n`;
};

const credentialOutput = (output: string): { readonly password?: string } => {
    const values = new Map(
        output
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const separator = line.indexOf('=');
                return [line.slice(0, separator), line.slice(separator + 1)];
            }),
    );
    return { password: values.get('password') || undefined };
};

const runGitCredential: GitCredentialRunner = (operation, input) =>
    new Promise((resolve, reject) => {
        const child = spawn('git', ['credential', operation], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        const chunks: Buffer[] = [];
        child.once('error', () =>
            reject(new Error('Git credential helper is unavailable.')),
        );
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.once('close', code => {
            if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
            else reject(new Error('Git credential helper could not complete.'));
        });
        child.stdin.end(input);
    });
