import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { startManagedOpenCodeServer } from './managed-opencode.js';

const directories: string[] = [];

const fixture = async (
    source: string,
): Promise<{
    readonly directory: string;
    readonly executable: string;
}> => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-opencode-'));
    directories.push(directory);
    const executable = join(directory, 'opencode-fixture');
    await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, {
        mode: 0o700,
    });
    await chmod(executable, 0o700);
    return { directory, executable };
};

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

describe('managed OpenCode server', () => {
    test('starts on loopback without a shell and closes the child', async () => {
        const { directory, executable } = await fixture(`
import { writeFileSync } from "node:fs";
writeFileSync(new URL("argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
process.on("SIGTERM", () => process.exit(0));
console.log("opencode server listening on http://127.0.0.1:43123");
setInterval(() => {}, 1000);
`);

        const server = await startManagedOpenCodeServer({
            executablePath: executable,
            workspace: directory,
        });
        expect(server.url).toBe('http://127.0.0.1:43123/');
        expect(
            JSON.parse(await readFile(join(directory, 'argv.json'), 'utf8')),
        ).toEqual([
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            '0',
            '--print-logs',
        ]);

        await server.close();
        await expect(server.exited).resolves.toMatchObject({ code: 0 });
    });

    test('reports bounded startup failure and reaps the child', async () => {
        const { directory, executable } = await fixture(`
process.stderr.write("fixture failed\\n");
process.exit(7);
`);

        await expect(
            startManagedOpenCodeServer({
                executablePath: executable,
                workspace: directory,
            }),
        ).rejects.toThrow('fixture failed');
    });

    test('observes direct-child exit even while a descendant holds output pipes', async () => {
        const { directory, executable } = await fixture(`
import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
console.log("opencode server listening on http://127.0.0.1:43124");
setTimeout(() => process.exit(0), 25);
`);

        const server = await startManagedOpenCodeServer({
            executablePath: executable,
            workspace: directory,
        });

        await expect(
            Promise.race([
                server.exited,
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error('direct child exit timed out')),
                        500,
                    ),
                ),
            ]),
        ).resolves.toMatchObject({ code: 0 });
    });
});
