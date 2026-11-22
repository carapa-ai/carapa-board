import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { listTranscriptFiles } from './reader-core.js';
import { runCli } from './transcripts-cli.js';

const FIXTURES = path.join(
  import.meta.dir,
  'fixtures/transcripts-reader/shared',
);

/** Minimal ustar writer so member names can be hostile (system tar refuses). */
function tarGz(members: Array<{ name: string; body: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const m of members) {
    const body = Buffer.from(m.body);
    const header = Buffer.alloc(512);
    header.write(m.name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write(
      (Date.UTC(2026, 2, 9) / 1000).toString(8).padStart(11, '0') + '\0',
      136,
    );
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

describe('transcripts reader and skill CLI', () => {
  let root: string;
  let transcripts: string;
  let env: Record<string, string>;
  const run = (...args: string[]) => runCli(args, env).stdout;
  const json = (...args: string[]) => JSON.parse(run(...args, '--json'));

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-reader-'));
    transcripts = path.join(root, 'transcripts');
    fs.cpSync(FIXTURES, transcripts, { recursive: true });
    for (const name of fs.readdirSync(transcripts)) {
      const day = name.slice(0, 10);
      const t = new Date(`${day}T12:00:00Z`);
      fs.utimesSync(path.join(transcripts, name), t, t);
    }
    fs.mkdirSync(path.join(transcripts, 'archive'));
    fs.writeFileSync(
      path.join(transcripts, 'archive', '2026-03-09.tar.gz'),
      tarGz([
        {
          name: '2026-03-09-chat-conv-1773000000000-old111.output.jsonl',
          body:
            JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: 'archived needle one',
              agent_name: 'claude',
            }) + '\n',
        },
        {
          name: '../evil.jsonl',
          body:
            JSON.stringify({ role: 'user', content: 'archived needle two' }) +
            '\n',
        },
        {
          name: '-x.jsonl',
          body:
            JSON.stringify({ role: 'user', content: 'archived needle three' }) +
            '\n',
        },
      ]),
    );
    env = { TRANSCRIPTS_GROUP_ROOT: root };
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('shared layout counts task .jsonl and chat .output.jsonl together', () => {
    const summary = json('summary');
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      group: 'shared',
      transcripts: 4,
    });
    expect(summary.groups[0].agents).toContain('claude:claude-opus-5-5');
    expect(summary.groups[0].agents).toContain('claude-sonnet-5');
  });

  test('current, task and legacy dialects normalise; non-message entries are skipped', () => {
    const chat = run('show', 'shared', 'conv-1790100000000');
    expect(chat).toContain('USER: Why is the kanban board slow?');
    expect(chat).toContain(
      'ASSISTANT (claude:claude-opus-5-5): The board is slow',
    );
    expect(chat).toContain('(2 messages)');
    expect(run('show', 'shared', 'task-1790000000000')).toContain(
      'Patched the scheduler test.',
    );
    // A task's raw output file has its own id and is not picked by the task id.
    const ids = json('list', 'shared').transcripts.map((t: any) => t.id);
    expect(ids).toContain('2026-10-01-task-1790000000000-aaaaaa.output');
    expect(new Set(ids).size).toBe(ids.length);
    expect(run('show', 'shared', 'task-1790000000000-aaaaaa.output')).toContain(
      'raw run output for scheduler',
    );
    const legacy = run('show', 'shared', 'conv-1790200000000');
    expect(legacy).toContain('ASSISTANT (claude-sonnet-5): Legacy answer.');
    expect(legacy).not.toContain('hmm');
  });

  test('board-injected context is stripped from user messages', () => {
    const chat = run('show', 'shared', 'conv-1790100000000', '--full');
    for (const hidden of [
      'AGENT_CONTEXT',
      'hidden',
      'CHANNEL',
      'INSTRUCTION',
      'Shared browser',
    ]) {
      expect(chat).not.toContain(hidden);
    }
  });

  test('tool calls are hidden by default and shown with --tools', () => {
    const chat = run('show', 'shared', 'conv-1790100000000');
    expect(chat).not.toContain('TOOL');
    expect(chat).toContain('[1 tool call; --tools shows them]');
    expect(json('show', 'shared', 'conv-1790100000000').hiddenToolCalls).toBe(
      1,
    );
    const withTools = run('show', 'shared', 'conv-1790100000000', '--tools');
    expect(withTools).toContain('TOOL #1 Bash: grep -rn slowpath src → 10 B');
    expect(withTools).toContain('(3 messages)');
    expect(run('show', 'shared', 'conv-1790200000000', '--tools')).toContain(
      'TOOL #1 Read: /tmp/legacy.txt',
    );
  });

  test('--full keeps tool inputs whole; the last agent reply is never truncated', () => {
    const dir = path.join(root, 'long', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const longInput = `${'x'.repeat(300)} INPUT_END`;
    const earlyReply = `${'e'.repeat(300)} EARLY_END`;
    const finalReply = `${'f'.repeat(300)} FINAL_END`;
    const lines = [
      { type: 'message', role: 'user', content: 'go' },
      { type: 'message', role: 'assistant', content: earlyReply },
      {
        type: 'tool_call',
        status: 'started',
        name: 'create_cronjob',
        input: { title: 'Weekly', description: longInput },
      },
      {
        type: 'tool_call',
        status: 'failed',
        name: 'Bash',
        error: { message: `${'z'.repeat(120)} ERR_END` },
      },
      { type: 'message', role: 'assistant', content: finalReply },
    ];
    fs.writeFileSync(
      path.join(dir, '2026-10-04-chat-conv-1790300000000-dddddd.output.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );

    const brief = run('show', 'long', 'conv-1790300000000');
    expect(brief).toContain('FINAL_END');
    expect(brief).not.toContain('EARLY_END');
    expect(brief).toContain('[2 tool calls; --tools shows them]');
    expect(run('show', 'long', 'conv-1790300000000', '--tools')).not.toContain(
      'INPUT_END',
    );
    expect(
      json('show', 'long', 'conv-1790300000000').messages.at(-1).content,
    ).toContain('FINAL_END');

    const full = run('show', 'long', 'conv-1790300000000', '--full', '--tools');
    expect(full).toContain('EARLY_END');
    expect(full).toContain('"title":"Weekly"');
    expect(full).toContain('INPUT_END');
    expect(run('result', 'long', 'conv-1790300000000', '2')).toContain(
      'ERR_END',
    );

    // --last counts visible messages only; hidden tool calls stay summarised.
    const tail = run('show', 'long', 'conv-1790300000000', '--last', '1');
    expect(tail).toContain('(1 messages)');
    expect(tail).not.toContain('tool call');
    fs.rmSync(path.join(root, 'long'), { recursive: true, force: true });
  });

  test('result returns one numbered call with its whole output, in every dialect', () => {
    const dir = path.join(root, 'res', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, lines: unknown[]) =>
      fs.writeFileSync(
        path.join(dir, name),
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
    const bigOutput = `${'o'.repeat(5000)} OUT_END`;
    write('2026-10-05-chat-conv-1790400000000-eeeeee.output.jsonl', [
      { type: 'message', role: 'user', content: 'go' },
      {
        type: 'tool_call',
        id: 'a',
        status: 'started',
        name: 'Bash',
        input: { command: 'ls' },
      },
      {
        type: 'tool_call',
        id: 'a',
        status: 'completed',
        name: 'Bash',
        output: bigOutput,
      },
      {
        type: 'tool_call',
        id: 'b',
        status: 'started',
        name: 'Read',
        input: { file_path: '/x' },
      },
      {
        type: 'tool_call',
        id: 'b',
        status: 'failed',
        name: 'Read',
        error: { message: 'ENOENT /x' },
      },
      { type: 'message', role: 'assistant', content: 'done' },
    ]);
    // MCP tools return {content: [blocks], structuredContent, _meta}.
    write('2026-10-05-chat-conv-1790800000000-iiiiii.output.jsonl', [
      {
        type: 'tool_call',
        id: 'm',
        status: 'started',
        name: 'board/get_cronjob',
        input: { cronjob_id: 'c1' },
      },
      {
        type: 'tool_call',
        id: 'm',
        status: 'completed',
        name: 'board/get_cronjob',
        output: {
          content: [{ type: 'text', text: '{"title":"Weekly"}' }],
          structuredContent: { title: 'Weekly' },
          _meta: {},
        },
      },
    ]);
    // Legacy provider output: results arrive as user tool_result blocks.
    write('2026-10-05-chat-conv-1790500000000-ffffff.output.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'Grep',
              input: { pattern: 'x' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [{ type: 'text', text: 'LEGACY_OUT' }],
            },
          ],
        },
      },
    ]);
    // opencode logs the same part while running and when it finishes.
    write('2026-10-05-chat-conv-1790600000000-gggggg.output.jsonl', [
      {
        type: 'tool_use',
        part: {
          id: 'p1',
          tool: 'ripgrep',
          state: { status: 'running', input: { query: 'q' } },
        },
      },
      {
        type: 'tool_use',
        part: {
          id: 'p1',
          tool: 'ripgrep',
          state: { status: 'error', input: { query: 'q' }, output: 'OC_ERR' },
        },
      },
    ]);

    // Search numbers tool hits like show, so `result` can follow directly.
    const hit = json('search', 'ENOENT', '--group', 'res', '--tools');
    expect(hit.total).toBe(0);
    const tool = json('search', '/x', '--group', 'res', '--tools').results;
    expect(tool).toHaveLength(1);
    expect(tool[0].message).toMatchObject({ toolNo: 2 });
    expect(run('search', 'ls', '--group', 'res', '--tools')).toContain(
      'TOOL #1 Bash: ls → 4.9 KB',
    );

    const listing = run('show', 'res', 'conv-1790400000000', '--tools');
    expect(listing).toContain('TOOL #1 Bash: ls → 4.9 KB');
    expect(listing).toContain('TOOL #2 Read: /x → failed: ENOENT /x');
    expect(listing).not.toContain('OUT_END');
    expect(
      json('show', 'res', 'conv-1790400000000', '--tools').messages[1],
    ).not.toHaveProperty('result');

    const one = run('result', 'conv-1790400000000', '1');
    expect(one).toContain('"command": "ls"');
    expect(one).toContain('Result (ok, 5008 bytes)');
    expect(one).toContain('OUT_END');
    const cut = json(
      'result',
      'res',
      'conv-1790400000000',
      '1',
      '--max-bytes',
      '100',
    );
    expect(cut.result).toMatchObject({ truncated: true, bytes: 5008 });
    expect(cut.result.text).toHaveLength(100);
    expect(run('result', 'conv-1790400000000', '2')).toContain(
      'Result (failed, 9 bytes):\nENOENT /x',
    );
    expect(run('result', 'conv-1790400000000', '3')).toContain(
      'Tool call #3 not found',
    );

    expect(run('result', 'conv-1790500000000', '1')).toContain('LEGACY_OUT');
    const mcp = json('result', 'conv-1790800000000', '1').result;
    expect(mcp.text).toBe('{"title":"Weekly"}');
    const oc = run('show', 'res', 'conv-1790600000000', '--tools');
    expect(oc).toContain('TOOL #1 ripgrep: q → failed: OC_ERR');
    expect(oc).not.toContain('#2');
    expect(run('result', 'conv-1790600000000', '1')).toContain('OC_ERR');
    fs.rmSync(path.join(root, 'res'), { recursive: true, force: true });
  });

  test('result --max-bytes never splits a character and prefers a word break', () => {
    const dir = path.join(root, 'cut', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const outputs = [
      // 'é' is 2 bytes and straddles the 100-byte limit.
      `${'a'.repeat(99)}é${'z'.repeat(20)}`,
      // A word break in the second half of the limit is used.
      `${'w'.repeat(60)} ${'x'.repeat(60)}`,
      // A break in the first half would lose too much: the full limit is kept.
      `${'w'.repeat(10)} ${'x'.repeat(200)}`,
    ];
    const lines = outputs.flatMap((output, i) => [
      {
        type: 'tool_call',
        id: `c${i}`,
        status: 'started',
        name: 'Bash',
        input: { command: 'x' },
      },
      {
        type: 'tool_call',
        id: `c${i}`,
        status: 'completed',
        name: 'Bash',
        output,
      },
    ]);
    fs.writeFileSync(
      path.join(dir, '2026-10-06-chat-conv-1790700000000-hhhhhh.output.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const cut = (n: string) =>
      json('result', 'conv-1790700000000', n, '--max-bytes', '100').result;

    expect(cut('1').text).toBe('a'.repeat(99));
    expect(
      run('result', 'conv-1790700000000', '1', '--max-bytes', '100'),
    ).toContain('[truncated: first 99 of 121 bytes');
    expect(cut('2').text).toBe('w'.repeat(60));
    expect(cut('3').text).toBe(`${'w'.repeat(10)} ${'x'.repeat(89)}`);
    expect(cut('3').truncated).toBe(true);
    fs.rmSync(path.join(root, 'cut'), { recursive: true, force: true });
  });

  test('archives are read only with --archive, member names are data, nothing is written', () => {
    const before = fs.readdirSync(root).sort();
    const beforeTranscripts = fs.readdirSync(transcripts).sort();
    expect(run('search', 'archived needle')).toContain('No results');
    const hits = json('search', 'archived needle', '--archive');
    expect(hits.total).toBe(3);
    expect(hits.results.map((r: any) => r.id).sort()).toEqual(
      ['-x', '../evil', '2026-03-09-chat-conv-1773000000000-old111'].sort(),
    );
    expect(hits.results.every((r: any) => r.archived)).toBe(true);
    expect(run('show', 'shared', 'conv-1773000000000', '--archive')).toContain(
      'archived needle one',
    );
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readdirSync(transcripts).sort()).toEqual(beforeTranscripts);
    expect(fs.existsSync(path.join(root, 'evil.jsonl'))).toBe(false);
    expect(run('show', 'shared', 'conv-1773000000000')).toContain(
      'pass --archive',
    );
  });

  test('--since filters files and messages and pulls in archives when it predates live files', () => {
    expect(
      json('list', 'shared', '--since', '2026-10-02').transcripts,
    ).toHaveLength(2);
    expect(json('search', 'needle', '--since', '2026-01-01').total).toBe(3);
    expect(run('summary', '--since', 'yesterday')).toContain(
      'expected YYYY-MM-DD',
    );
  });

  test('--role and --limit constrain search and report the total', () => {
    const assistant = json('search', 'slow', '--role', 'assistant');
    expect(assistant.total).toBe(1);
    expect(assistant.results[0].message.role).toBe('assistant');
    expect(
      json('search', 'slow', '--role', 'user').results[0].message.role,
    ).toBe('user');
    const limited = json('search', 'the', '--limit', '1');
    expect(limited.shown).toBe(1);
    expect(limited.total).toBeGreaterThan(1);
    expect(run('search', 'the', '--limit', '1')).toContain(
      `of ${limited.total} matches`,
    );
  });

  test('search ORs several terms in one pass and reports per-term counts', () => {
    const terms = ['scheduler', 'legacy', 'zzz-absent'];
    const multi = json('search', ...terms);
    expect(multi.query).toBe('scheduler | legacy | zzz-absent');
    expect(multi.terms).toEqual(terms);
    expect(multi.termTotals).toEqual({
      scheduler: 3,
      legacy: 2,
      'zzz-absent': 0,
    });
    // The union of the single-term searches, without duplicates.
    const key = (r: any) => JSON.stringify([r.group, r.id, r.message]);
    const union = new Set(
      terms.flatMap((t) => json('search', t).results.map(key)),
    );
    expect(multi.total).toBe(5);
    expect(multi.shown).toBe(multi.total);
    expect(union.size).toBe(multi.total);
    expect(multi.results.map(key).sort()).toEqual([...union].sort());
    const text = run('search', ...terms);
    expect(text).toContain(
      "=== Search results for 'scheduler' | 'legacy' | 'zzz-absent' (5 matches) ===",
    );
    expect(text).toContain('Per term: scheduler 3, legacy 2, zzz-absent 0');
    // Case-insensitive duplicates collapse to one term; single-term output
    // keeps its exact shape (no per-term line, no extra JSON fields).
    const dup = json('search', 'scheduler', 'SCHEDULER');
    expect(dup.total).toBe(3);
    expect(dup).not.toHaveProperty('terms');
    expect(run('search', 'scheduler', 'SCHEDULER')).not.toContain('Per term');
    const single = json('search', 'scheduler');
    expect(single.query).toBe('scheduler');
    expect(single).not.toHaveProperty('terms');
    expect(single).not.toHaveProperty('termTotals');
    expect(run('search', 'scheduler')).toContain(
      "=== Search results for 'scheduler' (3 matches) ===",
    );
  });
});

describe('transcripts reader resolves run IDs', () => {
  const RUN_1 = 'run-1794310440319-luklh9';
  const RUN_2 = 'run-1794310999999-abc123';
  const EPOCH_2 = 1794310999999;
  let root: string;
  const run = (...args: string[]) =>
    runCli(args, { TRANSCRIPTS_GROUP_ROOT: root }).stdout;
  const json = (...args: string[]) => JSON.parse(run(...args, '--json'));

  const write = (
    group: string,
    name: string,
    lines: unknown[],
    mtimeMs: number,
  ) => {
    const dir = path.join(root, group, 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };
  const start = (run_id: string) => ({
    role: 'system',
    entry_type: 'run_start',
    run_id,
    content: '',
  });
  const msg = (role: string, content: string) => ({ role, content });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-runid-'));
    // Old file name, newer mtime: a re-run appended to the original file.
    write(
      'alpha',
      '2026-03-13-task-1773414486309-gv7eg5.jsonl',
      [
        msg('user', 'first prompt'),
        start(RUN_1),
        msg('assistant', 'answer of run one'),
        start(RUN_2),
        msg('user', 'second prompt'),
        msg('assistant', 'answer of run two'),
        start('run-1794311000000-zzzzzz'),
      ],
      EPOCH_2 + 1000,
    );
    write(
      'beta',
      '2026-11-10-task-1794310000000-bbbbbb.jsonl',
      [start('run-1794310440320-qqqqqq'), msg('assistant', 'beta only')],
      EPOCH_2,
    );
    // Mentions the run ID in text only, in a chat transcript.
    write(
      'beta',
      '2026-11-10-chat-conv-1794310000001-cccccc.output.jsonl',
      [msg('user', `what happened in "run_id":"${RUN_2}" ${RUN_2}?`)],
      EPOCH_2,
    );
    // Modified before the run could have started: never read.
    const stale = 'run-1794320000000-stale1';
    write(
      'gamma',
      '2026-11-10-task-1794300000000-dddddd.jsonl',
      [start(stale), msg('assistant', 'too old')],
      1794320000000 - 60_001,
    );
    write(
      'gamma',
      '2026-11-10-task-1794300000001-eeeeee.jsonl',
      [start('run-1794330000000-edge11'), msg('assistant', 'on the edge')],
      1794330000000 - 60_000,
    );
    fs.mkdirSync(path.join(root, 'empty', 'transcripts'), { recursive: true });
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('show limits a transcript to the run, with or without a group', () => {
    for (const args of [[RUN_2], ['alpha', RUN_2]]) {
      const out = run('show', ...args);
      expect(out).toContain(
        `=== 2026-03-13-task-1773414486309-gv7eg5 · run ${RUN_2} (2 messages) ===`,
      );
      expect(out).toContain('answer of run two');
      expect(out).not.toContain('answer of run one');
      expect(out).not.toContain('first prompt');
    }
    const data = json('show', RUN_2, '--last', '1');
    expect(data).toMatchObject({ group: 'alpha', runId: RUN_2 });
    expect(data.messages.map((m: any) => m.content)).toEqual([
      'answer of run two',
    ]);
    expect(run('show', RUN_1)).toContain('(1 messages)');
    // The run_start line that ends the file leaves no messages.
    expect(run('show', 'run-1794311000000-zzzzzz')).toContain('(0 messages)');
    expect(run('result', RUN_2, '1')).toContain('Tool call #1 not found');
  });

  test('the mtime bound is inclusive and chat text mentions are ignored', () => {
    expect(run('show', 'run-1794330000000-edge11')).toContain('on the edge');
    expect(run('show', 'run-1794320000000-stale1')).toContain(
      "Run 'run-1794320000000-stale1' not found in any task transcript.",
    );
    // Beta holds RUN_2 only as chat message text.
    expect(run('show', 'beta', RUN_2)).toContain(
      `Run '${RUN_2}' not found in any task transcript in group 'beta'.`,
    );
  });

  test('unknown run IDs and empty groups report the run as not found', () => {
    const unknown = 'run-1794310440319-nope00';
    const all = json('show', unknown);
    expect(all).toMatchObject({ group: null, id: null, messages: [] });
    expect(all.error).toBe(
      `Run '${unknown}' not found in any task transcript. Archives were not searched; pass --archive. Run IDs resolve only for task runs.`,
    );
    const scoped = json('show', 'empty', unknown);
    expect(scoped).toMatchObject({ group: 'empty', id: null, messages: [] });
    expect(scoped.error).toBe(
      `Run '${unknown}' not found in any task transcript in group 'empty'. Run IDs resolve only for task runs.`,
    );
  });
});

describe('transcript reader refuses agent-planted symlinks and FIFOs', () => {
  let root: string;
  let foreign: string;
  const names = (dir: string, archive = false) =>
    listTranscriptFiles(dir, { archive }).map((f) => f.fileName);

  function makeDir(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-planted-'));
    foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(
      path.join(foreign, 'secret.jsonl'),
      JSON.stringify({ role: 'user', content: 'foreign secret' }) + '\n',
    );
    fs.writeFileSync(
      path.join(foreign, '2026-03-09.tar.gz'),
      tarGz([{ name: 'foreign-archived.jsonl', body: '{"role":"user"}\n' }]),
    );
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('regular live files and archives are listed and readable', () => {
    const dir = makeDir('regular');
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{"role":"user"}\n');
    fs.mkdirSync(path.join(dir, 'archive'));
    fs.copyFileSync(
      path.join(foreign, '2026-03-09.tar.gz'),
      path.join(dir, 'archive', '2026-03-09.tar.gz'),
    );
    expect(names(dir, true).sort()).toEqual([
      'a.jsonl',
      'foreign-archived.jsonl',
    ]);
    const live = listTranscriptFiles(dir).find((f) => f.fileName === 'a.jsonl');
    expect(live?.readText()).toBe('{"role":"user"}\n');
  });

  test('a symlinked archive directory contributes no archived members', () => {
    const dir = makeDir('linked-archive');
    fs.symlinkSync(foreign, path.join(dir, 'archive'));
    expect(names(dir, true)).toEqual([]);
  });

  test('a symlinked live file is not listed', () => {
    const dir = makeDir('linked-live');
    fs.symlinkSync(
      path.join(foreign, 'secret.jsonl'),
      path.join(dir, 'x.jsonl'),
    );
    expect(names(dir)).toEqual([]);
  });

  test('a FIFO live file is not listed and listing does not block', () => {
    const dir = makeDir('fifo-live');
    try {
      execFileSync('mkfifo', [path.join(dir, 'y.jsonl')]);
    } catch {
      return; // mkfifo unavailable
    }
    expect(names(dir)).toEqual([]);
  }, 2000);

  test('a symlinked transcripts directory lists nothing', () => {
    const link = path.join(root, 'linked-transcripts');
    fs.symlinkSync(foreign, link);
    expect(names(link, true)).toEqual([]);
  });
});
