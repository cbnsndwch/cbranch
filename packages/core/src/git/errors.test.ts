import { GitError } from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import {
    classifyGitSpawnError,
    classifyNodeError,
    gitError,
    gitStderrExcerpt,
    scrubSecrets,
} from './errors';

describe('scrubSecrets (NF-SEC-9 / NF-LOG-4)', () => {
    test('redacts user:password embedded in a remote URL', () => {
        expect(
            scrubSecrets('fatal: https://alice:s3cr3t@github.com/x.git failed'),
        ).toBe('fatal: https://alice:***@github.com/x.git failed');
    });

    test('redacts a bare token in userinfo', () => {
        expect(scrubSecrets('remote: https://ghp_TOKEN123@github.com/x')).toBe(
            'remote: https://***@github.com/x',
        );
    });

    test('leaves credential-free text untouched', () => {
        expect(scrubSecrets('fatal: not a git repository')).toBe(
            'fatal: not a git repository',
        );
    });
});

describe('gitError', () => {
    test('builds a GitError with a scrubbed message + code', () => {
        const err = gitError('authFailed', 'auth to https://u:p@h failed');
        expect(err).toBeInstanceOf(GitError);
        expect(err.code).toBe('authFailed');
        expect(err.message).toBe('auth to https://u:***@h failed');
    });

    test('scrubs a string detail', () => {
        const err = gitError('gitFailed', 'boom', 'leaked https://u:p@h');
        expect(err.detail).toBe('leaked https://u:***@h');
    });
});

describe('classifyNodeError (stable error codes, never localized text)', () => {
    test('EACCES → permissionDenied', () => {
        expect(
            classifyNodeError({ code: 'EACCES', message: 'denied' }).code,
        ).toBe('permissionDenied');
    });

    test('ENOENT → fsError', () => {
        expect(
            classifyNodeError({ code: 'ENOENT', message: 'missing' }).code,
        ).toBe('fsError');
    });

    test('abort → cancelled', () => {
        expect(classifyNodeError({ code: 'ABORT_ERR' }).code).toBe('cancelled');
    });

    test('unknown → fsError', () => {
        expect(classifyNodeError(new Error('weird')).code).toBe('fsError');
    });
});

describe('classifyGitSpawnError', () => {
    test('ENOENT for the git binary → hostGitMissing', () => {
        expect(
            classifyGitSpawnError({
                code: 'ENOENT',
                message: 'spawn git ENOENT',
            }).code,
        ).toBe('hostGitMissing');
    });
});

describe('gitStderrExcerpt', () => {
    test('returns undefined for blank stderr', () => {
        expect(gitStderrExcerpt('   ')).toBeUndefined();
    });

    test('scrubs and truncates a long excerpt', () => {
        const out = gitStderrExcerpt('x'.repeat(5000));
        expect(out?.gitStderrExcerpt.endsWith('…')).toBe(true);
        expect(out?.gitStderrExcerpt.length).toBe(2001);
    });
});
