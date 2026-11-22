package ai.carapa.board

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.LocaleList
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.io.IOException
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Transcribes committed phrases with an Android speech recognition service
 * (the alternative to Whisper). The phrase PCM is streamed to the service
 * through `EXTRA_AUDIO_SOURCE` (Android 13+), so the service never opens the
 * microphone and the browser VAD keeps defining phrases as it does for
 * Whisper. [transcribe] blocks and must run on a worker thread; [markPending]
 * and [cancel] may be called from any thread.
 */
class SystemSpeechRecognizer(private val context: Context) {
    data class Service(val id: String, val label: String, val isDefault: Boolean)

    private class RecognitionFailed(message: String, val transient: Boolean) : Exception(message)

    companion object {
        val unsupportedReason: String?
            get() = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                "Android speech recognition of captured phrases needs Android 13 or newer"
            } else {
                null
            }

        private const val TIMEOUT_MS = 30_000L
        private const val MAX_LANGUAGES = 3

        /** Service hiccups worth one retry of the same phrase. */
        private val TRANSIENT_ERRORS = setOf(
            SpeechRecognizer.ERROR_SERVER,
            SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
            SpeechRecognizer.ERROR_CLIENT,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
        )

        /**
         * 0.3 s of 16 kHz silence around each phrase. VAD cuts phrases tightly
         * and Google's recognizer then drops the last word ("Da sigur" -> "da").
         */
        private val SILENCE = ByteArray(16_000 * 2 * 3 / 10)

        private fun describe(error: Int): String = when (error) {
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "the recognizer does not support this language"
            SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "the language is not downloaded for this recognizer"
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "the recognizer needs a network connection"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "microphone permission is missing"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "the recognizer is busy"
            SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "the recognition service failed"
            SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "the recognizer cannot check language support"
            else -> "recognition error $error"
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val pending = HashSet<String>()
    private val cancelled = HashSet<String>()
    private var running: String? = null
    private var active: SpeechRecognizer? = null
    private var result: CompletableFuture<String>? = null

    /** Installed recognition services; the system default is marked. */
    fun services(): List<Service> {
        val pm = context.packageManager
        val default = Settings.Secure.getString(context.contentResolver, "voice_recognition_service")
            ?.let { ComponentName.unflattenFromString(it) }
        return pm.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0).map { info ->
            val component = ComponentName(info.serviceInfo.packageName, info.serviceInfo.name)
            Service(
                component.flattenToString(),
                info.serviceInfo.applicationInfo.loadLabel(pm).toString(),
                component == default,
            )
        }.sortedWith(compareBy({ !it.isDefault }, { it.label }))
    }

    fun markPending(id: String) {
        synchronized(lock) { pending.add(id) }
    }

    /** Cancels queued or running requests; null cancels every request. */
    fun cancel(ids: Collection<String>?) {
        synchronized(lock) {
            val current = running
            val targets = ids?.filter { it in pending || it == current } ?: (pending + listOfNotNull(current))
            cancelled.addAll(targets.filter { it in pending })
            if (current != null && current in targets) {
                result?.complete("")
                active?.let { recognizer -> main.post { recognizer.cancel() } }
                cancelled.add(current)
            }
        }
    }

    /** One transcript of the phrase, recognized as [language] (a BCP 47 tag). */
    data class Candidate(val language: String, val text: String)

    /**
     * Transcripts of the phrase in each candidate language, in order, or
     * null when the request was cancelled. Google's recognizer understands
     * only the language it is asked for and ignores its multi-language
     * extras: under the wrong language it returns nothing (English heard as
     * Romanian) or confident phonetic nonsense (Romanian heard as English),
     * and its confidence scores do not tell them apart. So a chosen language
     * ([language], Whisper-style: "ro,en", "en") is recognized alone, while
     * "auto" recognizes the phrase in each language set in Android and the
     * caller chooses among the transcripts that have text.
     */
    fun transcribe(id: String, serviceId: String?, pcm16: ByteArray, language: String): List<Candidate>? {
        unsupportedReason?.let { throw IllegalStateException(it) }
        synchronized(lock) {
            pending.remove(id)
            if (cancelled.remove(id)) return null
            running = id
        }
        try {
            val candidates = mutableListOf<Candidate>()
            var failure: RecognitionFailed? = null
            for (tag in candidateLanguages(language)) {
                if (synchronized(lock) { id in cancelled }) return null
                val text = try {
                    try {
                        recognizeOnce(serviceId, pcm16, tag)
                    } catch (error: RecognitionFailed) {
                        if (!error.transient || synchronized(lock) { id in cancelled }) throw error
                        recognizeOnce(serviceId, pcm16, tag)
                    }
                } catch (error: RecognitionFailed) {
                    // One language failing (e.g. not supported) must not lose
                    // the phrase when another language recognizes it.
                    failure = error
                    continue
                }
                if (synchronized(lock) { id in cancelled }) return null
                candidates.add(Candidate(tag, text))
            }
            if (candidates.isEmpty()) failure?.let { throw it }
            return candidates
        } finally {
            synchronized(lock) {
                running = null
                cancelled.remove(id)
            }
        }
    }

