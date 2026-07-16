import { useEffect } from 'react';

import { setDesktopWindowTitle } from '../desktop/bridge';
import { APP_INFO } from '../lib/app-info';
import { useEngagementWorkspace } from '../rpc/hooks';
import { useUiStore } from '../state/store';

// On web there is no in-app title bar, so this headless component keeps both browser and
// desktop window titles aligned with the active workspace and repository.
export function DocumentTitle() {
    const repoId = useUiStore(s => s.activeRepoId);
    const engagementId = useUiStore(s => s.activeEngagementId);
    const workspace = useEngagementWorkspace();
    const engagement = workspace.data?.engagements.find(
        item => item.id === engagementId,
    );
    const repository = repoId
        ? (engagement?.repositories.find(item => item.repoId === repoId) ??
          workspace.data?.unassignedRepositories.find(
              item => item.repoId === repoId,
          ) ??
          workspace.data?.engagements
              .flatMap(item => item.repositories)
              .find(item => item.repoId === repoId))
        : undefined;
    const title =
        engagement && repository
            ? `${engagement.name} · ${repository.name} • ${APP_INFO.name}`
            : engagement
              ? `${engagement.name} • ${APP_INFO.name}`
              : repository
                ? `${repository.name} • ${APP_INFO.name}`
                : APP_INFO.name;

    useEffect(() => {
        document.title = title;
        void setDesktopWindowTitle(title).catch(() => undefined);
    }, [title]);

    useEffect(
        () => () => {
            document.title = APP_INFO.name;
            void setDesktopWindowTitle(APP_INFO.name).catch(() => undefined);
        },
        [],
    );

    return null;
}
