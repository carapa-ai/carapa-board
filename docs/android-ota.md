# Android web-bundle updates

CarapaBoard can publish signed Capacitor web bundles from its normal Docker
deployment. Kotlin, Android resources, permissions, certificates, and
Capacitor plugin changes still require a new APK over USB.

## One-time setup

The board creates the Ed25519 signing key itself at boot when neither the
Docker secret nor `store/secrets/android_ota_private_key` exists. It is written
there as PEM (file mode 0600, directory 0700) and an existing key at either
location is never replaced. Running `./scripts/generate-android-ota-keys.sh`
beforehand is optional; use it to place the key in `SECRETS_DIR` for Docker
Compose or to write the public key file:

```bash
./scripts/generate-android-ota-keys.sh
```

The public key is also available to signed-in users from
`GET /api/android/pairing-info` (`otaPublicKey`). **Back up the private key**
(`store/secrets/android_ota_private_key`): losing it requires another USB
bootstrap install.

The repository's `docker-compose.yml` declares no `android_ota_private_key`
secret. To keep the key with your other secrets, add that secret to your Compose
file yourself so it is mounted read-only at
`/run/secrets/android_ota_private_key`, and run the generator with `SECRETS_DIR`
exported, or pass that directory explicitly. When `SECRETS_DIR` is unavailable,
the generator defaults to the ignored `store/secrets/` directory. The server
prefers the Docker secret mount when it exists and otherwise uses
`/app/store/secrets/`, which is the default for the shipped Compose file. The raw public key is written to
`store/android-ota/public-key.base64`;
`ui/android/install-apk.sh` embeds it in the APK. Back up both files. Never
commit the private key.

The deployment Compose file must list this secret for every build target,
including a fast local runtime image, so boot publishing works there too. After generating the key, recreate the board container once;
restarting an existing container cannot add a secret mount.

Install the bootstrap APK once:

```bash
ui/android/install-apk.sh
```

