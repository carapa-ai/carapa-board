package ai.carapa.board

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * App-level PIN: a second factor that gates app access INDEPENDENTLY of
 * the device's screen-lock PIN/biometric. The PIN is bound to a USER
 * ACCOUNT, not the device — each account that has logged in on this
 * device gets its own verifier and Keystore HMAC alias. User B logging
 * in next to User A never inherits or has to bypass User A's PIN.
 *
 * Storage shape (per user):
 *   verifier_b64_<userId>          = HMAC-SHA256(pin, K_userId)
 *   failed_attempts_<userId>
 *   duress_verifier_b64_<userId>   = HMAC-SHA256(duressPin, K_userId)
 *
 *   K_userId is a non-extractable HMAC key generated inside the Android
 *   Keystore under alias "carapa_pin_hmac_<userId>" (hardware-backed on
 *   TEE/SE devices). Per-user keys mean a leak of user A's verifier
 *   reveals nothing useful about user B's PIN even if K_userA is
 *   somehow recovered.
 *
 *   We persist {verifier, failedAttempts} in EncryptedSharedPreferences.
 *   The verifier alone is useless: without the right Keystore key, no
 *   candidate PIN can be tested off-device. `adb backup` blobs are inert.
 *
 * Brute-force defense (per user): a kill-switch fires after
 * [KILL_SWITCH_THRESHOLD] consecutive wrong entries on that user's
 * verifier. The kill-switch atomically wipes the Keystore device-
 * handshake key (see [CarapaKeystore]) and the persisted device metadata
 * (see [CarapaCredentials]) — the next API call cannot sign, the user is
 * forced through the full login flow, and a fresh device key is
 * bootstrapped.
 *
 * The PIN HMAC key and verifier are PRESERVED across kill-switch cycles
 * so the legitimate user re-logs in and uses the same PIN. The failed-
 * attempt counter is NOT reset by the kill-switch itself — the next
 * successful login calls [resetAttempts] for that user to clear it. (If
 * we reset here, an attacker could brute-force in 3-attempt batches
 * forever.)
 *
 * A successful PIN entry resets the counter immediately.
 */
object CarapaPin {
    private const val HMAC_ALIAS_PREFIX = "carapa_pin_hmac_"
    private const val PREFS_NAME = "carapa_pin"

    private const val KEY_VERIFIER_PREFIX = "verifier_b64_"
    private const val KEY_DURESS_VERIFIER_PREFIX = "duress_verifier_b64_"
    private const val KEY_FAILED_ATTEMPTS_PREFIX = "failed_attempts_"

    const val MIN_PIN_LEN = 4
    const val MAX_PIN_LEN = 16
    const val KILL_SWITCH_THRESHOLD = 3

    sealed class VerifyResult {
        object Ok : VerifyResult()
        object NoPin : VerifyResult()
        data class Wrong(val failedAttempts: Int, val attemptsRemaining: Int) : VerifyResult()
        data class KillSwitch(val failedAttempts: Int) : VerifyResult()
        /**
         * The entered PIN matched the duress verifier. Native does NOT fire
         * the kill-switch here — the JS layer needs the device-handshake
         * key to sign the duress-alert request first. The JS sequence:
         *
         *   1. POST /api/security/duress (signed by the still-valid device key)
         *   2. clearCredentials() → wipes the device key + creds
         *   3. logout() — auth_token + session state
         *   4. set duressMode → AuthGate renders a connection-error UI
         *      indistinguishable from a real network outage.
         */
        object Duress : VerifyResult()
    }

    class DuressSetupError(message: String) : RuntimeException(message)

    class PinSetupError(message: String) : RuntimeException(message)

