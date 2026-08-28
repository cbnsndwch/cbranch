import {
    PLUGIN_CONTRACT_VERSION,
    type PluginAutomationAction,
    type PluginCatalogEntry,
    type PluginGrant,
    type PluginManifest,
    type PluginRepositorySourceKind,
} from '@cbranch/plugin-contract';

export type PluginPolicyCode =
    | 'pluginArtifactInvalid'
    | 'pluginIncompatible'
    | 'pluginMetadataExpired'
    | 'pluginMetadataInvalid'
    | 'pluginPermissionDenied'
    | 'pluginPolicyDenied'
    | 'pluginRepositoryInvalid';

export class PluginPolicyError extends Error {
    readonly code: PluginPolicyCode;

    constructor(code: PluginPolicyCode, message: string) {
        super(message);
        this.name = 'PluginPolicyError';
        this.code = code;
    }
}

const pluginIdPattern =
    /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9]+)?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9]+)?)+$/;
const semverPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const shellNames = new Set([
    'bash',
    'cmd',
    'command',
    'dash',
    'fish',
    'powershell',
    'pwsh',
    'sh',
    'zsh',
]);

/** Reject repository forms that could smuggle credentials or invoke local helpers. */
export const validateRepositoryUrl = (
    kind: PluginRepositorySourceKind,
    value: string,
): URL => {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new PluginPolicyError(
            'pluginRepositoryInvalid',
            'Plugin repository URL must be absolute.',
        );
    }

    const allowedProtocols = kind === 'https' ? ['https:'] : ['https:', 'ssh:'];
    if (
        !allowedProtocols.includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.hostname
    ) {
        throw new PluginPolicyError(
            'pluginRepositoryInvalid',
            'Plugin repository URL uses a forbidden transport or contains credentials.',
        );
    }
    return url;
};

/** Validate manifest data after schema decoding and before an artifact can activate. */
export const validateManifest = (
    manifest: PluginManifest,
    hostVersion: string,
): void => {
    if (manifest.schemaVersion !== PLUGIN_CONTRACT_VERSION) {
        throw new PluginPolicyError(
            'pluginIncompatible',
            'Plugin manifest uses an unsupported schema version.',
        );
    }
    if (
        !pluginIdPattern.test(manifest.id) ||
        !semverPattern.test(manifest.version)
    ) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Plugin manifest has an invalid id or version.',
        );
    }
    if (manifest.engines.pluginContract !== PLUGIN_CONTRACT_VERSION) {
        throw new PluginPolicyError(
            'pluginIncompatible',
            'Plugin requires an unsupported plugin contract version.',
        );
    }
    if (!satisfiesCbranchRange(hostVersion, manifest.engines.cbranch)) {
        throw new PluginPolicyError(
            'pluginIncompatible',
            `Plugin requires cbranch ${manifest.engines.cbranch}; this host is ${hostVersion}.`,
        );
    }
    if (
        !isSafeRelativePath(manifest.entrypoint) ||
        !isTrustedEsmEntrypoint(manifest.entrypoint)
    ) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Plugin entrypoint must be a relative .mjs or .js file.',
        );
    }
    if (manifest.runtime !== 'trusted-esm') {
        throw new PluginPolicyError(
            'pluginIncompatible',
            'Plugin requires an unsupported runtime.',
        );
    }
    requireUnique(manifest.capabilities, 'capabilities');
    requireUnique(
        manifest.automation.map(action => action.id),
        'automation action ids',
    );
    requireUnique(
        manifest.contributes.commands.map(command => command.id),
        'command contribution ids',
    );
    for (const command of manifest.contributes.commands) {
        if (!command.id.startsWith(`${manifest.id}.`)) {
            throw new PluginPolicyError(
                'pluginArtifactInvalid',
                'Plugin command ids must be prefixed with the plugin id.',
            );
        }
    }
    requireUnique(
        manifest.contributes.panels.map(panel => panel.id),
        'panel contribution ids',
    );
    for (const action of manifest.automation) {
        validateAutomationAction(action);
    }
};

