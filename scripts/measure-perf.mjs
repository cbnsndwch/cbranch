#!/usr/bin/env node
/**
 * NF-PERF-1/2/3 measurement script (docs/spec/12 §Performance budgets).
 *
 * Prerequisite — start the server first:
 *   CBRANCH_CLIENT_DIR=/tmp/empty-dir \
 *   CBRANCH_PORT=7420 \
 *   pnpm --filter @cbranch/web-server start
 *
 * Then run:
 *   node scripts/measure-perf.mjs /path/to/large/repo [--port 7420] [--runs 5]
 *
 * Probes (via real WebSocket RPC, no browser needed — Node 22+ WebSocket built-in):
 *
 *   NF-PERF-1  time-to-first-row: RepoOpen + LogStream until first commit arrives.
 *              Budget: p95 ≤ 1500 ms (docs/spec/12).
 *
 *   NF-PERF-2  incremental delivery: first row arrives before stream end.
 *              Budget: must be true (user sees results before full history loads).
 *
 *   NF-PERF-3  stream throughput proxy: rows/s over the whole LogStream.
 *              Budget: ≥ 1000 rows/s (ensures 50k commits transfer in ≤ 50 s,
 *              well within the interactive window at 50 fps virtualized rendering).
 *
 * Exit 0 = all budgets met.  Exit 1 = one or more budgets missed.
 */

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const repoPath = args.find(a => !a.startsWith('--'));
const flag = name => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
};
const port = parseInt(flag('--port') ?? '7420', 10);
const RUNS = parseInt(flag('--runs') ?? '5', 10);

if (!repoPath) {
    console.error(
        'Usage: node scripts/measure-perf.mjs <repo-path> [--port 7420] [--runs 5]',
    );
    process.exit(1);
}

// ── Stats helper ─────────────────────────────────────────────────────────────
function pct(samples, p) {
    const s = [...samples].toSorted((a, b) => a - b);
    return s[Math.max(0, Math.floor((s.length - 1) * p))];
}

// ── Single probe ─────────────────────────────────────────────────────────────
function probe() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
        let firstRowMs = null;
        let rowCount = 0;
        const t0 = performance.now();

        ws.addEventListener('open', () => {
            ws.send(
                JSON.stringify({ _tag: 'RepoOpen', path: repoPath }) + '\n',
            );
        });

        ws.addEventListener('message', ({ data }) => {
            for (const line of String(data).split('\n')) {
                if (!line.trim()) continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }

                if (msg._tag === 'RepoOpen' && msg.repoId) {
                    ws.send(
                        JSON.stringify({
                            _tag: 'LogStream',
                            repoId: msg.repoId,
                            limit: 100_000,
                        }) + '\n',
                    );
                } else if (msg._tag === 'LogStream') {
                    if (msg.oid) {
                        if (firstRowMs === null)
                            firstRowMs = performance.now() - t0;
                        rowCount++;
                    }
                    if (msg._end || msg._cause) {
                        const totalMs = performance.now() - t0;
                        ws.close();
                        resolve({
                            firstRowMs,
                            rowCount,
                            totalMs,
                            incremental:
                                firstRowMs !== null &&
                                firstRowMs < totalMs - 10,
                        });
                    }
                } else if (msg._tag === 'GitError' || msg._cause) {
                    ws.close();
                    reject(new Error(msg.message ?? JSON.stringify(msg)));
                }
            }
        });

        ws.addEventListener('error', e =>
            reject(new Error(String(e.message ?? e))),
        );
        setTimeout(() => {
            ws.close();
            reject(new Error('probe timeout after 60s'));
        }, 60_000);
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────
const ttfr = [];
const throughput = [];
let incrementalOk = true;

console.log(
    `\nProbing ws://127.0.0.1:${port} against ${repoPath} (${RUNS} runs)…\n`,
);

for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  run ${i + 1}/${RUNS} … `);
    let r;
    try {
        // eslint-disable-next-line no-await-in-loop -- benchmark runs must be serialized to measure one at a time.
        r = await probe();
    } catch (e) {
        console.error(`FAILED: ${e.message}`);
        process.exit(1);
    }
    const rps =
        r.rowCount > 0 && r.totalMs > 0
            ? Math.round(r.rowCount / (r.totalMs / 1000))
            : 0;
    console.log(
        `ttfr=${Math.round(r.firstRowMs)}ms  rows=${r.rowCount}  ${rps} rows/s`,
    );
    ttfr.push(r.firstRowMs);
    throughput.push(rps);
    if (!r.incremental) incrementalOk = false;
}

const ttfrP95 = Math.round(pct(ttfr, 0.95));
const rpsMedian = Math.round(pct(throughput, 0.5));

console.log('\n─── NF-PERF results ─────────────────────────────────────────');
console.log(
    `NF-PERF-1  time-to-first-row  p95 = ${ttfrP95} ms    (budget ≤ 1500 ms)`,
);
console.log(
    `NF-PERF-2  incremental?        ${incrementalOk ? 'YES ✓' : 'NO  ✗'}`,
);
console.log(
    `NF-PERF-3  throughput (p50)    ${rpsMedian} rows/s  (budget ≥ 1000 rows/s)`,
);
console.log('─────────────────────────────────────────────────────────────\n');

const failures = [];
if (ttfrP95 > 1500)
    failures.push(`NF-PERF-1: p95 ${ttfrP95} ms exceeds 1500 ms budget`);
if (!incrementalOk) failures.push('NF-PERF-2: stream was not incremental');
if (rpsMedian > 0 && rpsMedian < 1000)
    failures.push(`NF-PERF-3: ${rpsMedian} rows/s below 1000 rows/s budget`);

if (failures.length) {
    console.error('BUDGET FAILURES:');
    failures.forEach(f => console.error('  ✗', f));
    process.exit(1);
}

console.log('All measured budgets met ✓');
