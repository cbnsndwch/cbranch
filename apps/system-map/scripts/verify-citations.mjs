import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const dataRoot = fileURLToPath(new URL('../src/data', import.meta.url));
const dataFiles = (await readdir(dataRoot))
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .toSorted();

const sources = await Promise.all(
    dataFiles.map(async name => ({
        name,
        text: await readFile(`${dataRoot}/${name}`, 'utf8'),
    })),
);
const shared = sources.find(({ name }) => name === 'shared.ts')?.text ?? '';
const revision = shared.match(/revision:\s*["']([^"']+)["']/)?.[1];

if (!revision) {
    throw new Error('Could not read SOURCE_SNAPSHOT.revision from shared.ts');
}

execFileSync('git', [
    '-C',
    repositoryRoot,
    'cat-file',
    '-e',
    `${revision}^{commit}`,
]);

const citationPattern = /citation\(\s*["']([^"']+)["']\s*,\s*(\d+)/g;
const citations = sources.flatMap(({ name, text }) =>
    [...text.matchAll(citationPattern)].map(match => ({
        declaredIn: name,
        path: match[1],
        line: Number(match[2]),
    })),
);

if (citations.length === 0) {
    throw new Error('No literal source citations were found');
}

const lineCounts = new Map();
const failures = [];

for (const item of citations) {
    try {
        let count = lineCounts.get(item.path);
        if (count === undefined) {
            const content = execFileSync(
                'git',
                ['-C', repositoryRoot, 'show', `${revision}:${item.path}`],
                { encoding: 'utf8' },
            );
            count =
                content.length === 0
                    ? 0
                    : content.split('\n').length -
                      (content.endsWith('\n') ? 1 : 0);
            lineCounts.set(item.path, count);
        }

        if (item.line < 1 || item.line > count) {
            failures.push(
                `${item.declaredIn}: ${item.path}:${item.line} exceeds ${count} lines`,
            );
        }
    } catch {
        failures.push(
            `${item.declaredIn}: ${item.path}:${item.line} is absent at ${revision}`,
        );
    }
}

if (failures.length > 0) {
    throw new Error(`Invalid source citations:\n${failures.join('\n')}`);
}

console.log(
    `Verified ${citations.length} citations across ${lineCounts.size} files at ${revision}.`,
);
