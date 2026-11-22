package ai.carapa.board

import android.os.Build
import java.io.File

/**
 * One whisper.cpp context. [load], [transcribe] and [release] must run on a
 * single worker thread, which serializes inference; [markPending] and
 * [cancel] may be called from any thread.
 */
class LocalWhisper {
    companion object {
        private val libraryError: String? = try {
            System.loadLibrary("carapa_whisper")
            null
        } catch (error: Throwable) {
            error.message ?: "native library unavailable"
        }

        /** Null when this device can run the arm64 dotprod/fp16 build. */
        val unsupportedReason: String? by lazy {
            if (Build.SUPPORTED_ABIS.firstOrNull() != "arm64-v8a") {
                return@lazy "On-device transcription needs an arm64 device"
            }
            libraryError?.let { return@lazy "On-device transcription library failed to load: $it" }
            val features = try {
                File("/proc/cpuinfo").readLines()
                    .firstOrNull { it.startsWith("Features") }
                    ?.substringAfter(':')?.trim()?.split(Regex("\\s+"))?.toSet()
            } catch (_: Exception) {
                null
            } ?: emptySet()
            if ("asimddp" !in features || "asimdhp" !in features) {
                "This processor lacks the instructions on-device transcription needs"
            } else {
                null
            }
        }
    }

    private external fun nativeLoad(path: String): Long
    private external fun nativeFree(handle: Long)
    private external fun nativeSetAbort(handle: Long, abort: Boolean)
    private external fun nativeTranscribe(
        handle: Long,
        samples: FloatArray,
        language: String,
        threads: Int,
        audioCtx: Int,
        maxTokens: Int,
    ): ByteArray?

    private val lock = Any()
    @Volatile private var handle = 0L
    private var running: String? = null
    private val pending = HashSet<String>()
    private val cancelled = HashSet<String>()

    /** Catalog id of the loaded model, or null. */
    @Volatile var loadedModelId: String? = null
        private set

    val isLoaded: Boolean get() = handle != 0L

    fun load(model: File, modelId: String) {
        if (loadedModelId == modelId) return
        release()
        val loaded = nativeLoad(model.absolutePath)
        if (loaded == 0L) throw IllegalStateException("The voice model could not be loaded")
        handle = loaded
        loadedModelId = modelId
    }

    fun release() {
        synchronized(lock) {
            if (handle != 0L) nativeFree(handle)
            handle = 0L
            loadedModelId = null
        }
    }

    fun markPending(id: String) {
        synchronized(lock) { pending.add(id) }
    }

    /** Cancels queued or running requests; null cancels every request. */
    fun cancel(ids: Collection<String>?) {
        synchronized(lock) {
            val active = running
            val targets = ids?.filter { it in pending || it == active } ?: (pending + listOfNotNull(active))
            cancelled.addAll(targets.filter { it in pending })
            if (active != null && active in targets && handle != 0L) nativeSetAbort(handle, true)
        }
    }

    /** Returns null when the request was cancelled before or during inference. */
    fun transcribe(
        id: String,
        samples: FloatArray,
        language: String,
        threads: Int,
        audioCtx: Int,
        maxTokens: Int = 0,
    ): String? {
        synchronized(lock) {
            pending.remove(id)
            if (cancelled.remove(id)) return null
            if (handle == 0L) throw IllegalStateException("The voice model is not loaded")
            running = id
            nativeSetAbort(handle, false)
        }
        try {
            val bytes = nativeTranscribe(handle, samples, language, threads, audioCtx, maxTokens) ?: return null
            return String(bytes, Charsets.UTF_8)
        } finally {
            synchronized(lock) {
                running = null
                cancelled.remove(id)
            }
        }
    }
}
