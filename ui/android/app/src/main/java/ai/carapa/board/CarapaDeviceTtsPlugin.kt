package ai.carapa.board

import android.net.Uri
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

/**
 * Settings and WebView access for on-device text-to-speech ([DeviceTts]).
 *
 * - `getStatus()` reports the opt-in, the installed engines and their
 *   offline voices, and why the last reply fell back to server audio.
 * - `setEnabled`, `selectEngine`, `selectVoice` manage the per-device
 *   setting (SharedPreferences, also read by the push service).
 * - `preview({text, language?, voice?})` renders a voice preview with this
 *   device's voice for the language (or the given voice), whether or not
 *   the setting is on.
 * - `synthesize({text, language})` returns a `file://` WAV for the WebView
 *   playback paths; it rejects with `UNAVAILABLE` so callers can fall back
 *   to server audio.
 */
@CapacitorPlugin(name = "CarapaDeviceTts")
class CarapaDeviceTtsPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "carapa-device-tts") }

    private fun status(): JSObject {
        val ctx = context.applicationContext
        val enabled = DeviceTts.enabled(ctx)
        val result = JSObject().put("enabled", enabled)
        val (engines, voices, defaultEngine) = try {
            DeviceTts.describe(ctx)
        } catch (error: Throwable) {
            return result
                .put("state", "failed")
                .put("error", error.message ?: "The text-to-speech engine did not start")
                .put("engines", JSArray())
                .put("voices", JSArray())
        }
        if (engines.isEmpty()) {
            return result
                .put("state", "unsupported")
                .put("error", "No text-to-speech engine is installed on this device")
                .put("engines", JSArray())
                .put("voices", JSArray())
        }
        val chosen = DeviceTts.selectedEngine(ctx)
        val engineList = JSArray()
        for (engine in engines) {
            engineList.put(
                JSObject()
                    .put("id", engine.name)
                    .put("label", engine.label)
                    .put("isDefault", engine.name == defaultEngine)
                    .put("selected", engine.name == chosen || (chosen == null && engine.name == defaultEngine)),
            )
        }
        val voiceList = JSArray()
        for (voice in voices) {
            voiceList.put(
                JSObject()
                    .put("id", voice.name)
                    .put("language", voice.language)
                    .put("label", voice.label)
                    .put("selected", DeviceTts.selectedVoice(ctx, voice.language) == voice.name),
            )
        }
        val fallback = DeviceTts.lastFallback
        return result
            .put("state", if (!enabled) "disabled" else if (fallback != null) "fallback" else "ready")
            .put("error", if (enabled) fallback else null)
            .put("engines", engineList)
            .put("voices", voiceList)
    }

    private fun respond(call: PluginCall, change: () -> Unit) {
        worker.execute {
            try {
                change()
                call.resolve(status())
            } catch (error: Throwable) {
                call.reject(error.message ?: "Could not change the setting", "FAILED")
            }
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) = respond(call) {}

    @PluginMethod
    fun setEnabled(call: PluginCall) {
        val enabled = call.getBoolean("enabled")
        if (enabled == null) {
            call.reject("enabled is required", "BAD_PAYLOAD")
            return
        }
        respond(call) { DeviceTts.setEnabled(context.applicationContext, enabled) }
    }

    @PluginMethod
    fun selectEngine(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) {
            call.reject("id is required", "BAD_PAYLOAD")
            return
        }
        respond(call) { DeviceTts.selectEngine(context.applicationContext, id) }
    }

    @PluginMethod
    fun selectVoice(call: PluginCall) {
        val language = call.getString("language")
        val id = call.getString("id")
        if (language.isNullOrBlank() || id.isNullOrBlank()) {
            call.reject("language and id are required", "BAD_PAYLOAD")
            return
        }
        respond(call) { DeviceTts.selectVoice(context.applicationContext, language, id) }
    }

    @PluginMethod
    fun synthesize(call: PluginCall) {
        val text = call.getString("text")?.trim()
        if (text.isNullOrEmpty()) {
            call.reject("text is required", "BAD_PAYLOAD")
            return
        }
        val language = call.getString("language")?.takeIf { it.isNotBlank() }
        worker.execute {
            try {
                val file = DeviceTts.textSpeechFile(context.applicationContext, text, language)
                call.resolve(JSObject().put("uri", Uri.fromFile(file).toString()))
            } catch (error: Throwable) {
                call.reject(error.message ?: "Device speech is unavailable", "UNAVAILABLE")
            }
        }
    }

    @PluginMethod
    fun preview(call: PluginCall) {
        val text = call.getString("text")?.trim()
        if (text.isNullOrEmpty()) {
            call.reject("text is required", "BAD_PAYLOAD")
            return
        }
        val language = call.getString("language")?.takeIf { it.isNotBlank() }
        val voice = call.getString("voice")?.takeIf { it.isNotBlank() }
        worker.execute {
            try {
                val file = DeviceTts.previewFile(context.applicationContext, text, language, voice)
                call.resolve(JSObject().put("uri", Uri.fromFile(file).toString()))
            } catch (error: Throwable) {
                call.reject(error.message ?: "The voice could not be previewed", "UNAVAILABLE")
            }
        }
    }

    override fun handleOnDestroy() {
        worker.shutdown()
    }
}
