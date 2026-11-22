package ai.carapa.board

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Android Keystore-backed device keypair.
 *
 * The private key is GENERATED inside the Keystore and never leaves it.
 * On devices with a TEE (most modern Android) or StrongBox (some Pixels,
 * recent Samsungs) it lives in a separate secure element — the OS, root,
 * and adb backups all see only a sign oracle. The keypair is bound to the
 * app's UID, so other apps on the device cannot use it either.
 *
 * The signing format matches the JS WebCrypto path used on web/iOS:
 * ECDSA P-256, SHA-256, signature returned as base64-encoded IEEE P1363
 * (raw r||s, 64 bytes). Java's Signature emits ASN.1 DER, so we convert
 * via [CarapaSigner.derToP1363] before returning.
 */
object CarapaKeystore {
    private const val KEY_ALIAS = "carapa_device_key"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val SIG_ALGO = "SHA256withECDSA"

    private fun keystore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    fun hasKey(): Boolean = keystore().containsAlias(KEY_ALIAS)

    /**
     * Generate the keypair if it doesn't already exist. Idempotent — calls
     * after the first one are no-ops and just return the existing public key.
     *
     * Returns: SPKI base64 (X.509-format) public key, the same shape the JS
     * `exportPublicKey('spki')` path produces, so the server doesn't have to
     * distinguish between native and web origins.
     */
    fun ensureKey(): String {
        val ks = keystore()
        if (!ks.containsAlias(KEY_ALIAS)) {
            // PURPOSE_VERIFY is included so the server's public-key verify path
            // (mirrored by CarapaApiClient if it ever needed to verify) works
            // without needing a separate public-key import. Costs nothing.
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
            val gen = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                ANDROID_KEYSTORE,
            )
            gen.initialize(spec)
            gen.generateKeyPair()
        }
        return getPublicKeyBase64()
    }

    fun getPublicKeyBase64(): String {
        val ks = keystore()
        val cert = ks.getCertificate(KEY_ALIAS)
            ?: throw IllegalStateException("Keystore alias $KEY_ALIAS not present")
        val pub: PublicKey = cert.publicKey
        return Base64.encodeToString(pub.encoded, Base64.NO_WRAP)
    }

    /**
     * Sign a request payload using the Keystore-bound private key.
     * Returns base64 P1363 (raw r||s, 64 bytes for P-256).
     */
    fun sign(payload: String): String {
        val ks = keystore()
        val privateKey = ks.getKey(KEY_ALIAS, null) as? PrivateKey
            ?: throw IllegalStateException("Keystore alias $KEY_ALIAS not present or not a PrivateKey")
        // CarapaSigner.signPayload accepts a PrivateKey reference and signs
        // through Java's Signature API. The Keystore private key here is a
        // handle — actual signing happens inside the secure element on
        // hardware-backed devices.
        return CarapaSigner.signPayload(privateKey, payload)
    }

    /** Full reset. Only call from explicit "wipe device identity" flows —
     *  NOT from regular logout (the keypair is per-device). */
    fun deleteKey() {
        val ks = keystore()
        if (ks.containsAlias(KEY_ALIAS)) {
            ks.deleteEntry(KEY_ALIAS)
        }
    }

    /**
     * Where does the private key actually live? Answers come straight from
     * the Keystore implementation rather than guessing from device model.
     *
     * - `securityLevel` is the strongest authoritative signal. On API 31+
     *   `KeyInfo.getSecurityLevel()` returns one of:
     *     SECURITY_LEVEL_SOFTWARE — software-only keystore (no TEE/SE)
     *     SECURITY_LEVEL_TRUSTED_ENVIRONMENT — ARM TrustZone / TEE
     *     SECURITY_LEVEL_STRONGBOX — dedicated tamper-resistant chip
     * - `isInsideSecureHardware` is the legacy boolean (deprecated in 31
     *   but still works). True iff TEE or StrongBox.
     *
     * If the alias doesn't exist, `hasKey` is false and the rest of the
     * fields are nulls — caller should call [ensureKey] first to take a
     * meaningful snapshot.
     */
    data class Info(
        val hasKey: Boolean,
        val isInsideSecureHardware: Boolean?,
        val securityLevel: String?,
    )

    fun describe(): Info {
        val ks = keystore()
        if (!ks.containsAlias(KEY_ALIAS)) {
            return Info(hasKey = false, isInsideSecureHardware = null, securityLevel = null)
        }
        return try {
            val privateKey = ks.getKey(KEY_ALIAS, null) as PrivateKey
            val factory = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore")
            val info = factory.getKeySpec(privateKey, KeyInfo::class.java)
            val secLevel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (info.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_SOFTWARE -> "SOFTWARE"
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TRUSTED_ENVIRONMENT"
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                    KeyProperties.SECURITY_LEVEL_UNKNOWN -> "UNKNOWN"
                    KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> "UNKNOWN_SECURE"
                    else -> "UNKNOWN(${info.securityLevel})"
                }
            } else null
            // isInsideSecureHardware is the pre-API-31 way of asking the same
            // question (TEE-or-better → true, software-only → false).
            @Suppress("DEPRECATION")
            val secure = info.isInsideSecureHardware
            Info(hasKey = true, isInsideSecureHardware = secure, securityLevel = secLevel)
        } catch (e: Exception) {
            Log.w("CarapaKeystore", "describe() failed", e)
            Info(hasKey = true, isInsideSecureHardware = null, securityLevel = null)
        }
    }
}
