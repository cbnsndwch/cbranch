import { type EngagementId } from '@cbranch/rpc-contract';
import { Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../lib/cn';
import { engagementColorClass, moveWorkspaceId } from '../lib/engagements';
import {
    useActivateEngagement,
    useEngagementWorkspace,
    useReorderEngagements,
} from '../rpc/hooks';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import { WorkspaceAvatar } from './WorkspaceAvatar';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from './ui/tooltip';

export function EngagementRail() {
    const workspace = useEngagementWorkspace();
    const activeEngagementId = useUiStore(s => s.activeEngagementId);
    const setManagerOpen = useUiStore(s => s.setEngagementManagerOpen);
    const activate = useActivateEngagement();
    const reorder = useReorderEngagements();
    const { openEngagement, openRepo } = useNavigation();
    const [draggedId, setDraggedId] = useState<EngagementId | null>(null);
    const engagements = workspace.data?.engagements ?? [];

    const selectEngagement = (id: NonNullable<typeof activeEngagementId>) => {
        activate.mutate(id, {
            onSuccess: next => {
                const engagement = next.engagements.find(
                    item => item.id === id,
                );
                if (engagement?.activeRepoId)
                    openRepo(engagement.activeRepoId, engagement.slug);
                else if (engagement) openEngagement(engagement.slug);
            },
        });
    };

    const moveWorkspace = (source: EngagementId, target: EngagementId) => {
        if (source === target || reorder.isPending) return;
        reorder.mutate(
            moveWorkspaceId(
                engagements.map(engagement => engagement.id),
                source,
                target,
            ),
        );
    };

    return (
        <TooltipProvider>
            <aside className="bg-muted flex gap-2 min-h-0 w-12 shrink-0 flex-col items-center border-r py-1.5">
                <img
                    src="/favicon.svg"
                    alt="cbranch"
                    className="mb-1.5 size-8"
                />
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1 py-2">
                    {engagements.map(engagement => (
                        <Tooltip key={engagement.id}>
                            <TooltipTrigger
                                render={
                                    <button
                                        type="button"
                                        aria-label={`Open ${engagement.name}`}
                                        aria-current={
                                            activeEngagementId === engagement.id
                                                ? 'page'
                                                : undefined
                                        }
                                        onClick={() =>
                                            selectEngagement(engagement.id)
                                        }
                                        draggable={!reorder.isPending}
                                        onDragStart={event => {
                                            setDraggedId(engagement.id);
                                            event.dataTransfer.effectAllowed =
                                                'move';
                                        }}
                                        onDragOver={event => {
                                            if (draggedId === null) return;
                                            event.preventDefault();
                                            event.dataTransfer.dropEffect =
                                                'move';
                                        }}
                                        onDrop={event => {
                                            event.preventDefault();
                                            if (draggedId)
                                                moveWorkspace(
                                                    draggedId,
                                                    engagement.id,
                                                );
                                            setDraggedId(null);
                                        }}
                                        onDragEnd={() => setDraggedId(null)}
                                        title="Drag to reorder workspaces"
                                        className={cn(
                                            'relative grid size-8 shrink-0 place-items-center text-[10px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                            engagementColorClass[
                                                engagement.color
                                            ],
                                            activeEngagementId === engagement.id
                                                ? 'ring-2 ring-foreground ring-offset-1 ring-offset-muted'
                                                : 'opacity-75 hover:opacity-100',
                                            draggedId === engagement.id &&
                                                'opacity-40',
                                        )}
                                    >
                                        <WorkspaceAvatar
                                            name={engagement.name}
                                            color={engagement.color}
                                            avatarUrl={engagement.avatarUrl}
                                            className="size-8 text-[10px] font-semibold"
                                        />
                                    </button>
                                }
                            />
                            <TooltipContent side="right">
                                {engagement.name}
                            </TooltipContent>
                        </Tooltip>
                    ))}
                </div>
                <div className="mt-1 flex flex-col gap-1 border-t pt-1">
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8"
                                    aria-label="New workspace"
                                    onClick={() => setManagerOpen(true)}
                                >
                                    <Plus
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                </Button>
                            }
                        />
                        <TooltipContent side="right">
                            New workspace
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8"
                                    aria-label="Manage workspaces"
                                    onClick={() => setManagerOpen(true)}
                                >
                                    <Settings2
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                </Button>
                            }
                        />
                        <TooltipContent side="right">
                            Manage workspaces
                        </TooltipContent>
                    </Tooltip>
                </div>
            </aside>
        </TooltipProvider>
    );
}
