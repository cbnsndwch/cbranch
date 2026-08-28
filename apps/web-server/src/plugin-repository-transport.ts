// HTTPS-only plugin repository transport. TUF verification remains above this
// transport; it only guarantees requests stay on the configured trusted origin.

import type { PluginRepositoryTransport } from '@cbranch/plugin-runtime';

import { validateRepositoryUrl } from '@cbranch/plugin-runtime';

const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_TARGET_BYTES = 50 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class PluginRepositoryTransportError extends Error {
    constructor(
        readonly code: 'authFailed' | 'networkError' | 'pluginMetadataInvalid',
        message: string,
    ) {
        super(message);
        this.name = 'PluginRepositoryTransportError';
    }
}

export type PluginRepositoryTransportOptions = {
    readonly url: string;
    /** Resolves a credential immediately before each request; it is never cached here. */
    readonly getCredential?: () => Promise<string | undefined>;
    readonly rejectCredential?: (credential?: string) => Promise<void>;
    readonly fetch?: typeof globalThis.fetch;
    readonly requestTimeoutMs?: number;
};

/** Fetch repository metadata and targets without following redirects or leaking tokens. */
export const makeHttpsPluginRepositoryTransport = (
    options: PluginRepositoryTransportOptions,
): PluginRepositoryTransport => {
    const baseUrl = validateRepositoryUrl('https', options.url);
    const fetcher = options.fetch ?? globalThis.fetch;
    const requestTimeoutMs =
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
        !Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs <= 0 ||
        requestTimeoutMs > 5 * 60_000
    ) {
        throw new RangeError(
            'Plugin repository request timeout must be a positive bounded integer.',
        );
    }
    const fetchPath = async (
        path: string,
        limit: number,
    ): Promise<Uint8Array> => {
        const url = resolveRepositoryPath(baseUrl, path);
        let credential: string | undefined;
        try {
            credential = await options.getCredential?.();
        } catch {
            throw new PluginRepositoryTransportError(
                'networkError',
                'Plugin repository credential lookup failed.',
            );
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const response = await fetcher(url, {
                headers: credential
                    ? { authorization: `Bearer ${credential}` }
                    : undefined,
                redirect: 'manual',
                signal: controller.signal,
            });
            if (response.status === 401 && options.rejectCredential)
                await options
                    .rejectCredential(credential)
                    .catch(() => undefined);
            if (
                response.type === 'opaqueredirect' ||
                (response.status >= 300 && response.status < 400)
            ) {
                throw new PluginRepositoryTransportError(
                    'networkError',
                    'Plugin repository redirects are not allowed.',
                );
            }
            if (!response.ok) {
                throw new PluginRepositoryTransportError(
                    response.status === 401 ? 'authFailed' : 'networkError',
                    `Plugin repository request failed with HTTP ${response.status}.`,
                );
            }
            const contentLength = Number(
                response.headers.get('content-length'),
            );
            if (
                (Number.isFinite(contentLength) && contentLength > limit) ||
                (Number.isFinite(contentLength) && contentLength < 0)
            ) {
                throw new PluginRepositoryTransportError(
                    'pluginMetadataInvalid',
                    'Plugin repository response exceeds its size limit.',
                );
            }
            return await readBoundedBody(response, limit);
        } catch (error) {
            if (error instanceof PluginRepositoryTransportError) throw error;
            throw new PluginRepositoryTransportError(
                'networkError',
                controller.signal.aborted
                    ? 'Plugin repository request timed out.'
                    : 'Plugin repository request failed.',
            );
        } finally {
            clearTimeout(timeout);
        }
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
        path.includes('\\') ||
        path.includes('\0') ||
        /%(?:2e|2f|5c)/iu.test(path) ||
        path
            .split('/')
            .some(
                segment =>
                    segment === '' || segment === '.' || segment === '..',
            )
    ) {
        throw new PluginRepositoryTransportError(
            'pluginMetadataInvalid',
            'Plugin repository path is unsafe.',
        );
    }
    const base = new URL(
        baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`,
    );
    const url = new URL(path, base);
    if (
        url.origin !== baseUrl.origin ||
        url.username ||
        url.password ||
        !url.pathname.startsWith(base.pathname)
    ) {
        throw new PluginRepositoryTransportError(
            'pluginMetadataInvalid',
            'Plugin repository path escapes its configured origin.',
        );
    }
    return url;
};

const readBoundedBody = async (
    response: Response,
    limit: number,
): Promise<Uint8Array> => {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            // The stream must be consumed sequentially to enforce the aggregate cap.
            // oxlint-disable-next-line eslint/no-await-in-loop
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await reader.cancel().catch(() => undefined);
                throw new PluginRepositoryTransportError(
                    'pluginMetadataInvalid',
                    'Plugin repository response exceeds its size limit.',
                );
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
};
