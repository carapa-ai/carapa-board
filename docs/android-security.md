# CarapaBoard Android Security Architecture

This document describes the security primitives that protect the CarapaBoard
mobile application and its API. The system is layered: a single failure in any
one layer should not expose user data.

---

## 1. Cryptographic Request Handshake (Keystore-backed)

Every API request from the mobile app is cryptographically signed by a device-
specific **ECDSA P-256** keypair. The signature proves request integrity and
binds the request to a specific device, in addition to the session cookie.

- **Private key generation**: the keypair is generated **inside the Android
  Keystore** via `KeyPairGenerator.getInstance("EC", "AndroidKeyStore")` with
  `ECGenParameterSpec("secp256r1")`. The private key never enters JS memory,
  the WebView, or any backup blob. On devices with a TEE (most modern Android)
  or StrongBox (recent Pixels, Samsung Knox flagships), the raw key material
  never exists outside the secure element — even root cannot extract it. See
  [`CarapaKeystore.kt`](../ui/android/app/src/main/java/ai/carapa/board/CarapaKeystore.kt)
  for the implementation.
- **Bootstrap**: the JS side calls `bootstrapDevice({ apiBase })` on the
  `CarapaBridge` plugin. The plugin generates the Keystore key (idempotent),
  mints a stable `deviceId`, persists `deviceId + apiBase` in
  `EncryptedSharedPreferences`, and returns `{ deviceId, publicKey }` (SPKI
  base64) for server registration.
- **Signing**: every `apiFetch` calls `CarapaBridge.signPayload({ payload })`.
  The plugin signs through the Keystore alias and returns the base64 P1363
  signature plus the bound `deviceId`. JS sets the signature headers and never
  touches the private key directly.
- **Headers**:
  - `X-Carapa-Device-ID` — unique device identifier (UUID-style, returned by
    the native bootstrap).
  - `X-Carapa-Timestamp` — ISO-8601 timestamp; replay window is 5 minutes
    enforced server-side via `requireFreshSignature`.
  - `X-Carapa-Signature` — base64 IEEE-P1363 signature of
    `timestamp:method:path:body`. The `body` segment is empty for GET/HEAD
    and for empty objects (`{}` ≡ `''` to match the server's empty-body
    shortcut).

The FCM service ([`CarapaApiClient.kt`](../ui/android/app/src/main/java/ai/carapa/board/CarapaApiClient.kt))
uses the same Keystore alias to sign payload-fetch and ack-payload requests
when the WebView is dead, so push-notification delivery survives a process
recycle. The persisted `deviceId + apiBase` ride along in
`CarapaCredentials` (EncryptedSharedPreferences); the legacy `private_key_pkcs8_b64`
field is wiped on plugin load.

### Diagnostics

The plugin exposes `getKeystoreInfo()` and logs the key's storage location
once at boot. To verify hardware-backing on a specific device:

```bash
adb -s <SERIAL> logcat -d -T 200 CarapaKeystore:I '*:S'
```

Possible `securityLevel` values:

| Level                 | Meaning                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `STRONGBOX`           | Dedicated tamper-resistant chip (Pixel 3+, Knox flagships).                                           |
| `TRUSTED_ENVIRONMENT` | Hardware-backed via TEE / TrustZone. Strong protection — most modern Android phones.                  |
| `SOFTWARE`            | Software-only Keystore. Encrypted at rest but extractable with root. Legacy/cheap devices, emulators. |
| `null` (API < 31)     | Pre-Android 12. Read `isInsideSecureHardware` instead — `true` ≈ TEE-or-better.                       |

If a deployment target reports `SOFTWARE`, treat the handshake as still strong
against off-device attacks but weaker against rooted-device attacks.

---

## 2. SSL Pinning & Encryption

The application enforces encrypted communication via HTTPS and uses **SSL
pinning** so it only talks to authorized servers.

