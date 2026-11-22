#!/usr/bin/env bun
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: bun scripts/decode-antigravity-conversations.ts --output <dir> [options]

Reads Antigravity's authenticated localhost language-server RPC and writes
temporary structured trajectory JSON for import-native-conversations.ts.

Options:
  --output <dir>        Required output directory
  --home <dir>          Native store (default: ~/.gemini/antigravity-ide)
  --config-home <dir>   IDE config (default: ~/.config/Antigravity IDE)
  --endpoint <url>      Override detected language-server HTTP endpoint
  --pid <number>        Override detected host language-server PID
  --help, -h            Show this help`);
  process.exit(0);
}

const output = valueAfter('--output');
if (!output) throw new Error('--output is required');
const nativeHome = path.resolve(
  valueAfter('--home') || path.join(os.homedir(), '.gemini', 'antigravity-ide'),
);
const configHome = path.resolve(
  valueAfter('--config-home') || path.join(os.homedir(), '.config', 'Antigravity IDE'),
);

async function detectServerPid(): Promise<number> {
  const override = Number(valueAfter('--pid'));
  if (Number.isInteger(override) && override > 0) return override;
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const cmdline = (await fs.readFile(`/proc/${entry.name}/cmdline`, 'utf8')).split('\0');
      if (
        cmdline[0]?.includes('/opt/antigravity-ide/')
        && cmdline[0]?.endsWith('/language_server_linux_x64')
        && cmdline.includes('--app_data_dir')
        && cmdline.includes(path.basename(nativeHome))
      ) return Number(entry.name);
    } catch {}
  }
  throw new Error('No authenticated host Antigravity language server found; open Antigravity and sign in first');
}

async function csrfToken(pid: number): Promise<string> {
  const cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  const index = cmdline.indexOf('--csrf_token');
  if (index < 0 || !cmdline[index + 1]) throw new Error(`Antigravity PID ${pid} has no CSRF token`);
  return cmdline[index + 1];
}

async function latestLanguageServerLog(root: string): Promise<string> {
  const candidates: Array<{ file: string; mtime: number }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name === 'ls-main.log') {
        candidates.push({ file, mtime: (await fs.stat(file)).mtimeMs });
      }
    }
  }
  await walk(path.join(root, 'logs'));
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates[0]) throw new Error(`No Antigravity language-server log found under ${root}`);
  return candidates[0].file;
}

async function detectEndpoint(): Promise<string> {
  const override = valueAfter('--endpoint');
  if (override) return override.replace(/\/+$/, '');
  const log = await fs.readFile(await latestLanguageServerLog(configHome), 'utf8');
  const matches = [...log.matchAll(/listening on (?:random|fixed) port at (\d+) for HTTP/g)];
  const port = matches.at(-1)?.[1];
  if (!port) throw new Error('Could not detect Antigravity HTTP language-server port');
  return `http://127.0.0.1:${port}`;
}

const pid = await detectServerPid();
const token = await csrfToken(pid);
const endpoint = await detectEndpoint();
const conversationsDir = path.join(nativeHome, 'conversations');
const files = (await fs.readdir(conversationsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.pb'))
  .map((entry) => entry.name)
  .sort();
const outputDir = path.join(path.resolve(output), 'conversations');
await fs.mkdir(outputDir, { recursive: true });

let decoded = 0;
const failures: Array<{ sessionId: string; reason: string }> = [];
for (const file of files) {
  const sessionId = file.slice(0, -3);
  try {
    const response = await fetch(
      `${endpoint}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeium-csrf-token': token,
        },
        body: JSON.stringify({ cascadeId: sessionId }),
      },
    );
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    const parsed = JSON.parse(body);
    if (parsed?.trajectory?.cascadeId !== sessionId) {
      throw new Error('decoder returned a mismatched or empty trajectory');
    }
    const target = path.join(outputDir, `${sessionId}.json`);
    const temporary = `${target}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(parsed)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
    decoded++;
  } catch (error) {
    failures.push({
      sessionId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({
  nativeHome,
  output: path.resolve(output),
  discovered: files.length,
  decoded,
  failed: failures.length,
  failures: failures.slice(0, 50),
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
