package ai.carapa.board

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/**
 * Optional on-device transcription for composer dictation and Live Mode.
 * Off by default and enabled per device (not per account), so a tablet can
 * transcribe locally while a phone keeps the server path. The engine is
 * either Whisper (default) or an Android speech recognition service
 * ([SystemSpeechRecognizer]); both receive the same committed phrases.
 *
 * - `getStatus()` reports the opt-in, the engine, the selected model's state,
 *   the pinned model catalog and the installed recognition services;
 *   `status` events report download/load progress.
 * - `setEnabled`, `selectEngine`, `selectModel`, `downloadModel`,
 *   `deleteModel` manage the per-device setting and the downloaded models.
 * - `prepare()` downloads (if needed), verifies and loads the selected model;
 *   the Android engine needs no preparation.
 * - `transcribe({requestId, pcm, language})` runs one committed 16 kHz mono
 *   Int16 phrase (base64) on a single inference thread; `cancel({requestIds})`
 *   drops queued requests and aborts the running one.
 *
 * Downloads run on their own thread so a large download never delays
 * transcription with an already-installed model.
 */
@CapacitorPlugin(name = "CarapaWhisper")
class CarapaWhisperPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "carapa-whisper") }
    private val downloader = Executors.newSingleThreadExecutor { Thread(it, "carapa-whisper-download") }
    private val engine = LocalWhisper()
    private val recognizer by lazy { SystemSpeechRecognizer(context.applicationContext) }
    private val store by lazy { WhisperModelStore(context.applicationContext) }
    private val prefs by lazy {
        context.applicationContext.getSharedPreferences("carapa_whisper", Context.MODE_PRIVATE)
    }

    private val stateLock = Any()
    private var phase: String? = null
    private var phaseModel: String? = null
    private var progress: Double? = null
    private val errors = HashMap<String, String>()
    private val preparing = mutableListOf<PluginCall>()
    private val cancelledDownloads: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())

    private class Disabled : Exception("On-device transcription is turned off for this device")

    private fun enabled() = prefs.getBoolean("enabled", false)

    /** "whisper" (default) or "system" (an Android recognition service). */
    private fun engineId() = if (prefs.getString("engine", null) == ENGINE_SYSTEM) ENGINE_SYSTEM else ENGINE_WHISPER

    /** Selected recognition service, or null for the system default. */
    private fun recognizerId() = prefs.getString("recognizer", null)

    private fun unsupportedReason(engineId: String = engineId()) =
        if (engineId == ENGINE_SYSTEM) SystemSpeechRecognizer.unsupportedReason else LocalWhisper.unsupportedReason

    private fun selected(): WhisperModel =
        WhisperModels.find(prefs.getString("model", null)) ?: WhisperModels.find(WhisperModels.DEFAULT_ID)!!

    override fun load() {
        downloader.execute { store.pruneUnknown() }
        // Load and warm the selected model in the background so the first
        // dictated phrase does not pay the cold-start cost.
        if (LocalWhisper.unsupportedReason == null && enabled() && engineId() == ENGINE_WHISPER && store.isInstalled(selected())) {
            val model = selected()
            worker.execute {
                try {
                    loadModel(model)
                } catch (error: Throwable) {
                    Log.w(TAG, "background load of ${model.id} failed", error)
                }
            }
        }
    }

    private fun status(): JSObject {
        val engineId = engineId()
        val unsupported = unsupportedReason(engineId)
        val model = selected()
        val services = JSArray()
        if (SystemSpeechRecognizer.unsupportedReason == null) {
            val chosen = recognizerId()
            val available = recognizer.services()
            for (service in available) {
                services.put(
                    JSObject()
                        .put("id", service.id)
                        .put("label", service.label)
                        .put("isDefault", service.isDefault)
                        .put("selected", service.id == chosen || (chosen == null && service.isDefault)),
                )
            }
        }
        return synchronized(stateLock) {
            val state = when {
                unsupported != null -> "unsupported"
                !enabled() -> "disabled"
                engineId == ENGINE_SYSTEM -> if (services.length() > 0) "ready" else "failed"
                engine.loadedModelId == model.id -> "ready"
                phaseModel == model.id && phase != null -> phase
                errors[model.id] != null -> "failed"
                store.isInstalled(model) -> "installed"
                else -> "missing"
            }
            val models = JSArray()
            for (entry in WhisperModels.catalog) {
                models.put(
                    describe(entry)
                        .put("installed", store.isInstalled(entry))
                        .put("selected", entry.id == model.id)
                        .put("loaded", engine.loadedModelId == entry.id)
                        .put("phase", if (phaseModel == entry.id) phase else null)
                        .put("progress", if (phaseModel == entry.id) progress else null)
                        .put("error", errors[entry.id]),
                )
            }
            JSObject()
                .put("state", state)
                .put("enabled", enabled())
                .put("engine", engineId)
                .put(
                    "engines",
                    JSObject()
                        .put(ENGINE_WHISPER, JSObject().put("unsupported", LocalWhisper.unsupportedReason))
                        .put(ENGINE_SYSTEM, JSObject().put("unsupported", SystemSpeechRecognizer.unsupportedReason)),
                )
                .put("progress", if (phaseModel == model.id) progress else null)
                .put(
                    "error",
                    unsupported ?: if (engineId == ENGINE_SYSTEM) {
                        if (services.length() == 0) "No Android speech recognition service is installed" else null
                    } else {
                        errors[model.id]
                    },
                )
                .put("model", describe(model))
                .put("models", models)
                .put("recognizers", services)
        }
    }

    private fun describe(model: WhisperModel) = JSObject()
        .put("id", model.id)
        .put("label", model.label)
        .put("sizeBytes", model.sizeBytes)
        .put("sha256", model.sha256)

    private fun setPhase(next: String?, model: String?, nextProgress: Double? = null) {
        synchronized(stateLock) {
            phase = next
            phaseModel = model
            progress = nextProgress
        }
        notifyListeners("status", status())
    }

    private fun modelArg(call: PluginCall): WhisperModel? {
        val model = WhisperModels.find(call.getString("id"))
        if (model == null) call.reject("Unknown model", "BAD_PAYLOAD")
        return model
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(status())
    }

    @PluginMethod
    fun setEnabled(call: PluginCall) {
        val enable = call.getBoolean("enabled")
        if (enable == null) {
            call.reject("enabled is required", "BAD_PAYLOAD")
            return
        }
        unsupportedReason()?.let {
            if (enable) {
                call.reject(it, "UNSUPPORTED")
                return
            }
        }
        prefs.edit().putBoolean("enabled", enable).apply()
        if (enable) {
            call.resolve(status())
            return
        }
        // Off frees memory but keeps downloaded models for a quick re-enable.
        engine.cancel(null)
        worker.execute {
            engine.release()
            call.resolve(status())
        }
    }

    @PluginMethod
    fun selectEngine(call: PluginCall) {
        val engineId = call.getString("engine")
        if (engineId != ENGINE_WHISPER && engineId != ENGINE_SYSTEM) {
            call.reject("engine must be whisper or system", "BAD_PAYLOAD")
            return
        }
        unsupportedReason(engineId)?.let {
            call.reject(it, "UNSUPPORTED")
            return
        }
        val edit = prefs.edit().putString("engine", engineId)
        if (call.data.has("recognizer")) edit.putString("recognizer", call.getString("recognizer"))
        edit.apply()
        engine.cancel(null)
        recognizer.cancel(null)
        if (engineId == ENGINE_WHISPER || engine.loadedModelId == null) {
            call.resolve(status())
            return
        }
        // The Android engine needs no model; free Whisper's memory.
        worker.execute {
            engine.release()
            call.resolve(status())
        }
    }

    @PluginMethod
    fun selectModel(call: PluginCall) {
        val model = modelArg(call) ?: return
        prefs.edit().putString("model", model.id).apply()
        if (engine.loadedModelId == null || engine.loadedModelId == model.id) {
            call.resolve(status())
            return
        }
        engine.cancel(null)
        worker.execute {
            engine.release()
            call.resolve(status())
        }
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val model = modelArg(call) ?: return
        downloader.execute {
            try {
                download(model)
                call.resolve(status())
            } catch (_: ProvisioningCancelled) {
                call.reject("Voice model download was cancelled", "CANCELLED")
            } catch (error: Throwable) {
                call.reject(error.message ?: "Voice model download failed", "DOWNLOAD_FAILED")
            }
        }
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val model = modelArg(call) ?: return
        cancelledDownloads.add(model.id)
        if (engine.loadedModelId == model.id) engine.cancel(null)
        worker.execute {
            if (engine.loadedModelId == model.id) engine.release()
            store.delete(model)
            synchronized(stateLock) { errors.remove(model.id) }
            call.resolve(status())
        }
    }

    /** Runs on the downloader thread. */
    private fun download(model: WhisperModel) {
        if (store.isInstalled(model)) return
        cancelledDownloads.remove(model.id)
        synchronized(stateLock) { errors.remove(model.id) }
        var lastPercent = -1
        try {
            setPhase("downloading", model.id, 0.0)
            store.provision(
                model,
                onProgress = { downloaded, total ->
                    val percent = (downloaded * 100 / total).toInt()
                    if (percent != lastPercent) {
                        lastPercent = percent
                        setPhase("downloading", model.id, downloaded.toDouble() / total)
                    }
                },
                onVerifying = { setPhase("verifying", model.id) },
                isCancelled = { model.id in cancelledDownloads },
            )
            setPhase(null, null)
        } catch (cancelled: ProvisioningCancelled) {
            setPhase(null, null)
            throw cancelled
        } catch (error: Throwable) {
            Log.w(TAG, "download of ${model.id} failed", error)
            synchronized(stateLock) { errors[model.id] = error.message ?: "Voice model download failed" }
            setPhase(null, null)
            throw error
        }
    }

    /** Runs on the inference thread. */
    private fun loadModel(model: WhisperModel) {
        if (!enabled()) throw Disabled()
        if (engine.loadedModelId == model.id) return
        engine.cancel(null)
        setPhase("loading", model.id)
        val started = SystemClock.elapsedRealtime()
        try {
            engine.load(store.file(model), model.id)
            Log.i(TAG, "loaded ${model.id} in ${SystemClock.elapsedRealtime() - started} ms")
            // The first inference after a load is several times slower (cold
            // buffers and cores); absorb it before real phrases arrive.
            worker.execute { warmUp(model.id) }
        } catch (error: Throwable) {
            // A verified file that still fails to load is treated as corrupt,
            // so the next attempt downloads a fresh copy.
            store.delete(model)
            synchronized(stateLock) { errors[model.id] = error.message ?: "The voice model could not be loaded" }
            throw error
        } finally {
            setPhase(null, null)
        }
    }

    /** Runs on the inference thread. */
    private fun warmUp(modelId: String) {
        if (engine.loadedModelId != modelId) return
        val started = SystemClock.elapsedRealtime()
        val id = "warmup-$modelId-$started"
        engine.markPending(id)
        try {
            // One token: silence can make Whisper decode a long hallucination.
            engine.transcribe(id, FloatArray(16_000), "en", INFERENCE_THREADS, audioContextFor(16_000), maxTokens = 1)
            Log.i(TAG, "warmed $modelId in ${SystemClock.elapsedRealtime() - started} ms")
        } catch (error: Throwable) {
            Log.w(TAG, "warm-up of $modelId failed", error)
        }
    }

    @PluginMethod
    fun prepare(call: PluginCall) {
        unsupportedReason()?.let {
            call.reject(it, "UNSUPPORTED")
            return
        }
        if (!enabled()) {
            call.reject(Disabled().message, "DISABLED")
            return
        }
        if (engineId() == ENGINE_SYSTEM) {
            val ready = status()
            if (ready.getString("state") == "ready") {
                call.resolve(ready)
            } else {
                call.reject(ready.getString("error") ?: "Android speech recognition is unavailable", "PREPARE_FAILED")
            }
            return
        }
        synchronized(stateLock) {
            preparing.add(call)
            if (preparing.size > 1) return
        }
        startPreparation(1)
    }

    /**
     * One round of the shared preparation for the model selected now; a round
     * is a download (if needed) and a load, dispatched asynchronously.
     */
    private fun startPreparation(round: Int) {
        val model = selected()
        if (store.isInstalled(model)) {
            worker.execute { runPrepare(round) { loadModel(model) } }
        } else {
            downloader.execute {
                runPrepare(round) {
                    download(model)
                    try {
                        worker.submit(Callable { loadModel(model) }).get()
                    } catch (wrapped: ExecutionException) {
                        throw wrapped.cause ?: wrapped
                    }
                }
            }
        }
    }

    private fun runPrepare(round: Int, work: () -> Unit) {
        val outcome: (PluginCall) -> Unit = try {
            work()
            if (enabled() && engineId() == ENGINE_WHISPER && engine.loadedModelId != selected().id) {
                // Another model was selected while this round ran: prepare it
                // for the joined calls instead of resolving with a stale one.
                if (round < MAX_PREPARE_ROUNDS) {
                    startPreparation(round + 1)
                    return
                }
                throw IllegalStateException("The voice model selection changed during preparation")
            }
            val ready = status()
            ({ it.resolve(ready) })
        } catch (_: ProvisioningCancelled) {
            ({ it.reject("Voice model download was cancelled", "CANCELLED") })
        } catch (error: Disabled) {
            ({ it.reject(error.message, "DISABLED") })
        } catch (error: Throwable) {
            Log.w(TAG, "prepare failed", error)
            val message = error.message ?: "The voice model could not be prepared"
            ({ it.reject(message, "PREPARE_FAILED") })
        }
        val calls = synchronized(stateLock) { preparing.toList().also { preparing.clear() } }
        calls.forEach(outcome)
    }

    @PluginMethod
    fun transcribe(call: PluginCall) {
        val requestId = call.getString("requestId")
        val pcm = call.getString("pcm")
        val language = call.getString("language")?.takeIf { it.isNotBlank() } ?: "auto"
        if (requestId.isNullOrBlank() || pcm == null) {
            call.reject("requestId and pcm are required", "BAD_PAYLOAD")
            return
        }
        if (enabled() && engineId() == ENGINE_SYSTEM) {
            transcribeWithSystem(call, requestId, pcm, language)
            return
        }
        val modelId = engine.loadedModelId
        if (!enabled() || modelId == null || modelId != selected().id) {
            call.reject("The on-device voice model is not loaded", "NOT_READY")
            return
        }
        val samples = try {
            val shorts = ByteBuffer.wrap(Base64.decode(pcm, Base64.DEFAULT))
                .order(ByteOrder.LITTLE_ENDIAN)
                .asShortBuffer()
            FloatArray(shorts.remaining()) { shorts.get(it) / 32768f }
        } catch (_: IllegalArgumentException) {
            call.reject("pcm must be base64 Int16 audio", "BAD_PAYLOAD")
            return
        }
        engine.markPending(requestId)
        worker.execute {
            val started = SystemClock.elapsedRealtime()
            try {
                val audioCtx = audioContextFor(samples.size)
                val text = engine.transcribe(requestId, samples, language, INFERENCE_THREADS, audioCtx)
                if (text == null) {
                    call.reject("Transcription was cancelled", "CANCELLED")
                    return@execute
                }
                val inferenceMs = SystemClock.elapsedRealtime() - started
                Log.i(TAG, "phrase ${samples.size / 16} ms audio -> $inferenceMs ms inference ($modelId, $language, ctx $audioCtx)")
                call.resolve(
                    JSObject()
                        .put("text", text.trim())
                        .put("inferenceMs", inferenceMs)
                        .put("audioMs", samples.size / 16),
                )
            } catch (error: Throwable) {
                Log.w(TAG, "transcription failed", error)
                call.reject(error.message ?: "On-device transcription failed", "INFERENCE_FAILED")
            }
        }
    }

    private fun transcribeWithSystem(call: PluginCall, requestId: String, pcm: String, language: String) {
        val bytes = try {
            Base64.decode(pcm, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            call.reject("pcm must be base64 Int16 audio", "BAD_PAYLOAD")
            return
        }
        val serviceId = recognizerId()
        recognizer.markPending(requestId)
        worker.execute {
            val started = SystemClock.elapsedRealtime()
            try {
                val candidates = recognizer.transcribe(requestId, serviceId, bytes, language)
                if (candidates == null) {
                    call.reject("Transcription was cancelled", "CANCELLED")
                    return@execute
                }
                val inferenceMs = SystemClock.elapsedRealtime() - started
                Log.i(
                    TAG,
                    "phrase ${bytes.size / 32} ms audio -> $inferenceMs ms Android recognition " +
                        "(${serviceId ?: "default"}, $language: ${candidates.joinToString { "${it.language}=${it.text.length} chars" }})",
                )
                val list = JSArray()
                candidates.forEach { list.put(JSObject().put("language", it.language).put("text", it.text)) }
                call.resolve(
                    JSObject()
                        // The hinted language's transcript when it has text;
                        // JS asks the server to choose when several do.
                        .put("text", candidates.firstOrNull { it.text.isNotEmpty() }?.text ?: "")
                        .put("candidates", list)
                        .put("inferenceMs", inferenceMs)
                        .put("audioMs", bytes.size / 32),
                )
            } catch (error: Throwable) {
                Log.w(TAG, "Android recognition failed", error)
                call.reject(error.message ?: "Android speech recognition failed", "INFERENCE_FAILED")
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val ids = call.getArray("requestIds")?.toList<String>()
        engine.cancel(ids)
        recognizer.cancel(ids)
        call.resolve()
    }

    override fun handleOnDestroy() {
        WhisperModels.catalog.forEach { cancelledDownloads.add(it.id) }
        engine.cancel(null)
        recognizer.cancel(null)
        worker.execute { engine.release() }
        worker.shutdown()
        downloader.shutdown()
    }

    companion object {
        private const val TAG = "CarapaWhisper"
        private const val ENGINE_WHISPER = "whisper"
        private const val ENGINE_SYSTEM = "system"

        /** Rounds of one shared preparation when the selection keeps changing. */
        private const val MAX_PREPARE_ROUNDS = 3

        // The tablet's Snapdragon 8 Gen 3 has six performance cores; 6
        // threads beat 4 by ~15% there. Efficiency cores would slow every
        // ggml barrier, so never go wider.
        private val INFERENCE_THREADS = Runtime.getRuntime().availableProcessors().coerceIn(1, 6)

        /**
         * Whisper encodes a fixed 30 s window (1500 positions) however short
         * the phrase. Phrase-sized windows cut encoder cost ~4x but lose
         * characters below ~10 s, so use at least 512 positions and grow
         * with longer phrases (speech + 2.5 s margin).
         */
        private fun audioContextFor(samples: Int): Int {
            val positions = (samples.toLong() * 50 / 16_000).toInt() + 128
            return ((positions + 63) / 64 * 64).coerceIn(512, 1500)
        }
    }
}
