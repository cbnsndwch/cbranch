import { CBRANCH_BACKEND_VERSION } from '@cbranch/rpc-contract';

/** Release packaging injects the desktop tag for managed canary server builds. */
export const serverVersion = (env: NodeJS.ProcessEnv = process.env): string =>
    env.CBRANCH_RELEASE_VERSION?.trim() || CBRANCH_BACKEND_VERSION;
