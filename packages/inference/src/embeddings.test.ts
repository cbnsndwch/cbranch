import { describe, expect, test } from 'vitest';

import { cosineSimilarity, normalizeEmbeddingResult } from './embeddings';

describe('embedding normalization', () => {
    test('accepts only finite vectors with a common dimension', () => {
        expect(
            normalizeEmbeddingResult(
                {
                    vectors: [
                        [1, 0],
                        [0, 1],
                    ],
                    usage: { inputTokens: 4 },
                },
                2,
            ),
        ).toEqual({
            vectors: [
                [1, 0],
                [0, 1],
            ],
            usage: { inputTokens: 4 },
        });
        expect(() =>
            normalizeEmbeddingResult({ vectors: [[1], [1, 0]] }, 2),
        ).toThrow('inconsistent dimensions');
        expect(() =>
            normalizeEmbeddingResult({ vectors: [[1, 0]] }, 2),
        ).toThrow('unexpected vector count');
    });

    test('calculates bounded cosine similarity without NaN leakage', () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
        expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
        expect(cosineSimilarity([1], [1, 0])).toBe(0);
    });
});
