#!/usr/bin/env bun

if (!process.argv.includes('--source')) {
  process.argv.splice(2, 0, '--source', 'codex');
}

await import('./import-native-conversations.js');
