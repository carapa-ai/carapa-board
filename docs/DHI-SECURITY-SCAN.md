# CarapaBoard DHI migration and security scan

Audit date: 2026-09-22. Platform tested: Linux amd64.

## Images and packaging

Board now uses matched Bun 1.4.2 images on Alpine 3.23:

- Build: `dhi.io/bun:1.4.2-alpine3.23-dev@sha256:f622fcf7d9677b071b288b4e57386bc18a45c27798c3a0c2bf2cb8f1a0e3be4a`
- Runtime: `dhi.io/bun:1.4.2-alpine3.23@sha256:eade039763b153d27382026f82563bdcc148970b6dda45993cbf34f096776b05`

On 2026-10-29 the Dockerfile moved to Bun 1.4.4 on Alpine 3.23; the scan
results below are for the 1.4.2 images:

- Build: `dhi.io/bun:1.4.4-alpine3.23-dev@sha256:2ddf7ec8434deb282e13d94fe4cc1f153abba7a269fc79eb47724f8f2b3f0f48`
- Runtime: `dhi.io/bun:1.4.4-alpine3.23@sha256:a869de0c70874053e763c6cfbab740fd85849bba12b5140a29f6795cd717ff15`

The runtime temporarily mounts the matching development image's APK executable
and libraries during construction. Required tools, including Bash, FFmpeg,
OpenSSL and ripgrep, are installed into the runtime's own package database.
The final image retains the complete package inventory, but contains neither
APK nor the mounted builder. Board still runs as UID 1000.

Backend and UI dependencies were updated to compatible patched versions.
`drizzle-kit` is now development-only; production migrations use `drizzle-orm`.
The isolated UI dependencies needed for Android OTA builds remain available.

## Vulnerability results

Trivy 0.69.3 scanned the complete final image with the database available on the
audit date. These are raw findings, without vulnerability suppressions.

| Severity | Previous image | DHI candidate |
| --- | ---: | ---: |
| Critical | 6 | 0 |
| High | 111 | 0 |
| Medium | 152 | 0 |
| Low | 20 | 1 |
| Unknown | 3 | 0 |

Previous image: `sha256:29ee605a3ea168c504bbceeb9ddc5e5e7875ee6c7bdd5858dbe66e91a98bdb9c`.

Tested candidate, built as `carapa-board:dhi-audit`:
`sha256:a28315332e6bb0263f77ec523baff2158b0925cd09a76f8c38e8630f03497421`.

The remaining LOW finding is
[GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr)
in esbuild 0.27.4, fixed in 0.28.1. Upstream describes a Windows-only development
server file-read issue. Board's Linux OTA process uses esbuild for compilation,
so the affected execution path is not used here. The finding remains visible.

esbuild is pinned to 0.27.4 because the attempted 0.28.2 upgrade failed the
production frontend build with unsupported destructuring lowering for Board's
existing browser targets. The passing version preserves those targets.

## Verification

- The full Docker `deploy` target passed all seven gates: backend tests,
  backend typecheck, contract tests, contract typecheck, UI tests, UI typecheck
  and frontend production build.
- Two IPC permission tests skipped by the root build runner were run separately
  as UID 1000 in the final image: all three tests in that file passed, with no
  skips or failures.
- The remaining backend skip is the opt-in real-provider cache integration test
  (`RUN_LUNA_CACHE_INTEGRATION=1`); external provider calls were not exercised.
- A final-image smoke check passed under a read-only filesystem, dropped
  capabilities, no-new-privileges and Board's seccomp profile. It covered native
  canvas, FFmpeg, certificate generation, the actual entrypoint, fresh
  PostgreSQL migrations and HTTPS health. PostgreSQL was disposable and no
  production data was used.
- The actual local Android OTA builder passed its tests, typecheck, production
  build, ZIP packaging and checksum checks. This ran before the final
  backend-only `form-data` update; the OTA layer was unchanged.
- Package formatting and `git diff --check` passed.

`bun run verify:changed` could not run because the local CarapaBox connection did
not respond. It was not substituted with an unsupported host run. Live
CarapaBox integration and ARM64 execution remain unverified.

No publish or deployment command was part of this audit. A final read-only
check observed that concurrent work had tagged this same candidate as
`carapa-board:latest` and started a healthy Board container.

## Reproduction

From the repository root, with access to the pinned DHI images:

```sh
docker build --target deploy --progress plain -t carapa-board:dhi-audit .
trivy image --scanners vuln --format json --output final-scan.json carapa-board:dhi-audit
```

Local audit evidence is in `/tmp/carapa-board-dhi-evaluation/`, including
`current-scan.json`, `final-scan.json`, `deploy-final-build.log`,
`runtime-smoke-final.log`, `ipc-nonroot-tests.log` and `ota-smoke.log`.
This temporary directory is not a durable artifact store; later scans may
change as the vulnerability database evolves.
