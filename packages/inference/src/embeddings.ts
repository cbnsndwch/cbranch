import { z } from 'zod';

/** The only text material an embedding adapter may receive from cbranch. */
export const InferenceEmbeddingRequest = z.object({
    profileId: z.string().min(1),
    model: z.string().min(1),
    inputs: z.array(z.string().min(1).max(12_000)).min(1).max(200),
});
export type InferenceEmbeddingRequest = z.infer<
    typeof InferenceEmbeddingRequest
>;

export const InferenceEmbeddingUsage = z
    .object({
        inputTokens: z.number().int().nonnegative().optional(),
    })
    .optional();
export type InferenceEmbeddingUsage = z.infer<typeof InferenceEmbeddingUsage>;

export interface InferenceEmbeddingResult {
    readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
    readonly usage?: NonNullable<InferenceEmbeddingUsage>;
}

/** Provider IO belongs to a host adapter; this package cannot issue a request. */
export interface InferenceEmbeddingRunner {
    readonly embed: (
        request: InferenceEmbeddingRequest,
    ) => Promise<InferenceEmbeddingResult>;
}

const vector = z.array(z.number().finite()).min(1).max(4_096);

const response = z.object({
    vectors: z.array(vector).min(1).max(200),
    usage: InferenceEmbeddingUsage,
});

/**
 * Rejects malformed/inconsistent vectors rather than letting a corrupted
 * semantic index affect lexical search. No raw provider payload is returned.
 */
export const normalizeEmbeddingResult = (
    value: unknown,
    expectedCount: number,
): InferenceEmbeddingResult => {
    const parsed = response.safeParse(value);
    if (!parsed.success)
        throw new Error('The embedding provider returned invalid vectors.');
    if (parsed.data.vectors.length !== expectedCount)
        throw new Error(
            'The embedding provider returned an unexpected vector count.',
        );
    const dimension = parsed.data.vectors[0]?.length;
    if (
        dimension === undefined ||
        parsed.data.vectors.some(item => item.length !== dimension)
    )
        throw new Error(
            'The embedding provider returned inconsistent dimensions.',
        );
    return {
        vectors: parsed.data.vectors,
        ...(parsed.data.usage === undefined
            ? {}
            : { usage: parsed.data.usage }),
    };
};

/** Stable bounded cosine score for graph/lexical candidate reranking. */
export const cosineSimilarity = (
    left: ReadonlyArray<number>,
    right: ReadonlyArray<number>,
): number => {
    if (left.length === 0 || left.length !== right.length) return 0;
    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index]!;
        const rightValue = right[index]!;
        dot += leftValue * rightValue;
        leftMagnitude += leftValue * leftValue;
        rightMagnitude += rightValue * rightValue;
    }
    if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
    return Math.max(
        -1,
        Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)),
    );
};
