import { type EngagementColor } from '@cbranch/rpc-contract';
import { useState } from 'react';

import { cn } from '../lib/cn';
import { engagementColorClass, engagementInitials } from '../lib/engagements';
import { useHostEndpoint } from '../rpc/connection-provider';
import { resolveHostUrl } from '../rpc/client';

/** Workspace image with a deterministic initials fallback for unavailable avatars. */
export function WorkspaceAvatar({
    name,
    color,
    avatarUrl,
    className,
}: {
    readonly name: string;
    readonly color: EngagementColor;
    readonly avatarUrl?: string;
    readonly className: string;
}) {
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const endpoint = useHostEndpoint();
    const resolvedAvatarUrl =
        avatarUrl === undefined
            ? undefined
            : resolveHostUrl(endpoint, avatarUrl);
    const imageUrl =
        resolvedAvatarUrl !== undefined && resolvedAvatarUrl !== failedUrl
            ? resolvedAvatarUrl
            : undefined;

    if (imageUrl)
        return (
            <img
                src={imageUrl}
                alt=""
                className={cn('block shrink-0 object-cover', className)}
                onError={() => setFailedUrl(imageUrl)}
            />
        );

    return (
        <span
            aria-hidden="true"
            className={cn(
                'grid shrink-0 place-items-center',
                engagementColorClass[color],
                className,
            )}
        >
            {engagementInitials(name)}
        </span>
    );
}
