const releaseVersionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

const parseReleaseVersion = (
    version: string,
): readonly [number, number, number] | undefined => {
    const match = releaseVersionPattern.exec(version);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** A newer same-major server can satisfy an older client's RPC surface. */
export const isBackendVersionCompatible = (
    backendVersion: string,
    requiredVersion: string,
): boolean => {
    if (backendVersion === requiredVersion) return true;
    const backend = parseReleaseVersion(backendVersion);
    const required = parseReleaseVersion(requiredVersion);
    if (!backend || !required || backend[0] !== required[0]) return false;
    for (let index = 1; index < backend.length; index++) {
        if (backend[index]! > required[index]!) return true;
        if (backend[index]! < required[index]!) return false;
    }
    return true;
};
