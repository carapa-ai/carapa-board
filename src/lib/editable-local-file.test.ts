import { afterEach, describe, expect, it } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  EDITABLE_TEXT_MAX_BYTES,
  EditableFileError,
  isSensitiveFilePath,
  loadEditableLocalFile,
  replaceEditableLocalFile,
} from './editable-local-file.js';
import { REQUEST_LOG_REDACT_PATHS } from '../logger.js';

const roots: string[] = [];
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'carapa-edit-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

describe('editable local files', () => {
  it('loads exact UTF-8 bytes with source, normalized path, revision and sensitivity', async () => {
    const root = await fixture();
    await fsp.writeFile(path.join(root, '.env.local'), 'TOKEN=héllo\n');
    const file = await loadEditableLocalFile(root, './.env.local', 'group');
    expect(file).toMatchObject({
      source: 'group',
      path: '.env.local',
      content: 'TOKEN=héllo\n',
      mimetype: 'text/plain',
      sensitive: true,
    });
    expect(file.size).toBe(Buffer.byteLength(file.content));
    expect(file.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('atomically replaces matching content while preserving mode', async () => {
    const root = await fixture();
    const target = path.join(root, 'notes.txt');
    await fsp.writeFile(target, 'before');
    await fsp.chmod(target, 0o640);
    const loaded = await loadEditableLocalFile(root, 'notes.txt', 'group');
    const saved = await replaceEditableLocalFile(
      root,
      'notes.txt',
      'group',
      'after ✓',
      loaded.revision,
    );
    expect(await fsp.readFile(target, 'utf8')).toBe('after ✓');
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o640);
    expect(saved.size).toBe(Buffer.byteLength('after ✓'));
    expect(
      (await fsp.readdir(root)).filter((name) => name.includes('.carapa-')),
    ).toEqual([]);
  });

  it('returns metadata-only conflict and leaves a stale target unchanged', async () => {
    const root = await fixture();
    const target = path.join(root, 'notes.txt');
    await fsp.writeFile(target, 'first');
    const loaded = await loadEditableLocalFile(root, 'notes.txt', 'group');
    await fsp.writeFile(target, 'someone else');
    let error: EditableFileError | undefined;
    try {
      await replaceEditableLocalFile(
        root,
        'notes.txt',
        'group',
        'my draft',
        loaded.revision,
      );
    } catch (cause) {
      error = cause as EditableFileError;
    }
    expect(error?.status).toBe(409);
    expect(error?.stale).toEqual({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: 12,
    });
    expect(JSON.stringify(error?.stale)).not.toContain('someone else');
    expect(await fsp.readFile(target, 'utf8')).toBe('someone else');
  });

  it('rejects runtime paths, managed artifacts, symlinks, binary and oversized files', async () => {
    const root = await fixture();
    await fsp.mkdir(path.join(root, 'logs'));
    await fsp.mkdir(path.join(root, '.git'));
    await fsp.mkdir(path.join(root, 'node_modules'));
    await fsp.mkdir(path.join(root, 'nested', '.git'), { recursive: true });
    await fsp.mkdir(path.join(root, 'nested', 'node_modules'), {
      recursive: true,
    });
    await fsp.mkdir(path.join(root, '.agent'));
    await fsp.mkdir(path.join(root, 'nested', '.runtime'), {
      recursive: true,
    });
    await fsp.writeFile(path.join(root, 'logs', 'run.log'), 'secret');
    await fsp.writeFile(path.join(root, '.git', 'config'), 'secret');
    await fsp.writeFile(
      path.join(root, 'node_modules', 'package.js'),
      'secret',
    );
    await fsp.writeFile(path.join(root, 'nested', '.git', 'config'), 'secret');
    await fsp.writeFile(
      path.join(root, 'nested', 'node_modules', 'package.js'),
      'secret',
    );
    await fsp.writeFile(path.join(root, '.agent', 'rules.md'), 'managed');
    await fsp.writeFile(
      path.join(root, 'nested', '.runtime', 'state.txt'),
      'managed',
    );
    await fsp.writeFile(path.join(root, 'nested', '.env'), 'TOKEN=value');
    await fsp.writeFile(path.join(root, 'file.meta.json'), '{}');
    await fsp.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 1, 2]));
    await fsp.writeFile(
      path.join(root, 'large.txt'),
      Buffer.alloc(EDITABLE_TEXT_MAX_BYTES + 1, 65),
    );
    await fsp.symlink(
      path.join(root, 'binary.txt'),
      path.join(root, 'link.txt'),
    );
    for (const [file, source, status] of [
      ['logs/run.log', 'group', 403],
      ['.git/config', 'group', 403],
      ['node_modules/package.js', 'group', 403],
      ['nested/.git/config', 'group', 403],
      ['nested/node_modules/package.js', 'group', 403],
      ['.agent/rules.md', 'group', 403],
      ['nested/.runtime/state.txt', 'group', 403],
      ['artifacts/file.txt', 'group', 403],
      ['file.meta.json', 'artifact', 403],
      ['link.txt', 'group', 400],
      ['binary.txt', 'group', 415],
      ['large.txt', 'group', 413],
    ] as const) {
      await expect(
        loadEditableLocalFile(root, file, source),
      ).rejects.toMatchObject({ status });
    }
    expect(
      (await loadEditableLocalFile(root, 'nested/.env', 'group')).sensitive,
    ).toBe(true);
  });

  it('rejects malformed UTF-8 without exposing or replacing altered text', async () => {
    const root = await fixture();
    const target = path.join(root, 'invalid.txt');
    const malformed = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
    await fsp.writeFile(target, malformed);

    await expect(
      loadEditableLocalFile(root, 'invalid.txt', 'group'),
    ).rejects.toMatchObject({ status: 415 });
    expect(await fsp.readFile(target)).toEqual(malformed);
  });

  it('serializes simultaneous compare-and-swap replacements per target', async () => {
    const root = await fixture();
    const target = path.join(root, 'notes.txt');
    await fsp.writeFile(target, 'before');
    const loaded = await loadEditableLocalFile(root, 'notes.txt', 'group');
    const results = await Promise.allSettled([
      replaceEditableLocalFile(
        root,
        'notes.txt',
        'group',
        'first writer',
        loaded.revision,
      ),
      replaceEditableLocalFile(
        root,
        'notes.txt',
        'group',
        'second writer',
        loaded.revision,
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(['first writer', 'second writer']).toContain(
      await fsp.readFile(target, 'utf8'),
    );
  });

  it('does not overwrite an external modification at the replacement boundary', async () => {
    const root = await fixture();
    const target = path.join(root, 'notes.txt');
    await fsp.writeFile(target, 'before');
    const loaded = await loadEditableLocalFile(root, 'notes.txt', 'group');

    await expect(
      replaceEditableLocalFile(
        root,
        'notes.txt',
        'group',
        'replacement',
        loaded.revision,
        {
          beforeFinalRevalidation: () =>
            fsp.writeFile(target, 'external writer'),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fsp.readFile(target, 'utf8')).toBe('external writer');
  });

  it('does not recreate a target deleted at the replacement boundary', async () => {
    const root = await fixture();
    const target = path.join(root, 'notes.txt');
    await fsp.writeFile(target, 'before');
    const loaded = await loadEditableLocalFile(root, 'notes.txt', 'group');

    await expect(
      replaceEditableLocalFile(
        root,
        'notes.txt',
        'group',
        'replacement',
        loaded.revision,
        { beforeFinalRevalidation: () => fsp.unlink(target) },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(fsp.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('classifies common credential names conservatively', () => {
    expect(isSensitiveFilePath('config/.env.production')).toBe(true);
    expect(isSensitiveFilePath('service-credentials.json')).toBe(true);
    expect(isSensitiveFilePath('tls/private_key.pem')).toBe(true);
    expect(isSensitiveFilePath('.npmrc')).toBe(true);
    expect(isSensitiveFilePath('config/.pypirc')).toBe(true);
    expect(isSensitiveFilePath('.netrc')).toBe(true);
    expect(isSensitiveFilePath('.ssh/id_rsa')).toBe(true);
    expect(isSensitiveFilePath('.ssh/id_ed25519.pub')).toBe(true);
    expect(isSensitiveFilePath('notes.md')).toBe(false);
  });

  it('registers editable content for request-log redaction', () => {
    expect(REQUEST_LOG_REDACT_PATHS).toContain('req.body.content');
    expect(REQUEST_LOG_REDACT_PATHS).toContain('body.content');
  });
});
