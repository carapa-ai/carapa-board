package ai.carapa.board

import android.content.Context
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Looper
import android.util.Log
import android.webkit.SslErrorHandler
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.Socket
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

/**
 * Per-server certificate pins: an additional trust anchor for one exact
 * host and port (a publicly trusted certificate there still works). The UI
 * pushes the list through `CarapaBridge.setServerPins`; it is stored
 * app-privately so the process, including [CarapaMessagingService] without an
 * activity, can read it at start.
 */
object CarapaTls {
    private const val TAG = "CarapaTls"
    private const val PINS_FILE = "carapa-server-pins.json"

    @Volatile
    private var pins: List<ServerPin> = emptyList()
    private var installed = false
    private var platformTrust: X509TrustManager? = null
    private var platformVerifier: HostnameVerifier? = null
    private var activeContext: SSLContext? = null

    /** Load the stored pins and install the native TLS hooks; once per process. */
    @Synchronized
    fun init(context: Context) {
        if (installed) return
        installed = true
        pins = readPins(File(context.filesDir, PINS_FILE))
        installNativeTls()
    }

    /** Replace all pins (an empty list clears them). */
    @Synchronized
    fun setPins(context: Context, next: List<ServerPin>) {
        val distinct = next.distinct()
        if (distinct == pins) return
        val file = File(context.filesDir, PINS_FILE)
        val temp = File(context.filesDir, "$PINS_FILE.tmp")
        temp.writeText(
            JSONArray(
                distinct.map {
                    JSONObject().put("host", it.host).put("port", it.port).put("certSha256", it.certSha256)
                },
            ).toString(),
        )
        if (!temp.renameTo(file)) {
            temp.delete()
            throw java.io.IOException("could not persist server pins")
        }
        pins = distinct
        // Resumed TLS sessions and pooled connections skip certificate validation, so a
        // changed policy must not inherit them: switch to a fresh context and factory.
        if (installed) installNativeTls()
    }

    private fun readPins(file: File): List<ServerPin> = try {
        if (!file.exists()) {
            emptyList()
        } else {
            val array = JSONArray(file.readText())
            (0 until array.length()).mapNotNull {
                val entry = array.getJSONObject(it)
                val sha = entry.getString("certSha256")
                val host = CertPinPolicy.normalizeHost(entry.getString("host"))
                val port = entry.getInt("port")
                if (host.isEmpty() || port !in 1..65535 || !CertPinPolicy.isSha256Hex(sha)) null
                else ServerPin(host, port, sha)
            }
        }
    } catch (error: Exception) {
        // Fail closed: unreadable pins mean no extra trust.
        Log.w(TAG, "Ignoring unreadable server pins", error)
        emptyList()
    }

    /** A pinned leaf is only accepted while it is inside its validity period. */
    private fun pinnedLeafAllowed(host: String, port: Int, leaf: X509Certificate): Boolean = try {
        leaf.checkValidity()
        CertPinPolicy.allows(host, port, leaf.encoded, pins)
    } catch (_: Exception) {
        false
    }

    // ──── Native HttpsURLConnection ──────────────────────────────────

    /**
     * (Re)build the process-wide HttpsURLConnection defaults. Every call creates a
     * new [SSLContext] (empty session cache) and a new socket factory and hostname
     * verifier; connection pools key on those instances, so earlier pooled
     * connections are not reused, and the replaced context's sessions are dropped.
     */
    @Synchronized
    private fun installNativeTls() {
        try {
            val trust = platformTrust ?: run {
                val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                factory.init(null as KeyStore?)
                factory.trustManagers.filterIsInstance<X509TrustManager>().first()
            }
            val verifier = platformVerifier ?: HttpsURLConnection.getDefaultHostnameVerifier()
            val context = SSLContext.getInstance("TLS")
            context.init(null, arrayOf<TrustManager>(PinFallbackTrustManager(trust)), null)
            HttpsURLConnection.setDefaultSSLSocketFactory(context.socketFactory)
            HttpsURLConnection.setDefaultHostnameVerifier(PinHostnameVerifier(verifier))
            platformTrust = trust
            platformVerifier = verifier
            activeContext?.let(::invalidateSessions)
            activeContext = context
        } catch (error: Exception) {
            // Without the hook the app behaves as it did before pins existed.
            Log.e(TAG, "Failed to install native TLS pin fallback", error)
        }
    }

    /** For connections still holding the replaced factory: no session may resume without validation. */
    private fun invalidateSessions(context: SSLContext) {
        val sessions = context.clientSessionContext ?: return
        sessions.sessionTimeout = 1
        for (id in java.util.Collections.list(sessions.ids)) sessions.getSession(id)?.invalidate()
    }

