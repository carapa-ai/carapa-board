package ai.carapa.board

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Minimal signed HTTP client used by [CarapaMessagingService] to fetch a
 * notification payload from the board while the WebView is not running.
 *
 * Mirrors the request-signing scheme in `ui/src/lib/api.ts`:
 *   X-Carapa-Device-ID:  <device id>
 *   X-Carapa-Timestamp:  <ISO timestamp>
 *   X-Carapa-Signature:  base64(P1363(ECDSA-SHA256(payload)))
 * where payload = `<timestamp>:<METHOD>:<path>:<body>`.
 */
object CarapaApiClient {
    private const val TAG = "CarapaApiClient"

    data class NotifPayload(
        val id: String,
        val kind: String,
        val summary: String,
        val content: String,
    )

    fun fetchPayload(context: Context, payloadId: String): NotifPayload? {
        val creds = CarapaCredentials.read(context) ?: run {
            Log.w(TAG, "device not bootstrapped — cannot fetch payload (run bootstrapDevice after login)")
            return null
        }
        if (!CarapaKeystore.hasKey()) {
            Log.w(TAG, "Keystore device key missing — cannot sign payload fetch")
            return null
        }
        Log.d(TAG, "fetchPayload start: payloadId=$payloadId apiBase=${creds.apiBase} deviceId=${creds.deviceId.take(12)}…")

        val path = "/api/notifications/payloads/${java.net.URLEncoder.encode(payloadId, "UTF-8")}"
        val timestamp = isoNow()
        val signingPayload = CarapaSigner.createSigningPayload("GET", path, timestamp, "")
        val signature = try {
            CarapaKeystore.sign(signingPayload)
        } catch (e: Exception) {
            Log.w(TAG, "signPayload failed", e)
            return null
        }

        val url = URL(creds.apiBase.trimEnd('/') + path)
        val conn = try {
            (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 8000
                setRequestProperty("X-Carapa-Device-ID", creds.deviceId)
                setRequestProperty("X-Carapa-Timestamp", timestamp)
                setRequestProperty("X-Carapa-Signature", signature)
                setRequestProperty("Accept", "application/json")
            }
        } catch (e: Exception) {
            Log.w(TAG, "openConnection failed for $url", e)
            return null
        }

        return try {
            val code = conn.responseCode
            if (code != 200) {
                val errBody = try {
                    conn.errorStream?.bufferedReader()?.use { it.readText() }
                } catch (_: Exception) { null }
                Log.w(TAG, "GET $url -> $code body=${errBody?.take(240)}")
                return null
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            Log.d(TAG, "GET $url -> 200, ${body.length} bytes")
            parseItem(body)
        } catch (e: Exception) {
            Log.w(TAG, "fetchPayload threw", e)
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun parseItem(body: String): NotifPayload? {
        val root = JSONObject(body)
        val item = root.optJSONObject("item") ?: return null
        return NotifPayload(
            id = item.optString("id"),
            kind = item.optString("kind", "text"),
            summary = item.optString("summary", "CarapaBoard"),
            content = item.optString("content", ""),
        )
    }

    /**
     * ACK a notification payload with no form values — i.e. "user dismissed".
     * Server-side this routes to [cancelPending], which wakes any agent that
     * was blocking on this form's response. Returns true on a 2xx response,
     * false otherwise. Synchronous: callers must run on a background thread.
     */
    fun ackPayload(context: Context, payloadId: String): Boolean {
        val creds = CarapaCredentials.read(context) ?: run {
            Log.w(TAG, "ackPayload: device not bootstrapped")
            return false
        }
        if (!CarapaKeystore.hasKey()) {
            Log.w(TAG, "ackPayload: Keystore device key missing")
            return false
        }

        val path = "/api/notifications/payloads/${java.net.URLEncoder.encode(payloadId, "UTF-8")}/ack"
        val timestamp = isoNow()
        // No body — server's requireFreshSignature uses '' for empty bodies,
        // so we sign over '' too. Keeping the body literally absent (no
        // Content-Length, no bytes) avoids the '{}' vs '' asymmetry.
        val signingPayload = CarapaSigner.createSigningPayload("POST", path, timestamp, "")
        val signature = try {
            CarapaKeystore.sign(signingPayload)
        } catch (e: Exception) {
            Log.w(TAG, "ackPayload: signPayload failed", e)
            return false
        }

        val url = URL(creds.apiBase.trimEnd('/') + path)
        val conn = try {
            (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 8000
                // No body — leave doOutput at its default (false). HttpURLConnection
                // sends Content-Length: 0 automatically.
                setRequestProperty("X-Carapa-Device-ID", creds.deviceId)
                setRequestProperty("X-Carapa-Timestamp", timestamp)
                setRequestProperty("X-Carapa-Signature", signature)
                setRequestProperty("Accept", "application/json")
            }
        } catch (e: Exception) {
            Log.w(TAG, "ackPayload: openConnection failed for $url", e)
            return false
        }

        return try {
            val code = conn.responseCode
            val ok = code in 200..299
            if (!ok) {
                val errBody = try {
                    conn.errorStream?.bufferedReader()?.use { it.readText() }
                } catch (_: Exception) { null }
                Log.w(TAG, "POST $url -> $code body=${errBody?.take(240)}")
            } else {
                Log.d(TAG, "POST $url -> $code (cancelled payload $payloadId)")
            }
            ok
        } catch (e: Exception) {
            Log.w(TAG, "ackPayload threw", e)
            false
        } finally {
            conn.disconnect()
        }
    }

    fun fetchSpeech(context: Context, conversationId: String, messageId: String, sessionId: String? = null): File? {
        val dir = File(context.cacheDir, "tts").apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - SPEECH_CACHE_TTL_MS
        dir.listFiles()?.forEach { file ->
            if (file.isFile && file.lastModified() < cutoff) file.delete()
        }
        val cacheKey = "$conversationId-$messageId".replace(Regex("[^a-zA-Z0-9_-]"), "_").take(160)
        val target = File(dir, "$cacheKey.ogg")
        if (target.exists() && target.length() > 0L && target.lastModified() >= cutoff) return target

        val creds = CarapaCredentials.read(context) ?: return null
        if (!CarapaKeystore.hasKey()) return null
        val query = if (sessionId.isNullOrBlank()) {
            "manual=1"
        } else {
            "liveModeSessionId=${URLEncoder.encode(sessionId, "UTF-8")}"
        }
        val path = "/api/native/tts/conversations/${URLEncoder.encode(conversationId, "UTF-8")}/messages/${URLEncoder.encode(messageId, "UTF-8")}?$query"
        val timestamp = isoNow()
        val signature = try { CarapaKeystore.sign(CarapaSigner.createSigningPayload("GET", path, timestamp, "")) } catch (_: Exception) { return null }
        for (base in listOf(creds.apiBase, creds.remoteApiBase).distinct()) {
            val conn = try {
                (URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 60_000
                    setRequestProperty("X-Carapa-Device-ID", creds.deviceId)
                    setRequestProperty("X-Carapa-Timestamp", timestamp)
                    setRequestProperty("X-Carapa-Signature", signature)
                    setRequestProperty("Accept", "audio/ogg")
                }
            } catch (e: Exception) { Log.w(TAG, "speech connection failed for $base", e); continue }
            try {
                if (conn.responseCode != 200) continue
                if (!target.exists() || target.length() == 0L) {
                    val temporary = File(dir, "$cacheKey.${Thread.currentThread().id}.tmp")
                    conn.inputStream.use { input -> temporary.outputStream().use { output -> input.copyTo(output) } }
                    if (!temporary.renameTo(target)) { temporary.copyTo(target, overwrite = true); temporary.delete() }
                }
                return target
            } catch (e: Exception) {
                Log.w(TAG, "speech download failed for $base", e)
            } finally { conn.disconnect() }
        }
        return null
    }

    data class SpeechText(val text: String, val language: String?)

    /**
     * Speech-ready text for a reply (server normalization applied, voice
     * control tags removed) and its language, for on-device synthesis. Same
     * signed route family, access checks and session semantics as
     * [fetchSpeech].
     */
    fun fetchSpeechText(context: Context, conversationId: String, messageId: String, sessionId: String? = null): SpeechText? {
        val creds = CarapaCredentials.read(context) ?: return null
        if (!CarapaKeystore.hasKey()) return null
        val query = if (sessionId.isNullOrBlank()) {
            "manual=1"
        } else {
            "liveModeSessionId=${URLEncoder.encode(sessionId, "UTF-8")}"
        }
        val path = "/api/native/tts/conversations/${URLEncoder.encode(conversationId, "UTF-8")}/messages/${URLEncoder.encode(messageId, "UTF-8")}/text?$query"
        val timestamp = isoNow()
        val signature = try { CarapaKeystore.sign(CarapaSigner.createSigningPayload("GET", path, timestamp, "")) } catch (_: Exception) { return null }
        for (base in listOf(creds.apiBase, creds.remoteApiBase).distinct()) {
            val conn = try {
                (URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 60_000
                    setRequestProperty("X-Carapa-Device-ID", creds.deviceId)
                    setRequestProperty("X-Carapa-Timestamp", timestamp)
                    setRequestProperty("X-Carapa-Signature", signature)
                    setRequestProperty("Accept", "application/json")
                }
            } catch (e: Exception) { Log.w(TAG, "speech text connection failed for $base", e); continue }
            try {
                if (conn.responseCode != 200) {
                    Log.w(TAG, "speech text GET -> ${conn.responseCode} from $base")
                    continue
                }
                val body = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                val text = body.optString("text").trim()
                if (text.isEmpty()) return null
                return SpeechText(text, body.optString("language").takeIf { it.isNotBlank() })
            } catch (e: Exception) {
                Log.w(TAG, "speech text download failed for $base", e)
            } finally { conn.disconnect() }
        }
        return null
    }

    fun ackSpeech(
        context: Context,
        conversationId: String,
        messageId: String,
        sessionId: String,
        outcome: String,
        durationMs: Long? = null,
    ): Boolean {
        val creds = CarapaCredentials.read(context) ?: return false
        if (!CarapaKeystore.hasKey()) return false
        val path = "/api/native/tts/conversations/${URLEncoder.encode(conversationId, "UTF-8")}/messages/${URLEncoder.encode(messageId, "UTF-8")}/complete"
        val body = JSONObject().put("liveModeSessionId", sessionId).put("outcome", outcome)
            .apply { if (durationMs != null) put("durationMs", durationMs) }
            .toString()
        val timestamp = isoNow()
        val signature = try { CarapaKeystore.sign(CarapaSigner.createSigningPayload("POST", path, timestamp, body)) } catch (_: Exception) { return false }
        for (base in listOf(creds.apiBase, creds.remoteApiBase).distinct()) {
            val conn = try {
                (URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 8_000; readTimeout = 8_000; doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("X-Carapa-Device-ID", creds.deviceId)
                    setRequestProperty("X-Carapa-Timestamp", timestamp)
                    setRequestProperty("X-Carapa-Signature", signature)
                }
            } catch (e: Exception) { Log.w(TAG, "speech ack connection failed for $base", e); continue }
            try {
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                if (conn.responseCode in 200..299) return true
            } catch (e: Exception) { Log.w(TAG, "speech ack failed for $base", e) } finally { conn.disconnect() }
        }
        return false
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    private const val SPEECH_CACHE_TTL_MS = 3L * 24L * 60L * 60L * 1000L
}
