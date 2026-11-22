# FCM Setup — Android Push Notifications

This guide walks through creating the Firebase Cloud Messaging (FCM) project and obtaining the two credential files CarapaBoard needs in order to push notifications to Android devices.

You will end up with **two separate JSON files**, used in different places:

| File                   | Goes to                                                   | Purpose                                             |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `google-services.json` | `ui/android/app/google-services.json`                     | Identifies the Android app to FCM (client-side)     |
| Service account JSON   | Path pointed to by `FCM_SERVICE_ACCOUNT_PATH` on the host | Backend credential for sending pushes (server-side) |

Both files are secrets — never commit either one.

---

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with the Google account that should own the project.
2. Click **Add project** → name it (e.g. `carapa-board`) → disable Google Analytics unless you want it → **Create**.
3. Note the **Project ID** shown on the project overview. This is the value for `FCM_PROJECT_ID` (it appears in the FCM v1 endpoint URL: `/v1/projects/<id>/messages:send`).

Firebase creates a matching Google Cloud project in the background. FCM is free at any volume — the only paid Firebase products are Firestore, Cloud Functions, etc., which CarapaBoard does not use.

---

## 2. Register the Android app → `google-services.json`

1. On the Firebase project overview, click the **Android icon** ("Add app").
2. **Android package name**: must match `applicationId` in `ui/android/app/build.gradle`. Verify before continuing.
3. App nickname: optional. SHA-1: skip (only required for Firebase Auth / Dynamic Links, not FCM).
4. Click **Register app**.
5. Click **Download `google-services.json`**. Save the file to:
   ```
   ui/android/app/google-services.json
   ```
6. Skip the rest of the wizard (the Gradle plugin steps are already covered by the implementation plan).

**Every Android build requires this file.** `ui/android/app/build.gradle` fails the build with a "Missing or empty ... google-services.json" error when it is absent (debug and release, no opt-out). `ui/android/install-apk.sh` run in a git worktree copies the file from the main checkout (`ui/android/app/google-services.json` there) when the worktree has none, exits before building when neither location has it, and after the build checks that the APK contains the `google_app_id` resource (needs `aapt2` or `apkanalyzer` in the Android SDK; otherwise it prints a note and skips). If an APK without Firebase is installed anyway, the app does not crash; it shows the toast "Push notifications are not included in this app build. Reinstall a build that contains Firebase."

This file is bundled into the APK. It is not strictly secret — it can be extracted from any installed APK — but treat it as private anyway and keep it out of git (`.gitignore` already excludes it via the existing secrets rules).

---

## 3. Generate the service account key → backend credential

This is the credential `src/modules/push/fcm-sender.ts` reads to mint OAuth tokens for `messages:send`.

1. In Firebase console, click the **gear icon → Project settings**.
2. Open the **Service accounts** tab.
3. In the "Firebase Admin SDK" section, click **Generate new private key**.
4. Confirm the dialog. A file like `carapa-board-firebase-adminsdk-XXXXX-YYYYY.json` downloads.

⚠️ **This file is downloaded once and cannot be re-downloaded.** If you lose it, you must generate a new key and revoke the old one from the same screen. Keep a backup somewhere safe (1Password, encrypted vault, etc.).

The contents look like:

```json
{
  "type": "service_account",
  "project_id": "carapa-board-...",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...",
  "client_email": "firebase-adminsdk-...@....iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  ...
}
```

---

## 4. Place the service account JSON on the host

The host is the machine running the CarapaBoard container — not inside any container, not in the repo.

```bash
sudo mkdir -p /etc/carapa/secrets
sudo mv ~/Downloads/carapa-board-firebase-adminsdk-*.json \
       /etc/carapa/secrets/fcm-service-account.json
sudo chmod 600 /etc/carapa/secrets/fcm-service-account.json
```

Mount it into the CarapaBoard container as a Docker secret or read-only bind mount, e.g. in `docker-compose.yml`:

```yaml
services:
  carapa-board:
    volumes:
      - /etc/carapa/secrets/fcm-service-account.json:/run/secrets/fcm-service-account.json:ro
    environment:
      FCM_PROJECT_ID: carapa-board-...
      FCM_SERVICE_ACCOUNT_PATH: /run/secrets/fcm-service-account.json
```

---

## 5. Confirm Cloud Messaging API v1 is enabled

Firebase enables FCM v1 by default for new projects, but verify:

1. Project settings → **Cloud Messaging** tab.
2. **"Firebase Cloud Messaging API (V1)"** should show as _Enabled_. If it shows "Manage API", click through and enable it in the GCP console.
3. The legacy **"Cloud Messaging API"** (server-key flavor) can stay disabled — CarapaBoard only uses V1.

---

## 6. Quick sanity check (before running the app)

You can verify the service account JSON is valid with `curl`, before any client code is wired up.

```bash
# Mint an access token from the JSON (use any JWT helper, or a short script).
# Required scope: https://www.googleapis.com/auth/firebase.messaging

# Then send to a fake device token — expect 404 NOT_FOUND or 400 INVALID_ARGUMENT,
# which proves the credential is valid (only the device token is wrong).
curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":{"token":"fake","notification":{"title":"t","body":"b"}}}' \
  "https://fcm.googleapis.com/v1/projects/$FCM_PROJECT_ID/messages:send"
```

