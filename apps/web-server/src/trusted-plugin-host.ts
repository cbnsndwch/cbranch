// OpenCode-style trusted extensions. Installing one is equivalent to trusting its
// publisher with the host account; this is intentionally not a sandbox boundary.

import { realpath } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
    PluginCommandContext,
    PluginContext,
    PluginFactory,
    PluginHooks,
} from '@cbranch/plugin-contract/author';

export type TrustedPluginContext = PluginContext;
export type TrustedPluginHooks = PluginHooks;
export type TrustedPluginCommandContext = PluginCommandContext;
export type TrustedPlugin = PluginFactory;

export type TrustedPluginLoadOptions = {
    /** Activated root containing the immutable reviewed module. */
    readonly root?: string;
    /** Distinguishes reviewed versions when the ESM loader caches a module URL. */
    readonly cacheKey?: string;
};

/** Load a reviewed local ESM module with the same explicit-trust semantics as OpenCode. */
export const loadTrustedPlugin = async (
    path: string,
    context: TrustedPluginContext,
    options: TrustedPluginLoadOptions = {},
): Promise<TrustedPluginHooks> => {
    const modulePath = await resolveTrustedPluginPath(path, options.root);
    const url = pathToFileURL(modulePath);
    if (options.cacheKey)
        url.searchParams.set('cbranch-lock', options.cacheKey);
    const module = await import(url.href);
    const plugin = module.default as TrustedPlugin | undefined;
    if (typeof plugin !== 'function') {
        throw new Error(
            'Trusted plugin must export a default plugin function.',
        );
    }
    return validateTrustedPluginHooks(await plugin(context));
};

const resolveTrustedPluginPath = async (
    path: string,
    root: string | undefined,
): Promise<string> => {
    const extension = extname(path);
    if (extension !== '.mjs' && extension !== '.js') {
        throw new Error(
            'Trusted plugin entrypoint must be a .mjs or .js file.',
        );
    }
    const modulePath = await realpath(resolve(path));
    if (!root) return modulePath;

    const rootPath = await realpath(resolve(root));
    const pathFromRoot = relative(rootPath, modulePath);
    if (
        pathFromRoot === '' ||
        pathFromRoot === '..' ||
        pathFromRoot.startsWith('../') ||
        pathFromRoot.startsWith('..\\')
    ) {
        throw new Error(
            'Trusted plugin entrypoint must remain inside its activation root.',
        );
    }
    return modulePath;
};

const validateTrustedPluginHooks = (hooks: unknown): TrustedPluginHooks => {
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
        throw new Error('Trusted plugin factory must return a hooks object.');
    }
    const candidate = hooks as Partial<TrustedPluginHooks>;
    for (const name of [
        'commandExecuted',
        'toolExecuteBefore',
        'toolExecuteAfter',
        'dispose',
    ] as const) {
        if (
            candidate[name] !== undefined &&
            typeof candidate[name] !== 'function'
        ) {
            throw new Error(`Trusted plugin hook ${name} must be a function.`);
        }
    }
    if (candidate.commands !== undefined) {
        if (
            !candidate.commands ||
            typeof candidate.commands !== 'object' ||
            Array.isArray(candidate.commands) ||
            Object.values(candidate.commands).some(
                command => typeof command !== 'function',
            )
        ) {
            throw new Error(
                'Trusted plugin commands must be an object of functions.',
            );
        }
    }
    return candidate as TrustedPluginHooks;
};