- **Server certificates**: the backend uses a self-signed RSA 2048 certificate.
- **No bundled certificate**: one APK serves every board, so the app contains
  no server certificate. `network_security_config.xml` trusts, in `base-config`:
  - `system`: publicly trusted certificates (Let's Encrypt, Cloudflare tunnel).
  - `user`: a private certificate authority the device owner installed in
    Android Settings → Security → Encryption & credentials → Install a
    certificate → CA certificate. Use this for a home CA, for example one that
    signs the certificate of a reverse proxy in front of the board. Android
    requires a screen lock to install one, and the app then trusts every CA in
    that list, so install only CAs you control.
  - A board with a single self-signed certificate (and no CA on the phone) is
    trusted through the per-server pin below.
- **Per-server pins**: the pairing link (`carapaboard://server?...&homeCert=…&remoteCert=…`)
  can carry the SHA-256 of the board's certificate for each address. The UI
  stores it with the server config and hands the list `[{ origin, certSha256 }]`
  to native code (`CarapaBridge.setServerPins`) at startup and whenever the
  config is saved; native code keeps it app-privately, so
  `CarapaMessagingService` has it without the activity. A pin allows exactly
  that certificate (SHA-256 of the leaf DER) for exactly that host and port
  (`CertPinPolicy`), so a self-signed board works in the store app without the
  bundled certificate.
  - **WebView**: `CarapaTls` installs a `WebViewClient` whose
    `onReceivedSslError` proceeds only for an untrusted-chain or host-mismatch
    error when the leaf matches the pin and is within its validity period.
    The error URL may be `https` (sub-resources, fetch) or `wss` (the
    application WebSocket); both map to the same host and port. WebView
    remembers a `proceed()` per host and certificate, not per port. Chromium
    records it synchronously inside `proceed()` and consults it on the same
    UI thread, so the client clears it in the same callback, right after
    `proceed()`; no other handshake can see the approval, and every handshake
    is judged against the exact host and port. Everything else (no
    pin, other certificate, expired, unreadable, Android below 10 where the
    leaf cannot be read) is cancelled.
  - **Native HTTP** (`HttpsURLConnection`, used by CapacitorHttp and
    `CarapaApiClient`): a process-wide default trust manager first applies the
    platform validation (including `network_security_config.xml`) and accepts
    the connection only when that fails and the pin matches the peer's host
    and port. For a matching pin the hostname check is satisfied by the pin.
    Hosts without a pin behave as before. Whenever the pin list changes, the
    default `SSLContext`, socket factory and hostname verifier are replaced, so
    resumed TLS sessions and pooled connections from the old policy are not
    reused.
  - **Semantics**: a pin is an _additional_ trust anchor for one address, not an
    exclusive pin. A publicly trusted certificate on a pinned address still
    works. An empty list clears all pins.
  - **OTA bundle download**: the updater plugin's OkHttp client (patched in
    `ui/patches/@capgo+capacitor-updater+*.patch`) takes its socket factory from
    the same process-wide `HttpsURLConnection` defaults, and uses their pin
    hostname verifier only as a fallback after OkHttp's own host name check
    fails, so a per-server pin applies to the bundle download too, with the same
    decision function, while publicly trusted origins verify as before. Idle connections are not pooled, so a changed pin list
    never meets an older connection.

### Backup and device transfer

Cloud backup and device-to-device transfer are both off:
`android:allowBackup="false"` in `AndroidManifest.xml`, plus
`res/xml/data_extraction_rules.xml`, which excludes every domain for
`<cloud-backup>` and `<device-transfer>` (on Android 12+ `allowBackup="false"`
alone does not stop device-to-device transfer).

Why: the device signing key and the Keystore master key for the encrypted
preferences are bound to the phone, so restored credentials and PIN files
could not be decrypted; the on-device speech models are 60 MB to 875 MB each.
Vendor phone-clone tools that ignore these rules are not covered.

On a new phone, or after a reinstall, the app starts empty: pair with the board
again and download the speech model again.

---

## 3. Native Network Layer (CapacitorHttp)

To handle self-signed certificates and custom headers more reliably than the
WebView's `fetch`, the app uses the Capacitor Native HTTP plugin.

- Bypasses the WebView's strict Chromium SSL checks.
- Uses the native Android `HttpURLConnection` / `OkHttp` stack.
- Ensures `X-Carapa-Signature` and friends pass through without browser-level
  CORS interference.

---

## 4. Cloudflare Tunnel Integration

For secure internet access without port forwarding, the board supports
Cloudflare Tunnels.

- **Protocol**: end-to-end HTTPS (`cloudflared` → `carapa-board:3000`).
- **TLS verification**: the tunnel is configured with `No TLS Verify` to
  accept the board's self-signed internal certificate.
- **Global trust**: when accessed via the public domain, the app trusts the
  standard Cloudflare-issued certificate via the system CA.

---

## 5. App Lock System

The app's **lock state** is independent of the server session. It exists to
gate UI access when the user is not actively present, regardless of whether
their `auth_token` is still valid. Implementation lives in
[`auth-gate.tsx`](../ui/src/components/auth-gate.tsx) and
[`activity-tracker.ts`](../ui/src/lib/activity-tracker.ts).

### Activity tracking (in-memory, DOM-event-driven)

The freshness gate is an in-memory `lastUserInputAt` timestamp set ONLY by
`pointerdown` / `keydown` / `touchstart` events at the document root. Critically,
network traffic does **not** count as user activity:

- Polling, WS-driven invalidations, refetch intervals, and reconnect probes
  fire constantly while the JS thread is alive. An earlier design tracked
  `last_auth_time` in `localStorage` and refreshed it on every `apiFetch` —
  any background fetch could "look active" while the user was nowhere near
  the device.
- localStorage timestamps also survive hard reloads, so a freshly-spawned
  WebView could appear active before any input.
- The current design lives only in module scope: a fresh process resets to 0
  → caller is always treated as stale → lock engages. That's the intended
  behavior.

### Lock engagement

The lock can be engaged by:

- **Cold boot** — `computeInitialLocked()` returns `true` for
  `Capacitor.isNativePlatform()` (Android always starts locked) or for
  any web/iOS browser where `vaultIsConfigured()` is true (a wrapped
  WebAuthn vault is present).
