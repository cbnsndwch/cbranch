import { useEffect } from 'react';

import { useRepoState } from '../rpc/hooks';
import { useUiStore } from '../state/store';

// On web there is no in-app title bar, the browser window title IS the title bar. This
// headless component reflects the active repository's current branch in `document.title`
// (e.g. "main • cBranch", or just "cBranch" with no repo open) and renders nothing.
export function DocumentTitle() {
    const repoId = useUiStore(s => s.activeRepoId);
    const { data: state } = useRepoState(repoId);
    const title = state?.currentBranch
        ? `${state.currentBranch} • cBranch`
        : 'cBranch';

    useEffect(() => {
        document.title = title;
    }, [title]);

    return null;
}
