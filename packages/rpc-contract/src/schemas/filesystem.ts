// Host filesystem picker schemas. These are intentionally read-only discovery
// records: the browser receives only names and resolved paths within host-defined roots.

import { Schema } from 'effect';

export const FilesystemEntryKind = Schema.Literals([
    'dir',
    'file',
    'symlink',
    'other',
]);
export type FilesystemEntryKind = typeof FilesystemEntryKind.Type;

export class FilesystemRoot extends Schema.Class<FilesystemRoot>(
    'FilesystemRoot',
)({
    label: Schema.String,
    path: Schema.String,
}) {}

export class FilesystemBreadcrumb extends Schema.Class<FilesystemBreadcrumb>(
    'FilesystemBreadcrumb',
)({
    label: Schema.String,
    path: Schema.String,
}) {}

export class FilesystemEntry extends Schema.Class<FilesystemEntry>(
    'FilesystemEntry',
)({
    name: Schema.String,
    kind: FilesystemEntryKind,
    hidden: Schema.Boolean,
    /** A directory containing a .git entry; used only as a picker badge. */
    isRepository: Schema.Boolean,
    /** False when a symlink resolves outside the host's allowed roots. */
    navigable: Schema.Boolean,
    resolvedKind: Schema.optional(FilesystemEntryKind),
}) {}

/** One bounded, immediate host-directory listing for the reusable picker. */
export class FilesystemDirectoryListing extends Schema.Class<FilesystemDirectoryListing>(
    'FilesystemDirectoryListing',
)({
    path: Schema.String,
    parent: Schema.NullOr(Schema.String),
    breadcrumbs: Schema.Array(FilesystemBreadcrumb),
    roots: Schema.Array(FilesystemRoot),
    entries: Schema.Array(FilesystemEntry),
    truncated: Schema.Boolean,
}) {}
