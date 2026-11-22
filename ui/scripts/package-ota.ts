import { createHash } from 'node:crypto';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';

const uiDir = path.resolve(import.meta.dir, '..');
const distDir = path.join(uiDir, 'dist');
const otaDir = path.join(uiDir, 'ota');
const shellVersionPath = path.join(
  uiDir,
  'android',
  'native-shell-version.json',
);

async function collectFiles(
  dir: string,
  prefix = '',
): Promise<Array<[string, Uint8Array]>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<[string, Uint8Array]> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory())
      files.push(...(await collectFiles(absolute, relative)));
    else if (entry.isFile())
      files.push([relative, new Uint8Array(await readFile(absolute))]);
  }
  return files;
}

const { versionCode, bundleGeneration } = JSON.parse(
  await readFile(shellVersionPath, 'utf8'),
) as { versionCode?: unknown; bundleGeneration?: unknown };
if (!Number.isSafeInteger(versionCode) || Number(versionCode) < 1) {
  throw new Error(
    `${shellVersionPath} must contain a positive integer versionCode`,
  );
}
if (!Number.isSafeInteger(bundleGeneration) || Number(bundleGeneration) < 1) {
  throw new Error(
    `${shellVersionPath} must contain a positive integer bundleGeneration`,
  );
}
const requestedBundleGeneration =
  process.env.ANDROID_OTA_BUNDLE_GENERATION === undefined
    ? Number(bundleGeneration)
    : Number(process.env.ANDROID_OTA_BUNDLE_GENERATION);
if (
  !Number.isSafeInteger(requestedBundleGeneration) ||
  requestedBundleGeneration < 1 ||
  (process.env.ANDROID_OTA_BUNDLE_GENERATION !== undefined &&
    requestedBundleGeneration <= Number(bundleGeneration))
) {
  throw new Error(
    'ANDROID_OTA_BUNDLE_GENERATION must be an integer newer than the built-in bundle generation',
  );
}
await writeFile(
  path.join(distDir, 'android-ota-bundle.json'),
  `${JSON.stringify({ bundleGeneration: requestedBundleGeneration })}\n`,
);

const files = await collectFiles(distDir);
if (!files.some(([name]) => name === 'index.html')) {
  throw new Error(`OTA bundle source has no index.html: ${distDir}`);
}

const archive: Zippable = {};
for (const [name, contents] of files) {
  archive[name] = [contents, { mtime: new Date('1980-01-01T00:00:00.000Z') }];
}

const zip = zipSync(archive, { level: 9 });
const checksum = createHash('sha256').update(zip).digest('hex');
const metadata = {
  version: checksum.slice(0, 24),
  checksum,
  size: zip.byteLength,
  requiredNativeVersionCode: Number(versionCode),
  bundleGeneration: requestedBundleGeneration,
};

await rm(otaDir, { recursive: true, force: true });
await mkdir(otaDir, { recursive: true });
await writeFile(path.join(otaDir, 'candidate.zip'), zip);
await writeFile(
  path.join(otaDir, 'candidate.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
console.log(
  `Android OTA candidate ${metadata.version} (${metadata.size} bytes)`,
);