The script embeds no server certificate; the app trusts the board through a
publicly trusted or user-installed CA, or a pin from the pairing link (see
[Android security](android-security.md#2-ssl-pinning--encryption)).

From a sandbox or git worktree (no `store/` of its own), the script reads the
OTA public key from the main checkout's `store/` (the parent of
`git rev-parse --git-common-dir`); `ANDROID_OTA_PUBLIC_KEY_FILE` still wins.

The embedded key is only a fallback. The app verifies update manifests with
the key from the pairing link (`otaKey`) when it has one, and with the embedded
key otherwise. A build without `ANDROID_OTA_PUBLIC_KEY` (an APK for other
people's boards) embeds an empty key: it receives updates only after pairing
with a link that carries `otaKey`, and until then keeps its built-in web
bundle. A Play release bundle (`ui/android/build-release.sh`) is built this way
and takes the key from the pairing link. Never distribute an APK with your own key embedded: a board paired
without `otaKey` would have its manifests checked against your key and every
update check would fail. See [Publishing the Android app](android-play-release.md)
for what a public build still needs. When more than one device is in
`device` state, the script exits before building and lists the serials; set
`ANDROID_SERIAL` to pick one. It installs the normal package `ai.carapa.board`
signed with the local debug key. If the device already has the app signed with a
different key (for example the host-signed app on a developer's tablet), Android
refuses the install with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; the script prints
that and exits non-zero. It never uninstalls the app, because that would erase
its login, PIN and device registration. Sandboxes install only on a device
without the app or one that carries the matching key.

After that installation, one administrator action ships both the browser and
the Android UI:

1. **Build app** starts the normal CarapaBox build in the background. When it
   succeeds, the existing yellow **Restart** action appears in the sidebar.
   Nothing restarts automatically. The yellow action exits the board only after
   acknowledging the request, allowing the external service watcher to recreate
   it from the already-built image.
2. When the restarted board starts, after its HTTP server is up, it packages
   the image's `ui/dist` into a signed OTA bundle and publishes it at
   `/android-updates/latest.json`. Publishing on boot (not right after the
   build) guarantees the Android UI never reaches phones before the server it
   talks to is running.

The boot step publishes only when the web content changed. It fingerprints the
files of `ui/dist` (SHA-256 over sorted relative paths and bytes, excluding
`android-ota-bundle.json`) and compares it, together with
`requiredNativeVersionCode`, to the server-only sidecar
`store/android-ota/published/published-content-<version>.json` written at the last
publish. A server-only change leaves `ui/dist` identical, so no new generation
is published and phones are not prompted. The sidecar is not part of the signed
manifest. The zip checksum cannot serve for this comparison because the bundle
embeds its own `android-ota-bundle.json`, which changes with every generation.
The bundle is assembled in memory; the read-only `ui/dist` is never written.

**Native URLs.** Native builds compile `VITE_API_URL`, `VITE_LOCAL_IP` and
`VITE_LOCAL_HOSTNAMES` from `ui/.env` (gitignored, but inside the Docker build
context). The Docker `frontend-build` stage copies `ui/.env*` when present, so
the single `ui/dist` carries the same server URLs as the APK. Without
`ui/.env` the build still succeeds but has no server address: the app then
shows its server setup screen until the user enters one. Create `ui/.env`
before building if the APK should start with your server. In browsers `API_BASE_URL` stays empty unless the app runs in
Capacitor, so these values do not change browser behavior.

A build or boot-publish failure leaves the last published Android update
untouched. Boot publishing is best effort: a missing or invalid signing key, a
missing `ui/dist` or any publish error is logged and the board keeps booting.

The Android app checks on launch, foregrounding, and update-ready events. It
downloads and verifies new bundles before showing **Restart now** or **Later**.
Publishing identical assets reports that Android is already current and does
not emit a false update-ready prompt. A boot that publishes new content
broadcasts the same update-ready event.

After an admin **Restart** from the app, the app skips the page reload and
applies a newer verified bundle directly, without the prompt. If there is no
newer bundle, nothing restarts.

If the signing key is absent or invalid, boot publishing logs a warning. The
last successfully published update remains available. No unsigned OTA bundle is published.

## Native compatibility

`ui/android/native-shell-version.json` contains two independent release
identities. `versionCode` is the OTA compatibility boundary. Increment it
whenever changing Kotlin code, Android resources or
permissions, the manifest (for example an intent filter such as the
`carapaboard://server` setup link), `capacitor.config.ts`, or a dependency that installs native code.
Then install the new APK. A shell accepts any bundle whose required version is
less than or equal to its own `versionCode` and orders it by `bundleGeneration`
as usual. A bundle requiring a higher version is refused and the app shows an
"update the Android app" message.

Because a server can publish a bundle built for an older shell than the one
installed (for example after an app update through a store), a newer native
shell must keep working with web bundles built for older shells. Native changes
(Kotlin plugins and their JS-facing methods, `CarapaBridge` methods, permissions
the UI relies on) must be additive: do not remove or change the behaviour of a
method an older bundle may call. A breaking native change needs an explicit
decision.

`bundleGeneration` is a signed, monotonically increasing web release number.
It is assigned automatically on every publish as `max(built-in, published) + 1`
and written into the bundle's `android-ota-bundle.json`; the value in
`native-shell-version.json` is the APK's built-in floor, so you do not
increment it for web-only releases. Do not derive ordering from the content
hash. Web-only changes do not increment `versionCode`. Run
`ui/android/check-native-version.sh` in CI to fail native changes without a
compatibility bump. The guard resolves the merge-base with `origin/develop`
(then `origin/main`) by default; CI may set `ANDROID_NATIVE_BASE_REF` to its
checked-out develop merge-base explicitly.

Manifests or bundles without `bundleGeneration` are legacy generation 0 and
are never allowed to replace a generation-bearing bundle. A manifest with the
same generation but a different content hash is also ignored because hashes
identify content but do not establish ordering.

**Paired servers.** When the app was set up from a pairing link, the server
config carries `otaPublicKey`; manifests are then verified with that key
instead of the APK's compiled-in one (an APK without a compiled-in key still
updates). Generations are assigned per server, so in this mode the update check
compares `bundleGeneration` only with the last generation applied from that key
(stored in `carapa-android-ota-paired`, 0 on a fresh pairing); the built-in
generation and the embedded-bundle pin are ignored. A bundle handed to the
updater only joins that floor from `notifyAndroidOtaReady`, after
`notifyAppReady` succeeded and only if the serving bundle is that very bundle
(matched by its updater id, not by generation). The update check never raises
the floor, so a bundle that failed to boot, or one the updater replaced by a
fallback, is offered again, while a fallback to the built-in bundle never
allows a downgrade. A change of server origin, certificate pin or
`otaPublicKey` saves the new config, switches back to the APK's built-in
bundle and deletes the record when the key changed (a server with the same key
continues the same generation sequence, so its floor stays), so one server's
UI code never runs against another.
The change runs in the same queue as update activation, so it never overlaps a
`set` in flight. It is refused (not queued) while an apply is waiting or
running, and once an activation has started restarting the app. The change first writes the marker `carapa-server-change-pending`; if
the process ends or the updater restores the old bundle, the next start
finishes the change (forgets the record, selects the built-in bundle again,
keeping the saved config) and the marker is cleared once the built-in bundle
has reported ready (`completeServerChange`). The app fails closed there: if
that startup recovery cannot select the built-in bundle, `main.tsx` shows a
blocking error with a "Retry" button that re-runs the recovery, and renders
nothing else (no router, no login) until it succeeds. A reset that fails
while the app is still running does not restore the previous config: the new
config and the marker stay, `applyServerConfig` rejects with
`ServerChangeIncompleteError`, and its callers reload the app so that the same
blocking recovery runs. Only a failure before the config is saved (credential
wipe, pin update) restores the previous config and reports an inline error. Updates
checked under an older server config are discarded, and a downloaded but not
applied bundle is deleted from the updater. Switching servers always returns to
the APK's built-in bundle; the only refusals are an activation already
restarting the app and a failure before the config is saved. A built-in bundle
built before paired-key support keeps working against the new server but gets
no paired OTA updates until the APK is replaced.
Without `otaPublicKey` nothing changes.

**First load of a paired server.** While no bundle of the paired server has
been confirmed (`carapa-android-ota-paired` absent or generation 0), the built-in
UI must not offer its login: the signed-out screen shows "Loading the app from
your server…" and `AndroidOtaController` runs check, download and apply
without the "Restart now / Later" prompt. The app then restarts into the
server's bundle and shows its login. The gate also covers an unreachable
server: the auth check's generic "Connection Failed" screen does not replace it.
On a first load the built-in bundle is never `current`, even when its version
equals the manifest's; it is replaced by a download of the server's bundle.
Outcomes: `current` (the server's own bundle is already active) shows the
login; `incompatible` shows "This server needs a newer version of the app"; no manifest (404) shows "This server has not
published an Android UI yet"; a network, signature or apply error shows its
text. The failure screens offer "Change server" (the existing server editor),
and "Retry" except for `incompatible`. There is no way past it with the
built-in UI. Changing the server restarts the check under the new config.
Only the first load is gated: once a bundle of the server has been confirmed
(a persisted flag, independent of the generation number, so a generation-0
bundle counts too), later launches never wait for the network and later updates keep using the
prompt. The gate is UI-level, not a security boundary against someone who can
edit the app's local storage. If the first load is interrupted or the applied
bundle fails to boot (the updater rolls back to the built-in bundle), the next
start shows the gate again; there is no retry limit.

**Pinned download.** The updater plugin downloads with OkHttp, which does not
use the `HttpsURLConnection` defaults. `ui/patches/@capgo+capacitor-updater+*.patch`
gives its shared client a socket factory that reads those defaults on every
handshake and a hostname verifier that runs OkHttp's own check first and falls
back to the pin-aware verifier, so the process-wide pin-aware trust
(`CarapaTls`, see [Android security](android-security.md)) decides: a bundle on
an origin with a certificate pin downloads, an untrusted origin without one
fails, and idle connections are not pooled so a changed pin list never meets an
old connection. The checksum from the signed manifest is still verified.

`ui/android/install-apk.sh` arms a one-shot app-private marker with
`adb shell run-as ai.carapa.board touch files/carapa-activate-embedded-once`.
During native bridge initialization, before the first WebView navigation,
CarapaBridge asks CapacitorUpdater to select the APK's bundled UI without
reloading. The marker is removed only after that selection succeeds; the
JavaScript fallback can consume it if native activation is unavailable. This
leaves credentials, device registration, settings, and drafts untouched.

## Device acceptance

The final acceptance check must run on a USB-connected Android device or
emulator with `adb` available. The installer clears only logcat evidence for
that launch, installs with `pm install -r`, arms the app-private marker above,
and fails unless package metadata, the active CapacitorUpdater bundle and
generation, and the web build label all match the newly built APK. It does
not clear application data. The web build label is read from the
`[carapa-build] web build <label>` line logged at startup (so a device stopped at
the login screen passes) or the signed-in `[carapa-build] sidebar build <label>`
line, and the active bundle from `[carapa-ota-runtime]` (`webBuild` must equal
the label). A missing or different label fails. When no ADB device is available (as in isolated
agent environments), automated OTA lifecycle tests and package/source checks
can pass, but this device-level activation and data-preservation check remains
outstanding and must be recorded before release.

## Recovery

Capacitor Updater keeps the previous successful bundle and the built-in APK
bundle. A downloaded bundle must call `notifyAppReady()` during startup; if it
cannot boot far enough to do so, the plugin rolls back automatically.
