// @cbranch/web-server — Node host service + static bundle server.
//
// The single deployable host unit (NF-PKG-1) and the ONLY package permitted to open a
// listening socket (REQ-ARCH-005 / DECISIONS D10). It assembles the Effect platform
// HTTP/WebSocket layers into one multiplexed NDJSON socket (`/rpc`), serves the static
// SPA + the large-blob HTTP side-channel, enforces the `Origin`/`Host` allowlist, and
// binds loopback by default. The runnable entry point is `./main`; this module exports
// the composable building blocks (used by the integration tests and any embedder).

export { buildServerLive, RPC_PATH } from './server';
export { WORKSPACE_AVATAR_CHANNEL_PATH } from './workspace-avatar-channel';
export {
    DEFAULT_HOST,
    DEFAULT_PORT,
    defaultClientDir,
    ensureClientDir,
    isLoopbackHost,
    type LogLevel,
    resolveServerConfig,
    type ServerConfig,
} from './config';
export { isAllowedRequest, makeOriginGuard } from './origin-guard';
export { handlersLayer } from './rpc-handlers';
export {
    activatedPluginDirectory,
    makeTrustedPluginManager,
    trustedPluginManagerLayer,
    type PluginManagerApi,
    type TrustedPluginManagerOptions,
    type VerifiedPluginInstall,
} from './plugin-manager';
export {
    makePluginAuditStore,
    PLUGIN_AUDIT_FILE_NAME,
    type PluginAuditStore,
} from './plugin-audit-store';
export {
    makeHttpsPluginRepositoryTransport,
    type PluginRepositoryTransportOptions,
} from './plugin-repository-transport';
export { verifyTufEd25519Signature } from './tuf-signature-verifier';
export {
    makeTufPluginRepository,
    type TufPluginRepositoryOptions,
} from './tuf-plugin-repository';
export {
    makePluginRepositoryStore,
    PLUGIN_REPOSITORY_FILE_NAME,
    type PluginRepositoryStore,
} from './plugin-repository-store';
export {
    makePluginArtifactStore,
    type PluginArtifactStore,
} from './plugin-artifact-store';
export {
    makeProcessCredentialStore,
    type PluginCredentialReference,
    type PluginCredentialStore,
} from './plugin-credentials';
export {
    makePluginLockStore,
    PLUGIN_LOCK_FILE_NAME,
    PLUGIN_LOCK_VERSION,
    resolvePluginDataDirectory,
    type PluginLockStore,
} from './plugin-lock-store';
export {
    containBlobPath,
    guessContentType,
    safeRev,
    SIDE_CHANNEL_PATH,
    sideChannelRoute,
} from './side-channel';
