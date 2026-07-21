import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type PluginRepositoryId } from '@cbranch/rpc-contract';
import { useState } from 'react';
import { toast } from 'sonner';

import { useApi } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

const EMPTY_GRANT = {
    capabilities: [],
    repositoryIds: [],
    networkOrigins: [],
    automationActionIds: [],
    hostAutomationApproved: false,
} as const;

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export function PluginsDialog() {
    const open = useUiStore(state => state.pluginsDialogOpen);
    const setOpen = useUiStore(state => state.setPluginsDialogOpen);
    if (!open) return null;
    return <PluginsDialogBody onClose={() => setOpen(false)} />;
}

/** Plugin commands return data only; the host owns the modal presentation. */
export function PluginCommandResultDialog() {
    const result = useUiStore(state => state.pluginCommandResult);
    const setResult = useUiStore(state => state.setPluginCommandResult);
    if (!result) return null;
    return (
        <Dialog open onOpenChange={next => !next && setResult(null)}>
            <DialogContent style={{ width: 'min(480px, 92vw)' }}>
                <div className="grid gap-3 p-4">
                    <DialogTitle>{result.title}</DialogTitle>
                    <DialogDescription className="min-w-0 break-all whitespace-pre-wrap">
                        {result.output ?? 'Plugin command completed.'}
                    </DialogDescription>
                </div>
                <DialogFooter className="border-t p-3">
                    <Button onClick={() => setResult(null)}>Close</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PluginsDialogBody({ onClose }: { readonly onClose: () => void }) {
    const api = useApi();
    const queryClient = useQueryClient();
    const [url, setUrl] = useState('');
    const [selectedRepositoryId, setSelectedRepositoryId] =
        useState<PluginRepositoryId>();
    const repositories = useQuery({
        queryKey: ['plugins', 'repositories'],
        queryFn: () => api.pluginRepositoryList(),
    });
    const installed = useQuery({
        queryKey: ['plugins', 'installed'],
        queryFn: () => api.pluginList(),
    });
    const catalog = useQuery({
        queryKey: ['plugins', 'catalog', selectedRepositoryId],
        queryFn: () => api.pluginCatalogList(selectedRepositoryId!),
        enabled: selectedRepositoryId !== undefined,
    });
    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ['plugins'] });
    };
    const run = (operation: Promise<unknown>, success: string) => {
        void operation
            .then(() => {
                toast.success(success);
                refresh();
            })
            .catch(error => toast.error(errorMessage(error)));
    };

    return (
        <Dialog open onOpenChange={next => !next && onClose()}>
            <DialogContent style={{ width: 'min(760px, 94vw)' }}>
                <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-4">
                    <DialogHeader>
                        <DialogTitle>Plugins</DialogTitle>
                        <DialogDescription>
                            Trusted plugins execute with your host-user
                            authority. Only install publishers you trust.
                        </DialogDescription>
                    </DialogHeader>

                    <section className="grid gap-2 border p-3">
                        <strong className="text-sm">Add repository</strong>
                        <div className="flex gap-2">
                            <Input
                                value={url}
                                onChange={event => setUrl(event.target.value)}
                                placeholder="https://raw.githubusercontent.com/org/repo/plugin-registry"
                            />
                            <Button
                                disabled={!url.trim()}
                                onClick={() =>
                                    run(
                                        api.pluginRepositoryAdd(url.trim()),
                                        'Repository added.',
                                    )
                                }
                            >
                                Add
                            </Button>
                        </div>
                    </section>

                    <section className="grid gap-2">
                        <strong className="text-sm">Repositories</strong>
                        {repositories.data?.map(repository => (
                            <div
                                key={repository.id}
                                className="flex flex-wrap items-center gap-2 border p-2 text-xs"
                            >
                                <span className="min-w-0 flex-1 break-all">
                                    {repository.url}
                                </span>
                                <span>{repository.trustState}</span>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                        run(
                                            api.pluginRepositoryRefresh(
                                                repository.id,
                                            ),
                                            'Repository refreshed.',
                                        )
                                    }
                                >
                                    Refresh
                                </Button>
                                {repository.trustState === 'untrusted' &&
                                    repository.publisherFingerprint && (
                                        <Button
                                            size="sm"
                                            onClick={() =>
                                                run(
                                                    api.pluginPublisherTrust(
                                                        repository.id,
                                                        repository.publisherFingerprint!,
                                                    ),
                                                    'Publisher trusted.',
                                                )
                                            }
                                        >
                                            Trust publisher
                                        </Button>
                                    )}
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                        setSelectedRepositoryId(repository.id)
                                    }
                                >
                                    Browse
                                </Button>
                            </div>
                        ))}
                    </section>

                    {selectedRepositoryId && (
                        <section className="grid gap-2">
                            <strong className="text-sm">Catalog</strong>
                            {catalog.isLoading && (
                                <p className="text-muted-foreground text-xs">
                                    Verifying catalog…
                                </p>
                            )}
                            {catalog.isError && (
                                <p
                                    role="alert"
                                    className="text-destructive text-xs"
                                >
                                    {errorMessage(catalog.error)}
                                </p>
                            )}
                            {catalog.isSuccess && catalog.data.length === 0 && (
                                <p className="text-muted-foreground text-xs">
                                    This verified catalog has no plugins.
                                </p>
                            )}
                            {catalog.data?.map(plugin => (
                                <div
                                    key={`${plugin.pluginId}@${plugin.version}`}
                                    className="flex items-center gap-2 border p-2 text-xs"
                                >
                                    <span className="flex-1">
                                        {plugin.pluginId} {plugin.version}
                                    </span>
                                    <Button
                                        size="sm"
                                        onClick={() =>
                                            run(
                                                api.pluginInstall({
                                                    repositoryId:
                                                        selectedRepositoryId,
                                                    pluginId: plugin.pluginId,
                                                    version: plugin.version,
                                                    grant: EMPTY_GRANT,
                                                }),
                                                'Plugin installed. Enable it to use it.',
                                            )
                                        }
                                    >
                                        Install
                                    </Button>
                                </div>
                            ))}
                        </section>
                    )}

                    <section className="grid gap-2">
                        <strong className="text-sm">Installed plugins</strong>
                        {installed.data?.map(plugin => (
                            <div
                                key={plugin.lock.pluginId}
                                className="flex items-center gap-2 border p-2 text-xs"
                            >
                                <span className="flex-1">
                                    {plugin.lock.pluginId} {plugin.lock.version}
                                </span>
                                <Button
                                    size="sm"
                                    onClick={() =>
                                        run(
                                            plugin.enabled
                                                ? api.pluginDisable(
                                                      plugin.lock.pluginId,
                                                  )
                                                : api.pluginEnable(
                                                      plugin.lock.pluginId,
                                                  ),
                                            plugin.enabled
                                                ? 'Plugin disabled.'
                                                : 'Plugin enabled.',
                                        )
                                    }
                                >
                                    {plugin.enabled ? 'Disable' : 'Enable'}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                        run(
                                            api.pluginUninstall(
                                                plugin.lock.pluginId,
                                            ),
                                            'Plugin uninstalled.',
                                        )
                                    }
                                >
                                    Uninstall
                                </Button>
                            </div>
                        ))}
                    </section>
                </div>
                <DialogFooter className="border-t p-3">
                    <Button variant="outline" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
