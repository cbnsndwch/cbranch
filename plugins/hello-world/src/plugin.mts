import type { PluginFactory } from '@cbranch/plugin-contract/author';

const helloWorldPlugin: PluginFactory = ({ log }) => {
    log('info', 'Hello World plugin loaded.');

    return {
        commands: {
            'dev.cbranch.hello-world.greet': (input, { repoId }) => ({
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
};

export default helloWorldPlugin;