export const validateAutomationAction = (
    action: PluginAutomationAction,
): void => {
    const executableName = action.executable.split('/').at(-1)?.toLowerCase();
    if (
        !action.executable.startsWith('/') ||
        action.executable.includes('\0') ||
        !executableName ||
        shellNames.has(executableName)
    ) {
        throw new PluginPolicyError(
            'pluginPolicyDenied',
            'Automation executable must be an absolute non-shell path.',
        );
    }
    if (
        action.arguments.some(
            argument => argument.includes('\0') || argument.includes('${'),
        )
    ) {
        throw new PluginPolicyError(
            'pluginPolicyDenied',
            'Automation arguments must be fixed values, not shell templates.',
        );
    }
    if (action.environment?.some(name => !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Automation environment declarations must be environment variable names.',
        );
    }
};

/** Prove a grant never gives authority the decoded manifest did not request. */
export const validateGrant = (
    manifest: PluginManifest,
    grant: PluginGrant,
    hostVersion: string,
): void => {
    validateManifest(manifest, hostVersion);
    requireUnique(grant.capabilities, 'granted capabilities');
    requireUnique(grant.repositoryIds, 'granted repository ids');
    requireUnique(grant.networkOrigins, 'granted network origins');
    requireUnique(grant.automationActionIds, 'granted automation action ids');

    if (
        grant.capabilities.some(
            capability => !manifest.capabilities.includes(capability),
        )
    ) {
        throw new PluginPolicyError(
            'pluginPermissionDenied',
            'Grant includes a capability not requested by the plugin.',
        );
    }
    if (
        grant.automationActionIds.some(
            id => !manifest.automation.some(action => action.id === id),
        )
    ) {
        throw new PluginPolicyError(
            'pluginPermissionDenied',
            'Grant includes an automation action not declared by the plugin.',
        );
    }
    if (
        grant.hostAutomationApproved !==
        grant.capabilities.includes('hostAutomation')
    ) {
        throw new PluginPolicyError(
            'pluginPermissionDenied',
            'hostAutomation requires its separate explicit approval.',
        );
    }
    if (
        grant.automationActionIds.length > 0 &&
        !grant.capabilities.includes('automation.exec')
    ) {
        throw new PluginPolicyError(
            'pluginPermissionDenied',
            'Automation actions require the automation.exec capability.',
        );
    }
    for (const origin of grant.networkOrigins) {
        const url = validateRepositoryUrl('https', origin);
        if (url.pathname !== '/' || url.port) {
            throw new PluginPolicyError(
                'pluginPermissionDenied',
                'Network grants must be exact HTTPS origins.',
            );
        }
    }
};

export type TufRoleState = {
    readonly role: 'root' | 'timestamp' | 'snapshot' | 'targets' | string;
    readonly version: number;
    readonly expiresAt: number;
    /** Last locally accepted version for this role, when one exists. */
    readonly trustedVersion?: number;
};

/**
 * Validate freshness and rollback invariants after a TUF adapter has checked role
 * signatures, hashes, lengths, and delegations. It deliberately does not accept an
 * expired cache merely because it was previously trusted.
 */
export const validateTufMetadata = (
    roles: readonly TufRoleState[],
    now = Date.now(),
): void => {
    const required = new Set(['root', 'timestamp', 'snapshot', 'targets']);
    const seen = new Set<string>();
    for (const role of roles) {
        if (
            seen.has(role.role) ||
            !Number.isSafeInteger(role.version) ||
            role.version < 1 ||
            !Number.isFinite(role.expiresAt)
        ) {
            throw new PluginPolicyError(
                'pluginMetadataInvalid',
                'Plugin repository metadata is malformed.',
            );
        }
        seen.add(role.role);
        required.delete(role.role);
        if (role.expiresAt <= now) {
            throw new PluginPolicyError(
                'pluginMetadataExpired',
                `Plugin repository ${role.role} metadata has expired.`,
            );
        }
        if (
            role.trustedVersion !== undefined &&
            role.version < role.trustedVersion
        ) {
            throw new PluginPolicyError(
                'pluginMetadataInvalid',
                `Plugin repository ${role.role} metadata was rolled back.`,
            );
        }
    }
    if (required.size > 0) {
        throw new PluginPolicyError(
            'pluginMetadataInvalid',
            'Plugin repository is missing required TUF metadata.',
        );
    }
};

