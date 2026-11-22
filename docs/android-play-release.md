# Publishing the Android app (Google Play)

Status as of 2026-11-13. Release signing, the signed-bundle script and the
versioning rules (sections 1-3) are implemented; the rest of this page lists
what a public release still needs. `ui/android/install-apk.sh` makes a
**debug** APK for one person's board, installs it over USB and arms
debug-only hooks. A public build must work for any self-hosted board and
contain nothing that belongs to one operator; `ui/android/build-release.sh`
produces it.

Already done (no work left):

- **Server certificates.** The APK bundles no server certificate.
  `network_security_config.xml` trusts system and user-installed CAs, and a
  single self-signed board is trusted through the per-server pin from the
  pairing link. The pairing page pins the certificate each address actually
  presents, so a reverse proxy in front of the board works. See
  [Android security](android-security.md#2-ssl-pinning--encryption).
- **OTA key fallback.** The app verifies update manifests with the pairing
  link's `otaKey` first and with the embedded key only as a fallback. With no
  key at all it disables updates and keeps its built-in web bundle. See
  [Android web-bundle updates](android-ota.md).

## 1. Release build and signing

`ui/android/build-release.sh` produces a signed Android App Bundle (`.aab`, the
only format Play accepts for new apps) at
`ui/android/app/build/outputs/bundle/release/app-release.aab`.

- **Upload key.** Create a keystore once
  (`keytool -genkeypair -v -keystore upload.jks -keyalg RSA -keysize 4096 -validity 10000 -alias upload`).
  Keep it outside every checkout and back it up; losing it means asking
  Google to reset the upload key. Enrol in **Play App Signing**: Google holds
  the real app signing key and re-signs uploads. Creating the keystore,
  enrolling and uploading the bundle are manual operator steps; nothing in the
  repository does them.
- **Signing properties file.** Put a Java properties file next to the keystore,
  outside the repository, and point `ANDROID_RELEASE_KEYSTORE_PROPERTIES` at it:

  ```properties
  storeFile=/home/me/android-keys/upload.jks
  storePassword=...
  keyAlias=upload
  keyPassword=...
  ```

  A relative `storeFile` is resolved against the properties file's directory.
  `app/build.gradle` reads it only for release packaging tasks
  (`bundleRelease`, `assembleRelease`); they fail, naming the variable and this
  page but never a password, when the variable is unset, the file or a key is
  missing or empty, the keystore does not exist, or the properties file or
  keystore is inside the repository working tree. Debug tasks do not read it.
  `*.jks`, `*.keystore` and `keystore.properties` are gitignored as a second
  line of defence. Never commit any of them.

- **Build command.** `ANDROID_RELEASE_KEYSTORE_PROPERTIES=/path/keystore.properties ui/android/build-release.sh`.
  It refuses to run when tracked files have uncommitted changes (one bundle,
  one commit; a run that follows another in a worktree is refused until you
  drop the `cap sync` output the first one left, with the `git checkout --`
  command the refusal prints), needs `google-services.json` and the CapacitorUpdater patch like
  `install-apk.sh`, and then:
  - builds the web bundle with `VITE_API_URL`, `VITE_LOCAL_IP` and
    `VITE_LOCAL_HOSTNAMES` forced to empty, whatever `ui/.env*` or your
    environment hold, and fails afterwards if the synced assets still contain a
    non-empty value of those variables from `ui/.env`, `.env.local`,
    `.env.production` or `.env.production.local`;
  - unsets `ANDROID_OTA_PUBLIC_KEY` (see section 2), takes the built-in bundle
    version and generation from `ui/ota/candidate.json`, and runs
    `./gradlew bundleRelease`;
  - prints the bundle path, size, SHA-256, `versionCode`, `versionName` and
    commit. It never calls `adb`, installs, uploads, or writes a keystore or
    password.
- The release build type is not debuggable; keep it that way (`run-as`, which
  `install-apk.sh` uses for its one-shot bundle activation marker, only works
  on debuggable builds, so that marker cannot be created on a Play install;
  `resetWhenUpdate: true` in `ui/capacitor.config.ts` already resets to the new
  built-in bundle when the native version changes). `minifyEnabled` is false,
  so R8 rules are not a concern yet.

## 2. Values the public build must not contain

| Value                              | Where it comes from today                                                                                                                     | Public build                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTA public key                     | `install-apk.sh` exports `ANDROID_OTA_PUBLIC_KEY` from `store/android-ota/public-key.base64` into `BuildConfig`                               | Leave the variable unset (empty key); `build-release.sh` unsets it. An APK with the publisher's key makes every board paired without `otaKey` fail its update checks.                                                                  |
| Default server addresses           | `ui/.env`: `VITE_API_URL` (the publisher's public domain) and `VITE_LOCAL_IP` (a LAN IP), compiled into the web bundle as the server defaults | Build with both empty (`build-release.sh` forces this). There is no built-in fallback address: a native install with nothing stored and no default shows a setup screen (scan the setup QR or type an address) and contacts no server. |
| Local hostnames                    | `ui/.env`: `VITE_LOCAL_HOSTNAMES`, an operator-specific comma list of hostnames treated as the local network                                  | Leave empty. It holds no default address and needs no code change.                                                                                                                                                                     |
| Built-in bundle version/generation | `install-apk.sh` reads `ui/ota/candidate.json`                                                                                                | Same mechanism is fine; the values describe the bundle, not a board.                                                                                                                                                                   |
| Firebase config                    | `ui/android/app/google-services.json` (gitignored, Firebase project of the publisher)                                                         | Required: every build fails without it. Must be the publisher's Firebase project; see push below.                                                                                                                                      |

## 3. Versioning

- `versionCode` comes from `ui/android/native-shell-version.json`
  (`versionCode`, currently 19). Play rejects an upload whose `versionCode` is
  not higher than every earlier upload, so **bump it for every Play upload**,
  not only for native changes. The script prints the current value but does not
  track what was uploaded. `ui/android/check-native-version.sh` also requires a
  higher value for native changes.
- `versionName` is the environment variable `ANDROID_VERSION_NAME` when set and
  non-empty, otherwise `1.0-<BUILD_COMMIT>` (what `install-apk.sh` asserts).
  `build-release.sh` sets it to `1.<versionCode>` (for example `1.19`) unless
  you already set it, and prints the commit separately.
- Web bundles still update over the air from each user's own board.
  `requiredNativeVersionCode` in the OTA manifest keeps a newer board from
  pushing a bundle into an APK that is too old; users on an old Play version
  see "incompatible" until they update from Play.

## 4. Push notifications

How it works today:

- The board sends **data-only** FCM v1 messages (`src/modules/push/fcm-sender.ts`)
  with only `{ kind, ref }`, no content. `CarapaMessagingService` on the phone
  receives the ping, fetches the real payload from the board over the signed
  device channel and posts the notification. The device registers its FCM
  token with the board at `POST /api/devices/push-token` (`src/routes/push.ts`).
- The board needs `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_PATH` (a Firebase
  service account JSON); without them push is disabled and `notify_user`
  reports "push notifications are disabled on this server" (`src/config.ts`, `.env.example`).
- The APK only receives FCM when built with that same Firebase project's
  `google-services.json`. `ui/android/app/build.gradle` requires the file for
  every build and fails without it.

The problem for a public app: an FCM message to an app can only be sent with
credentials of the Firebase project the app was built with. That is the
publisher's project. Other operators' boards cannot get its service account
(it would let them message every user of the app), so **push only works for
the publisher's own board** today.

Options, to decide before release:

1. **Publisher-run push relay** (the approach most self-hosted apps with Play
   builds take). Each board sends `{ token, kind, ref }` to a relay operated
   by the publisher; the relay holds the service account and calls FCM. The
   payload is already content-free, so the relay sees only device tokens and
   opaque refs. Needs: a relay service, board registration/authentication
   (per-board key), rate limits, a board setting for the relay URL with the
   current direct-FCM mode kept for self-built APKs, and a privacy-policy
   statement about the relay.
2. **UnifiedPush** (for example via ntfy). The user installs a distributor
   app and the board pushes to the user's chosen server; no Google
   credentials are involved. Needs: UnifiedPush support in the app (an
   endpoint registration next to the FCM token) and a sender in the board.
   More setup for users; can coexist with option 1.
3. **No push in the public build.** Notifications only while the app is open
   (WebSocket). The simplest first release; document it as a limitation.

Also check: notification permission prompt (`POST_NOTIFICATIONS`, Android
13+) and that a build with push unconfigured on the board degrades without
errors. Every build requires `google-services.json` (the build fails without
it), so there is no public build without Firebase.

## 5. Play Console requirements

Check the current Play Console rules when starting; these change.

- **Developer account**: one-time fee and identity verification. New
  personal accounts must run a **closed test** with a minimum number of
  testers for 14 days before production access.
- **Privacy policy URL** (required: the app uses camera, microphone,
  notifications and stores credentials) and the **Data safety** form. State
  that data goes to the user's own board, plus Firebase/relay if push is
  enabled. The app opts out of cloud backup
  (`allowBackup="false"`, no data in Google Drive backups).
- **Permissions to declare or justify** (`ui/android/app/src/main/AndroidManifest.xml`):
  `CAMERA`, `RECORD_AUDIO`, `POST_NOTIFICATIONS`, `USE_BIOMETRIC`, and
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` for `CarapaSpeechService`. Foreground
  service types need a declaration in the Play Console, usually with a short
  video of the feature.
- **Over-the-air web updates**: the app downloads JavaScript bundles from the
  user's board. Play's device-and-network-abuse policy allows code that runs
  in a WebView/JavaScript engine; confirm this when submitting and do not
  extend OTA to native code.
- **Target API level**: `targetSdkVersion` is 36, which meets the current
  requirement; keep up with Play's yearly bump.
- **Devices**: `abiFilters 'arm64-v8a'` (on-device Whisper) limits the app to
  64-bit ARM phones and tablets. Decide whether that is acceptable or build
  other ABIs without local transcription.
- **Store listing**: name, icon, screenshots, short and full description. The
  licence is PolyForm Noncommercial 1.0.0; do not describe the app as open
  source.

## 6. User flow gaps

- **Address typed by hand.** Done (kanban task-1794489630186-s2iq2k). A user
  who enters their board's address in the server editor, instead of scanning
  the setup QR, gets no `otaKey` and no certificate pin. With a public build
  that means no web updates and no way to reach a self-signed board. The
  editor tells them to use the QR from Account → Connect the Android app, and
  asks for confirmation before a save drops a pin or the key.
- **First run without a server.** A build with empty `VITE_API_URL` and
  `VITE_LOCAL_IP` has no default address. A fresh install shows a setup screen
  instead of "Connection Failed": it says to open the board in a browser, go to
  Account → Connect the Android app and scan the setup QR with the phone's
  camera, and offers "Enter the address manually" (the server editor). No
  request is sent until a server is stored; opening a `carapaboard://server`
  link on that screen works as usual. There is no in-app QR scanner.
- **Board and app version skew.** A Play install starts with the web bundle
  built into the APK until the first OTA from the user's board applies. Check
  that this built-in UI can at least sign in to an older or newer board and
  then update.
