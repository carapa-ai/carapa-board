// Minimal JNI surface over whisper.cpp for LocalWhisper.kt. Callers serialize
// all calls on one context; only nativeAbort may run concurrently.
#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <string>
#include "whisper.h"

#define TAG "CarapaWhisper"

namespace {

struct Engine {
    whisper_context *ctx;
    std::atomic<bool> abort{false};
};

bool shouldAbort(void *data) {
    return static_cast<Engine *>(data)->abort.load();
}

void logToAndroid(enum ggml_log_level level, const char *text, void *) {
    const int priority = level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR
                         : level == GGML_LOG_LEVEL_WARN ? ANDROID_LOG_WARN
                                                        : ANDROID_LOG_INFO;
    __android_log_write(priority, TAG, text);
}

void throwRuntime(JNIEnv *env, const char *message) {
    jclass cls = env->FindClass("java/lang/RuntimeException");
    if (cls) env->ThrowNew(cls, message);
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_ai_carapa_board_LocalWhisper_nativeLoad(JNIEnv *env, jobject, jstring path) {
    whisper_log_set(logToAndroid, nullptr);
    const char *modelPath = env->GetStringUTFChars(path, nullptr);
    whisper_context_params params = whisper_context_default_params();
    params.use_gpu = false;
    whisper_context *ctx = whisper_init_from_file_with_params(modelPath, params);
    env->ReleaseStringUTFChars(path, modelPath);
    if (!ctx) return 0;
    auto *engine = new Engine();
    engine->ctx = ctx;
    __android_log_print(ANDROID_LOG_INFO, TAG, "model loaded: %s", whisper_print_system_info());
    return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT void JNICALL
Java_ai_carapa_board_LocalWhisper_nativeFree(JNIEnv *, jobject, jlong handle) {
    auto *engine = reinterpret_cast<Engine *>(handle);
    if (!engine) return;
    whisper_free(engine->ctx);
    delete engine;
}

extern "C" JNIEXPORT void JNICALL
Java_ai_carapa_board_LocalWhisper_nativeSetAbort(JNIEnv *, jobject, jlong handle, jboolean abort) {
    auto *engine = reinterpret_cast<Engine *>(handle);
    if (engine) engine->abort.store(abort == JNI_TRUE);
}

/** Returns UTF-8 phrase bytes, or null when aborted. Throws on inference failure.
 * Bytes, not jstring: whisper tokens may split multi-byte characters, which
 * NewStringUTF rejects fatally. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_ai_carapa_board_LocalWhisper_nativeTranscribe(
        JNIEnv *env, jobject, jlong handle, jfloatArray samples, jstring language, jint threads,
        jint audioCtx, jint maxTokens) {
    auto *engine = reinterpret_cast<Engine *>(handle);
    if (!engine) {
        throwRuntime(env, "model is not loaded");
        return nullptr;
    }
    const char *lang = env->GetStringUTFChars(language, nullptr);
    std::string languageCode(lang);
    env->ReleaseStringUTFChars(language, lang);
    // "auto", one language, or a candidate list such as "ro,en" (patched
    // whisper.cpp restricts detection to the list).
    bool valid = languageCode != "auto";
    for (size_t start = 0; valid && start <= languageCode.size();) {
        size_t end = languageCode.find(',', start);
        if (end == std::string::npos) end = languageCode.size();
        valid = whisper_lang_id(languageCode.substr(start, end - start).c_str()) >= 0;
        start = end + 1;
    }
    if (!valid) languageCode = "auto";

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = threads;
    params.audio_ctx = audioCtx;
    params.max_tokens = maxTokens;  // 0 = unlimited
    params.language = languageCode.c_str();
    params.detect_language = false;
    params.translate = false;
    params.no_context = true;
    params.no_timestamps = true;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_special = false;
    params.print_timestamps = false;
    params.suppress_blank = true;
    params.abort_callback = shouldAbort;
    params.abort_callback_user_data = engine;

    jsize count = env->GetArrayLength(samples);
    jfloat *pcm = env->GetFloatArrayElements(samples, nullptr);
    int status = whisper_full(engine->ctx, params, pcm, count);
    env->ReleaseFloatArrayElements(samples, pcm, JNI_ABORT);

    if (engine->abort.load()) return nullptr;
    if (status != 0) {
        throwRuntime(env, ("whisper_full failed with status " + std::to_string(status)).c_str());
        return nullptr;
    }
    std::string text;
    const int segments = whisper_full_n_segments(engine->ctx);
    for (int i = 0; i < segments; ++i) {
        text += whisper_full_get_segment_text(engine->ctx, i);
    }
    jbyteArray result = env->NewByteArray(static_cast<jsize>(text.size()));
    env->SetByteArrayRegion(result, 0, static_cast<jsize>(text.size()),
                            reinterpret_cast<const jbyte *>(text.data()));
    return result;
}
