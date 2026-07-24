// HTTPS-only plugin repository transport. TUF verification remains above this
// transport; it only guarantees requests stay on the configured trusted origin.

import type { PluginRepositoryTransport } from '@cbranch/plugin-runtime';

import { validateRepositoryUrl } from '@cbranch/plugin-runtime';

const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_TARGET_BYTES = 50 * 1024 * 1024;

export type PluginRepositoryTransportOptions = {
    readonly url: string;
    /** Resolves a credential immediately before each request; it is never cached here. */
    readonly getCredential?: () => Promise<string | undefined>;
    readonly rejectCredential?: (credential?: string) => Promise<void>;
    readonly fetch?: typeof globalThis.fetch;
};

/** Fetch repository metadata and targets without following redirects or leaking tokens. */
export const makeHttpsPluginRepositoryTransport = (
    options: PluginRepositoryTransportOptions,
): PluginRepositoryTransport => {
    const baseUrl = validateRepositoryUrl('https', options.url);
    const fetcher = options.fetch ?? globalThis.fetch;
    const fetchPath = async (
        path: string,
        limit: number,
    ): Promise<Uint8Array> => {
        const url = resolveRepositoryPath(baseUrl, path);
        const credential = await options.getCredential?.();
        const response = await fetcher(url, {
            headers: credential
                ? { authorization: `Bearer ${credential}` }
                : undefined,
            redirect: 'manual',
        });
        if (response.status === 401 && options.rejectCredential)
            await options.rejectCredential(credential).catch(() => undefined);
        if (
            response.type === 'opaqueredirect' ||
            (response.status >= 300 && response.status < 400)
        ) {
            throw new Error('Plugin repository redirects are not allowed.');
        }
        if (!response.ok) {
            throw new Error(
                `Plugin repository request failed with HTTP ${response.status}.`,
            );
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (
            (Number.isFinite(contentLength) && contentLength > limit) ||
            (Number.isFinite(contentLength) && contentLength < 0)
        ) {
            throw new Error(
                'Plugin repository response exceeds its size limit.',
            );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) {
            throw new Error(
                'Plugin repository response exceeds its size limit.',
            );
        }
        return bytes;
    };

    return {
        fetchMetadata: path => fetchPath(path, MAX_METADATA_BYTES),
        fetchTarget: path => fetchPath(path, MAX_TARGET_BYTES),
    };
};

const resolveRepositoryPath = (baseUrl: URL, path: string): URL => {
    if (
        path.length === 0 ||
        path.startsWith('/') ||
        path.startsWith('\\') ||
        path.includes('\0') ||
        path
            .split('/')
            .some(
                segment =>
                    segment === '' || segment === '.' || segment === '..',
            )
    ) {
        throw new Error('Plugin repository path is unsafe.');
    }
    const base = new URL(
        baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`,
    );
    const url = new URL(path, base);
    if (url.origin !== baseUrl.origin || url.username || url.password) {
        throw new Error(
            'Plugin repository path escapes its configured origin.',
        );
    }
    return url;
};