/** Verify TUF target fields agree with the manifest from the verified archive. */
export const validateManifestTargetConsistency = async (
    manifest: PluginManifest,
    target: Pick<
        PluginCatalogEntry,
        | 'pluginId'
        | 'version'
        | 'publisherFingerprint'
        | 'pluginContractVersion'
        | 'capabilityDigest'
    > & { readonly minimumCbranchVersion?: string },
    hostVersion: string,
): Promise<void> => {
    validateManifest(manifest, hostVersion);
    const manifestCapabilityDigest = await digestManifestCapabilities(manifest);
    if (target.minimumCbranchVersion !== undefined) {
        if (!parseSemver(target.minimumCbranchVersion)) {
            throw new PluginPolicyError(
                'pluginMetadataInvalid',
                'Signed target metadata has an invalid minimum cbranch version.',
            );
        }
        if (!hostSupportsMinimum(target.minimumCbranchVersion, hostVersion)) {
            throw new PluginPolicyError(
                'pluginIncompatible',
                `Plugin requires cbranch ${target.minimumCbranchVersion} or newer; this host is ${hostVersion}.`,
            );
        }
        if (
            !satisfiesCbranchRange(
                target.minimumCbranchVersion,
                manifest.engines.cbranch,
            )
        ) {
            throw new PluginPolicyError(
                'pluginArtifactInvalid',
                'Plugin manifest compatibility does not match its signed target metadata.',
            );
        }
    }
    if (
        manifest.id !== target.pluginId ||
        manifest.version !== target.version ||
        manifest.publisherFingerprint !== target.publisherFingerprint ||
        manifest.engines.pluginContract !== target.pluginContractVersion ||
        manifestCapabilityDigest !== target.capabilityDigest
    ) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Plugin manifest does not match its signed target metadata.',
        );
    }
};

const hostSupportsMinimum = (minimum: string, hostVersion: string): boolean => {
    const host = parseSemver(hostVersion);
    const required = parseSemver(minimum);
    return Boolean(host && required && compareSemver(host, required) >= 0);
};

/** Supports the intentionally narrow >=x.y.z [<x.y.z] range grammar used by P9. */
export const satisfiesCbranchRange = (
    version: string,
    range: string,
): boolean => {
    const current = parseSemver(version);
    if (!current) return false;
    const terms = range.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return false;
    const parsedTerms = terms.map(term => {
        const match = /^(>=|>|<=|<|=)?(.+)$/.exec(term);
        const bound = match && parseSemver(match[2]);
        return match && bound
            ? { operator: match[1] ?? '=', bound }
            : undefined;
    });
    if (parsedTerms.some(term => !term)) return false;
    if (
        current.prerelease.length > 0 &&
        !parsedTerms.some(
            term =>
                term!.bound.prerelease.length > 0 &&
                term!.bound.major === current.major &&
                term!.bound.minor === current.minor &&
                term!.bound.patch === current.patch,
        )
    ) {
        return false;
    }
    return parsedTerms.every(term => {
        const comparison = compareSemver(current, term!.bound);
        switch (term!.operator) {
            case '>=':
                return comparison >= 0;
            case '>':
                return comparison > 0;
            case '<=':
                return comparison <= 0;
            case '<':
                return comparison < 0;
            default:
                return comparison === 0;
        }
    });
};

/** Hash authority-bearing capability declarations in a canonical order. */
export const digestManifestCapabilities = (
    manifest: Pick<PluginManifest, 'capabilities'>,
): Promise<string> => canonicalSha256(manifest.capabilities.toSorted());

