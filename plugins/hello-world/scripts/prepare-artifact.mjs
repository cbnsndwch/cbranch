import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
if (process.env.PLUGIN_PUBLISHER_FINGERPRINT)
    manifest.publisherFingerprint = process.env.PLUGIN_PUBLISHER_FINGERPRINT;
await writeFile('dist/plugin.json', `${JSON.stringify(manifest)}\n`);
