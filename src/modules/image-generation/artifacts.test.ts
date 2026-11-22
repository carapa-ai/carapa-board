import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as stateManager from '../../state-manager.js';
import fs from 'fs';

import { getGroupDir } from '../../group-dir.js';
import { writeArtifactFile } from '../chat/artifacts.js';
import { readThumbnailSource } from '../knowledge/thumbnail-source.js';
import {
  extractGeneratedImageArtifacts,
  filterTrustedGeneratedArtifacts,
  type GeneratedImageArtifact,
} from './artifacts.js';

const envelope = {
  type: 'generated_image_artifact',
  artifact: {
    provider: 'openai-codex',
    model: 'gpt-image-2',
    mimetype: 'image/png',
    filename: 'result.png',
    relPath: 'images/result.png',
    containerPath: '/workspace/group/artifacts/images/result.png',
    browserUrl: '/artifacts/demo/images/result.png',
  },
};

describe('generated image artifact extraction', () => {
  test('extracts nested MCP output and JSONL without duplicating artifacts', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
      },
    });

    const artifacts = extractGeneratedImageArtifacts(`${line}\n${line}\n`);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].relPath).toBe('images/result.png');
  });

  test('ignores ordinary tool prose and malformed envelopes', () => {
    expect(extractGeneratedImageArtifacts('generation complete')).toEqual([]);
    expect(
      extractGeneratedImageArtifacts(
        JSON.stringify({ ...envelope, artifact: { filename: 'x.png' } }),
      ),
    ).toEqual([]);
  });
});

describe('trusted generated image artifacts', () => {
  const group = `generated-artifact-trust-${process.pid}`;
  const genuine = {
    ...envelope.artifact,
    containerPath: '/workspace/group/artifacts/images/result.png',
    browserUrl: `/artifacts/${group}/images/result.png`,
  } as GeneratedImageArtifact;
  const trusted = (overrides: Partial<typeof genuine>) =>
    filterTrustedGeneratedArtifacts([{ ...genuine, ...overrides }], group);

  let lookup: ReturnType<typeof spyOn>;
  beforeAll(async () => {
    lookup = spyOn(stateManager, 'getGroupByFolder').mockReturnValue({
      folder: group,
    } as any);
    await writeArtifactFile(group, 'images/result.png', Buffer.from('png'));
  });
  afterAll(() => {
    lookup.mockRestore();
    fs.rmSync(getGroupDir(group), { recursive: true, force: true });
  });

  test('accepts the envelope the image tool emits for an existing file', () => {
    expect(trusted({})).toHaveLength(1);
  });

  test.each([
    ['absolute foreign URL', { browserUrl: 'https://attacker.example/p.png' }],
    ['protocol-relative URL', { browserUrl: '//attacker.example/p.png' }],
    ['foreign folder', { browserUrl: '/artifacts/other/images/result.png' }],
    [
      'traversing relPath',
      {
        relPath: 'images/../../x',
        browserUrl: `/artifacts/${group}/images/../../x`,
        containerPath: '/workspace/group/artifacts/images/../../x',
      },
    ],
    ['mismatched containerPath', { containerPath: '/x' }],
    [
      'missing file',
      {
        relPath: 'images/missing.png',
        browserUrl: `/artifacts/${group}/images/missing.png`,
        containerPath: '/workspace/group/artifacts/images/missing.png',
      },
    ],
  ])('rejects %s', (_name, overrides) => {
    expect(trusted(overrides)).toEqual([]);
  });
});

describe('generated image artifacts under a symlinked root', () => {
  const group = `generated-artifact-root-${process.pid}`;
  const other = `${getGroupDir(group)}/other`;

  let lookup: ReturnType<typeof spyOn>;
  beforeAll(() => {
    lookup = spyOn(stateManager, 'getGroupByFolder').mockReturnValue({
      folder: group,
    } as any);
    fs.mkdirSync(`${other}/images`, { recursive: true });
    fs.writeFileSync(`${other}/images/result.png`, 'png');
    fs.symlinkSync(other, `${getGroupDir(group)}/artifacts`);
  });
  afterAll(() => {
    lookup.mockRestore();
    fs.rmSync(getGroupDir(group), { recursive: true, force: true });
  });

  test('does not trust an artifact reached through the linked root', () => {
    const artifact = {
      ...envelope.artifact,
      containerPath: '/workspace/group/artifacts/images/result.png',
      browserUrl: `/artifacts/${group}/images/result.png`,
    } as GeneratedImageArtifact;
    expect(filterTrustedGeneratedArtifacts([artifact], group)).toEqual([]);
  });

  test('refuses to read a thumbnail source through the linked root', async () => {
    await expect(
      readThumbnailSource(group, 'artifacts/images/result.png'),
    ).rejects.toThrow(
      'Thumbnail source is missing or outside project artifacts',
    );
  });
});
