package ai.carapa.board

import java.net.URI
import java.security.MessageDigest

/** SHA-256 pin of the certificate a board presents on one exact host and port. */
data class ServerPin(val host: String, val port: Int, val certSha256: String)

/**
 * The single trust decision shared by the WebView and native-TLS paths. Pure
 * JVM code (no Android types) so it is unit-testable.
 */
object CertPinPolicy {
    private val sha256Pattern = Regex("^[0-9a-f]{64}$")

    fun isSha256Hex(value: String): Boolean = sha256Pattern.matches(value)

    /** Lowercase, without IPv6 brackets or a trailing dot, so equal hosts compare equal. */
    fun normalizeHost(host: String): String =
        host.trim().removePrefix("[").removeSuffix("]").removeSuffix(".").lowercase()

    /** Parse `{origin, certSha256}` from the UI; null when it is not a valid https origin or pin. */
    fun parsePin(origin: String, certSha256: String): ServerPin? {
        val sha = certSha256.lowercase()
        if (!isSha256Hex(sha)) return null
        val uri = try {
            URI(origin.trim())
        } catch (_: Exception) {
            return null
        }
        val host = uri.host?.let(::normalizeHost)
        if (!"https".equals(uri.scheme, ignoreCase = true) || host.isNullOrEmpty()) return null
        if (uri.userInfo != null || !uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null) {
            return null
        }
        return ServerPin(host, if (uri.port == -1) 443 else uri.port, sha)
    }

    fun sha256Hex(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /**
     * True only when [pins] has an entry for exactly [host] and [port] whose
     * SHA-256 equals that of the presented leaf certificate ([leafDer]).
     */
    fun allows(host: String, port: Int, leafDer: ByteArray, pins: List<ServerPin>): Boolean {
        val normalized = normalizeHost(host)
        val candidates = pins.filter { it.host == normalized && it.port == port }
        if (candidates.isEmpty()) return false
        val actual = sha256Hex(leafDer).toByteArray()
        return candidates.any { MessageDigest.isEqual(it.certSha256.toByteArray(), actual) }
    }
}
