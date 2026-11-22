import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import fs from 'fs';
import { getGroupDir } from '../../group-dir.js';
import { groupFsTestHooks } from '../../lib/group-fs.js';
import {
  deleteArtifactByPath,
  openArtifactFile,
  openArtifactsRoot,
  openArtifactsRootSync,
  writeArtifactFile,
} from './artifacts.js';

const GROUP = `artifact-mime-test-${process.pid}`;

beforeAll(() => {
  fs.mkdirSync(`${getGroupDir(GROUP)}/artifacts`, { recursive: true });
});

afterAll(() => {
  fs.rmSync(getGroupDir(GROUP), { recursive: true, force: true });
});

describe('artifact file operations', () => {
  test('does not delete through an artifact symlink escaping the root', async () => {
    const outside = `/tmp/artifact-delete-outside-${process.pid}`;
    fs.mkdirSync(outside, { recursive: true });
    const secret = `${outside}/secret.txt`;
    fs.writeFileSync(secret, 'secret');
    fs.symlinkSync(outside, `${getGroupDir(GROUP)}/artifacts/delete-escape`);
    try {
      expect(
        await deleteArtifactByPath(GROUP, 'delete-escape/secret.txt'),
      ).toBe(false);
      expect(fs.readFileSync(secret, 'utf8')).toBe('secret');
    } finally {
      fs.unlinkSync(`${getGroupDir(GROUP)}/artifacts/delete-escape`);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('deletes the exact legal filename without touching its sanitized collision', async () => {
    const root = `${getGroupDir(GROUP)}/artifacts/exact`;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${root}/Q1 draft.pdf`, 'spaced');
    fs.writeFileSync(`${root}/Q1_draft.pdf`, 'underscored');

    expect(await deleteArtifactByPath(GROUP, 'exact/Q1 draft.pdf')).toBe(true);
    expect(fs.existsSync(`${root}/Q1 draft.pdf`)).toBe(false);
    expect(fs.readFileSync(`${root}/Q1_draft.pdf`, 'utf8')).toBe('underscored');
  });

  test('rejects final artifact symlinks without deleting their referent', async () => {
    const root = `${getGroupDir(GROUP)}/artifacts/links`;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${root}/referent.txt`, 'keep');
    fs.symlinkSync('referent.txt', `${root}/alias.txt`);

    expect(await deleteArtifactByPath(GROUP, 'links/alias.txt')).toBe(false);
    expect(fs.readFileSync(`${root}/referent.txt`, 'utf8')).toBe('keep');
  });

  test('refuses writes that traverse a symlink out of the artifacts dir', async () => {
    const base = fs.mkdtempSync(`/tmp/artifact-write-${process.pid}-`);
    const artifacts = `${getGroupDir(GROUP)}/artifacts`;
    const rules = `${base}/b/.claude/rules`;
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(`${base}/b/target.md`, 'keep');
    fs.symlinkSync(rules, `${artifacts}/plans`);
    fs.symlinkSync(`${base}/b/target.md`, `${artifacts}/notes.md`);
    fs.writeFileSync(`${artifacts}/captioned.md`, 'x');
    fs.symlinkSync(
      `${base}/b/sidecar.json`,
      `${artifacts}/captioned.md.meta.json`,
    );
    try {
      await expect(
        writeArtifactFile(GROUP, 'plans/x.md', Buffer.from('evil')),
      ).rejects.toThrow('Artifact path escapes artifacts directory');
      // Leaf links are replaced by the atomic write, never written through.
      await writeArtifactFile(GROUP, 'notes.md', Buffer.from('evil'));
      await writeArtifactFile(GROUP, 'captioned.md', Buffer.from('evil'), {
        caption: 'c',
      });
      expect(fs.lstatSync(`${artifacts}/notes.md`).isFile()).toBe(true);
      expect(fs.readdirSync(rules)).toEqual([]);
      expect(fs.readFileSync(`${base}/b/target.md`, 'utf8')).toBe('keep');
      expect(fs.existsSync(`${base}/b/sidecar.json`)).toBe(false);
      expect(
        await writeArtifactFile(GROUP, 'ok/nested/deep.md', Buffer.from('ok')),
      ).toEqual({
        relPath: 'ok/nested/deep.md',
        url: `/artifacts/${GROUP}/ok/nested/deep.md`,
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('symlinked artifacts root', () => {
  const groupA = `artifact-root-a-${process.pid}`;
  const groupB = `artifact-root-b-${process.pid}`;
  const rulesB = `${getGroupDir(groupB)}/.claude/rules`;
  const artifactsA = `${getGroupDir(groupA)}/artifacts`;

  beforeAll(() => {
    fs.mkdirSync(rulesB, { recursive: true });
    fs.writeFileSync(`${rulesB}/rule.md`, 'keep');
    fs.mkdirSync(getGroupDir(groupA), { recursive: true });
    fs.symlinkSync(rulesB, artifactsA);
  });

  afterAll(() => {
    fs.rmSync(getGroupDir(groupA), { recursive: true, force: true });
    fs.rmSync(getGroupDir(groupB), { recursive: true, force: true });
  });

  test('refuses write, open and delete through the linked root', async () => {
    await expect(
      writeArtifactFile(groupA, 'x.md', Buffer.from('evil')),
    ).rejects.toThrow('Artifact path escapes artifacts directory');
    expect(fs.readdirSync(rulesB)).toEqual(['rule.md']);
    expect(await openArtifactsRoot(groupA)).toBeNull();
    expect(await openArtifactsRoot(groupA, { create: true })).toBeNull();
    expect(openArtifactsRootSync(groupA)).toBeNull();
    expect(await openArtifactFile(groupA, ['rule.md'])).toBeNull();
    expect(await deleteArtifactByPath(groupA, 'rule.md')).toBe(false);
    expect(fs.readFileSync(`${rulesB}/rule.md`, 'utf8')).toBe('keep');
  });

  test('a missing root is null on read and created only on request', async () => {
    const group = `artifact-root-missing-${process.pid}`;
    fs.mkdirSync(getGroupDir(group), { recursive: true });
    try {
      expect(await openArtifactsRoot(group)).toBeNull();
      expect(await openArtifactFile(group, ['a.txt'])).toBeNull();
      expect(fs.existsSync(`${getGroupDir(group)}/artifacts`)).toBe(false);
      const root = await openArtifactsRoot(group, { create: true });
      expect(root).not.toBeNull();
      await root!.close();
      expect(fs.existsSync(`${getGroupDir(group)}/artifacts`)).toBe(true);
    } finally {
      fs.rmSync(getGroupDir(group), { recursive: true, force: true });
    }
  });
});

describe('artifact folder swap race', () => {
  const groupA = `artifact-swap-a-${process.pid}`;
  const groupB = `artifact-swap-b-${process.pid}`;
  const topicA = `${getGroupDir(groupA)}/artifacts/topic`;
  const topicB = `${getGroupDir(groupB)}/artifacts/topic`;

  beforeEach(() => {
    for (const topic of [topicA, topicB]) {
      fs.rmSync(topic, { recursive: true, force: true });
      fs.mkdirSync(topic, { recursive: true });
    }
    fs.writeFileSync(`${topicA}/file.txt`, 'a');
    fs.writeFileSync(`${topicB}/file.txt`, 'b');
  });

  afterEach(() => {
    groupFsTestHooks.beforeOpen = undefined;
  });

  afterAll(() => {
    fs.rmSync(getGroupDir(groupA), { recursive: true, force: true });
    fs.rmSync(getGroupDir(groupB), { recursive: true, force: true });
  });

  /** Replace group A's topic dir by a link to group B's when it is about to be opened. */
  const swapTopicOnce = () => {
    let swapped = false;
    groupFsTestHooks.beforeOpen = (_label, segment) => {
      if (swapped || segment !== 'topic') return;
      swapped = true;
      fs.rmSync(topicA, { recursive: true, force: true });
      fs.symlinkSync(topicB, topicA);
    };
  };

  test('writeArtifactFile refuses a topic dir swapped to another group', async () => {
    swapTopicOnce();
    await expect(
      writeArtifactFile(groupA, 'topic/file.txt', Buffer.from('evil'), {
        caption: 'c',
      }),
    ).rejects.toThrow('Artifact path escapes artifacts directory');
    expect(fs.readdirSync(topicB)).toEqual(['file.txt']);
    expect(fs.readFileSync(`${topicB}/file.txt`, 'utf8')).toBe('b');
  });

  test('deleteArtifactByPath refuses a topic dir swapped to another group', async () => {
    swapTopicOnce();
    expect(await deleteArtifactByPath(groupA, 'topic/file.txt')).toBe(false);
    expect(fs.readFileSync(`${topicB}/file.txt`, 'utf8')).toBe('b');
  });

  test('writeArtifactFile replaces a planted leaf link instead of writing through it', async () => {
    fs.rmSync(`${topicA}/file.txt`);
    fs.symlinkSync(`${topicB}/file.txt`, `${topicA}/file.txt`);
    await writeArtifactFile(groupA, 'topic/file.txt', Buffer.from('new'));
    expect(fs.readFileSync(`${topicB}/file.txt`, 'utf8')).toBe('b');
    expect(fs.lstatSync(`${topicA}/file.txt`).isFile()).toBe(true);
    expect(fs.readFileSync(`${topicA}/file.txt`, 'utf8')).toBe('new');
  });
});
