/**
 * Bundle the transcripts skill CLI into the carapa-agent-kit checkout, which
 * distributes the skill (`platform/skills/transcripts/scripts/transcripts.mjs`).
 *
 *   bun scripts/build-transcripts-skill.ts          # rewrite transcripts.mjs
 *   bun scripts/build-transcripts-skill.ts --check  # fail when it is stale
 *   bun scripts/build-transcripts-skill.ts --kit <path>  # kit checkout
 *
 * The kit defaults to `../carapa-agent-kit` next to this repository. `--check`
 * skips (exit 0) when the kit checkout is absent, as it is in CI.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const entry = path.join(root, 'src/modules/transcripts/transcripts-main.ts');

function kitRoot(argv: string[]): string {
  const flag = argv.indexOf('--kit');
  if (flag === -1) return path.resolve(root, '../carapa-agent-kit');
  const value = argv[flag + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--kit requires a path to the carapa-agent-kit checkout');
  }
  return path.resolve(value);
}

export async function buildTranscriptsSkill(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(
      `transcripts skill bundle failed: ${result.logs.map(String).join('\n')}`,
    );
  }
  return await result.outputs[0].text();
}

if (import.meta.main) {
  const kit = kitRoot(process.argv);
  const outFile = path.join(
    kit,
    'platform/skills/transcripts/scripts/transcripts.mjs',
  );
  const check = process.argv.includes('--check');
  if (check && !fs.existsSync(kit)) {
    console.log(`Skipping transcripts skill check: no kit checkout at ${kit}`);
    process.exit(0);
  }
  const bundle = await buildTranscriptsSkill();
  if (check) {
    const current = fs.existsSync(outFile)
      ? fs.readFileSync(outFile, 'utf8')
      : '';
    if (current !== bundle) {
      console.error(
        'transcripts.mjs is stale; run: bun run build:transcripts-skill',
      );
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, bundle);
    console.log(`Wrote ${outFile}`);
  }
}
