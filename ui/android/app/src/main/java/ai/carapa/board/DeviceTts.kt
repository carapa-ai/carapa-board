package ai.carapa.board

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Optional per-device text-to-speech: when enabled, replies are spoken with
 * an Android TTS engine on this device instead of the server's voices.
 * Settings live in SharedPreferences so [CarapaMessagingService] can read
 * them without the WebView.
 *
 * Live replies use [speakPieces], which hands the player the first sentence
 * as soon as it is synthesized and the rest while it plays; manual replays
 * use [speechFile], which synthesizes the whole reply into
 * `cacheDir/tts/<key>.device.wav`. Both fall back to the server audio when
 * the engine, the language or the synthesis is unavailable. Synthesis is
 * serialized and blocking; never call it on the main thread.
 */
object DeviceTts {
    private const val TAG = "CarapaDeviceTts"
    private const val PREFS = "carapa_device_tts"
    private const val INIT_TIMEOUT_MS = 5_000L
    private const val PIECE_TIMEOUT_MS = 15_000L
    private const val PIECE_CHARS = 1_000
    /** Live replies start playing after a first piece about one sentence long. */
    private const val FIRST_PIECE_CHARS = 80

    class Unavailable(message: String) : Exception(message)

    data class VoiceEntry(val name: String, val language: String, val label: String)

    private val lock = Any()
    private var tts: TextToSpeech? = null
    private var ttsEngine: String? = null
    private val utterances = ConcurrentHashMap<String, CompletableFuture<Unit>>()

