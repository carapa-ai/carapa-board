// Bundle entry for the `transcripts` skill (see transcripts-cli.ts).
import { runCli } from './transcripts-cli.js';

const { stdout, code } = runCli(process.argv.slice(2), process.env);
process.stdout.write(stdout);
process.exitCode = code;
