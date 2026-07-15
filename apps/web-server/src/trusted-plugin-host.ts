// OpenCode-style trusted extensions. Installing one is equivalent to trusting its
// publisher with the host account; this is intentionally not a sandbox boundary.

import { pathToFileURL } from 'node:url';

export type TrustedPluginContext = {
    readonly directory: string;
    readonly log: (
        level: 'debug' | 'info' | 'warn' | 'error',
        message: string,
    ) => void;
};

export type TrustedPluginHooks = {
    readonly commandExecuted?: (command: string) => void | Promise<void>;
    readonly toolExecuteBefore?: (
        tool: string,
        arguments_: Record<string, unknown>,
    ) => void | Promise<void>;
    readonly toolExecuteAfter?: (
        tool: string,
        result: unknown,
    ) => void | Promise<void>;
};

export type TrustedPlugin = (
    context: TrustedPluginContext,
) => TrustedPluginHooks | Promise<TrustedPluginHooks>;

/** Load a reviewed local ESM module with the same explicit-trust semantics as OpenCode. */
export const loadTrustedPlugin = async (
    path: string,
    context: TrustedPluginContext,
): Promise<TrustedPluginHooks> => {
    const module = await import(pathToFileURL(path).href);
    const plugin = module.default as TrustedPlugin | undefined;
    if (typeof plugin !== 'function') {
        throw new Error(
            'Trusted plugin must export a default plugin function.',
        );
    }
    return plugin(context);
};