- **Visibility change to visible** — when the WebView/tab returns to the
  foreground:
  - **Android with app PIN**: re-locks ONLY if the user has been idle
    ≥ 60 s (`isUserActive()` threshold). Without the grace, every share-
    sheet hop or quick app-switch would demand the PIN, which is hostile
    for normal use. The device-level lock (OS PIN/biometric) still gates
    the 60 s window — an attacker grabbing a phone hands-on within 60 s
    also needs to bypass the OS unlock.
  - **Web/iOS with biometric vault**: re-locks ONLY if the user has been
    idle ≥ 60 s (`isUserActive()` threshold). Tab-switching on a desktop
    is too common to demand a biometric every time. Engagement also
    calls `vaultClearMemory()`, so the in-memory plaintext is gone the
    moment the lock screen appears.
  - **Native without app PIN**: re-locks if idle, gated on
    `isUnlockAvailableCached()` so the user isn't trapped without an
    unlock method.
- **Successful login** — when `login()` succeeds on Android and a PIN is
  configured for the user, the lock is engaged unconditionally. This
  closes a gap where a logout+login round-trip (or the biometric login
  shortcut) inherited `locked=false` from the post-logout state and
  skipped the PIN gate entirely. Cold-boot logins were already covered
  by `computeInitialLocked()`; this makes the in-process case behave
  the same way.
- **Notification tap on a stale session** (Android) — `gatedNavigate()` in
  [`push.ts`](../ui/src/lib/push.ts) checks `isUserActive()` before
  navigating to a notification's detail route; if stale, it engages the
  lock and queues the navigation in module memory until unlock.

On native, lock engagement is additionally gated on
`isUnlockAvailableCached()` — biometric OR device credential — to avoid
trapping a user with no acceptable unlock method. On web/iOS the
WebAuthn credential itself is always available (or the lock isn't
configured), so no retraction logic is needed.

### Lock release

Release paths, evaluated in this order:

1. **App PIN entry** (Android) — when an app PIN is configured.
   Hardware-backed HMAC+Keystore via [`app-pin.ts`](../ui/src/lib/app-pin.ts)
   (Android-only facade). See [§6](#6-app-lock).
2. **Biometric unlock** (web/iOS) — when WebAuthn biometric unlock is
   configured. The session vault is encrypted under a key derived from a
   WebAuthn PRF assertion; without a successful Touch ID / Face ID /
   Windows Hello / hardware-key UV, the saved session is undecryptable.
   See [§6](#6-app-lock).
3. **System BiometricPrompt with DEVICE_CREDENTIAL fallback** (Android, no
   app PIN configured) — `CarapaBridge.verifyUser()` opens a BiometricPrompt with
   `BIOMETRIC_WEAK | DEVICE_CREDENTIAL` allowed. The user can authenticate
   with a fingerprint OR their phone's screen-lock PIN/pattern/password (the
   negative button reads "Use PIN"). This is the device's existing screen-
   lock credential, NOT an app-managed secret.
4. **Capacitor-native biometric** (native fallback when no app PIN) —
   `NativeBridge.biometricLogin()` from `capacitor-native-biometric`.

Important properties of the unlock paths:

- Boot-time biometric/credential availability is cached **once** at app start
  via `initBiometricAvailability()`. It is never re-queried. Some Android OEMs
  report `isAvailable=false` during a post-cancel cooldown; if we re-queried
  and trusted that, the AuthGate's safety-retraction effect would silently
  drop the lock and let an unauthenticated user past the gate.
- Cancel detection is **category-based**, not exact-string-match: `'cancel'` /
  `'canceled'` / `'cancelled'` substring, or codes `13` /
  `BIOMETRIC_ERROR_USER_CANCELED`. Different Android OEMs and Capacitor plugin
  versions report cancel differently.
- **No error path in the lock can ever call `setLocked(false)`**. The lock is
  only released by a successful authentication or by an explicit Sign Out.

---

## 6. App Lock

A second factor that gates app access **independently of the device's
screen-lock PIN/biometric**. The threat model is "attacker has unlocked
phone" — legitimate device PIN compromised, biometric coerced (lost finger,
evil twin, sleeping owner), or device unlocked when stolen.

Two completely separate backends, picked by platform — they share only
the lock-engagement plumbing in `auth-gate.tsx`:

| Platform  | Backend                                                                                                            | Verifier                                                                      | Hardware binding                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Android   | Numeric PIN via [`app-pin.ts`](../ui/src/lib/app-pin.ts) → Keystore                                                | `HMAC-SHA256(pin, K)` in `EncryptedSharedPreferences`                         | `K` is a non-extractable HMAC key inside Android Keystore. TEE/StrongBox-bound on most modern devices.                |
| Web / iOS | WebAuthn-PRF via [`webauthn.ts`](../ui/src/lib/webauthn.ts) + [`session-vault.ts`](../ui/src/lib/session-vault.ts) | AES-GCM blob encrypting the four session secrets, key derived from PRF output | Private key is generated and held inside the OS secure enclave / TPM / external authenticator. Browser never sees it. |

### Android storage ([`CarapaPin.kt`](../ui/android/app/src/main/java/ai/carapa/board/CarapaPin.kt))

**App PINs are bound to the user account, not the device.** Two users
sharing the same Android device keep separate PINs. A different user
logging in never inherits or has to bypass the previous user's PIN —
the lock-method probe (`appHasAppPin(userId)`) reports "no PIN" for a
user who hasn't set one. Logout is a no-op for the PIN, since the same
user logs back in and uses the same PIN.

Per-user namespaced keys in a single `EncryptedSharedPreferences` file
(`carapa_pin`, master key = Keystore-bound AES-256-GCM):