    /** Platform validation first (including network_security_config); a pin only rescues a failure. */
    private class PinFallbackTrustManager(private val platform: X509TrustManager) : X509ExtendedTrustManager() {
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket?) {
            try {
                if (platform is X509ExtendedTrustManager) {
                    platform.checkServerTrusted(chain, authType, socket)
                } else {
                    platform.checkServerTrusted(chain, authType)
                }
            } catch (error: CertificateException) {
                val session = (socket as? SSLSocket)?.handshakeSession
                acceptPinnedOrThrow(error, chain, session?.peerHost, session?.peerPort)
            }
        }

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine?) {
            try {
                if (platform is X509ExtendedTrustManager) {
                    platform.checkServerTrusted(chain, authType, engine)
                } else {
                    platform.checkServerTrusted(chain, authType)
                }
            } catch (error: CertificateException) {
                val session = engine?.handshakeSession
                acceptPinnedOrThrow(error, chain, session?.peerHost, session?.peerPort)
            }
        }

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
            platform.checkServerTrusted(chain, authType)

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket?) =
            platform.checkClientTrusted(chain, authType)

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine?) =
            platform.checkClientTrusted(chain, authType)

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            platform.checkClientTrusted(chain, authType)

        override fun getAcceptedIssuers(): Array<X509Certificate> = platform.acceptedIssuers

        private fun acceptPinnedOrThrow(
            error: CertificateException,
            chain: Array<X509Certificate>,
            host: String?,
            port: Int?,
        ) {
            val leaf = chain.firstOrNull()
            if (leaf == null || host.isNullOrEmpty() || port == null || port <= 0 || !pinnedLeafAllowed(host, port, leaf)) {
                throw error
            }
        }
    }

    /** The pin stands in for hostname verification, but only for the pinned certificate on its address. */
    private class PinHostnameVerifier(private val platform: HostnameVerifier) : HostnameVerifier {
        override fun verify(hostname: String?, session: SSLSession?): Boolean {
            if (platform.verify(hostname, session)) return true
            if (hostname == null || session == null) return false
            val leaf = try {
                session.peerCertificates.firstOrNull() as? X509Certificate
            } catch (_: Exception) {
                null
            } ?: return false
            return pinnedLeafAllowed(hostname, session.peerPort, leaf)
        }
    }

    // ──── WebView ────────────────────────────────────────────────────

    /** Install the pin-aware client; the Capacitor client does not handle SSL errors. */
    fun installWebViewClient(bridge: Bridge) {
        bridge.setWebViewClient(PinWebViewClient(bridge))
    }

    private class PinWebViewClient(bridge: Bridge) : BridgeWebViewClient(bridge) {
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // The isolation below relies on running in one UI-thread task; fail closed otherwise.
            if (Looper.myLooper() != Looper.getMainLooper() || !webViewErrorAllowed(error)) {
                handler.cancel()
                return
            }
            // WebView remembers proceed() per host and certificate, not per port. Chromium
            // records that decision synchronously inside proceed() (SSLManager::OnAllowCertificate)
            // and looks it up on the same UI thread (SSLManager::OnCertError), so no other
            // handshake can observe it between these two calls. Clearing it in this same task
            // leaves no window in which the approval for this port covers another one, and every
            // later handshake, including after a pin change, is judged by this callback again.
            try {
                handler.proceed()
            } finally {
                view.clearSslPreferences()
            }
        }
    }

    private fun webViewErrorAllowed(error: SslError): Boolean {
        // Only a chain or host-name problem may be overridden: never expiry or other defects.
        val primary = error.primaryError
        if (primary != SslError.SSL_UNTRUSTED && primary != SslError.SSL_IDMISMATCH) return false
        if (error.hasError(SslError.SSL_EXPIRED) || error.hasError(SslError.SSL_NOTYETVALID) ||
            error.hasError(SslError.SSL_DATE_INVALID) || error.hasError(SslError.SSL_INVALID)
        ) {
            return false
        }
        // SslCertificate.getX509Certificate() only exists from API 29.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        return try {
            val uri = Uri.parse(error.url)
            val host = uri.host ?: return false
            val port = if (uri.port == -1) 443 else uri.port
            // Sub-resources report https, the application WebSocket reports wss: both are
            // TLS to the same host and port, with 443 as the default for either.
            if (!"https".equals(uri.scheme, ignoreCase = true) && !"wss".equals(uri.scheme, ignoreCase = true)) return false
            val leaf = error.certificate?.x509Certificate ?: return false
            pinnedLeafAllowed(host, port, leaf)
        } catch (_: Exception) {
            false
        }
    }
}
