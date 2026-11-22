package ai.carapa.board

import android.os.Build
import android.util.Log
import java.io.File
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import ee.forgr.capacitor_updater.CapacitorUpdaterPlugin
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID

/**
 * JS↔native bridge.
 *
 * - `bootstrapDevice({apiBase})` lazily generates a Keystore-bound P-256
 *   keypair (see [CarapaKeystore]) and a stable device id, persisting
 *   the apiBase in [CarapaCredentials] for the FCM service. Idempotent.
 * - `signPayload({payload})` signs through the Keystore — JS never sees
 *   the private key.
 * - `hasCredentials()` reports whether the device is fully bootstrapped.
 * - `clearCredentials()` is for explicit reset only; logout does NOT call
 *   it (the keypair is per-device, not per-session).
 * - The plugin emits a `notifTap` event when [MainActivity] is launched
 *   with a `carapa_notif_id` intent extra.
 */
@CapacitorPlugin(name = "CarapaBridge")
class CarapaBridgePlugin : Plugin() {

    private val embeddedActivationMarker = "carapa-activate-embedded-once"
    private val embeddedPinPendingMarker = "carapa-embedded-pin-pending"
    private val embeddedPinFile = "carapa-embedded-pin.json"

    /** Immutable information baked into the installed APK, not an OTA bundle. */
    @PluginMethod
    fun getOtaShellInfo(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("nativeVersionCode", BuildConfig.VERSION_CODE)
                .put("nativeVersionName", BuildConfig.VERSION_NAME)
                .put("builtinBundleVersion", BuildConfig.ANDROID_OTA_BUILTIN_VERSION)
                .put("builtinBundleGeneration", BuildConfig.ANDROID_OTA_BUILTIN_GENERATION)
                .put("publicKey", BuildConfig.ANDROID_OTA_PUBLIC_KEY)
        )
    }

    /** Consume the install script's one-shot request to select the APK bundle. */
    @PluginMethod
    fun consumeEmbeddedBundleActivation(call: PluginCall) {
        // The debug installer creates this app-private marker through
        // `run-as`; no exported activity intent can replay or forge it.
        val marker = File(context.filesDir, embeddedActivationMarker)
        call.resolve(JSObject().put("activate", marker.exists()))
    }

    /** Acknowledge the fallback reset only after CapacitorUpdater succeeds. */
    @PluginMethod
    fun acknowledgeEmbeddedBundleActivation(call: PluginCall) {
        File(context.filesDir, embeddedActivationMarker).delete()
        armEmbeddedBundlePin()
        call.resolve()
    }

    /**
     * After an installer-requested activation, the server bundle already
     * published at install time is not an update for the embedded bundle.
     * JS records that generation once (`pending`) and later offers only
     * newer generations while the embedded bundle stays active.
     */
    private fun armEmbeddedBundlePin() {
        File(context.filesDir, embeddedPinFile).delete()
        File(context.filesDir, embeddedPinPendingMarker).createNewFile()
    }

    @PluginMethod
    fun getEmbeddedBundlePin(call: PluginCall) {
        val result = JSObject()
            .put("pending", File(context.filesDir, embeddedPinPendingMarker).exists())
        try {
            val pin = File(context.filesDir, embeddedPinFile)
            if (pin.exists()) {
                val stored = JSObject(pin.readText())
                result.put("generation", stored.getInt("generation"))
                result.put("builtinVersion", stored.getString("builtinVersion"))
            }
        } catch (error: Exception) {
            Log.w("CarapaBridge", "Ignoring unreadable embedded bundle pin", error)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun setEmbeddedBundlePin(call: PluginCall) {
        val generation = call.getInt("generation")
        val builtinVersion = call.getString("builtinVersion")
        if (generation == null || generation < 0 || builtinVersion.isNullOrEmpty()) {
            call.reject("generation and builtinVersion are required", "BAD_PAYLOAD")
            return
        }
        File(context.filesDir, embeddedPinFile).writeText(
            JSObject()
                .put("generation", generation)
                .put("builtinVersion", builtinVersion)
                .toString()
        )
        File(context.filesDir, embeddedPinPendingMarker).delete()
        call.resolve()
    }

    /**
     * Replace the per-server certificate pins (`[{origin, certSha256}]`; an
     * empty list clears them). Each is an additional trust anchor for that one
     * https origin, enforced for the WebView and native HTTP (see [CarapaTls]).
     */
    @PluginMethod
    fun setServerPins(call: PluginCall) {
        val entries = call.getArray("pins")
        if (entries == null) {
            call.reject("pins is required", "BAD_PAYLOAD")
            return
        }
        val pins = mutableListOf<ServerPin>()
        for (i in 0 until entries.length()) {
            val entry = entries.optJSONObject(i)
            val pin = entry?.let { CertPinPolicy.parsePin(it.optString("origin"), it.optString("certSha256")) }
            if (pin == null) {
                call.reject("pins[$i] needs an https origin and a SHA-256 fingerprint", "BAD_PAYLOAD")
                return
            }
            pins.add(pin)
        }
        try {
            CarapaTls.setPins(context.applicationContext, pins)
            call.resolve()
        } catch (e: Exception) {
            call.reject("could not store pins: ${e.message}", "PINS_ERROR")
        }
    }

    /** Stream a manually requested message asset straight to the native cache. */
    @PluginMethod
    fun cacheSpeech(call: PluginCall) {
        val conversationId = call.getString("conversationId")
        val messageId = call.getString("messageId")
        if (conversationId.isNullOrBlank() || messageId.isNullOrBlank()) {
            call.reject("conversationId and messageId are required", "BAD_PAYLOAD")
            return
        }
        Thread {
            val file = DeviceTts.speechFile(context.applicationContext, conversationId, messageId)
            if (file == null) {
                call.reject("speech download failed", "SPEECH_DOWNLOAD_FAILED")
                return@Thread
            }
            call.resolve(JSObject().put("uri", android.net.Uri.fromFile(file).toString()))
        }.start()
    }

    @PluginMethod
    fun enqueueSpeech(call: PluginCall) {
        val conversationId = call.getString("conversationId")
        val messageId = call.getString("messageId")
        val sessionId = call.getString("sessionId")
        if (conversationId.isNullOrBlank() || messageId.isNullOrBlank() || sessionId.isNullOrBlank()) {
            call.reject("conversationId, messageId, and sessionId are required", "BAD_PAYLOAD")
            return
        }
        Thread {
            if (!CarapaSpeechService.speakReply(context.applicationContext, conversationId, messageId, sessionId)) {
                call.reject("speech download failed", "SPEECH_DOWNLOAD_FAILED")
                return@Thread
            }
            call.resolve()
        }.start()
    }

    @PluginMethod
    fun activateSpeechSession(call: PluginCall) {
        val sessionId = call.getString("sessionId")
        if (sessionId.isNullOrBlank()) {
            call.reject("sessionId is required", "BAD_PAYLOAD")
            return
        }
        CarapaSpeechService.activateSession(context.applicationContext, sessionId)
        call.resolve()
    }

    @PluginMethod
    fun stopSpeech(call: PluginCall) {
        val sessionId = call.getString("sessionId")
        if (sessionId.isNullOrBlank()) {
            call.reject("sessionId is required", "BAD_PAYLOAD")
            return
        }
        CarapaSpeechService.stop(context.applicationContext, sessionId)
        call.resolve()
    }

    override fun load() {
        super.load()

        // This runs during native plugin initialization, before the WebView can
        // load an older selected OTA bundle.
        val marker = File(context.filesDir, embeddedActivationMarker)
        if (marker.exists()) {
            try {
                val handle = bridge.getPlugin("CapacitorUpdater")
                val updater = handle?.let {
                    if (it.getInstance() == null) it.load()
                    it.getInstance()
                } as? CapacitorUpdaterPlugin
                if (updater == null || !updater.resetToBuiltinForCarapa()) {
                    Log.e("CarapaBridge", "Failed to activate embedded bundle")
                } else {
                    marker.delete()
                    armEmbeddedBundlePin()
                }
            } catch (error: Exception) {
                Log.e("CarapaBridge", "Failed to activate embedded bundle", error)
            }
        }

        instance = this
        // Drop any leftover plaintext private key from older app versions
        // that mirrored it into EncryptedSharedPreferences. Idempotent.
        try {
            CarapaCredentials.clearLegacyPrivateKey(context)
        } catch (_: Exception) {
            // Best-effort cleanup; not fatal if it fails.
        }
        // Drain anything queued before this plugin was wired up (cold launch).
        pendingNotifId?.let { emitNotifTap(it) }
        pendingNotifId = null
    }

    override fun handleOnDestroy() {
        if (instance === this) instance = null
        super.handleOnDestroy()
    }

    /**
     * Initialize this device: ensure the Keystore-bound keypair exists,
     * mint a stable deviceId on first run, persist the apiBase. Returns
     * `{ deviceId, publicKey }` so JS can register with the server.
     *
     * Idempotent. Subsequent calls return the same deviceId + publicKey
     * and just refresh the apiBase (which can change as the failover
     * URL flips between LAN and WAN).
     */
    @PluginMethod
    fun bootstrapDevice(call: PluginCall) {
        val apiBase = call.getString("apiBase")
        val remoteApiBase = call.getString("remoteApiBase")
        if (apiBase.isNullOrEmpty()) {
            call.reject("apiBase is required", "BAD_PAYLOAD")
            return
        }
        try {
            val publicKey = CarapaKeystore.ensureKey()
            val deviceId = bootstrapCredentials(apiBase, remoteApiBase)
            // Log once where the key actually lives so we can verify on a
            // real device without needing UI plumbing for the diagnostic.
            // Look for tag `CarapaKeystore` in Logcat after first login.
            try {
                val info = CarapaKeystore.describe()
                Log.i(
                    "CarapaKeystore",
                    "bootstrap: hasKey=${info.hasKey} " +
                        "isInsideSecureHardware=${info.isInsideSecureHardware} " +
                        "securityLevel=${info.securityLevel}",
                )
            } catch (_: Exception) {
                // Diagnostic only — never fail bootstrap because logging blew up.
            }
            val result = JSObject()
                .put("deviceId", deviceId)
                .put("publicKey", publicKey)
            call.resolve(result)
        } catch (e: Exception) {
            val detail = "${e::class.java.simpleName}: ${e.message ?: "no error message"}"
            Log.e("CarapaBridge", "bootstrapDevice failed: $detail", e)
            call.reject("bootstrap failed: $detail", "BOOTSTRAP_ERROR")
        }
    }

    private fun bootstrapCredentials(apiBase: String, remoteApiBase: String?): String {
        val existing = CarapaCredentials.read(context)
        val deviceId = existing?.deviceId ?: ("dev-" + UUID.randomUUID().toString())
        CarapaCredentials.set(context, deviceId, apiBase, remoteApiBase)
        return deviceId
    }

    /**
     * Wipe device identity: delete the Keystore alias AND the persisted
     * deviceId/apiBase. Use only for explicit "reset device" flows. Not
     * called on regular logout — the keypair is per-device.
     */
    @PluginMethod
    fun clearCredentials(call: PluginCall) {
        try {
            CarapaKeystore.deleteKey()
            CarapaCredentials.clear(context)
            call.resolve()
        } catch (e: Exception) {
            call.reject("clear failed: ${e.message}", "CLEAR_ERROR")
        }
    }

    /**
     * Sign a request payload with the Keystore-bound private key. The
     * private key never leaves the secure element on hardware-backed
     * devices — this method returns only the signature.
     *
     * Returns: { signature: base64 P1363 r||s, deviceId: string }
     */
    @PluginMethod
    fun signPayload(call: PluginCall) {
        val payload = call.getString("payload")
        if (payload.isNullOrEmpty()) {
            call.reject("payload is required", "BAD_PAYLOAD")
            return
        }
        val creds = CarapaCredentials.read(context)
        if (creds == null || !CarapaKeystore.hasKey()) {
            call.reject("device not bootstrapped", "NO_CREDENTIALS")
            return
        }
        try {
            val signature = CarapaKeystore.sign(payload)
            val result = JSObject()
                .put("signature", signature)
                .put("deviceId", creds.deviceId)
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("sign failed: ${e.message}", "SIGN_ERROR")
        }
    }

    /** Returns { hasCredentials: boolean } — true iff the Keystore alias
     *  AND the persisted deviceId/apiBase are both present. */
    @PluginMethod
    fun hasCredentials(call: PluginCall) {
        val present = CarapaKeystore.hasKey() && CarapaCredentials.read(context) != null
        val result = JSObject().put("hasCredentials", present)
        call.resolve(result)
    }

    /**
     * Reports whether the device has at least one usable unlock method
     * (biometric OR PIN/pattern/password). The lock-engagement decisions
     * in the JS layer (visibility handler, push gatedNavigate, retraction)
     * are gated on this — engaging the lock when no auth method exists
     * would just trap the user.
     */
    @PluginMethod
    fun canVerifyUser(call: PluginCall) {
        val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }
        val code = BiometricManager.from(context).canAuthenticate(authenticators)
        val result = JSObject()
            .put("canVerify", code == BiometricManager.BIOMETRIC_SUCCESS)
            .put("code", code)
        call.resolve(result)
    }

    /**
     * Diagnostic — reports where the device key actually lives. Use to
     * verify hardware-backed Keystore is active on a given device. Logged
     * once at app boot via [load], also queryable from JS for UI display.
     */
    @PluginMethod
    fun getKeystoreInfo(call: PluginCall) {
        val info = CarapaKeystore.describe()
        val result = JSObject()
            .put("hasKey", info.hasKey)
            .put("isInsideSecureHardware", info.isInsideSecureHardware)
            .put("securityLevel", info.securityLevel)
        call.resolve(result)
    }

    // ──── App PIN ────────────────────────────────────────────────────
    // Independent of the device's screen-lock PIN, and bound to a USER
    // ACCOUNT (not the device) — every PIN operation requires a userId.
    // See [CarapaPin] for storage shape and threat model. The native
    // side never returns the PIN itself or its verifier — only
    // success/failure outcomes.

    private fun requireUserId(call: PluginCall): String? {
        val userId = call.getString("userId")
        if (userId.isNullOrEmpty()) {
            call.reject("userId is required", "BAD_PAYLOAD")
            return null
        }
        return userId
    }

    @PluginMethod
    fun setAppPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        val pin = call.getString("pin")
        if (pin.isNullOrEmpty()) {
            call.reject("pin is required", "BAD_PAYLOAD")
            return
        }
        if (pin.length < CarapaPin.MIN_PIN_LEN || pin.length > CarapaPin.MAX_PIN_LEN) {
            call.reject(
                "pin length must be ${CarapaPin.MIN_PIN_LEN}..${CarapaPin.MAX_PIN_LEN}",
                "PIN_LENGTH",
            )
            return
        }
        try {
            CarapaPin.setupPin(context, userId, pin)
            call.resolve()
        } catch (e: CarapaPin.PinSetupError) {
            call.reject(e.message ?: "setup failed", "PIN_SETUP_ERROR")
        } catch (e: Exception) {
            call.reject("setup failed: ${e.message}", "PIN_SETUP_ERROR")
        }
    }

    @PluginMethod
    fun verifyAppPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        val pin = call.getString("pin")
        if (pin.isNullOrEmpty()) {
            call.reject("pin is required", "BAD_PAYLOAD")
            return
        }
        val out = JSObject()
        when (val r = CarapaPin.verifyPin(context, userId, pin)) {
            is CarapaPin.VerifyResult.Ok -> {
                out.put("ok", true)
            }
            is CarapaPin.VerifyResult.NoPin -> {
                out.put("ok", false).put("reason", "no_pin")
            }
            is CarapaPin.VerifyResult.Wrong -> {
                out
                    .put("ok", false)
                    .put("reason", "wrong")
                    .put("failedAttempts", r.failedAttempts)
                    .put("attemptsRemaining", r.attemptsRemaining)
            }
            is CarapaPin.VerifyResult.KillSwitch -> {
                // Kill-switch already wiped the Keystore device key + creds.
                // JS still has to clear auth_token + setAuth(false) so the
                // session-state side effects converge.
                out
                    .put("ok", false)
                    .put("reason", "kill_switch")
                    .put("failedAttempts", r.failedAttempts)
            }
            is CarapaPin.VerifyResult.Duress -> {
                // The duress PIN was entered. Native does NOT fire the
                // kill-switch here — JS needs the device key intact to
                // sign the duress-alert request, then JS calls
                // clearCredentials() to fire the kill-switch itself.
                out.put("ok", false).put("reason", "duress")
            }
        }
        call.resolve(out)
    }

    @PluginMethod
    fun hasAppPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        call.resolve(JSObject().put("hasPin", CarapaPin.hasPin(context, userId)))
    }

    @PluginMethod
    fun appPinStatus(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        val s = CarapaPin.status(context, userId)
        val out = JSObject()
            .put("hasPin", s.hasPin)
            .put("hasDuressPin", s.hasDuressPin)
            .put("failedAttempts", s.failedAttempts)
            .put("attemptsRemaining", s.attemptsRemaining)
        call.resolve(out)
    }

    @PluginMethod
    fun setAppDuressPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        val pin = call.getString("pin")
        if (pin.isNullOrEmpty()) {
            call.reject("pin is required", "BAD_PAYLOAD")
            return
        }
        if (pin.length < CarapaPin.MIN_PIN_LEN || pin.length > CarapaPin.MAX_PIN_LEN) {
            call.reject(
                "pin length must be ${CarapaPin.MIN_PIN_LEN}..${CarapaPin.MAX_PIN_LEN}",
                "PIN_LENGTH",
            )
            return
        }
        try {
            CarapaPin.setupDuressPin(context, userId, pin)
            call.resolve()
        } catch (e: CarapaPin.DuressSetupError) {
            // Surface the structured error code so the JS side can show
            // a specific message ("must differ from normal PIN", etc.)
            call.reject(e.message ?: "duress setup failed", "DURESS_SETUP_ERROR")
        } catch (e: Exception) {
            call.reject("duress setup failed: ${e.message}", "PIN_SETUP_ERROR")
        }
    }

    @PluginMethod
    fun hasAppDuressPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        call.resolve(JSObject().put("hasDuressPin", CarapaPin.hasDuressPin(context, userId)))
    }

    @PluginMethod
    fun clearAppDuressPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        try {
            CarapaPin.clearDuressPin(context, userId)
            call.resolve()
        } catch (e: Exception) {
            call.reject("duress clear failed: ${e.message}", "PIN_CLEAR_ERROR")
        }
    }

    /**
     * Reset the failed-attempt counter to 0 for [userId]. Called by JS
     * after a successful login so the user gets a fresh quota of 3
     * attempts (in particular: after a kill-switch fires, attempts
     * persist across the kill-switch — we only reset here to avoid an
     * attacker brute-forcing in 3-attempt batches indefinitely).
     */
    @PluginMethod
    fun resetAppPinAttempts(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        try {
            CarapaPin.resetAttempts(context, userId)
            call.resolve()
        } catch (e: Exception) {
            call.reject("reset failed: ${e.message}", "PIN_RESET_ERROR")
        }
    }

    @PluginMethod
    fun clearAppPin(call: PluginCall) {
        val userId = requireUserId(call) ?: return
        try {
            CarapaPin.clearPin(context, userId)
            call.resolve()
        } catch (e: Exception) {
            call.reject("clear failed: ${e.message}", "PIN_CLEAR_ERROR")
        }
    }

    /**
     * Prompt the user to verify their identity via biometric OR the device's
     * screen-lock credential (PIN / pattern / password). This is the lock-
     * screen unlock primitive — we do NOT manage an app-defined PIN; we let
     * Android prove the user is the device owner using whatever credential
     * they already configured at the OS level.
     *
     * The negative button on the system prompt is automatically replaced
     * with "Use PIN" / "Use pattern" / "Use password" when DEVICE_CREDENTIAL
     * is in the allowed authenticators set.
     *
     * Resolves with `{ ok: true }` on success.
     * Rejects with code "USER_CANCELED" if the user dismissed the prompt.
     * Rejects with code "NO_AUTH" if the device has neither biometric
     * enrolled nor a screen-lock set up — caller should treat this as
     * a hard failure (the device can't be locked at all).
     * Rejects with code "AUTH_ERROR" for everything else.
     */
    @PluginMethod
    fun verifyUser(call: PluginCall) {
        val title = call.getString("title") ?: "Unlock CarapaBoard"
        val subtitle = call.getString("subtitle") ?: "Use biometric or device PIN"
        val ctx = context

        // BiometricManager.canAuthenticate gates BiometricPrompt — if the
        // device has no biometric AND no credential set up, the prompt would
        // throw IllegalArgumentException at .authenticate() time. Surface a
        // clean error code so JS can degrade gracefully.
        val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            // Pre-R: BIOMETRIC_WEAK | DEVICE_CREDENTIAL is not allowed
            // together via setAllowedAuthenticators; we fall through to
            // setDeviceCredentialAllowed(true) below, which implicitly
            // permits any biometric class plus the device credential.
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }
        val canAuth = BiometricManager.from(ctx).canAuthenticate(authenticators)
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject("device cannot authenticate (code=$canAuth)", "NO_AUTH")
            return
        }

        val activity = activity as? FragmentActivity
        if (activity == null) {
            call.reject("no host activity", "AUTH_ERROR")
            return
        }

        activity.runOnUiThread {
            try {
                val executor = ContextCompat.getMainExecutor(ctx)
                val prompt = BiometricPrompt(
                    activity,
                    executor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(
                            result: BiometricPrompt.AuthenticationResult,
                        ) {
                            call.resolve(JSObject().put("ok", true))
                        }

                        override fun onAuthenticationError(
                            errorCode: Int,
                            errString: CharSequence,
                        ) {
                            // Treat all cancellations as a single category for
                            // the JS side; auth failures (wrong PIN, locked
                            // out by too many bad attempts) are AUTH_ERROR.
                            val isCancel = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                                errorCode == BiometricPrompt.ERROR_CANCELED
                            if (isCancel) {
                                call.reject("User canceled", "USER_CANCELED")
                            } else {
                                call.reject("auth failed: $errString", "AUTH_ERROR")
                            }
                        }

                        override fun onAuthenticationFailed() {
                            // Single non-final failure (e.g. fingerprint
                            // didn't match). BiometricPrompt keeps the UI
                            // up so the user can retry; we don't reject.
                        }
                    },
                )

                val builder = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    builder.setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_WEAK or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    builder.setDeviceCredentialAllowed(true)
                }

                prompt.authenticate(builder.build())
            } catch (e: Exception) {
                call.reject("authenticate threw: ${e.message}", "AUTH_ERROR")
            }
        }
    }

    /**
     * Dismiss a system-tray notification posted by [CarapaMessagingService].
     * Called from JS when a payload is acknowledged elsewhere (e.g. submitted
     * via the in-app bell or another device) so the lingering system entry
     * goes away. The notification id mirrors `payloadId.hashCode()` used by
     * [CarapaMessagingService.postRichNotification].
     */
    @PluginMethod
    fun dismissNotification(call: PluginCall) {
        val payloadId = call.getString("payloadId")
        if (payloadId.isNullOrEmpty()) {
            call.reject("payloadId is required")
            return
        }
        try {
            NotificationManagerCompat.from(context).cancel(payloadId.hashCode())
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS denied — nothing to dismiss anyway.
        }
        call.resolve()
    }

    /**
     * Drop the Firebase instance token so the next `register()` mints a
     * fresh one. Used when FCM yields no token or a registration error —
     * re-reporting a dead token would keep push broken.
     */
    @PluginMethod
    fun resetFcmToken(call: PluginCall) {
        if (!firebaseConfigured()) {
            call.reject("Firebase is not configured in this build", "FCM_UNAVAILABLE")
            return
        }
        com.google.firebase.messaging.FirebaseMessaging.getInstance().deleteToken()
            .addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    call.resolve()
                } else {
                    call.reject(task.exception?.localizedMessage ?: "deleteToken failed", "FCM_DELETE_FAILED")
                }
            }
    }

    /**
     * False when the APK was built without google-services.json: any FCM call
     * (including the push plugin's `register()`) would then crash the process.
     */
    @PluginMethod
    fun isPushAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", firebaseConfigured()))
    }

    private fun firebaseConfigured(): Boolean =
        com.google.firebase.FirebaseApp.getApps(context).isNotEmpty()

    private fun emitNotifTap(notifId: String) {
        val data = JSObject().put("notifId", notifId)
        notifyListeners("notifTap", data, true)
    }

    private fun emitSpeechPlayback(id: String, phase: String) {
        val parts = id.split('|', limit = 3)
        if (parts.size != 3) return
        val data = JSObject()
            .put("conversationId", parts[0])
            .put("messageId", parts[1])
            .put("sessionId", parts[2])
            .put("phase", phase)
        notifyListeners("speechPlayback", data, true)
    }

    companion object {
        @Volatile private var instance: CarapaBridgePlugin? = null
        @Volatile private var pendingNotifId: String? = null

        /** Called from MainActivity when an FCM notification tap launches the app. */
        @JvmStatic
        fun deliverNotifTap(notifId: String) {
            val live = instance
            if (live != null) {
                live.emitNotifTap(notifId)
            } else {
                // Cold launch: plugin not yet attached; load() will drain it.
                pendingNotifId = notifId
            }
        }

        /** Called by the Media3 service when native speech actually starts or ends. */
        @JvmStatic
        fun deliverSpeechPlayback(id: String, phase: String) {
            instance?.emitSpeechPlayback(id, phase)
        }
    }
}