| Key                            | Contents                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `verifier_b64_<userId>`        | `HMAC-SHA256(pin, K_<userId>)` — base64                  |
| `duress_verifier_b64_<userId>` | `HMAC-SHA256(duressPin, K_<userId>)` — base64 (optional) |
| `failed_attempts_<userId>`     | counter feeding the kill-switch                          |

`K_<userId>` is a non-extractable HMAC key generated inside the Android
Keystore under alias `carapa_pin_hmac_<userId>`. On hardware-backed
devices (TEE / StrongBox) the key never leaves the secure element. The
per-user alias means that even if `K_userA` were somehow recovered, it
reveals nothing about `K_userB` — they're independent keys with
independent verifiers.

- The verifier on its own is useless — without the right Keystore HMAC
  key no candidate PIN can be tested off-device. `adb backup` blobs are
  inert.
- On-device brute-force is bounded by:
  - One Keystore HMAC call per attempt (the Keystore serializes operations
    on a single key).
  - The per-user kill-switch (next subsection).
- The plugin layer (`CarapaBridgePlugin.kt`) requires a non-empty
  `userId` on every PIN method and validates the charset (UUID /
  alphanumeric / `-_.`) so a maliciously-crafted id can't escape its
  namespace.

### Web/iOS storage ([`webauthn.ts`](../ui/src/lib/webauthn.ts) + [`session-vault.ts`](../ui/src/lib/session-vault.ts))

The web/iOS backend wraps the four session secrets — `auth_token`,
`device_id`, `device_pub_key`, `device_priv_key` — under a key derived
from a WebAuthn PRF assertion. Without a successful biometric, the
ciphertext on disk is undecryptable; with a successful biometric, the
plaintext lives only in module memory until the next lock engagement.

- **Credential ceremony**: `webauthnRegister` calls
  `navigator.credentials.create` with `userVerification: 'required'`,
  `residentKey: 'preferred'`, and the `prf` extension. The authenticator
  (Touch ID / Face ID / Windows Hello / hardware key with UV) generates
  a non-extractable private key inside the OS secure enclave and returns
  a credentialId.
- **PRF derivation**: `webauthnAssertWithPRF` runs `navigator.credentials.get`
  with `prf.eval.first = SHA-256("carapa-vault-v1")` (a static salt — the
  authenticator mixes it with credential-internal key material, so two
  different apps with the same input get different PRF outputs). The
  32-byte output is HKDF-SHA256'd to an AES-GCM 256 wrapping key.
- **Vault layout**: `localStorage.vault_v1` holds `{ iv, ciphertext }`
  over the JSON-encoded payload. `localStorage.webauthn_v1` holds
  `{ credentialId }` so the next assertion can target the same credential.
  When the vault is configured, the four legacy localStorage keys
  (`auth_token` etc.) are deleted to avoid plaintext residue.
- **Read path**: every `apiFetch` and the auth helpers go through
  `vaultGetAuthToken()` / `vaultGetDeviceCreds()`. When the vault is
  configured these return memory only; while locked they return `null`,
  which fails any in-flight signing attempt closed.
- **Lock engagement**: when `auth-gate.tsx`'s visibility-change handler
  decides to re-engage the lock (web/iOS, idle ≥ 60s), it calls
  `vaultClearMemory()`. From that moment until the next biometric
  unwrap, no API call can produce a valid signature.

Why no kill-switch / wrong-attempt counter on the web/iOS side: the OS
biometric subsystem already rate-limits assertion attempts at the
hardware layer (lockout after a few biometric failures, then OS-PIN
fallback, then a longer hardware lockout). The PRF output is only
released after a successful UV, so there's no offline brute-force
vector against the PIN — and no PIN to brute-force in the first place.

#### Origin requirements

WebAuthn is gated by browser security policy and won't run against:

- **Bare IP-address origins** (e.g. `https://192.168.1.10:3000`) — the
  spec requires the RP ID to be a domain. Browsers throw "The operation
  is insecure" before any prompt is shown.
- **Self-signed certs that aren't in the OS/browser trust store** — a
  click-through "accept the cert" doesn't qualify; WebAuthn requires the
  cert chain to validate cleanly.

Two practical deployment paths:

1. **Public domain via Cloudflare tunnel** (recommended). The tunnel's
   cert is publicly trusted; WebAuthn works in every browser with no
   client-side setup.
2. **Local hostname + imported cert**. The cert SAN list in
   [`scripts/generate-certs.sh`](../scripts/generate-certs.sh) already
   includes `DNS:carapa-board`. Map that to the server's IP via the
   client's hosts file and import `store/certs/ca.crt` (the local CA
   that signs `server.crt`) into the OS trusted-root store (and Firefox's
   separate cert store, if relevant).

If neither is available, leave biometric unlock disabled — the user
falls back to "no app-level lock" on web/iOS, which matches the
pre-WebAuthn baseline.

### Kill-switch (3 wrongs) — Android only

The `KILL_SWITCH_THRESHOLD` (`3`) policy lives in `CarapaPin.kt`. The
counter is **per-user** — User A's wrong attempts never count against
User B's quota. On the threshold-th consecutive wrong entry on User A's
verifier, native atomically:

