package ai.carapa.board

import android.util.Base64
import java.security.PrivateKey
import java.security.Signature

/**
 * Stateless ECDSA-P-256 signing helpers shared between the bridge plugin
 * and the FCM service. The actual private key reference is supplied by
 * the caller — in this app, that always means [CarapaKeystore], so the
 * raw key never appears outside the secure element on hardware-backed
 * devices.
 *
 * Signature format matches the JS WebCrypto path: ECDSA P-256, SHA-256,
 * base64-encoded IEEE P1363 (raw r||s, 64 bytes). Java's `Signature`
 * emits ASN.1 DER, so we convert via [derToP1363] before returning.
 */
object CarapaSigner {
    private const val SIG_ALGO = "SHA256withECDSA"

    /** Returns base64 P1363 (r||s) signature. */
    fun signPayload(privateKey: PrivateKey, payload: String): String {
        val s = Signature.getInstance(SIG_ALGO)
        s.initSign(privateKey)
        s.update(payload.toByteArray(Charsets.UTF_8))
        val der = s.sign()
        val raw = derToP1363(der, 32)
        return Base64.encodeToString(raw, Base64.NO_WRAP)
    }

    /**
     * Convert ASN.1 DER ECDSA signature `30 LL 02 RL r 02 SL s` into the
     * IEEE P1363 fixed-width concatenation `r || s` of [coordSize] bytes
     * each (32 for P-256). Both r and s in DER may have a leading 0x00
     * byte (when their high bit is set) or be shorter than coordSize
     * (leading zeros stripped); we strip / left-pad to coordSize.
     */
    private fun derToP1363(der: ByteArray, coordSize: Int): ByteArray {
        var off = 0
        require(der[off++].toInt() and 0xFF == 0x30) { "expected DER SEQUENCE" }
        // Length: short or long form — for ECDSA P-256 it's always short form (<128).
        val seqLen = der[off++].toInt() and 0xFF
        require(seqLen + 2 == der.size) { "DER length mismatch" }

        require(der[off++].toInt() and 0xFF == 0x02) { "expected INTEGER for r" }
        val rLen = der[off++].toInt() and 0xFF
        val rBytes = der.copyOfRange(off, off + rLen)
        off += rLen

        require(der[off++].toInt() and 0xFF == 0x02) { "expected INTEGER for s" }
        val sLen = der[off++].toInt() and 0xFF
        val sBytes = der.copyOfRange(off, off + sLen)

        return leftPad(stripLeadingZero(rBytes), coordSize) +
            leftPad(stripLeadingZero(sBytes), coordSize)
    }

    private fun stripLeadingZero(b: ByteArray): ByteArray {
        return if (b.isNotEmpty() && b[0] == 0.toByte()) b.copyOfRange(1, b.size) else b
    }

    private fun leftPad(b: ByteArray, size: Int): ByteArray {
        if (b.size == size) return b
        if (b.size > size) {
            // Should not happen for P-256 (max 32 bytes), but guard anyway.
            return b.copyOfRange(b.size - size, b.size)
        }
        val out = ByteArray(size)
        b.copyInto(out, destinationOffset = size - b.size)
        return out
    }

    /** Mirror of `createSigningPayload` in ui/src/lib/crypto.ts. */
    fun createSigningPayload(method: String, path: String, timestamp: String, body: String = ""): String {
        return "$timestamp:$method:$path:$body"
    }
}
