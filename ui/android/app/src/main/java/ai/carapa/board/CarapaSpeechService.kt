package ai.carapa.board

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Native speech queue that survives WebView suspension and owns audio focus. */
class CarapaSpeechService : MediaSessionService() {
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var currentId: String? = null
    private var startedId: String? = null
    private val acknowledgedIds = mutableSetOf<String>()
    // A reply's later piece can reach an ended timeline, which resets
    // startedId; the reply must still report "started" only once.
    private val startedIds = mutableSetOf<String>()

    override fun onCreate() {
        super.onCreate()
        player = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    // Media3 only supports automatic audio-focus handling for
                    // MEDIA and GAME. Live Mode speech is long-running media
                    // playback, so MEDIA also gives it the expected headset,
                    // lock-screen, and interruption behavior.
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                true,
            )
            addListener(object : Player.Listener {
                override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                    // The pieces of one device-spoken reply play as one reply.
                    val next = mediaItem?.mediaId?.let(::replyId)
                    val previous = currentId
                    if (previous == next) return
                    if (previous != null) acknowledge(previous, "completed")
                    currentId = next
                    startedId = null
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    val id = currentId
                    if (isPlaying && id != null && startedId != id && startedIds.add(id)) {
                        startedId = id
                        CarapaBridgePlugin.deliverSpeechPlayback(id, "started")
                        val parts = id.split('|', limit = 3)
                        // Device-spoken replies have no server audio, so the
                        // server times the queue item by this reply's length:
                        // estimated when it is still being synthesized.
                        val durationMs = estimatedDurations.remove(id)
                            ?: player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
                        if (parts.size == 3) scope.launch {
                            CarapaApiClient.ackSpeech(applicationContext, parts[0], parts[1], parts[2], "started", durationMs)
                        }
                    }
                }

                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED) {
                        currentId?.let { acknowledge(it, "completed") }
                        if (player.hasNextMediaItem()) {
                            // A release can be appended on the same looper turn
                            // that the previous timeline reaches ENDED. Move to
                            // it explicitly instead of relying on ExoPlayer's
                            // automatic transition, which has already passed.
                            Log.d(TAG, "advance ended timeline to queued item")
                            player.seekToNextMediaItem()
                            player.prepare()
                            player.playWhenReady = true
                        } else {
                            currentId = null
                            startedId = null
                        }
                    }
                }

                override fun onPlayerError(error: PlaybackException) {
                    currentId?.let { acknowledge(it, "failed") }
                    currentId = null
                    startedId = null
                }
            })
        }
        session = MediaSession.Builder(this, player).build()
        // This service is started through our custom SPEECH_ENQUEUE intent,
        // rather than by a MediaController connection. Register the locally
        // created session explicitly so MediaSessionService observes playback,
        // publishes its media notification, and fulfills the initial
        // startForegroundService() request by promoting itself.
        addSession(session)
        serviceRunning.set(true)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ENQUEUE -> {
                val file = intent.getStringExtra(EXTRA_FILE) ?: return START_NOT_STICKY
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                if (player.currentMediaItem?.mediaId != id && !queuedIds.contains(id)) {
                    // ExoPlayer keeps the completed item selected at the end of
                    // its timeline. Appending after STATE_ENDED does not
                    // reliably move playback to the new item, so start a fresh
                    // timeline at this server-released clip.
                    if (player.playbackState == Player.STATE_ENDED) {
                        Log.d(TAG, "reset ended timeline before enqueue id=$id")
                        player.clearMediaItems()
                        currentId = null
                        startedId = null
                    }
                    Log.d(TAG, "enqueue media item id=$id count=${player.mediaItemCount}")
                    val newIndex = player.mediaItemCount
                    queuedIds.add(id)
                    player.addMediaItem(MediaItem.Builder().setMediaId(id).setUri(Uri.parse(file)).build())
                    // Cover the inverse race: ENDED may fire between the check
                    // above and addMediaItem(). In that case currentId was
                    // cleared and the newly appended item must be selected.
                    if (currentId == null && player.currentMediaItem?.mediaId != id) {
                        Log.d(TAG, "select appended item after ended race id=$id index=$newIndex")
                        player.seekTo(newIndex, 0L)
                    }
                    player.prepare()
                    player.playWhenReady = true
                }
            }
            ACTION_STOP -> {
                player.stop()
                player.clearMediaItems()
                queuedIds.clear()
                acceptedIds.clear()
                activeSessionId.set(STOPPED_SESSION)
                acknowledgedIds.clear()
                startedIds.clear()
                stopSelf()
                return START_NOT_STICKY
            }
        }
        // Let MediaSessionService publish and maintain the foreground media
        // notification after our custom enqueue action has updated the player.
        return super.onStartCommand(intent, flags, startId)
    }

    private fun acknowledge(id: String, outcome: String) {
        if (!acknowledgedIds.add(id)) return
        queuedIds.removeIf { replyId(it) == id }
        CarapaBridgePlugin.deliverSpeechPlayback(id, outcome)
        // v2 pacing is server-clocked from the playback-start signal above.
        // Completion remains a local UI event and must not advance the queue.
    }

    override fun onDestroy() {
        serviceRunning.set(false)
        session.release()
        player.release()
        super.onDestroy()
    }

    companion object {
        private const val ACTION_ENQUEUE = "ai.carapa.board.SPEECH_ENQUEUE"
        private const val ACTION_STOP = "ai.carapa.board.SPEECH_STOP"
        private const val EXTRA_FILE = "file"
        private const val EXTRA_ID = "id"
        private const val STOPPED_SESSION = "\u0000stopped"
        private const val TAG = "CarapaSpeech"
        /** Separates a reply's id from its piece number in a media id. */
        private const val PIECE_SEPARATOR = '\u001f'
        private val estimatedDurations = ConcurrentHashMap<String, Long>()

        private fun replyId(mediaId: String) = mediaId.substringBefore(PIECE_SEPARATOR)

        /** Whether this reply was already queued in the current session. */
        fun accepted(conversationId: String, messageId: String, sessionId: String) =
            acceptedIds.contains("$conversationId|$messageId|$sessionId")
        private val queuedIds = ConcurrentHashMap.newKeySet<String>()
        // FCM, WebSocket, and resume recovery can all request the same clip.
        // Keep a session-lifetime accepted set so a slower duplicate download
        // cannot re-enqueue after the first playback has already completed.
        private val acceptedIds = ConcurrentHashMap.newKeySet<String>()
        private val activeSessionId = AtomicReference<String?>(null)
        private val serviceRunning = AtomicBoolean(false)

        /**
         * Queues one reply clip, or piece [piece] of a reply that is still
         * being synthesized ([estimatedDurationMs] is then the whole reply's
         * estimated length). Returns false when the clip was rejected.
         */
        fun enqueue(
            context: Context,
            fileUri: String,
            conversationId: String,
            messageId: String,
            sessionId: String,
            piece: Int = 0,
            estimatedDurationMs: Long? = null,
        ): Boolean {
            while (true) {
                val active = activeSessionId.get()
                if (active == STOPPED_SESSION || (active != null && active != sessionId)) {
                    Log.w(TAG, "reject stale enqueue message=$messageId active=$active requested=$sessionId")
                    return false
                }
                if (active != null || activeSessionId.compareAndSet(null, sessionId)) break
            }
            val reply = "$conversationId|$messageId|$sessionId"
            val id = if (piece == 0) reply else "$reply$PIECE_SEPARATOR$piece"
            if (!acceptedIds.add(id)) return false
            if (piece == 0 && estimatedDurationMs != null) estimatedDurations[reply] = estimatedDurationMs
            Log.d(TAG, "accept enqueue id=$id running=${serviceRunning.get()}")
            val intent = Intent(context, CarapaSpeechService::class.java).apply {
                action = ACTION_ENQUEUE
                putExtra(EXTRA_FILE, fileUri)
                putExtra(EXTRA_ID, id)
            }
            // The session registered in onCreate lets MediaSessionService
            // promote the initial launch when playback begins. Re-requesting
            // foreground startup for every queued item creates a fresh Android
            // deadline, but an already playing session does not need another.
            if (serviceRunning.get()) {
                context.startService(intent)
            } else {
                ContextCompat.startForegroundService(context, intent)
            }
            return true
        }

        /**
         * Queues a Live reply: spoken by this device piece by piece when
         * device speech is on and works, else the server's audio. Blocking;
         * false when no audio could be obtained.
         */
        fun speakReply(context: Context, conversationId: String, messageId: String, sessionId: String): Boolean {
            if (accepted(conversationId, messageId, sessionId)) return true
            val spoken = DeviceTts.speakPieces(context, conversationId, messageId, sessionId) { file, piece, estimate ->
                enqueue(context, Uri.fromFile(file).toString(), conversationId, messageId, sessionId, piece, estimate)
            }
            if (spoken) return true
            val file = CarapaApiClient.fetchSpeech(context, conversationId, messageId, sessionId) ?: return false
            enqueue(context, Uri.fromFile(file).toString(), conversationId, messageId, sessionId)
            return true
        }

        /** Claim native playback for a newly active WebView session. */
        fun activateSession(context: Context, sessionId: String) {
            if (activeSessionId.getAndSet(sessionId) == sessionId) return
            queuedIds.clear()
            acceptedIds.clear()
            estimatedDurations.clear()
            context.stopService(Intent(context, CarapaSpeechService::class.java))
        }

        fun stop(context: Context, sessionId: String) {
            val active = activeSessionId.get()
            // A delayed stop push for the previous owner must not clear audio
            // already queued by a newer Live Mode session.
            if (active != null && active != sessionId) return
            queuedIds.clear()
            acceptedIds.clear()
            estimatedDurations.clear()
            activeSessionId.set(STOPPED_SESSION)
            context.stopService(Intent(context, CarapaSpeechService::class.java))
        }
    }
}