1. Deletes the Keystore device-handshake key (`carapa_device_key`).
2. Clears the persisted `deviceId + apiBase` in `CarapaCredentials`.
3. Returns `KillSwitch` to JS.

JS then calls `logout()` to clear the session cookie and `auth_token`,
and `AuthGate` routes to `LoginForm`. User A's PIN HMAC key and
verifier are **preserved** (per-user, on a separate Keystore alias) —
the same PIN works after re-login. The failed-attempt counter is **NOT**
reset by the kill-switch itself; only a successful login by the same
user (`nativeResetAppPinAttempts(user.id)`) clears it. Otherwise an
attacker could brute-force in repeated 3-attempt batches indefinitely.

### Lifecycle (Android PIN)

- **Setup / Change / Remove**: `Account → Security → App PIN`. All three
  flows pass the current `userId` from `useAuth()` so they only affect
  the logged-in user's PIN. Change and Remove require entering the
  current PIN, which feeds the same per-user kill-switch counter — an
  attacker past the lock cannot silently rotate or remove the PIN by
  going through settings.
- **Reset on login**: every successful `login()` calls
  `nativeResetAppPinAttempts(user.id)`, giving the user a fresh quota
  of 3 attempts on **their** counter.
- **Logout preserves the PIN**: `logout()` does NOT touch any PIN. PINs
  are user-bound, not session-bound — the same user logs back in and
  uses the same PIN. A different user logging in next is gated by their
  own (possibly absent) PIN, never by the previous user's. The
  previously-supported `preservePin: true` flag has been removed;
  preservation is now the only behavior.
- **Verification status**: the `'wrong'` outcome carries `attemptsRemaining`
  so the UI can show "1 attempt left before the device is unregistered."

### Lifecycle (web/iOS biometric)

- **Set up**: `Account → Security → Set up biometric unlock`.
  `webauthnRegister` runs the create ceremony, derives the PRF wrap key,
  and `vaultWrapAndPersist` encrypts the current memory contents. The
  four legacy localStorage keys are deleted in the same step, so plain
  `auth_token` no longer exists at rest. The user is shown a success
  toast and the next reload will land on the lock screen.
- **Unlock**: `BiometricUnlockScreen` calls `webauthnAssertWithPRF` on
  user gesture (Safari requires a user gesture for the assertion) and
  `vaultUnwrapFromStorage` decrypts the blob into module memory.
- **Re-lock on idle**: the visibility-change handler in `auth-gate.tsx`
  calls `vaultClearMemory()` when the user returns after ≥ 60 s of no
  input. The wrapped blob stays on disk — the next unlock starts a fresh
  PRF assertion.
- **Remove**: `Account → Security → Remove biometric unlock`. Requires a
  successful biometric assertion (proving credential ownership), then
  `vaultRemoveBiometric` decrypts the blob and writes the four secrets
  back to plain localStorage. The user remains logged in. The OS
  credential isn't programmatically deletable from the web — it can be
  removed manually from the platform's password / passkey manager.
- **Logout**: clears module memory, deletes `vault_v1` and
  `webauthn_v1`, deletes the four legacy keys. The OS credential
  survives, but with no `vault_v1` to decrypt it's useless until the
  user re-runs setup post-login.
- **No kill-switch**: the OS rate-limits biometric attempts at the
  hardware layer; no app-level counter is needed.

---

## 7. Duress PIN

A third factor: a **separate** PIN that, when entered on the lock screen,
fires a duress alert to the user's main agent and atomically wipes the
device session. The coercer watching the screen sees a generic
"Connection failed" — indistinguishable from a real network outage.

**Android-only.** The duress flow relies on indistinguishable HMAC
verifiers and on the kill-switch atomically wiping a hardware-backed
key — neither is replicable on the WebAuthn-PRF backend, where unlock
is biometric (no PIN to substitute a duress version of), so the duress
card is hidden on web/iOS.

### Storage

- A second verifier (`duress_verifier_b64_<userId>`) stored alongside the
  normal one, computed with the same per-user Keystore HMAC key
  (`K_<userId>`). User-bound, like the normal PIN — User B's duress
  flow never uses User A's verifier.
- Setup rejects when:
  - No normal PIN is configured (`no_normal_pin`).
  - The duress verifier collides with the normal verifier — i.e. the same
    digit sequence (`same_as_normal`).
  - Length is out of range (`length`).

### Order of operations on duress entry

`nativeVerifyAppPin` checks the normal verifier first, then the duress
verifier. On a duress match, native returns `Duress` — it does **NOT**
fire the kill-switch. The JS layer is responsible for the cascade because
the duress-alert request must be signed by the still-valid device key:

1. `await sendDuressSignal()` — POST `/api/security/duress` with
   `{ timestamp, hint? }`, signed by the device key. Errors are swallowed
   on purpose: any observable failure mode (delay, error UI, retry) could
   tip off a coercer that the PIN they observed was a duress code.
2. `await clearNativeCredentials()` — wipes the Keystore device key + creds
   (same kill-switch effect as 3 wrongs). The PIN HMAC key + verifier
   survive.
3. `await logout()` — clears `auth_token` and session state. The PIN is
   not touched: logout never removes a PIN.
4. `setDuressMode(true)` on the auth store.

### Indistinguishable failure UI

