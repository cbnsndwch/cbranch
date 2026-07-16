const version = import.meta.env.VITE_CBRANCH_VERSION?.replace(/^v/, '');

/** Build identity injected by desktop release workflows and available throughout the UI. */
export const APP_INFO = {
    name:
        import.meta.env.VITE_CBRANCH_APP_NAME ??
        (import.meta.env.VITE_CBRANCH_CANARY === '1'
            ? 'cBranch Canary'
            : 'cBranch'),
    version: version ?? CBRANCH_BACKEND_VERSION,
    isCanary: import.meta.env.VITE_CBRANCH_CANARY === '1',
} as const;
import { CBRANCH_BACKEND_VERSION } from '@cbranch/rpc-contract';