    private fun requireUserId(userId: String): String {
        require(userId.isNotEmpty()) { "userId is required" }
        // Defence-in-depth: the prefs/Keystore alias is an exact-string key,
        // but a maliciously-crafted userId could collide with another user's
        // namespace if it contained the prefix separator. We restrict the
        // charset to what the server hands out (UUID/alphanumeric/dash/dot).
        require(userId.all { it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' }) {
            "userId contains illegal characters"
        }
        return userId
    }

    private fun hmacAlias(userId: String): String = HMAC_ALIAS_PREFIX + requireUserId(userId)
    private fun verifierKey(userId: String): String = KEY_VERIFIER_PREFIX + requireUserId(userId)
    private fun duressVerifierKey(userId: String): String = KEY_DURESS_VERIFIER_PREFIX + requireUserId(userId)
    private fun failedAttemptsKey(userId: String): String = KEY_FAILED_ATTEMPTS_PREFIX + requireUserId(userId)

    private fun prefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return try {
            createPrefs(context, masterKey)
        } catch (error: Exception) {
            // Android backup/restore can leave this recoverable PIN metadata
            // encrypted with a Keystore key from another device. Treat that
            // state as no PIN rather than crashing the Capacitor plugin.
            if (!hasAeadBadTag(error)) throw error
            android.util.Log.w("CarapaPin", "resetting unrecoverable PIN metadata", error)
            context.deleteSharedPreferences(PREFS_NAME)
            createPrefs(context, masterKey)
        }
    }