Interpretation:

| Response                                        | Meaning                                                         |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `404 UNREGISTERED` or `400 INVALID_ARGUMENT`    | Credential is valid; only the device token is wrong (expected). |
| `401 UNAUTHENTICATED` / `403 PERMISSION_DENIED` | JSON or scope is wrong.                                         |
| `404 NOT_FOUND` on the project URL              | `FCM_PROJECT_ID` is wrong.                                      |

---

## Environment variable summary

| Variable                   | Required       | Description                                                     |
| -------------------------- | -------------- | --------------------------------------------------------------- |
| `FCM_PROJECT_ID`           | yes (for push) | Firebase project ID, used in the v1 endpoint URL.               |
| `FCM_SERVICE_ACCOUNT_PATH` | yes (for push) | Absolute path inside the container to the service-account JSON. |

If either is unset, the `notify_user` tool returns the note "push notifications are disabled on this server" rather than crashing.

---

## Security notes

- The service-account JSON grants the holder permission to send pushes to **any** device registered to this Firebase project. Treat it like a database password.
- `google-services.json` is shipped in the APK and is not a secret in the cryptographic sense, but is still kept out of git.
- Push payloads transit Google's servers in cleartext (TLS to FCM, then FCM to device). For sensitive content, send a "ping" payload and have the app fetch the real content from CarapaBoard over its existing authenticated channel.
- If a service-account key is ever leaked, revoke it immediately from **Project settings → Service accounts** and generate a new one.

---

## Troubleshooting

| Symptom                                        | Likely cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 UNAUTHENTICATED`                          | Wrong scope on the JWT (must be `https://www.googleapis.com/auth/firebase.messaging`) or expired access token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `403 PERMISSION_DENIED`                        | Service account lacks the "Firebase Admin SDK Administrator Service Agent" role — generate a fresh key from the **Service accounts** tab (it's auto-roled correctly there).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `404 NOT_FOUND` on `messages:send`             | `FCM_PROJECT_ID` doesn't match the project that owns the service account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| App registers but no token arrives in the DB   | `applicationId` in `build.gradle` doesn't match what's registered in Firebase, or `google-services.json` is outdated. A missing file now fails the build instead of producing a push-less APK; an already installed push-less APK shows "Push notifications are not included in this app build" in the app and `notify_user` returns `push_warning: no push device registered`.                                                                                                                                                                                                                                                                                                                                                    |
| Push delivered but never appears on device     | Battery optimizations / Doze killing the app — this is an Android-side device setting, not an FCM problem. Test with the screen on first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Payload visible in the app but no push arrives | Check `board.log` for `[push] dispatch`. `outcome=no_tokens token_count=0` means no row in `device_push_tokens`: the app must re-register (`POST /api/devices/push-token`; `GET /api/devices/push-token/status` tells it whether the stored token matches). `notify_user` then also returns `push_warning`. If `outcome=sent` with `delivered_count=0`, look for `[FCM] ... error_code=` lines (they never contain the token). `UNREGISTERED`/`NOT_FOUND` delete the token (dead device). `INVALID_ARGUMENT` and `SENDER_ID_MISMATCH` keep it and log a warning: `SENDER_ID_MISMATCH` means the APK's `google-services.json` belongs to a different Firebase project than `FCM_PROJECT_ID`; fix the project/APK, then re-register. |

### `notify_user` recipients and `skipped`

- Without `username`, a text notification goes to the entity owner (else the project owner) and the user who triggered the run.
- `username` is **exclusive**: only that user is notified. The owner and the triggerer get nothing unless one of them is that user. Forms ignore this and always go to the triggerer (or the owner).
- The result lists `skipped: [{ username, reason }]` for every recipient who got no push. `reason` is `not_opted_in` (the member has not enabled push for this project), `not_member`, or `no_device` (no push device registered). The in-app payload is still stored for them. If every recipient is skipped, `note` says so; `push_warning` is kept for the `no_device` case. When push is not configured on the server (no FCM credentials), nobody is pushed and `note` says "push notifications are disabled on this server"; this is not a per-recipient `skipped` reason.
- A member receives push from a non-main project only after enabling **Receive push notifications from this project** (Project settings → Preferences). Members of a main project are opted in by default.

### When the app re-registers its token

On every unlocked authenticated start (password sign-in, biometric session restore with or without an app PIN, and PIN unlock) and on every return to the foreground (at most once per 10 minutes) the app asks FCM for its current token and calls `GET /api/devices/push-token/status`. It does **not** POST while the server reports `registered: true` and `token_matches: true`. It re-registers (`POST /api/devices/push-token`, up to 3 attempts with a short backoff) only when the server has no row for the device, holds a different token, or FCM gives no token. In the last case the app deletes the Firebase instance token natively and requests a fresh one, once per app start. If the server still reports a mismatch after a re-register, the app logs a warning (`[push] ...` in the WebView console) and waits for the next start or foreground. To force a re-register, delete the row in `device_push_tokens` and bring the app to the foreground (after the 10-minute throttle) or restart it.
