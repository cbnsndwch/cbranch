import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
if (!tag) throw new Error('Pass the release tag, for example v0.1.0.');

const lines = (await readFile('CHANGELOG.md', 'utf8')).split('\n');
const start = lines.indexOf(`## ${tag}`);
if (start < 0) throw new Error(`CHANGELOG.md has no ${tag} section.`);

const end = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
);
process.stdout.write(
    `${lines
        .slice(start, end < 0 ? undefined : end)
        .join('\n')
        .trim()}\n`,
);
