import { useQuery } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useApi } from '../rpc/ApiProvider';

/** Host-owned panel region for static, schema-validated plugin contributions. */
export function PluginPanels() {
    const api = useApi();
    const plugins = useQuery({
        queryKey: ['plugins', 'installed'],
        queryFn: () => api.pluginList(),
    });
    if (plugins.isError) {
        return (
            <div className="border-b px-3 py-2 text-xs" role="alert">
                Plugin panels are unavailable: {String(plugins.error)}
            </div>
        );
    }
    const panels = (plugins.data ?? []).flatMap(plugin =>
        plugin.contributions.panels
            .filter(panel => panel.placement === 'plugins')
            .map(panel => ({ plugin, panel, available: plugin.enabled })),
    );
    if (panels.length === 0) return null;

    return (
        <section
            aria-label="Plugin panels"
            className="grid gap-2 border-b p-3 sm:grid-cols-2"
        >
            {panels.map(({ plugin, panel, available }) => (
                <PluginPanelErrorBoundary
                    key={`${plugin.lock.pluginId}.${panel.id}`}
                >
                    <article className="border p-3 text-xs">
                        <h2 className="font-medium">{panel.title}</h2>
                        <p className="text-muted-foreground mt-1">
                            {plugin.lock.pluginId} ·{' '}
                            {plugin.lock.publisherFingerprint}
                        </p>
                        {!available ? (
                            <p className="text-muted-foreground mt-2">
                                Unavailable: plugin disabled.
                            </p>
                        ) : panel.content?._tag === 'text' ? (
                            <p className="mt-2 whitespace-pre-wrap break-words">
                                {panel.content.text}
                            </p>
                        ) : panel.content?._tag === 'keyValue' ? (
                            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                {panel.content.items.map(item => (
                                    <div key={item.label} className="contents">
                                        <dt className="text-muted-foreground">
                                            {item.label}
                                        </dt>
                                        <dd className="break-words">
                                            {item.value}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        ) : null}
                    </article>
                </PluginPanelErrorBoundary>
            ))}
        </section>
    );
}

class PluginPanelErrorBoundary extends Component<
    { readonly children: ReactNode },
    { readonly failed: boolean }
> {
    override state = { failed: false };

    static getDerivedStateFromError(): { readonly failed: true } {
        return { failed: true };
    }

    override componentDidCatch(_: Error, __: ErrorInfo): void {}

    override render() {
        return this.state.failed ? (
            <article className="border p-3 text-xs" role="alert">
                Plugin panel is unavailable.
            </article>
        ) : (
            this.props.children
        );
    }
}
