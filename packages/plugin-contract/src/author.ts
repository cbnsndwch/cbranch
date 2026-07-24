/** Public API for reviewed trusted-ESM plugin entrypoints. */

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type PluginContext = {
    /** Absolute path to this plugin's immutable activated directory. */
    readonly directory: string;
    /** Writes a structured plugin lifecycle message to the host audit log. */
    readonly log: (level: PluginLogLevel, message: string) => void;
};

export type PluginCommandContext = {
    readonly repoId: string;
    readonly engagementId?: string;
};

export type PluginCommand = (
    input: unknown,
    context: PluginCommandContext,
) => unknown | Promise<unknown>;

export type PluginToolExecution = {
    readonly operationId: string;
    readonly pluginId: string;
    readonly commandId: string;
    readonly repoId: string;
    readonly engagementId?: string;
};

export type PluginToolExecutionResult = PluginToolExecution & {
    readonly state: 'completed' | 'failed';
};

export type PluginHooks = {
    readonly commands?: Readonly<Record<string, PluginCommand>>;
    readonly commandExecuted?: (command: string) => void | Promise<void>;
    readonly toolExecuteBefore?: (
        execution: PluginToolExecution,
    ) => void | Promise<void>;
    readonly toolExecuteAfter?: (
        execution: PluginToolExecutionResult,
    ) => void | Promise<void>;
    readonly dispose?: () => void | Promise<void>;
};

/** The required default export from a plugin's declared ESM entrypoint. */
export type PluginFactory = (
    context: PluginContext,
) => PluginHooks | Promise<PluginHooks>;
