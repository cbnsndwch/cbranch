/**
 * Workspace-local deterministic analysis policy. These values are persisted
 * separately from immutable runs; every new run records the effective snapshot.
 */
export interface WorkspaceIntelligenceAnalysisSettings {
    readonly includePatterns: ReadonlyArray<string>;
    readonly excludePatterns: ReadonlyArray<string>;
    readonly maxSourceFiles: number;
    readonly maxSourceFileBytes: number;
    readonly maxRepositorySourceBytes: number;
    readonly maxRepositoryDurationMs: number;
    readonly maxGraphNodes: number;
    readonly maxGraphEdges: number;
}

export const defaultWorkspaceIntelligenceAnalysisSettings: WorkspaceIntelligenceAnalysisSettings =
    Object.freeze({
        includePatterns: [],
        excludePatterns: [],
        maxSourceFiles: 25_000,
        maxSourceFileBytes: 512_000,
        maxRepositorySourceBytes: 100_000_000,
        maxRepositoryDurationMs: 120_000,
        maxGraphNodes: 100_000,
        maxGraphEdges: 200_000,
    });

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
    [...new Set(values.map(value => value.trim()).filter(Boolean))].toSorted();

const isRelativePattern = (pattern: string): boolean =>
    pattern.length <= 256 &&
    !pattern.startsWith('/') &&
    !pattern.startsWith('\\') &&
    !pattern.includes('\\') &&
    !pattern.split(/[\\/]/).includes('..');

const boundedInteger = (
    value: number,
    name: string,
    minimum: number,
    maximum: number,
): number => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new RangeError(
            `${name} must be an integer between ${minimum} and ${maximum}.`,
        );
    return value;
};

/** Validates and canonicalizes a complete workspace analysis policy. */
export const normalizeWorkspaceIntelligenceAnalysisSettings = (
    value: WorkspaceIntelligenceAnalysisSettings,
): WorkspaceIntelligenceAnalysisSettings => {
    const includePatterns = uniqueSorted(value.includePatterns);
    const excludePatterns = uniqueSorted(value.excludePatterns);
    if (
        !includePatterns.every(isRelativePattern) ||
        !excludePatterns.every(isRelativePattern)
    )
        throw new RangeError(
            'Source include and exclude patterns must be relative globs without parent traversal.',
        );
    if (includePatterns.length > 64 || excludePatterns.length > 64)
        throw new RangeError(
            'At most 64 source include and 64 source exclude patterns are allowed.',
        );
    return {
        includePatterns,
        excludePatterns,
        maxSourceFiles: boundedInteger(
            value.maxSourceFiles,
            'maxSourceFiles',
            1,
            250_000,
        ),
        maxSourceFileBytes: boundedInteger(
            value.maxSourceFileBytes,
            'maxSourceFileBytes',
            1,
            16_000_000,
        ),
        maxRepositorySourceBytes: boundedInteger(
            value.maxRepositorySourceBytes,
            'maxRepositorySourceBytes',
            1,
            1_000_000_000,
        ),
        maxRepositoryDurationMs: boundedInteger(
            value.maxRepositoryDurationMs,
            'maxRepositoryDurationMs',
            1_000,
            900_000,
        ),
        maxGraphNodes: boundedInteger(
            value.maxGraphNodes,
            'maxGraphNodes',
            1,
            100_000,
        ),
        maxGraphEdges: boundedInteger(
            value.maxGraphEdges,
            'maxGraphEdges',
            0,
            200_000,
        ),
    };
};
