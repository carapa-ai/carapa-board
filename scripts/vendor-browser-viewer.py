#!/usr/bin/env python3
"""Publish a built Playwright dashboard into CarapaBoard. No application proxying.

Usage: python3 scripts/vendor-browser-viewer.py /path/to/playwright-core [version]

The input can be either an extracted playwright-core npm package or the
playwright-core package directory from a Playwright source checkout after the
dashboard has been built. When supplied, ``version`` must match package.json.
PLAYWRIGHT_SOURCE_REPO and PLAYWRIGHT_SOURCE_COMMIT (set by build-browser-viewer.sh)
are recorded in version.json; each falls back to ``unknown``.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

if len(sys.argv) not in (2, 3):
    raise SystemExit('Usage: vendor-browser-viewer.py /path/to/playwright-core [version]')

package = Path(sys.argv[1]).resolve()
metadata = json.loads((package / 'package.json').read_text())
version = metadata['version']
if len(sys.argv) == 3 and version != sys.argv[2]:
    raise SystemExit(f'Playwright version mismatch: {version}; expected {sys.argv[2]}')
source = package / 'lib/vite/dashboard'
if not source.is_dir():
    raise SystemExit(f'Built dashboard not found: {source}')
viewer_root = Path(os.environ.get(
    'BROWSER_VIEWER_DIR',
    str(Path(__file__).resolve().parents[1] / 'ui/public/browser-viewer'),
)).expanduser().resolve()
destination = viewer_root / 'upstream'
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(source, destination)
license_path = package / 'LICENSE'
if not license_path.is_file():
    license_path = package.parent / 'LICENSE'
if not license_path.is_file():
    license_path = package.parent.parent / 'LICENSE'
if not license_path.is_file():
    raise SystemExit(f'Playwright LICENSE not found beside {package}')
shutil.copyfile(license_path, destination / 'LICENSE')
# The audited bundle contains absolute asset URLs. Rebase only its own assets;
# bundle files live together under upstream/assets, so their relative asset
# references must not include the upstream/assets directory again.
for script in (destination / 'assets').glob('*.js'):
    text = script.read_text().replace('`/assets/', '`./')
    if script.name.startswith('index-'):
        default = 'mode:`readonly`,recording:null'
        assert text.count(default) == 1, 'Review upstream interactive-mode integration'
        text = text.replace(default, 'mode:`interactive`,recording:null')
    script.write_text(text)
for stylesheet in (destination / 'assets').glob('*.css'):
    text = stylesheet.read_text()
    text = text.replace('url(/assets/', 'url(./')
    text = text.replace('url("/assets/', 'url("./')
    text = text.replace("url('/assets/", "url('./")
    stylesheet.write_text(text)
manifest = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(source.rglob('*')) if p.is_file()}
index = (source / 'index.html').read_text()
# Vite emits root-absolute (`/assets/...`) or, since Playwright 1.66, relative
# (`./assets/...`) entry URLs; serve both from upstream/ beside this page.
index = re.sub(r'((?:src|href)=")\.?/', r'\1./upstream/', index)
# The asset contents above are rebased after Vite has calculated its filenames.
# Add a digest of the final entry assets so a deployment cannot reuse a cached
# copy of the previous post-processed bundle under the same Vite filename.
entry_assets = b''.join(
    p.read_bytes()
    for p in sorted((destination / 'assets').glob('index-*.js'))
)
entry_assets += b''.join(
    p.read_bytes()
    for p in sorted((destination / 'assets').glob('index-*.css'))
)
asset_stamp = hashlib.sha256(entry_assets).hexdigest()[:12]
index = re.sub(
    r'((?:src|href)="\.\/upstream\/assets\/[^"?]+\.(?:js|css))"',
    rf'\1?v={asset_stamp}"',
    index,
)
index = index.replace('<head>', '<head>\n    <script src="./bridge.js"></script>\n    <link rel="stylesheet" href="./embed.css">')
(viewer_root / 'index.html').write_text(index)
(viewer_root / 'version.json').write_text(json.dumps({
    'playwrightVersion': version,
    'sourceRepo': os.environ.get('PLAYWRIGHT_SOURCE_REPO', 'unknown'),
    'sourceCommit': os.environ.get('PLAYWRIGHT_SOURCE_COMMIT', 'unknown'),
    'sha256': manifest,
}, indent=2) + '\n')