    private fun createPrefs(context: Context, masterKey: MasterKey): SharedPreferences {
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private fun hasAeadBadTag(error: Throwable): Boolean {
        var current: Throwable? = error
        while (current != null) {
            if (current::class.java.simpleName == "AEADBadTagException") return true
            current = current.cause
        }
        return false
    }

    private fun keystore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureHmacKey(userId: String): SecretKey {
        val alias = hmacAlias(userId)
        val ks = keystore()
        val existing = ks.getKey(alias, null) as? SecretKey
        if (existing != null) return existing
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    private fun computeVerifier(userId: String, pin: String): String {
        val key = ensureHmacKey(userId)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(key)
        val raw = mac.doFinal(pin.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(raw, Base64.NO_WRAP)
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) {
            diff = diff or (a[i].code xor b[i].code)
        }
        return diff == 0
    }

    fun hasPin(context: Context, userId: String): Boolean {
        return prefs(context).contains(verifierKey(userId))
    }

    fun hasDuressPin(context: Context, userId: String): Boolean {
        return prefs(context).contains(duressVerifierKey(userId))
    }

    /**
     * Set or replace the app PIN for [userId]. Resets the failed-attempt counter.
     * Rejects a PIN equal to the configured duress PIN: verifyPin checks the
     * normal PIN first, so an equal pair would silently disable duress.
     */
    fun setupPin(context: Context, userId: String, pin: String) {
        require(pin.length in MIN_PIN_LEN..MAX_PIN_LEN) {
            "pin length must be $MIN_PIN_LEN..$MAX_PIN_LEN"
        }
        val p = prefs(context)
        val verifier = computeVerifier(userId, pin)
        val duressVerifier = p.getString(duressVerifierKey(userId), null)
        if (duressVerifier != null && constantTimeEquals(verifier, duressVerifier)) {
            throw PinSetupError("New PIN must differ from your duress PIN")
        }
        p.edit()
            .putString(verifierKey(userId), verifier)
            .putInt(failedAttemptsKey(userId), 0)
            .apply()
    }

    /**
     * Set or replace the duress PIN for [userId]. Requires a normal PIN to
     * already exist for the same user (we don't want a duress-only
     * configuration), and rejects a duress PIN that hashes to the same
     * verifier as the normal PIN (i.e. the same digit sequence) — otherwise
     * the duress signal could not be triggered separately.
     */
    fun setupDuressPin(context: Context, userId: String, pin: String) {
        require(pin.length in MIN_PIN_LEN..MAX_PIN_LEN) {
            "pin length must be $MIN_PIN_LEN..$MAX_PIN_LEN"
        }
        val p = prefs(context)
        val normalVerifier = p.getString(verifierKey(userId), null)
            ?: throw DuressSetupError("normal PIN must be set before configuring a duress PIN")
        val duressVerifier = computeVerifier(userId, pin)
        if (constantTimeEquals(duressVerifier, normalVerifier)) {
            throw DuressSetupError("duress PIN must differ from the normal PIN")
        }
        p.edit().putString(duressVerifierKey(userId), duressVerifier).apply()
    }

    fun clearDuressPin(context: Context, userId: String) {
        prefs(context).edit().remove(duressVerifierKey(userId)).apply()
    }

    /**
     * Verify a PIN entry against [userId]'s verifier. On the
     * [KILL_SWITCH_THRESHOLD]-th wrong attempt fires the kill-switch
     * atomically (wipes the device-handshake Keystore key + persisted
     * deviceId/apiBase) and returns [VerifyResult.KillSwitch]. The PIN
     * itself survives — the user re-logs in, the device re-bootstraps,
     * and the same PIN works.
     */
    fun verifyPin(context: Context, userId: String, pin: String): VerifyResult {
        val p = prefs(context)
        val storedVerifier = p.getString(verifierKey(userId), null) ?: return VerifyResult.NoPin

        val computed = computeVerifier(userId, pin)
        if (constantTimeEquals(computed, storedVerifier)) {
            // Reset on success.
            p.edit().putInt(failedAttemptsKey(userId), 0).apply()
            return VerifyResult.Ok
        }

        val duressVerifier = p.getString(duressVerifierKey(userId), null)
        if (duressVerifier != null && constantTimeEquals(computed, duressVerifier)) {
            // Duress entry — the JS layer needs the device key intact to
            // sign the alert, so we DON'T fire the kill-switch here. The
            // counter is also untouched: the duress entry is "successful"
            // from the user-facing perspective and shouldn't burn quota
            // (the JS side wipes the device key right after the alert
            // is sent, which has the same security effect anyway).
            return VerifyResult.Duress
        }

        val failed = p.getInt(failedAttemptsKey(userId), 0) + 1
        p.edit().putInt(failedAttemptsKey(userId), failed).apply()

        if (failed >= KILL_SWITCH_THRESHOLD) {
            // Atomic kill-switch: wipe the device key + creds. PIN is kept
            // so the legitimate user re-logs in with the same PIN. The
            // failed-attempt counter is NOT reset here — only a successful
            // login (via resetAttempts) clears it.
            try {
                CarapaKeystore.deleteKey()
                CarapaCredentials.clear(context)
            } catch (_: Exception) {
                // Best-effort. The JS side also clears auth_token; the
                // user ends up at the login screen either way.
            }
            return VerifyResult.KillSwitch(failedAttempts = failed)
        }

        return VerifyResult.Wrong(
            failedAttempts = failed,
            attemptsRemaining = KILL_SWITCH_THRESHOLD - failed,
        )
    }

    /** Wipe [userId]'s PIN — verifier, duress verifier, attempt counter,
     *  and the per-user Keystore HMAC alias. Other users' PINs are
     *  untouched. Called when the user explicitly removes their PIN
     *  through Settings — NOT called on logout (PINs are user-bound and
     *  persist across logout/login). */
    fun clearPin(context: Context, userId: String) {
        try {
            val ks = keystore()
            val alias = hmacAlias(userId)
            if (ks.containsAlias(alias)) {
                ks.deleteEntry(alias)
            }
        } catch (_: Exception) {
            // Best-effort; the prefs wipe below makes the verifier useless anyway.
        }
        prefs(context).edit()
            .remove(verifierKey(userId))
            .remove(duressVerifierKey(userId))
            .remove(failedAttemptsKey(userId))
            .apply()
    }

    /** Reset only the failed-attempt counter for [userId]. Called from JS
     *  after a successful login so the user gets a fresh 3 attempts. */
    fun resetAttempts(context: Context, userId: String) {
        prefs(context).edit().putInt(failedAttemptsKey(userId), 0).apply()
    }

    data class Status(
        val hasPin: Boolean,
        val hasDuressPin: Boolean,
        val failedAttempts: Int,
        val attemptsRemaining: Int,
    )

    fun status(context: Context, userId: String): Status {
        val p = prefs(context)
        val failed = p.getInt(failedAttemptsKey(userId), 0)
        return Status(
            hasPin = p.contains(verifierKey(userId)),
            hasDuressPin = p.contains(duressVerifierKey(userId)),
            failedAttempts = failed,
            attemptsRemaining = (KILL_SWITCH_THRESHOLD - failed).coerceAtLeast(0),
        )
    }
}