/** Hash automation declarations independently for security-update policy. */
export const digestAutomationDeclarations = (
    manifest: Pick<PluginManifest, 'automation'>,
): Promise<string> =>
    canonicalSha256(
        manifest.automation
            .map(action => ({
                id: action.id,
                executable: action.executable,
                arguments: action.arguments,
                workingDirectory: action.workingDirectory,
                environment: action.environment?.toSorted() ?? [],
            }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
    );

/** Lock records use this digest to bind the exact user-approved grant. */
export const digestGrant = (grant: PluginGrant): Promise<string> =>
    canonicalSha256({
        capabilities: grant.capabilities.toSorted(),
        repositoryIds: grant.repositoryIds.toSorted(),
        networkOrigins: grant.networkOrigins.toSorted(),
        automationActionIds: grant.automationActionIds.toSorted(),
        hostAutomationApproved: grant.hostAutomationApproved,
    });

/** Check a downloaded artifact against already verified signed target metadata. */
export const validateArtifact = (
    target: Pick<PluginCatalogEntry, 'artifactLength' | 'artifactSha256'>,
    actualLength: number,
    actualSha256: string,
): void => {
    if (
        !Number.isSafeInteger(target.artifactLength) ||
        target.artifactLength < 0 ||
        !isSha256(target.artifactSha256) ||
        actualLength !== target.artifactLength ||
        actualSha256 !== target.artifactSha256
    ) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Plugin artifact does not match its signed digest or length.',
        );
    }
};

export const MAX_PLUGIN_ARCHIVE_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES = 200 * 1024 * 1024;

export type PluginArchiveEntry = {
    readonly path: string;
    readonly kind: 'file' | 'directory' | 'symlink' | 'device' | 'other';
    readonly size: number;
};

/**
 * Validate a tar index before extraction. The host extractor must perform the same
 * checks while writing each entry, because a malformed archive can lie in its index.
 */
export const validatePluginArchive = (
    compressedSize: number,
    entries: readonly PluginArchiveEntry[],
): void => {
    if (
        !Number.isSafeInteger(compressedSize) ||
        compressedSize < 0 ||
        compressedSize > MAX_PLUGIN_ARCHIVE_COMPRESSED_BYTES
    ) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Plugin archive exceeds the compressed size limit.',
        );
    }

    let extractedSize = 0;
    let manifestCount = 0;
    const paths = new Set<string>();
    for (const entry of entries) {
        if (
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            !isSafeRelativePath(entry.path) ||
            paths.has(entry.path) ||
            (entry.kind !== 'file' && entry.kind !== 'directory')
        ) {
            throw new PluginPolicyError(
                'pluginArtifactInvalid',
                'Plugin archive contains an unsafe entry.',
            );
        }
        paths.add(entry.path);
        if (entry.kind === 'file') {
            extractedSize += entry.size;
            if (entry.path === 'plugin.json') manifestCount += 1;
        }
        if (extractedSize > MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES) {
            throw new PluginPolicyError(
                'pluginArtifactInvalid',
                'Plugin archive exceeds the extracted size limit.',
            );
        }
    }
    if (manifestCount !== 1) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            'Plugin archive must contain exactly one root plugin.json manifest.',
        );
    }
};

/** Archive extractors call this for every entry before creating anything on disk. */
export const isSafeArchiveEntry = (path: string, kind: string): boolean =>
    kind === 'file' && isSafeRelativePath(path);

export const isSafeRelativePath = (path: string): boolean =>
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !path.includes('\0') &&
    !path
        .split('/')
        .some(segment => segment === '' || segment === '.' || segment === '..');

const isTrustedEsmEntrypoint = (path: string): boolean =>
    path.endsWith('.mjs') || path.endsWith('.js');

