package ai.carapa.board

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persistent device-side metadata used by [CarapaMessagingService] when the
 * WebView is not running: the deviceId to send in `X-Carapa-Device-ID`, and
 * the apiBase URL to fetch payloads from.
 *
 * The device PRIVATE KEY is no longer stored here — it lives in the Android
 * Keystore (see [CarapaKeystore]) and never leaves the secure element on
 * hardware-backed devices. We keep using EncryptedSharedPreferences for
 * deviceId/apiBase out of consistency: the file is sandboxed to this app's
 * UID and additionally encrypted with a Keystore-bound master key. (Both
 * fields are non-secret, but the encrypted store gives us tamper-evidence
 * for free.)
 *
 * Migration: an older build wrote a `private_key_pkcs8_b64` field here.
 * We no longer read it. When the next bootstrap runs the Keystore alias
 * is created and the old field is deleted on first read by [clearLegacyPrivateKey].
 */
object CarapaCredentials {
    private const val PREFS_NAME = "carapa_secure_creds"

    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_API_BASE = "api_base"
    private const val KEY_REMOTE_API_BASE = "remote_api_base"
    private const val LEGACY_KEY_PRIVATE_KEY = "private_key_pkcs8_b64"

    private fun prefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun set(context: Context, deviceId: String, apiBase: String, remoteApiBase: String? = null) {
        prefs(context).edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_API_BASE, apiBase)
            .putString(KEY_REMOTE_API_BASE, remoteApiBase ?: apiBase)
            .remove(LEGACY_KEY_PRIVATE_KEY)
            .apply()
    }

    fun setApiBase(context: Context, apiBase: String) {
        prefs(context).edit()
            .putString(KEY_API_BASE, apiBase)
            .apply()
    }

    fun clear(context: Context) {
        prefs(context).edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_API_BASE)
            .remove(KEY_REMOTE_API_BASE)
            .remove(LEGACY_KEY_PRIVATE_KEY)
            .apply()
    }

    /** Drop any leftover plain private key from older app versions. Safe to
     *  call repeatedly; no-op if the legacy field is absent. */
    fun clearLegacyPrivateKey(context: Context) {
        val p = prefs(context)
        if (p.contains(LEGACY_KEY_PRIVATE_KEY)) {
            p.edit().remove(LEGACY_KEY_PRIVATE_KEY).apply()
        }
    }

    data class Snapshot(
        val deviceId: String,
        val apiBase: String,
        val remoteApiBase: String,
    )

    fun read(context: Context): Snapshot? {
        val p = prefs(context)
        val deviceId = p.getString(KEY_DEVICE_ID, null) ?: return null
        val apiBase = p.getString(KEY_API_BASE, null) ?: return null
        return Snapshot(deviceId, apiBase, p.getString(KEY_REMOTE_API_BASE, null) ?: apiBase)
    }
}