When `duressMode === true`, `AuthGate` renders a fixed connection-error
screen ("Failed to reach the server. Please check your connection and try
again.") with a Retry button. The message is generic on purpose —
anything device-specific could differ from what a coercer expects of a
network outage. `duressMode` is **in-memory only**:

- Cold restart resets it to false. The legitimate user reloads or restarts
  and lands on `LoginForm` with a clean slate. They re-login (which
  re-bootstraps the device key) and the same normal PIN still works.
- The attacker, lacking credentials, is dead-ended at `LoginForm`. If they
  do have credentials and re-login, they face the PIN again; entering
  duress fires another alert, infinitely.

### Server-side handling

[`POST /api/security/duress`](../src/routes/security.ts), session-authenticated,
locates the requesting user's main group (`is_main && user_id ===
authUser.id`) and writes a chat message there. The alert lands in a conversation
in the user's main project and is answered by its agent:

```
🚨 DURESS SIGNAL · <ISO timestamp>
User: <username>
Hint: <optional hint string>
The user just entered their duress PIN. The device session has been
wiped (kill-switch fired) and the app is now showing a connection-error
screen to the holder of the device, indistinguishable from a real
network outage. Follow the per-user instructions configured in your
prompt to handle this signal.
```

Per-user response (call emergency, send GPS, notify a trusted contact)
lives in the agent's prompt configuration — outside the scope of this
client. The `hint` field is open-ended for future client-side context
(GPS coordinates, network info).

The endpoint always returns `200 { ok: true }` regardless of internal
state — same indistinguishability rationale as the client UI.

---

## 8. Biometric Authentication (saved-credentials shortcut)

Independent of the lock screen, the **LoginForm** offers an opt-in
"Login with Biometrics" shortcut. Powered by `capacitor-native-biometric`:

1. **Enrollment**: after a successful password login, the user is prompted
   "Enable biometric login for next time?" If accepted, the username +
   password are stored in `NativeBiometric.setCredentials({ server: 'carapa', ... })`,
   which encrypts them under a biometric-bound key.
2. **Storage**: the credentials live in the Android system's secure
   credential store, scoped to this app's UID. They do not appear in
   `localStorage` or any plain file.
3. **Login**: tapping "Login with Biometrics" runs a biometric prompt;
   on success the credentials are decrypted and POSTed to
   `/api/auth/login` like a normal credential login.

This shortcut is **separate** from the lock screen. Even with biometric
login configured, the App PIN gate (when set) still applies after login —
biometric access to the saved credentials does not bypass the PIN.

---

## 9. Context-Aware Network Routing

The app implements a self-healing router that switches between local LAN
and remote tunnel.

- **Auto-detection**: `useNetworkDetection` probes `${HOME_URL}/health` on
  startup, every 15 s, when the app returns to the foreground, and after a
  `@capacitor/network` change that reports connected (a burst at about 1 s,
  3 s and 8 s, because Wi-Fi is often not routable yet). Wi-Fi change events
  are never deduplicated (Android does not report the SSID); repeated
  identical events of other types are. Probes are serialized.
- **Manual switch**: on native, tapping the header connection indicator opens
  a menu with "Home / LAN" and "Remote / Cloud" (current one marked). It uses
  the same mode-change path as the detector (store, `API_BASE_URL`, forced
  WebSocket reconnect). Auto-detection keeps running afterwards, so a later
  probe may still change the mode. On web the indicator is display only.
- **Diagnostics**: the last LAN probe (time, outcome, error message) is logged
  with a `[NetworkDetection]` prefix and shown in the menu, e.g.
  "LAN check 12:03: failed: <message>" or "LAN reachable". Kept in memory only.
- **Failover**: if a request to the local IP fails (timeout or status
  0/503/504), `apiFetch` retries through the Cloudflare Tunnel URL.
- **Visual status**: a top-bar indicator shows
  `#10b981` Wifi (direct LAN) or `#60a5fa` Globe (Cloudflare Tunnel).
- **Server addresses**: the Home / LAN and Remote URLs are app settings
  (`carapa-server-config` in localStorage), edited with "Server" on the login
  screen only (native, signed out), and also on the "Connection Failed"
  screen shown when the startup auth check cannot reach the server (saving
  there retries the check). Stored values win; with nothing stored
  the build-time defaults from `ui/.env` apply (see "API URL configuration").
  A change takes effect without restarting the app.
- **One-URL mode**: if only one URL is set (or both resolve to the same
  origin) the Home / Remote picker and the header switch are hidden, the LAN
  `/health` probe and its timers do not run, and no remote retry happens.
- **Validation**: only `https://host[:port]` is accepted; userinfo, a path,
  query and fragment are rejected (`parseServerUrl`). The value is stored as
  a normalised origin. `apiFetch` sends credentials only to the current
  config's origins.
- **Credential wipe on change**: saving a config whose Home or Remote origin
  differs from the current one first drops the WebSocket,
  clears the native cookie jar (`CapacitorCookies.clearAllCookies`, since
  cookies are not port-scoped and work with the old server offline), the
  session vault (`vaultClearAll`), the saved-login shortcut (`deleteSecureCredentials`) and
  the native device key and credentials (`clearNativeCredentials`), then
  applies the new URLs (`applyServerConfig`). Saving unchanged origins or
  "Reset to app defaults" back to the same origins wipes nothing. The wipe
  fails closed: if the native credential clear fails, the previous config
  stays active and the editor shows an error. Sign-in is blocked while the
  editor is open, and a login that was already in flight when the server
  changed discards its result (config epoch check in `login`). A WebSocket token
  refresh that started before the change likewise discards its token instead
  of refilling the vault (`websocket-auth.ts`).

---

## 10. Operational Instructions

### Automated certificate management

```bash
./scripts/generate-certs.sh --force
./build.sh --sync
```

Restart the server after this: `docker compose restart carapa-board`.

The script needs no variable on a host where the board runs in Docker. It
resolves the certificate directory like `docker-compose.yml` resolves the
`/app/store` mount, first match wins:

1. `CARAPA_DATA_DIR` in the environment
2. the host source of the `/app/store` mount of the running `carapa-board`
   Compose container (`docker inspect`; used as `<source>/certs`)
3. `CARAPA_DATA_DIR` in `$CARAPA_BOARD_DEPLOY_DIR/.env`
4. `CARAPA_BOARD_SOURCE_DIR` (environment, then the deploy-dir `.env`)
5. `$CARAPA_BOARD_DEPLOY_DIR` itself (the Compose file directory)
6. `CARAPA_DATA_DIR` in the repo-root `.env`
7. the repo-local `./store/certs` (prints a warning)

In a git worktree, rule 7 uses the main checkout's `store/certs`. The script
prints the directory, the rule that chose it and the certificate's SHA-256.
Neither it nor `ui/android/install-apk.sh` copies the certificate into the APK;
phones trust it through a pin from the pairing link or a CA installed on the
phone.

### Pairing info endpoint

`GET /api/android/pairing-info` returns what a new app needs to pin this board.
It requires a signed-in user session (agent and task tokens are rejected) and is
sent with `Cache-Control: no-store`:

```json
{ "otaPublicKey": "<base64>" | null }
```

- `otaPublicKey`: base64 of the raw 32-byte Ed25519 public key derived from the
  OTA signing private key; `null` when no valid key is available. The private
  key is never returned or logged.

`GET /api/android/presented-cert?url=<https origin>` returns the certificate a
phone would see at that address, with the same authentication and caching:

```json
{ "certSha256": "<64 lowercase hex chars>" | null, "trusted": true | false }
```

The board opens a TLS connection to the address (handshake only, no request,
5-second limit) and returns the SHA-256 over the DER of the leaf it presents.
This is the certificate of whatever answers at that address, including a reverse
proxy in front of the board, not the board's own listener. `trusted` says
whether the board's CA store accepts the chain and host name. `certSha256` is
`null` when the address cannot be reached. Any signed-in user can make the board
connect to an https address of their choice this way; only the fingerprint is
returned.

### API URL configuration

Edit `ui/.env`:

- **Remote**: `VITE_API_URL=https://your-public-domain.com`
- **Local**: `VITE_LOCAL_IP=192.168.1.10`

These are only the defaults, and both may be left empty: a build without any
default has no server until the user stores one (the app then shows a setup
screen and sends no request). Users can override both addresses in the app
(login screen, "Server"); "Reset to app defaults" returns to the `ui/.env`
values compiled into the APK.

**Setup link / QR code.** In the web UI, Account → Devices → "Connect the
Android app" turns the two addresses into a QR code and a copyable link; scan it
with the phone camera. The page's own origin fills the Home or Remote field
(whichever side the browser is on); the other field starts with the web build's
`VITE_LOCAL_IP` (`https://<ip>:3000`) or `VITE_API_URL` address when the two
differ. A Home address that points at the Board's LAN IP only works when the
Board is published beyond loopback: set `CARAPA_BOARD_BIND=0.0.0.0` (or that LAN
address) in `.env` (see the README's _Network access_ section). The link format
is versioned:

```
carapaboard://server?v=1&home=<urlencoded https origin>&remote=<urlencoded https origin>[&homeCert=<64 hex>][&remoteCert=<64 hex>][&otaKey=<urlencoded base64>]
```

`home` and `remote` are each optional but at least one is required. Every
address goes through the same validation as the login-screen editor (https
only; no user name, password, path or query). A `v` other than `1` is rejected
and unknown parameters are ignored. The link carries no secrets.

Optional trust parameters, still `v=1` (links without them behave as before):

- `homeCert` / `remoteCert`: SHA-256 fingerprint (64 hex chars, case-insensitive,
  stored lowercase) of the certificate to pin for that address. Each needs its
  `home` / `remote` address.
- `otaKey`: base64 of the 32-byte Ed25519 OTA public key.

A malformed value, or a cert parameter without its address, makes the whole link
invalid and nothing is applied. The web card asks
`GET /api/android/presented-cert` for each address once typing pauses, and
offers a "pin" checkbox showing that fingerprint (default on when the
certificate is not publicly trusted). It shows no QR code until every address
has been read. `otaKey` (from `GET /api/android/pairing-info`) is included
whenever the board returns one. The app's
confirmation dialog lists, per address, the pinned fingerprint or "Needs a
publicly trusted certificate or a CA installed on this device", and the OTA key prefix, before anything is
applied.

Pins and the OTA key reach the app only through the link/QR, never from the
server at runtime. They are stored with the server addresses; `CarapaTls`
enforces the pins and the paired `otaKey` is used first for OTA manifest
verification (the APK's embedded key is only a fallback). Changing a pin or
the key for the same origin wipes credentials like an origin change. In the
login-screen editor, editing an address drops that address's pin, and the OTA key
is kept only when neither address changed. The editor shows each address's pin
state, asks before a save or "Reset to app defaults" drops a pin or the key, and
points hand-typed addresses to the setup QR.

Any app or web page can fire this link, so it never applies silently:

- signed out: the app shows the full Home and Remote origins and applies them
  only after "Use this server" (same save path as the editor, including the
  credential wipe); "Cancel" changes nothing;
- signed in: nothing changes; the app shows a notice that the server can only
  be changed after signing out;
- invalid or unsupported links show an error and change nothing.

### Managing registered devices

Public keys are stored in the `device_keys` table. View / manage with
Drizzle Studio:

```bash
npx drizzle-kit studio
```

When the kill-switch fires (or the user wipes app data), the next login
re-bootstraps a fresh keypair and registers the new public key.

### Verifying Keystore hardware backing

After a fresh install + login, check Logcat:

```bash
adb -s <SERIAL> logcat -d -T 200 CarapaKeystore:I '*:S'
```

Expected output:

```
I CarapaKeystore: bootstrap: hasKey=true isInsideSecureHardware=true securityLevel=TRUSTED_ENVIRONMENT
```

`STRONGBOX` is better; `SOFTWARE` is a warning sign. Pre-Android-12
devices may show `securityLevel=null`; trust the `isInsideSecureHardware`
boolean instead.

---

## 11. Troubleshooting

### Manual APK push (bypassing the IDE)

Android Studio is sensitive — if the phone takes 500ms too long to
respond, Studio kills the ADB link. To get a real error message, install
manually:

1. In Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
2. Click "locate" in the bottom-right popup to find `app-debug.apk`.
3. From a terminal in that folder: `adb install -r app-debug.apk`.

If it says `Success`, the problem was Studio's timeout. If it returns a
specific error (e.g. `INSTALL_FAILED_DUPLICATE_PERMISSION`,
`INSTALL_FAILED_INVALID_APK`), that's the real cause.

### Migrating off a stale pre-Keystore session

Pre-Keystore builds stored the device private key plain in `localStorage`.
On the first launch of a Keystore-aware build, `AuthGate` detects the
mismatch (`hasNativeCredentials() === false` while `authenticated === true`)
and forces a re-login. The localStorage `device_id` / `device_pub_key` /
`device_priv_key` keys are wiped before logout.

### Recovering a forgotten App PIN (Android)

There is no in-app recovery path for a forgotten PIN, by design:

- **Sign out** and logging in again does not remove it. `logout()` keeps the
  PIN, and after login `finishLogin()` locks the app again whenever
  `hasAppPin(userId)` is true. A password login only resets the
  failed-attempt counter.
- **Change PIN** and **Remove PIN** under **Account → Security** verify the
  current PIN first, and that screen is behind the lock.
- Three wrong entries fire the kill-switch, which unregisters the device
  but keeps the PIN (see below).
- The PIN never leaves the device, so neither the server nor an
  administrator can reset it.

The PIN exists only in the app's private storage: the verifier in the
`carapa_pin` EncryptedSharedPreferences and its HMAC key under the Keystore
alias `carapa_pin_hmac_<userId>`. The only code path that deletes them is
`CarapaPin.clearPin()`, reached from **Remove PIN** after the current PIN was
verified. To get rid of a forgotten PIN, delete the app's storage instead:
Android **Settings → Apps → CarapaBoard → Storage → Clear storage**, or
uninstall and reinstall the app.

This removes all local state of the app, not only the PIN: other users' PINs
on the device, the server address and the device registration. Set the app
up again (server address or pairing link, then log in). It then registers as
a new device and waits for approval under **Devices** from an already
approved device. If no approved device is left, use the database command in
the README's Verify section.

### Recovering after a kill-switch (Android)

The device key is gone after a kill-switch, but the PIN survives. Log in
again from `LoginForm`; `bootstrapDevice` mints a fresh Keystore key, the
server registers the new public key, and the failed-attempt counter resets
to 0. The same PIN works.

### Recovering biometric unlock (web/iOS)

If the WebAuthn credential is gone (cleared site data, switched browser,
deleted from the OS passkey manager) the wrapped vault can no longer be
decrypted. From the lock screen, tap **Sign out** → log in again → re-run
**Set up biometric unlock** under Account → Security with whatever
authenticator the device exposes now. No server-side state is involved
in this recovery — it's purely a client-local re-enrollment.

### "The operation is insecure" on web/iOS biometric setup

Surfaced by Firefox / Edge when WebAuthn refuses the origin itself. Two
common causes:

- The page is served from a bare IP origin (e.g. `https://192.168.1.10:3000`).
  WebAuthn requires a domain RP ID — switch to the Cloudflare tunnel URL
  or to a hosts-file-mapped name covered by the cert SAN.
- The cert chain doesn't validate cleanly. Self-signed certs need to be
  imported into the OS / browser trusted-root store (a click-through
  accept isn't enough for WebAuthn).

`localhost` is the only origin where WebAuthn works without a publicly
trusted cert.