/** Replaces known secrets before diagnostics or audit output leave a host adapter. */
export const redactSecrets = (
    value: string,
    secrets: readonly string[],
): string =>
    secrets
        .filter(secret => secret.length > 0)
        .toSorted((left, right) => right.length - left.length)
        .reduce(
            (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
            value,
        );

export type SecurityUpdateCandidate = Pick<
    PluginCatalogEntry,
    | 'pluginId'
    | 'version'
    | 'publisherFingerprint'
    | 'capabilityDigest'
    | 'advisoryIds'
> & {
    readonly automationDigest: string;
};

export type InstalledUpdateState = {
    readonly pluginId: string;
    readonly version: string;
    readonly publisherFingerprint: string;
    readonly capabilityDigest: string;
    readonly automationDigest: string;
    readonly hasHostAutomation: boolean;
    readonly securityOnlyAutoUpdates: boolean;
};

/** Implements the conservative auto-update conditions from REQ-PLG-UPD-004/005. */
export const isEligibleSecurityUpdate = (
    installed: InstalledUpdateState,
    candidate: SecurityUpdateCandidate,
): boolean => {
    const installedVersion = parseSemver(installed.version);
    const candidateVersion = parseSemver(candidate.version);
    if (!installedVersion || !candidateVersion) return false;
    return (
        installed.securityOnlyAutoUpdates &&
        !installed.hasHostAutomation &&
        installed.pluginId === candidate.pluginId &&
        installed.publisherFingerprint === candidate.publisherFingerprint &&
        installedVersion.major === candidateVersion.major &&
        compareSemver(candidateVersion, installedVersion) > 0 &&
        installed.capabilityDigest === candidate.capabilityDigest &&
        installed.automationDigest === candidate.automationDigest &&
        candidate.advisoryIds.length > 0
    );
};

type ParsedSemver = {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: readonly string[];
};

const parseSemver = (value: string): ParsedSemver | undefined => {
    const match = semverPattern.exec(value);
    if (!match) return undefined;
    const core = [match[1], match[2], match[3]].map(Number);
    if (core.some(part => !Number.isSafeInteger(part))) return undefined;
    const prerelease = match[4]?.split('.') ?? [];
    if (
        prerelease.some(
            identifier =>
                /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier),
        )
    ) {
        return undefined;
    }
    return {
        major: core[0]!,
        minor: core[1]!,
        patch: core[2]!,
        prerelease,
    };
};

const compareSemver = (left: ParsedSemver, right: ParsedSemver): number => {
    const core =
        left.major - right.major ||
        left.minor - right.minor ||
        left.patch - right.patch;
    if (core !== 0) return core;
    if (left.prerelease.length === 0) {
        return right.prerelease.length === 0 ? 0 : 1;
    }
    if (right.prerelease.length === 0) return -1;
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index++) {
        const leftIdentifier = left.prerelease[index];
        const rightIdentifier = right.prerelease[index];
        if (leftIdentifier === undefined) return -1;
        if (rightIdentifier === undefined) return 1;
        if (leftIdentifier === rightIdentifier) continue;
        const leftNumeric = /^\d+$/u.test(leftIdentifier);
        const rightNumeric = /^\d+$/u.test(rightIdentifier);
        if (leftNumeric && rightNumeric) {
            return (
                leftIdentifier.length - rightIdentifier.length ||
                leftIdentifier.localeCompare(rightIdentifier)
            );
        }
        if (leftNumeric) return -1;
        if (rightNumeric) return 1;
        return leftIdentifier.localeCompare(rightIdentifier);
    }
    return 0;
};

const requireUnique = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) {
        throw new PluginPolicyError(
            'pluginArtifactInvalid',
            `Plugin manifest has duplicate ${label}.`,
        );
    }
};

const isSha256 = (value: string): boolean =>
    /^sha256:[0-9a-f]{64}$/.test(value);

type CanonicalValue =
    | null
    | boolean
    | number
    | string
    | readonly CanonicalValue[]
    | { readonly [key: string]: CanonicalValue };

/** Stable JSON encoding with sorted object keys. */
const canonicalJson = (value: CanonicalValue): string => {
    if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'string'
    ) {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new PluginPolicyError(
                'pluginPolicyDenied',
                'Cannot digest a non-finite plugin declaration value.',
            );
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const object = value as { readonly [key: string]: CanonicalValue };
    return `{${Object.keys(object)
        .toSorted()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
        .join(',')}}`;
};

const canonicalSha256 = async (value: CanonicalValue): Promise<string> => {
    if (!globalThis.crypto?.subtle) {
        throw new PluginPolicyError(
            'pluginPolicyDenied',
            'The host does not provide Web Crypto for plugin verification.',
        );
    }
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const hash = new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', bytes),
    );
    return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};
