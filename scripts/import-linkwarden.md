# Linkwarden import

Run from the repository with Bun and its installed dependencies. This standalone script uses Linkwarden's read-only API and CarapaBoard's normal signed KB upload API. It never changes Linkwarden or writes directly to Board storage.

## Prepare

```sh
bun scripts/import-linkwarden.ts --prepare \
  --source-url http://localhost:4658 \
  --source-token-file ~/.secrets/lw-api \
  --state-dir /path/to/private/linkwarden-import
```

Preparation downloads the complete cursor-paginated library and checks collection counts. It caches the source snapshot and preserved archives, converts readable HTML into Markdown (including tables), and writes an inspectable `plan.json` and `assets/` directory. Preparation makes no destination changes. Interrupted preparations reuse the cached snapshot and archives. To capture a newer source library, use a new state directory.

Each collection becomes a KB named `Linkwarden / <collection path>`, including empty collections. Override the prefix with `--prefix`. KB descriptions carry the source origin and collection ID, used to recover interrupted creation. Import into the same origin URL consistently. No project sharing is added.

Documents retain trimmed, case-insensitively deduplicated tags. Markdown frontmatter records the original URL, Linkwarden ID, collection, dates and content source. The saved readable is preferred; plain text is the fallback, then a URL record if neither is available. Original uploaded PDFs and saved images remain binary files and receive a separate `-source.md` provenance document. Thus document counts can exceed link counts. Archived JPEG previews become sibling thumbnails using the actual uploaded document basename. Original saved images stay visible as image documents.

The import preserves existing archive quality. Blocked-page titles and missing readables are reported in the plan; the importer does not fetch original sites or ask Linkwarden to archive again. Original readable JSON is kept locally, so the HTML remains recoverable if conversion loses formatting. Full-page screenshots, monolith HTML and alternate PDF renderings of ordinary URL links are not imported. The raw library snapshot retains their references.

## Authenticate

Board requires an approved P-256 device. A server API token alone does not satisfy its request-signature requirement. Supply an existing private JSON device file with these fields:

```json
{
  "board": "https://your-board.example",
  "deviceId": "approved-device-id",
  "privKeyB64": "base64-PKCS8-private-key",
  "pubKeyB64": "base64-SPKI-public-key"
}
```

Pair a dedicated integration from an approved admin device:

```sh
bun scripts/carapa-device.ts \
  --url https://your-board.example \
  --name "Linkwarden importer" \
  --scopes knowledge:read,knowledge:write \
  --credentials-file /path/to/private/import-device.json
```

Open the displayed URL in Board on an approved admin device, enter the code,
review the owner and permissions, and approve pairing. The default authorization
lasts 30 days. This flow never needs the account password. Keep the credential
file private and revoke the integration after migration if ongoing access is
unnecessary. The importer uses the shared device client to acquire short-lived
sessions and sign requests. Tokens and private keys are never printed.

## Import and verify

```sh
bun scripts/import-linkwarden.ts --apply \
  --board-url https://your-board.example \
  --device-file /path/to/private/import-device.json \
  --state-dir /path/to/private/linkwarden-import

bun scripts/import-linkwarden.ts --verify \
  --board-url https://your-board.example \
  --device-file /path/to/private/import-device.json \
  --state-dir /path/to/private/linkwarden-import
```

The apply journal binds the plan to the destination and records returned KB IDs and filenames after each successful write. Rerunning `--apply` reconciles existing files by SHA-256 and tags before skipping them. Uncertain writes can be recovered on rerun when the destination contains the expected bytes. Conflicting content, edited tags, ambiguous collection matches, or removed previously imported files stop the run for review. No overwrite or deletion is attempted. Only run one importer against these collections at a time; the state directory has a lock to prevent concurrent use. After a process is forcibly killed, remove `.lock` only after checking that the recorded PID is no longer running.

`--verify` downloads all imported files again to check hashes, tags, and thumbnail association, including resumed uploads. Board indexing runs asynchronously through normal upload behavior; import completion does not claim embeddings or graph extraction have completed.

The private state directory contains library content, a snapshot, cached archives, a plan and a resume journal. Keep it outside Git and retain it until verification is complete. New files use mode `0600`, and new directories use `0700`. HTTP is allowed only for loopback origins; remote services require HTTPS. Redirects are rejected so credentials cannot follow an archive redirect to another origin. Unexpected archive failures stop preparation instead of silently omitting saved content.
