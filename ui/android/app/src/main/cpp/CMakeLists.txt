cmake_minimum_required(VERSION 3.22.1)
project(carapa_whisper LANGUAGES C CXX)

# Inference is unusably slow without optimization, and the debug APK is the
# installed tablet build, so the native runtime is always optimized.
set(CMAKE_BUILD_TYPE Release)

# Pinned whisper.cpp release. The source hash makes the fetch reproducible;
# only the model (provisioned at runtime) is downloaded on the device.
include(FetchContent)
FetchContent_Declare(
    whisper
    URL https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
    URL_HASH SHA256=ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
    # Language detection reuses the transcription encoder pass and honors a
    # "ro,en" candidate list. See whisper-carapa.patch.
    PATCH_COMMAND patch -p1 -i ${CMAKE_CURRENT_SOURCE_DIR}/whisper-carapa.patch
)
FetchContent_GetProperties(whisper)
if(NOT whisper_POPULATED)
    FetchContent_Populate(whisper)
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS OFF CACHE BOOL "" FORCE)
# CPU-only arm64 baseline: no OpenMP runtime to package, no host tuning.
# The JNI layer refuses to load on CPUs without these extensions.
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)
add_subdirectory(${whisper_SOURCE_DIR} ${whisper_BINARY_DIR} EXCLUDE_FROM_ALL)

add_library(carapa_whisper SHARED carapa_whisper_jni.cpp)
target_link_libraries(carapa_whisper PRIVATE whisper log)
target_link_options(carapa_whisper PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