    /** One recognition of the phrase in [tag]. */
    private fun recognizeOnce(serviceId: String?, pcm16: ByteArray, tag: String): String {
        val future = CompletableFuture<String>()
        synchronized(lock) { result = future }
        val pipe = ParcelFileDescriptor.createPipe()
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            // With an audio source, Google's recognizer reports text only
            // through segment results; the session ends with the pipe.
            putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16_000)
        }
        main.post {
            try {
                val recognizer = serviceId?.let { ComponentName.unflattenFromString(it) }
                    ?.let { SpeechRecognizer.createSpeechRecognizer(context, it) }
                    ?: SpeechRecognizer.createSpeechRecognizer(context)
                synchronized(lock) { active = recognizer }
                recognizer.setRecognitionListener(Listener(future))
                recognizer.startListening(intent)
            } catch (error: Throwable) {
                future.completeExceptionally(error)
            }
        }
        // The service reads the pipe while we write; closing it marks the
        // end of the phrase. Writing on its own thread keeps a service that
        // never reads from blocking past the timeout.
        val writer = Thread({
            try {
                ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use {
                    it.write(SILENCE)
                    it.write(pcm16)
                    it.write(SILENCE)
                }
            } catch (_: IOException) {
                // The service closed its end early (error or cancel).
            }
        }, "carapa-recognizer-pipe")
        writer.start()
        try {
            return try {
                future.get(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            } catch (_: TimeoutException) {
                // Not transient (no retry); `transcribe` skips this language.
                throw RecognitionFailed("The Android speech recognizer did not answer within ${TIMEOUT_MS / 1000} s", false)
            } catch (wrapped: java.util.concurrent.ExecutionException) {
                throw wrapped.cause ?: wrapped
            }
        } finally {
            val recognizer = synchronized(lock) {
                result = null
                active.also { active = null }
            }
            main.post { recognizer?.destroy() }
            try { pipe[0].close() } catch (_: IOException) {}
            writer.join(1_000)
        }
    }

    /**
     * A chosen language is used alone ("ro,en" -> ro-RO: the first of the
     * Whisper-style hint). Auto-detect tries the languages set in Android,
     * at most [MAX_LANGUAGES], and the caller picks among the transcripts.
     */
    private fun candidateLanguages(hint: String): List<String> {
        languageTags(hint).firstOrNull()?.let { return listOf(it) }
        val list = LocaleList.getAdjustedDefault()
        return (0 until list.size()).map { list[it] }
            .filter { it.language.isNotEmpty() }
            .map { if (it.country.isEmpty()) regionalTag(it.language) else Locale(it.language, it.country).toLanguageTag() }
            .distinctBy { Locale.forLanguageTag(it).language }
            .take(MAX_LANGUAGES)
    }

    private fun regionalTag(code: String) = when (code) {
        "en" -> "en-US"
        "ro" -> "ro-RO"
        "de" -> "de-DE"
        else -> Locale.forLanguageTag(code).toLanguageTag()
    }

    /** Regional tags for a Whisper-style hint ("ro,en" -> ro-RO, en-US); empty for auto. */
    private fun languageTags(hint: String): List<String> =
        hint.split(',').map { it.trim() }.filter { it.isNotEmpty() && it != "auto" }.map { code ->
            val device = Locale.getDefault()
            // Recognizers expect a regional tag (ro-RO); prefer the device's
            // region when it speaks the same language.
            if (device.language == code && device.country.isNotEmpty()) device.toLanguageTag() else regionalTag(code)
        }.distinct()

    private class Listener(private val future: CompletableFuture<String>) : RecognitionListener {
        private val segments = mutableListOf<String>()

        private fun best(results: Bundle?) =
            results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

        override fun onResults(results: Bundle?) {
            future.complete(best(results).ifEmpty { segments.joinToString(" ") })
        }

        override fun onSegmentResults(segmentResults: Bundle) {
            best(segmentResults).takeIf { it.isNotEmpty() }?.let { segments.add(it) }
        }

        override fun onEndOfSegmentedSession() {
            future.complete(segments.joinToString(" "))
        }

        override fun onError(error: Int) {
            // No speech in the phrase is an empty transcript, not a failure.
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                future.complete(segments.joinToString(" "))
            } else {
                future.completeExceptionally(
                    RecognitionFailed("Android speech recognition failed: ${describe(error)}", error in TRANSIENT_ERRORS),
                )
            }
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onPartialResults(partialResults: Bundle?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}
