type PluginContext = {
    readonly directory: string;
    readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
};

type CommandContext = {
    readonly repoId: string;
};

export default function helloWorldPlugin({ log }: PluginContext) {
    log('info', 'Hello World plugin loaded.');

    return {
        commands: {
            'dev.cbranch.hello-world.greet': (
                input: unknown,
                { repoId }: CommandContext,
            ) => ({
                message: 'Hello from the cbranch plugin system.',
                repoId,
                input,
            }),
        },
        commandExecuted(commandId: string) {
            log('info', `Completed ${commandId}.`);
        },
        dispose() {
            log('info', 'Hello World plugin unloaded.');
        },
    };
}
