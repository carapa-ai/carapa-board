package ai.carapa.board

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** A pinned, checksummed Whisper model that this device may download. */
data class WhisperModel(
    val id: String,
    val label: String,
    val sizeBytes: Long,
    val sha256: String,
) {
    val url: String get() = "${WhisperModels.SOURCE}/$id.bin"
}

/**
 * The on-device model catalog. Every entry is pinned to one Hugging Face
 * repository commit and its LFS SHA-256; adding or replacing a model means
 * editing this list (and bumping native-shell-version.json). The bridge and
 * JS code take the catalog from `getStatus`. See
 * docs/android-local-transcription.md.
 */
object WhisperModels {
    const val SOURCE =
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1"

    val catalog = listOf(
        WhisperModel(
            "ggml-base-q5_1",
            "Whisper base (fastest, least accurate)",
            59_707_625L,
            "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        ),
        WhisperModel(
            "ggml-small-q5_1",
            "Whisper small (balanced)",
            190_085_487L,
            "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        ),
        WhisperModel(
            "ggml-large-v3-turbo-q8_0",
            "Whisper large-v3 turbo (most accurate)",
            874_188_075L,
            "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
        ),
    )

    const val DEFAULT_ID = "ggml-small-q5_1"

    fun find(id: String?): WhisperModel? = catalog.firstOrNull { it.id == id }
}

class ProvisioningCancelled : Exception("model download cancelled")

/**
 * App-private model storage. A model's final file name exists only after the
 * download matched its pinned size and SHA-256, so an interrupted or corrupt
 * download never becomes usable; it stays a `.part` file that is deleted.
 */
class WhisperModelStore(context: Context) {
    private val dir = File(context.filesDir, "whisper-models")

    fun file(model: WhisperModel) = File(dir, "${model.id}.bin")
    private fun partFile(model: WhisperModel) = File(dir, "${model.id}.part")

    fun isInstalled(model: WhisperModel): Boolean =
        file(model).isFile && file(model).length() == model.sizeBytes

    fun delete(model: WhisperModel) {
        file(model).delete()
        partFile(model).delete()
    }

    /** Removes leftovers: superseded models and partial downloads. */
    fun pruneUnknown() {
        val known = WhisperModels.catalog.map { "${it.id}.bin" }.toSet()
        dir.listFiles()?.filter { it.name !in known }?.forEach { it.delete() }
    }

    fun provision(
        model: WhisperModel,
        onProgress: (downloaded: Long, total: Long) -> Unit,
        onVerifying: () -> Unit,
        isCancelled: () -> Boolean,
    ) {
        if (isInstalled(model)) return
        dir.mkdirs()
        delete(model)
        if (dir.usableSpace < model.sizeBytes + 64L * 1024 * 1024) {
            throw IOException("Not enough free storage for the ${model.sizeBytes / 1_000_000} MB voice model")
        }
        val part = partFile(model)
        val digest = MessageDigest.getInstance("SHA-256")
        var downloaded = 0L
        try {
            val connection = URL(model.url).openConnection() as HttpURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            try {
                if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                    throw IOException("Model download failed: HTTP ${connection.responseCode}")
                }
                connection.inputStream.use { input ->
                    part.outputStream().use { output ->
                        val buffer = ByteArray(256 * 1024)
                        while (true) {
                            if (isCancelled()) throw ProvisioningCancelled()
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            downloaded += read
                            if (downloaded > model.sizeBytes) {
                                throw IOException("Model download is larger than expected")
                            }
                            onProgress(downloaded, model.sizeBytes)
                        }
                        output.fd.sync()
                    }
                }
            } finally {
                connection.disconnect()
            }
            onVerifying()
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (downloaded != model.sizeBytes || actual != model.sha256) {
                throw IOException("Downloaded voice model failed checksum verification")
            }
            if (!part.renameTo(file(model))) throw IOException("Could not activate the voice model")
        } finally {
            part.delete()
        }
    }
}
