import { WorkspaceIntelligenceArchiveDescriptor } from '@cbranch/rpc-contract';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { workspaceIntelligenceArchiveDescriptor } from './rpc-handlers';

describe('workspaceIntelligenceArchiveDescriptor', () => {
    test('has the schema-class shape required by the serialized RPC response', () => {
        const descriptor = workspaceIntelligenceArchiveDescriptor(
            'run-1',
            'token with spaces',
        );
        const encode = Schema.encodeSync(
            WorkspaceIntelligenceArchiveDescriptor,
        );
        const decode = Schema.decodeUnknownSync(
            WorkspaceIntelligenceArchiveDescriptor,
        );

        const wire = JSON.parse(JSON.stringify(encode(descriptor)));

        expect(wire).toEqual({
            url: '/sidechannel/workspace-intelligence-archive?token=token%20with%20spaces',
            filename: 'workspace-intelligence-run-1.tar',
            contentType: 'application/x-tar',
        });
        expect(decode(wire)).toBeInstanceOf(
            WorkspaceIntelligenceArchiveDescriptor,
        );
    });
});
