package ai.carapa.board

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.net.URLDecoder

/**
 * FCM service that receives the data-only ping, fetches the real payload
 * from the board over the signed channel, and posts a rich Android
 * notification — even when the JS layer (and thus localStorage) isn't
 * running. Lock screen shows the actual summary, not a placeholder.
 *
 * Extends Capacitor's [MessagingService] so the plugin still receives
 * onNewToken (which the JS side reports to our server). We deliberately
 * do NOT call super.onMessageReceived — we own the rendering, and calling
 * super would also fire the Capacitor JS `pushNotificationReceived` event
 * which would render a duplicate local notification when the app is in
 * foreground.
 */
class CarapaMessagingService : MessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        val kind = data["kind"]
        val ref = data["ref"]

        // Killed-app fallback for the in-app WS dismiss path. Sent by the
        // server when a payload is acked elsewhere; we just clear the tray
        // entry keyed by the same hashCode used in postRichNotification.
        if (kind == "ack_dismiss") {
            if (ref == null || !looksLikePayloadId(ref)) {
                Log.i(TAG, "ack_dismiss with no payload id (ref=$ref); skipping")
                return
            }
            try {
                NotificationManagerCompat.from(applicationContext).cancel(ref.hashCode())
                Log.d(TAG, "ack_dismiss cleared tray notification for ref=$ref")
            } catch (e: SecurityException) {
                Log.w(TAG, "ack_dismiss: notification permission missing", e)
            }
            return
        }

        if (kind == "live_tts_stop") {
            if (!ref.isNullOrBlank()) CarapaSpeechService.stop(applicationContext, ref)
            return
        }

        if (kind == "live_tts") {
            val parts = ref?.split('|', limit = 3)?.map { URLDecoder.decode(it, "UTF-8") }
            if (parts == null || parts.size != 3) {
                Log.w(TAG, "invalid live_tts ref")
                return
            }
            Log.d(TAG, "live_tts received conversation=${parts[0]} message=${parts[1]} session=${parts[2]}")
            scope.launch {
                if (!CarapaSpeechService.speakReply(applicationContext, parts[0], parts[1], parts[2])) {
                    Log.w(TAG, "live speech download failed for ${parts[1]}")
                }
            }
            return
        }

        if (kind != "ping") {
            // Unknown payload — let the Capacitor plugin handle it as a fallback.
            super.onMessageReceived(remoteMessage)
            return
        }

        if (ref == null || !looksLikePayloadId(ref)) {
            // Defensive: every ping from notify_user carries a payload UUID.
            // A ref-less ping shouldn't happen in normal operation; nothing
            // to fetch, nothing to render.
            Log.i(TAG, "ping with no payload id (ref=$ref); skipping")
            return
        }

        scope.launch {
            try {
                val payload = CarapaApiClient.fetchPayload(applicationContext, ref)
                if (payload == null) {
                    Log.w(TAG, "fetchPayload returned null for ref=$ref; falling back to JS handler")
                    // Foreground apps still get a chance to render via the JS
                    // pushNotificationReceived listener (handlePing in push.ts).
                    super.onMessageReceived(remoteMessage)
                    return@launch
                }
                Log.d(
                    TAG,
                    "payload received id=${payload.id} kind=[${payload.kind}] " +
                        "summaryLen=${payload.summary.length} contentLen=${payload.content.length} " +
                        "summary=\"${payload.summary}\" content=\"${truncate(payload.content, 80)}\"",
                )
                ensureChannel(applicationContext)
                postRichNotification(applicationContext, payload)
            } catch (e: Exception) {
                Log.w(TAG, "onMessageReceived handling failed", e)
                super.onMessageReceived(remoteMessage)
            }
        }
    }

    private fun looksLikePayloadId(s: String): Boolean {
        // UUID-shape: 8 or more hex/dash chars. Mirrors the JS regex in push.ts.
        return Regex("^[0-9a-fA-F-]{8,}$").matches(s)
    }

    private fun postRichNotification(context: Context, payload: CarapaApiClient.NotifPayload) {
        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_NOTIF_ID, payload.id)
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pendingIntent = PendingIntent.getActivity(context, payload.id.hashCode(), tapIntent, pendingFlags)

        // For form notifications, swipe-away should signal "user dismissed" so
        // any agent blocking on the response unblocks. Text notifications have
        // no agent waiting — no delete intent needed. setContentIntent fires on
        // tap (and setAutoCancel(true) means the system removes the notification
        // without firing setDeleteIntent on tap), so this only fires on a real
        // user dismissal: swipe, "clear all", or programmatic cancel.
        val isForm = payload.kind == "json_form"
        val deletePendingIntent: PendingIntent? = if (isForm) {
            val dismissIntent = Intent(context, NotificationDismissReceiver::class.java).apply {
                action = NotificationDismissReceiver.ACTION_DISMISS
                putExtra(NotificationDismissReceiver.EXTRA_PAYLOAD_ID, payload.id)
            }
            PendingIntent.getBroadcast(
                context,
                payload.id.hashCode(),
                dismissIntent,
                pendingFlags,
            )
        } else null

        // Choose title + body so the collapsed view never visually duplicates.
        // Android clips the body line by width on lock-screens/heads-up banners,
        // so when summary is a prefix of content the truncated body looks
        // identical to the title. In that case (and when summary == content),
        // we drop the summary as title and let the body carry the message under
        // a generic app label.
        val summary = payload.summary
        val rawContent = truncate(payload.content, 240).trim()
        val isPrefixOfContent = rawContent.isNotEmpty() && rawContent.startsWith(summary) &&
            rawContent.length > summary.length

        val title: String
        val body: String?
        when (payload.kind) {
            "text" -> {
                if (isPrefixOfContent) {
                    title = APP_LABEL
                    body = rawContent
                } else if (rawContent.isBlank() || rawContent == summary) {
                    title = summary
                    body = null
                } else {
                    title = summary
                    body = rawContent
                }
            }
            "json_form" -> {
                title = summary
                body = "Tap to fill out form"
            }
            else -> {
                title = summary
                body = null
            }
        }
        Log.d(TAG, "render decision: kind=[${payload.kind}] title=\"${title}\" body=${if (body == null) "<title-only>" else "len=${body.length}"}")

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email) // TODO: replace with branded icon resource
            .setContentTitle(title)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)

        if (deletePendingIntent != null) {
            builder.setDeleteIntent(deletePendingIntent)
        }

        if (body != null) {
            builder.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }

        Log.d(TAG, "notify dispatched: title=\"${title}\" body=\"${body ?: "<title-only>"}\"")
        try {
            NotificationManagerCompat.from(context).notify(payload.id.hashCode(), builder.build())
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS denied (Android 13+). Nothing we can do here.
            Log.w(TAG, "notification permission missing", e)
        }
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "CarapaBoard notifications",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Notifications from agents and board events"
        }
        nm.createNotificationChannel(channel)
    }

    private fun truncate(s: String, n: Int): String =
        if (s.length <= n) s else s.substring(0, n - 1) + "…"

    companion object {
        const val CHANNEL_ID = "carapa_default"
        const val EXTRA_NOTIF_ID = "carapa_notif_id"
        private const val TAG = "CarapaMsgService"
        private const val APP_LABEL = "CarapaBoard"
    }
}
