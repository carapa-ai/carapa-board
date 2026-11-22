package ai.carapa.board

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Fires when the user swipes a CarapaBoard notification away (via the OS
 * shade) instead of tapping it. Forwards the dismissal to the board so any
 * agent that was blocking on the form's response unblocks with a 'cancelled'
 * status — the same effect as tapping Cancel inside the in-app notif route.
 *
 * Wired up in [CarapaMessagingService.postRichNotification] via
 * `setDeleteIntent`. Tapping the notification fires `setContentIntent`
 * instead, which (with `setAutoCancel(true)`) does NOT trigger this receiver.
 */
class NotificationDismissReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val payloadId = intent.getStringExtra(EXTRA_PAYLOAD_ID)
        if (payloadId.isNullOrBlank()) {
            Log.w(TAG, "received dismiss with no payload id; ignoring")
            return
        }

        val pending = goAsync()
        Thread {
            try {
                val ok = CarapaApiClient.ackPayload(context.applicationContext, payloadId)
                Log.d(TAG, "dismiss ack for payload=$payloadId ok=$ok")
            } catch (e: Exception) {
                Log.w(TAG, "dismiss ack threw for payload=$payloadId", e)
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val EXTRA_PAYLOAD_ID = "carapa_payload_id"
        const val ACTION_DISMISS = "ai.carapa.board.NOTIF_DISMISSED"
        private const val TAG = "CarapaDismissReceiver"
    }
}
