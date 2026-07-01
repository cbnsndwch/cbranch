#!/usr/bin/env node
// Build-time primitive-existence check (REQ-STACK-014).
//
// Verifies that the specific Base UI primitives the cbranch UI depends on actually
// exist on the pinned @base-ui/react version, and FAILS with a clear error if a
// required primitive is missing — so a Base-UI gap is caught at setup, not at runtime.
//
// NOTE on what is NOT a Base UI primitive (sourced elsewhere, reported but never a
// failure here): the resizable layout uses `react-resizable-panels`, the command
// palette uses `cmdk`, transient toasts use `sonner` (REQ-STACK-UX-001), and
// "Sheet" is a styled wrapper over Base UI's Dialog rather than its own primitive.

import * as BaseUI from '@base-ui/react';

// Required Base UI primitives -> { role, alias? } where `alias` records a Base UI
// rename relative to the conventional shadcn/Radix name the spec uses.
const REQUIRED = {
    Dialog: { role: 'modal dialogs (+ Sheet base)' },
    AlertDialog: { role: 'destructive confirmations' },
    Popover: { role: 'popovers / floating panels' },
    PreviewCard: { role: 'hover card', alias: 'HoverCard' },
    Tooltip: { role: 'tooltips' },
    ScrollArea: { role: 'custom scroll regions' },
    Tabs: { role: 'tabbed surfaces' },
    RadioGroup: { role: 'radio groups (theme picker)' },
    Select: { role: 'select menus' },
    Menu: { role: 'dropdown menus', alias: 'DropdownMenu' },
    ContextMenu: { role: 'right-click context menus' },
    Toggle: { role: 'toggle buttons' },
    Separator: { role: 'separators' },
};

// Non-Base-UI primitives — informational only.
const EXTERNAL = [
    ['Resizable panels', 'react-resizable-panels'],
    ['Command palette', 'cmdk'],
    ['Toast', 'sonner (REQ-STACK-UX-001)'],
    ['Sheet', 'styled wrapper over Base UI Dialog'],
];

const present = [];
const missing = [];

for (const [name, meta] of Object.entries(REQUIRED)) {
    const exists = name in BaseUI && BaseUI[name] != null;
    const label = meta.alias ? `${name} (cbranch "${meta.alias}")` : name;
    if (exists) present.push(`  OK   ${label} — ${meta.role}`);
    else missing.push(`  MISS ${label} — ${meta.role}`);
}

console.log(`Base UI primitive-existence check (@base-ui-components/react)\n`);
console.log('Required Base UI primitives:');
for (const line of present) console.log(line);
for (const line of missing) console.log(line);

console.log('\nNon-Base-UI primitives (sourced elsewhere, informational):');
for (const [role, source] of EXTERNAL)
    console.log(`  --   ${role} -> ${source}`);

if (missing.length > 0) {
    console.error(
        `\nFAIL: ${missing.length} required Base UI primitive(s) missing or renamed on the pinned version.`,
    );
    process.exit(1);
}

console.log(
    `\nPASS: all ${Object.keys(REQUIRED).length} required Base UI primitives are present.`,
);
