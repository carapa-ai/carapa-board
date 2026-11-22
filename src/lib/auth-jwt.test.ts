import { afterAll, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-jwt-'));
const modulePath = path.join(import.meta.dir, 'auth-jwt.ts');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function run(dataRoot: string, code: string, encryptionKey?: string) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    CARAPA_DATA_DIR: dataRoot,
    LOG_LEVEL: 'silent',
  };
  if (encryptionKey) env.CARAPA_BOARD_ENCRYPTION_KEY = encryptionKey;
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `const m = await import(${JSON.stringify(modulePath)}); ${code}`,
    ],
    { env, cwd: path.dirname(path.dirname(import.meta.dir)) },
  );
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString().trim();
}

function forge(secret: string): string {
  const enc = (v: object) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    type: 'user',
    sub: 'attacker',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

describe('auth-jwt secret resolution', () => {
  it('uses the raw env key and verifies its own tokens', () => {
    const out = run(
      path.join(root, 'env'),
      `console.log(JSON.stringify(m.verifyJwt(m.signUserJwt('u1'))?.sub))`,
      'env-secret',
    );
    expect(out).toBe('"u1"');
    expect(fs.existsSync(path.join(root, 'env', 'data', '.jwt-secret'))).toBe(
      false,
    );
  });

  it('persists a generated secret across reloads and rejects the old default', () => {
    const dataRoot = path.join(root, 'fallback');
    const token = run(dataRoot, `console.log(m.signUserJwt('u2'))`);
    const secretPath = path.join(dataRoot, 'data', '.jwt-secret');
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    const reloaded = run(
      dataRoot,
      `console.log(m.verifyJwt(${JSON.stringify(token)})?.sub)`,
    );
    expect(reloaded).toBe('u2');
    const legacy = forge(
      ['default', 'jwt', 'secret-key-32-chars-long-at-least'].join('-'),
    );
    expect(
      run(dataRoot, `console.log(m.verifyJwt(${JSON.stringify(legacy)}))`),
    ).toBe('null');
  });
});
