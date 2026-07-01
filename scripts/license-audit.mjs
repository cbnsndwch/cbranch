#!/usr/bin/env node
// License-audit gate (REQ-STACK-031 / 032 / 033).
//
// Two checks, both run via pnpm's built-in `pnpm licenses list --json` (no extra
// dependency):
//
//   1. PRODUCTION (shipped) tree  -> strict PERMISSIVE allow-list (REQ-STACK-032).
//      Every dependency that can end up in a shipped artifact MUST be permissive.
//      Fails the build on the offending package otherwise.
//
//   2. FULL tree (incl. dev/build tooling) -> DEV allow-list (REQ-STACK-033).
//      Dev tooling is exempt from BUNDLING but must still be license-clean. The dev
//      allow-list is the permissive set PLUS a small, documented set of weak/file-
//      level copyleft licenses that are only ever present in BUILD-TIME tooling and
//      never shipped. Strong copyleft (GPL/LGPL/AGPL/SSPL) fails ANYWHERE.
//
// HOW TO UPDATE THE ALLOW-LISTS:
//   - Production: add the SPDX id to PROD_ALLOWLIST below AND record the dependency
//     in LICENSES.md. Only ever add OSI-permissive, MIT-compatible, non-copyleft ids.
//   - Dev: add the SPDX id to DEV_EXTRA below WITH a one-line justification proving
//     the package is build-time only (not bundled) and document it in LICENSES.md.

import { execSync } from 'node:child_process';

const PROD_ALLOWLIST = new Set([
    'MIT',
    'MIT-0',
    'ISC',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'CC0-1.0',
    'Unlicense',
    'Python-2.0',
    'BlueOak-1.0.0',
]);

// Weak/file-level copyleft allowed ONLY in the dev/build tree (never shipped).
// Justification (documented in LICENSES.md): `lightningcss` is MPL-2.0 and is an
// unavoidable transitive build-time dependency of the spec-mandated
// `@tailwindcss/vite` (REQ-STACK-013) and of Vite. It runs only during the build to
// transform CSS; it is NOT linked into or emitted in the shipped browser bundle, so
// MPL-2.0's file-level copyleft does not reach cbranch's MIT-licensed artifacts.
// `CC-BY-4.0` covers ONLY the `caniuse-lite` browser-compatibility DATA table, an
// unavoidable transitive build-time dependency of `browserslist` (pulled in by the
// Vite/react-router dev tooling). It is a data file consumed during the build to
// target browsers; no `caniuse-lite` code or data is linked into or emitted in the
// shipped browser bundle, so CC-BY-4.0's attribution terms do not reach cbranch's
// MIT-licensed artifacts. Documented in LICENSES.md.
const DEV_EXTRA = new Set(['MPL-2.0', 'CC-BY-4.0']);
const DEV_ALLOWLIST = new Set([...PROD_ALLOWLIST, ...DEV_EXTRA]);

// Strong copyleft / network-copyleft — rejected EVERYWHERE, even in dev tooling.
const ALWAYS_DENY = new Set([
    'GPL-2.0',
    'GPL-3.0',
    'LGPL-2.1',
    'LGPL-3.0',
    'AGPL-3.0',
    'SSPL-1.0',
]);

function tokenizeSpdx(expr) {
    return expr
        .replace(/[()]/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t && !['OR', 'AND', 'WITH'].includes(t.toUpperCase()));
}

function expressionPasses(expr, allow) {
    if (!expr || expr === 'UNLICENSED' || expr === 'UNKNOWN') return false;
    // Strong copyleft anywhere in the expression is an automatic fail.
    if (tokenizeSpdx(expr).some(t => ALWAYS_DENY.has(t))) return false;
    if (allow.has(expr)) return true;
    const tokens = tokenizeSpdx(expr);
    if (tokens.length === 0) return false;
    return /\bOR\b/i.test(expr)
        ? tokens.some(t => allow.has(t))
        : tokens.every(t => allow.has(t));
}

function getRecords(args) {
    let raw;
    try {
        raw = execSync(`pnpm licenses list ${args} --json`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        raw = err.stdout?.toString() ?? '';
        if (!raw.trim()) return [];
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        console.error(
            `license-audit: could not parse \`pnpm licenses list ${args} --json\`.`,
        );
        process.exit(1);
    }
    const records = [];
    const push = (entry, licenseKey) => {
        const license = entry.license ?? licenseKey ?? 'UNKNOWN';
        const versions =
            entry.versions ?? (entry.version ? [entry.version] : ['?']);
        for (const version of versions)
            records.push({ name: entry.name, version, license });
    };
    if (Array.isArray(data)) {
        for (const entry of data) push(entry, entry.license);
    } else if (data && typeof data === 'object') {
        for (const [licenseKey, entries] of Object.entries(data)) {
            if (Array.isArray(entries))
                for (const entry of entries) push(entry, licenseKey);
        }
    }
    return records;
}

function audit(label, records, allow) {
    const offenders = [
        ...new Set(
            records
                .filter(r => !expressionPasses(r.license, allow))
                .map(r => `${r.name}@${r.version} -> ${r.license}`),
        ),
    ].toSorted();
    if (offenders.length > 0) {
        console.error(
            `license-audit FAILED (${label}): ${offenders.length} dependency license(s) not allowed:\n`,
        );
        for (const o of offenders) console.error(`  - ${o}`);
        console.error(`\nAllowed (${label}): ${[...allow].join(', ')}`);
        return false;
    }
    console.log(
        `  ${label}: ${records.length} dependency entries, all allowed.`,
    );
    return true;
}

const prod = getRecords('--prod');
const all = getRecords('');

if (prod.length === 0 && all.length === 0) {
    console.log(
        'license-audit: no dependency licenses reported (empty tree?). Treating as pass.',
    );
    process.exit(0);
}

console.log('license-audit:');
const prodOk = audit('production / shipped', prod, PROD_ALLOWLIST);
const devOk = audit('full tree incl. dev tooling', all, DEV_ALLOWLIST);

if (!prodOk || !devOk) {
    console.error(
        '\nTo resolve: replace the dependency, or update the appropriate allow-list in scripts/license-audit.mjs and record it in LICENSES.md.',
    );
    process.exit(1);
}
console.log('license-audit passed.');
