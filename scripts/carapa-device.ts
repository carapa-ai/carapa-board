#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { pairCarapaDevice } from '../src/lib/carapa-device-client.js';
import { DEVICE_SCOPES } from '../src/lib/device-auth/scopes.js';
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    name: { type: 'string' },
    scopes: { type: 'string' },
    'credentials-file': { type: 'string' },
    'list-scopes': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
try {
  if (values['list-scopes'])
    console.log(DEVICE_SCOPES.map((s) => s.id).join('\n'));
  else if (
    values.help ||
    !values.url ||
    !values.name ||
    !values.scopes ||
    !values['credentials-file']
  )
    console.log(
      'Usage: bun scripts/carapa-device.ts --url https://your-board --name "My integration" --scopes knowledge:read,knowledge:write --credentials-file /private/device.json\nUse --list-scopes to list supported scopes.',
    );
  else {
    const requested = values.scopes.split(',').map((s) => s.trim());
    if (requested.some((id) => !DEVICE_SCOPES.some((scope) => scope.id === id)))
      throw new Error('Unknown scope; use --list-scopes');
    await pairCarapaDevice({
      board: values.url,
      file: values['credentials-file'],
      name: values.name,
      scopes: requested,
      onCode: ({ userCode, verificationUrl, expiresAt }) =>
        console.log(
          `Open ${verificationUrl} on an approved admin device.\nPairing code: ${userCode}\nExpires: ${expiresAt}\nWaiting for approval…`,
        ),
    });
    console.log('Device paired. Credentials saved privately.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Pairing failed');
  process.exitCode = 1;
}
