import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let fixtureRoot = '';
let secretsDir = '';

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-secrets-'));
  secretsDir = path.join(fixtureRoot, 'secrets');
  await fs.mkdir(secretsDir);
  await fs.writeFile(path.join(secretsDir, 'file_secret'), ' file value\n');
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe('readSecret', () => {
  test('prefers a trimmed file secret and falls back to the environment', async () => {
    const script = `
      import { createSecretReader } from './src/lib/env.ts';
      const readSecret = createSecretReader();
      console.log(JSON.stringify({
        fromFile: readSecret('FILE_SECRET'),
        fromEnvironment: readSecret('ENV_ONLY'),
      }));
    `;
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', '--eval', script],
      {
        cwd: process.cwd(),
        env: {
          SECRETS_DIR: secretsDir,
          FILE_SECRET: 'environment value',
          ENV_ONLY: 'environment only',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      fromFile: 'file value',
      fromEnvironment: 'environment only',
    });
  });

  test('preserves the startup secret directory before loading .env', async () => {
    const dotenvSecretsDir = path.join(fixtureRoot, 'dotenv-secrets');
    await fs.mkdir(dotenvSecretsDir);
    await fs.writeFile(
      path.join(dotenvSecretsDir, 'carapa_box_api_token'),
      'file-token\n',
    );
    await fs.writeFile(
      path.join(fixtureRoot, '.env'),
      `SECRETS_DIR=${dotenvSecretsDir}\nCARAPA_BOX_API_TOKEN=env-token\n`,
    );

    const configUrl = pathToFileURL(path.resolve('src/config.ts')).href;
    const script = `
      const config = await import(${JSON.stringify(configUrl)});
      console.log(JSON.stringify(config.CARAPA_BOX_API_TOKEN));
    `;
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', '--eval', script],
      {
        cwd: fixtureRoot,
        env: { HOME: fixtureRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toBe('env-token');
  });
});
