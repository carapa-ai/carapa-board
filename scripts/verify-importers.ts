import path from 'node:path';

// Lists the backend test files that directly import any of the given
// production files (argv). Depth 1 only: no transitive expansion.

const testGlob = new Bun.Glob('src/**/*.{test,spec}.{ts,tsx}');
const importSpecifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.{1,2}(?:\/[^'"\n]*)?)\1/g;
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;

function stripExtension(file: string): string {
  return file.replace(sourceExtension, '');
}

export function importedModules(testFile: string, source: string): string[] {
  const dir = path.posix.dirname(testFile);
  const modules: string[] = [];
  for (const match of source.matchAll(importSpecifier)) {
    modules.push(stripExtension(path.posix.join(dir, match[2]!)));
  }
  return modules;
}

export async function findImporters(
  productionFiles: string[],
  root = process.cwd(),
): Promise<string[]> {
  // A module resolves to `<stem>` or, for a directory import, `<dir>/index`.
  const targets = new Set(
    productionFiles.map((file) => stripExtension(path.posix.normalize(file))),
  );
  const importers: string[] = [];
  for await (const testFile of testGlob.scan({ cwd: root })) {
    if (/\.browser\.test\.tsx?$/.test(testFile)) continue;
    const source = await Bun.file(path.join(root, testFile)).text();
    const hit = importedModules(testFile, source).some(
      (module) => targets.has(module) || targets.has(`${module}/index`),
    );
    if (hit) importers.push(testFile);
  }
  return importers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) process.exit(1);
  for (const importer of await findImporters(files)) {
    console.log(importer);
  }
}
