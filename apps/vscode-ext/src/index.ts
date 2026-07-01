// @cbranch/vscode-ext — VSCode webview extension (later track).
//
// P0 placeholder only. In its own track this binds the same @cbranch/rpc-contract
// RpcGroup to webview.postMessage and reuses @cbranch/core in the extension host.
// It MUST NOT open any network socket (REQ-ARCH-074).

import type { RpcContractPlaceholder } from '@cbranch/rpc-contract';

export const version = '0.0.0' as const;

/** Placeholder extension entry; realized in the VSCode track. */
export type VscodeExtPlaceholder = {
    readonly version: typeof version;
    readonly contract: RpcContractPlaceholder['version'];
};