    /** Why the last message fell back to server audio; cleared on success. */
    @Volatile var lastFallback: String? = null
        private set

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context) = prefs(context).getBoolean("enabled", false)

    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean("enabled", enabled).apply()
        lastFallback = null
    }

    /** Selected engine package, or null for the system default engine. */
    fun selectedEngine(context: Context): String? = prefs(context).getString("engine", null)

    fun selectEngine(context: Context, engine: String?) {
        prefs(context).edit().putString("engine", engine).apply()
        clearDeviceCache(context)
        lastFallback = null
    }

    /** Selected voice name for a language (e.g. "ro"), or null for the engine default. */
    fun selectedVoice(context: Context, language: String): String? =
        prefs(context).getString("voice:${baseLanguage(language)}", null)

    fun selectVoice(context: Context, language: String, voice: String?) {
        prefs(context).edit().putString("voice:${baseLanguage(language)}", voice).apply()
        clearDeviceCache(context)
        lastFallback = null
    }

    private fun baseLanguage(language: String) = language.trim().lowercase(Locale.ROOT).split('-', '_').first()

    /** Synthesized files depend on the selection; drop them when it changes. */
    private fun clearDeviceCache(context: Context) {
        File(context.cacheDir, "tts").listFiles()?.forEach { file ->
            if (file.name.endsWith(".device.wav")) file.delete()
        }
    }

    /** Initializes (or re-binds) the selected engine. Call with [lock] held. */
    private fun engine(context: Context): TextToSpeech {
        val wanted = selectedEngine(context)
        tts?.let { if (ttsEngine == wanted) return it }
        tts?.shutdown()
        tts = null
        val ready = CountDownLatch(1)
        var status = TextToSpeech.ERROR
        val listener = TextToSpeech.OnInitListener {
            status = it
            ready.countDown()
        }
        val created = if (wanted == null) {
            TextToSpeech(context.applicationContext, listener)
        } else {
            TextToSpeech(context.applicationContext, listener, wanted)
        }
        if (!ready.await(INIT_TIMEOUT_MS, TimeUnit.MILLISECONDS) || status != TextToSpeech.SUCCESS) {
            created.shutdown()
            throw Unavailable("the text-to-speech engine did not start")
        }
        created.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                utteranceId?.let { utterances.remove(it)?.complete(Unit) }
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                onError(utteranceId, TextToSpeech.ERROR)
            }
            override fun onError(utteranceId: String?, errorCode: Int) {
                utteranceId?.let {
                    utterances.remove(it)?.completeExceptionally(Unavailable("the engine failed to synthesize (error $errorCode)"))
                }
            }
            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                utteranceId?.let { utterances.remove(it)?.completeExceptionally(Unavailable("synthesis was stopped")) }
            }
        })
        tts = created
        ttsEngine = wanted
        return created
    }

    private fun installed(voice: Voice) =
        !voice.isNetworkConnectionRequired &&
            TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in voice.features.orEmpty()

    /** Engines, installed offline voices and the default engine, for the settings card. */
    fun describe(context: Context): Triple<List<TextToSpeech.EngineInfo>, List<VoiceEntry>, String?> =
        synchronized(lock) {
            val engine = engine(context)
            val voices = engine.voices.orEmpty()
                .filter(::installed)
                .map { voice ->
                    VoiceEntry(
                        voice.name,
                        voice.locale.toLanguageTag(),
                        "${voice.locale.getDisplayName(Locale.getDefault())} · ${voice.name}",
                    )
                }
                .sortedWith(compareBy({ it.language }, { it.name }))
            Triple(engine.engines, voices, engine.defaultEngine)
        }

    /** Picks the voice for [language]: the selected one, else an installed default. */
    private fun chooseVoice(context: Context, engine: TextToSpeech, language: String?) {
        if (language.isNullOrBlank()) {
            engine.defaultVoice?.let { engine.voice = it }
            return
        }
        val base = baseLanguage(language)
        val voices = engine.voices.orEmpty().filter(::installed)
        selectedVoice(context, base)?.let { name ->
            voices.firstOrNull { it.name == name }?.let {
                engine.voice = it
                return
            }
        }
        val locale = Locale.forLanguageTag(language.replace('_', '-'))
        if (engine.isLanguageAvailable(locale) < TextToSpeech.LANG_AVAILABLE) {
            throw Unavailable("no ${locale.getDisplayLanguage(Locale.ENGLISH)} voice is available on this device")
        }
        engine.language = locale
        if (engine.voice?.let(::installed) == true) return
        val local = voices.firstOrNull { it.locale.language == base }
            ?: throw Unavailable("the ${locale.getDisplayLanguage(Locale.ENGLISH)} voice is not downloaded on this device")
        engine.voice = local
    }

    /** Selects [voice], or the voice chosen for [language] when null. Call with [lock] held. */
    private fun prepareVoice(context: Context, engine: TextToSpeech, language: String?, voice: String?) {
        if (voice == null) {
            chooseVoice(context, engine, language)
        } else {
            engine.voice = engine.voices.orEmpty().filter(::installed).firstOrNull { it.name == voice }
                ?: throw Unavailable("the voice $voice is not installed")
        }
    }

    /** Synthesizes one bounded piece into [target]. Call with [lock] held. */
    private fun synthesizePiece(engine: TextToSpeech, piece: String, target: File) {
        target.parentFile?.mkdirs()
        val id = "carapa-${System.nanoTime()}"
        val done = CompletableFuture<Unit>()
        utterances[id] = done
        try {
            if (engine.synthesizeToFile(piece, Bundle(), target, id) != TextToSpeech.SUCCESS) {
                throw Unavailable("the engine rejected the text")
            }
            done.get(PIECE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            engine.stop()
            throw Unavailable("synthesis took longer than ${PIECE_TIMEOUT_MS / 1000} s")
        } catch (wrapped: ExecutionException) {
            throw wrapped.cause ?: wrapped
        } finally {
            utterances.remove(id)
        }
    }

    /**
     * Synthesizes [text] into the WAV file [target] with [voice], or the
     * voice chosen for [language] when null. Throws [Unavailable].
     */
    fun synthesize(context: Context, text: String, language: String?, target: File, voice: String? = null) {
        val pieces = split(text)
        if (pieces.isEmpty()) throw Unavailable("there is nothing to speak")
        synchronized(lock) {
            val engine = engine(context)
            prepareVoice(context, engine, language, voice)
            val parts = pieces.mapIndexed { index, piece ->
                File(target.parentFile, "${target.name}.$index.part").also { synthesizePiece(engine, piece, it) }
            }
            try {
                concatWav(parts, target)
            } finally {
                parts.forEach { it.delete() }
            }
        }
    }

    /**
     * The audio file to play for a reply: device speech when enabled and
     * possible, otherwise the server's audio. Null only when the server
     * audio is unavailable too.
     */
    fun speechFile(context: Context, conversationId: String, messageId: String, sessionId: String? = null): File? {
        if (!enabled(context)) return CarapaApiClient.fetchSpeech(context, conversationId, messageId, sessionId)
        val key = "$conversationId-$messageId".replace(Regex("[^a-zA-Z0-9_-]"), "_").take(160)
        val target = File(File(context.cacheDir, "tts"), "$key.device.wav")
        if (target.length() > 0L) return target
        val started = System.currentTimeMillis()
        try {
            val speech = CarapaApiClient.fetchSpeechText(context, conversationId, messageId, sessionId)
                ?: throw Unavailable("the reply text could not be loaded")
            val temporary = File(target.parentFile, "$key.${Thread.currentThread().id}.device.tmp")
            synthesize(context, speech.text, speech.language, temporary)
            if (!temporary.renameTo(target)) {
                temporary.copyTo(target, overwrite = true)
                temporary.delete()
            }
            lastFallback = null
            Log.i(TAG, "device speech for $messageId ready in ${System.currentTimeMillis() - started} ms (${speech.language})")
            return target
        } catch (error: Throwable) {
            val reason = error.message ?: "device speech failed"
            if (reason != lastFallback) Log.w(TAG, "falling back to server speech: $reason", error)
            lastFallback = reason
        }
        return CarapaApiClient.fetchSpeech(context, conversationId, messageId, sessionId)
    }

    private val speaking = ConcurrentHashMap.newKeySet<String>()

    /**
     * Live replies: speaks a reply piece by piece, so playback starts after
     * its first sentence instead of after the whole reply. [onPiece] gets
     * each WAV in order with the estimated length of the whole reply (from
     * the first piece's speaking rate, null when the file is the whole
     * reply) and returns false to stop, e.g. when the player rejected it.
     * Returns false when nothing was spoken, so the caller plays the
     * server's audio instead; a failure after the first piece ends the
     * reply early. A reply already being spoken by another caller (push and
     * WebSocket both request it) returns true without doing anything.
     */
    fun speakPieces(
        context: Context,
        conversationId: String,
        messageId: String,
        sessionId: String,
        onPiece: (file: File, index: Int, estimatedTotalMs: Long?) -> Boolean,
    ): Boolean {
        if (!enabled(context)) return false
        val key = "$conversationId-$messageId".replace(Regex("[^a-zA-Z0-9_-]"), "_").take(160)
        val whole = File(File(context.cacheDir, "tts"), "$key.device.wav")
        if (whole.length() > 0L) {
            onPiece(whole, 0, null)
            return true
        }
        if (!speaking.add(key)) return true
        val started = System.currentTimeMillis()
        var delivered = 0
        try {
            val speech = CarapaApiClient.fetchSpeechText(context, conversationId, messageId, sessionId)
                ?: throw Unavailable("the reply text could not be loaded")
            val pieces = split(speech.text, FIRST_PIECE_CHARS)
            if (pieces.isEmpty()) throw Unavailable("there is nothing to speak")
            synchronized(lock) {
                val engine = engine(context)
                prepareVoice(context, engine, speech.language, null)
                var estimate: Long? = null
                for ((index, piece) in pieces.withIndex()) {
                    val part = File(whole.parentFile, "$key.$index.device.wav")
                    synthesizePiece(engine, piece, part)
                    if (index == 0) {
                        estimate = wavDurationMs(part)?.let { first ->
                            first * speech.text.length / piece.length.coerceAtLeast(1)
                        }
                        lastFallback = null
                        Log.i(TAG, "device speech for $messageId started in ${System.currentTimeMillis() - started} ms (${speech.language}, ${pieces.size} pieces)")
                    }
                    delivered++
                    if (!onPiece(part, index, estimate)) break
                }
            }
            return true
        } catch (error: Throwable) {
            val reason = error.message ?: "device speech failed"
            if (delivered > 0) {
                Log.w(TAG, "device speech for $messageId ended after $delivered pieces: $reason", error)
                return true
            }
            if (reason != lastFallback) Log.w(TAG, "falling back to server speech: $reason", error)
            lastFallback = reason
            return false
        } finally {
            speaking.remove(key)
        }
    }

    /** Device speech for arbitrary text (WebView playback paths), cached by content. */
    fun textSpeechFile(context: Context, text: String, language: String?): File {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${selectedEngine(context)}\u0000${language ?: ""}\u0000${language?.let { selectedVoice(context, it) } ?: ""}\u0000$text".toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(32)
        val target = File(File(context.cacheDir, "tts"), "text-$digest.device.wav")
        if (target.length() > 0L) return target
        try {
            val temporary = File(target.parentFile, "text-$digest.${Thread.currentThread().id}.device.tmp")
            synthesize(context, text, language, temporary)
            if (!temporary.renameTo(target)) {
                temporary.copyTo(target, overwrite = true)
                temporary.delete()
            }
            lastFallback = null
            return target
        } catch (error: Throwable) {
            val reason = error.message ?: "device speech failed"
            if (reason != lastFallback) Log.w(TAG, "device speech unavailable: $reason", error)
            lastFallback = reason
            throw error
        }
    }

    /**
     * Voice previews: [text] in [voice], or in this device's voice for
     * [language], whether or not device speech is on. Failures throw and,
     * unlike replies, never change [lastFallback].
     */
    fun previewFile(context: Context, text: String, language: String?, voice: String?): File {
        val chosen = voice ?: language?.let { selectedVoice(context, it) }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${selectedEngine(context)}\u0000${language ?: ""}\u0000${chosen ?: ""}\u0000$text".toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(32)
        val target = File(File(context.cacheDir, "tts"), "preview-$digest.device.wav")
        if (target.length() > 0L) return target
        val temporary = File(target.parentFile, "preview-$digest.${Thread.currentThread().id}.device.tmp")
        synthesize(context, text, language, temporary, voice)
        if (!temporary.renameTo(target)) {
            temporary.copyTo(target, overwrite = true)
            temporary.delete()
        }
        return target
    }

    /**
     * Sentence-aligned pieces short enough for one bounded synthesis each;
     * the first piece stops after [firstPieceChars] so playback can start early.
     */
    private fun split(text: String, firstPieceChars: Int = PIECE_CHARS): List<String> {
        val pieces = mutableListOf<String>()
        var current = StringBuilder()
        for (sentence in text.trim().split(Regex("(?<=[.!?…])\\s+"))) {
            var rest = sentence.trim()
            while (rest.length > PIECE_CHARS) {
                val cut = rest.lastIndexOf(' ', PIECE_CHARS).takeIf { it > 0 } ?: PIECE_CHARS
                if (current.isNotEmpty()) {
                    pieces.add(current.toString())
                    current = StringBuilder()
                }
                pieces.add(rest.substring(0, cut).trim())
                rest = rest.substring(cut).trim()
            }
            if (rest.isEmpty()) continue
            val limit = if (pieces.isEmpty()) firstPieceChars else PIECE_CHARS
            if (current.length + rest.length + 1 > limit && current.isNotEmpty()) {
                pieces.add(current.toString())
                current = StringBuilder()
            }
            if (current.isNotEmpty()) current.append(' ')
            current.append(rest)
        }
        if (current.isNotEmpty()) pieces.add(current.toString())
        return pieces.filter { it.isNotBlank() }
    }

    /** The `fmt ` and `data` chunk contents of a WAV file. */
    private fun wavChunks(bytes: ByteArray): Pair<ByteArray?, ByteArray> {
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var pos = 12
        var format: ByteArray? = null
        var samples = ByteArray(0)
        while (pos + 8 <= bytes.size) {
            val id = String(bytes, pos, 4, Charsets.US_ASCII)
            val declared = buffer.getInt(pos + 4).toLong() and 0xffffffffL
            val length = minOf(declared, (bytes.size - pos - 8).toLong()).toInt()
            if (id == "fmt ") format = format ?: bytes.copyOfRange(pos + 8, pos + 8 + length)
            if (id == "data") samples = bytes.copyOfRange(pos + 8, pos + 8 + length)
            pos += 8 + length + (length and 1)
        }
        return format to samples
    }

    private fun wavDurationMs(file: File): Long? {
        val (format, samples) = wavChunks(file.readBytes())
        if (format == null || format.size < 12) return null
        val byteRate = ByteBuffer.wrap(format, 8, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong()
        return if (byteRate > 0) samples.size * 1000L / byteRate else null
    }

    /** Joins same-format WAV files from one voice into a single WAV file. */
    private fun concatWav(parts: List<File>, target: File) {
        if (parts.size == 1) {
            if (!parts[0].renameTo(target)) parts[0].copyTo(target, overwrite = true)
            return
        }
        var format: ByteArray? = null
        val data = parts.map { part ->
            val (fmt, samples) = wavChunks(part.readBytes())
            format = format ?: fmt
            samples
        }
        val fmt = format ?: throw Unavailable("the engine produced unreadable audio")
        val total = data.sumOf { it.size }
        RandomAccessFile(target, "rw").use { out ->
            out.setLength(0)
            val header = ByteBuffer.allocate(12 + 8 + fmt.size + 8).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(4 + 8 + fmt.size + 8 + total)
            header.put("WAVE".toByteArray(Charsets.US_ASCII))
            header.put("fmt ".toByteArray(Charsets.US_ASCII)).putInt(fmt.size).put(fmt)
            header.put("data".toByteArray(Charsets.US_ASCII)).putInt(total)
            out.write(header.array())
            data.forEach { out.write(it) }
        }
    }
}
