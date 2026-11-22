# Matching Bun 1.4.4 build/runtime images, pinned 2026-10-29.
FROM dhi.io/bun:1.4.4-alpine3.23-dev@sha256:2ddf7ec8434deb282e13d94fe4cc1f153abba7a269fc79eb47724f8f2b3f0f48 AS bun-dev

# ── Development dependencies ──────────────────────────────────────
FROM bun-dev AS development-deps

RUN apk add --no-cache bash coreutils findutils libstdc++ libgcc util-linux

WORKDIR /app

# Backend development dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Frontend dependencies remain independent so backend input changes cannot
# invalidate UI validation or production builds.
FROM bun-dev AS frontend-deps

RUN apk add --no-cache bash libstdc++ libgcc

WORKDIR /app/ui
COPY ui/package.json ui/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Local watch rebuilds need only fresh browser assets. Keeping this stage
# independent from CI and OTA packaging lets Docker skip both entirely.
FROM frontend-deps AS frontend-build

# The ui/.env* glob is optional (index.html always matches). Vite compiles its
# VITE_API_URL / VITE_LOCAL_IP / VITE_LOCAL_HOSTNAMES into the one ui/dist that
# serves both browsers and the Android OTA bundle published on boot.
COPY ui/index.html ui/vite.config.ts ui/.env* ./
COPY ui/public/ public/
COPY ui/src/ src/
RUN bun run build && touch /ui-build-passed

# ── Independent deploy gates ──────────────────────────────────────
FROM development-deps AS backend-typecheck

COPY src/ src/
COPY tsconfig.json tsconfig.production.json ./
RUN bun run typecheck:production && touch /backend-typecheck-passed

FROM development-deps AS backend-test-inputs

# Backend tests receive backend-owned inputs only. Cross-domain repository,
# UI, and Android contracts run in their own independent stage below.
RUN apk add --no-cache git
COPY tsconfig.json bunfig.toml .env.test .mcp.json ./
COPY src/ src/
COPY bin/ bin/
COPY scripts/ scripts/
COPY prompts/ prompts/
COPY drizzle/ drizzle/

FROM backend-test-inputs AS backend-tests

RUN bun run test:ci:backend && touch /backend-tests-passed

FROM development-deps AS contract-test-inputs

RUN apk add --no-cache git
COPY tsconfig.json bunfig.toml Dockerfile docker-compose.yml ./
COPY src/ src/
COPY ui/ ui/
COPY bin/ bin/
COPY scripts/ scripts/
COPY prompts/ prompts/
COPY drizzle/ drizzle/

FROM contract-test-inputs AS contract-typecheck

RUN bun run typecheck && touch /contract-typecheck-passed

FROM contract-test-inputs AS contract-tests

RUN bash scripts/test-ci.sh contracts && touch /contract-tests-passed

FROM frontend-deps AS ui-tests
COPY ui/ /app/ui/
COPY scripts/test-ci.sh scripts/test-file-groups.sh scripts/load-test-env.sh /app/scripts/
WORKDIR /app
RUN bash scripts/test-ci.sh ui && touch /ui-tests-passed

FROM frontend-deps AS ui-typecheck
COPY ui/tsconfig.json ./
COPY ui/scripts/check-fields.mjs ui/scripts/check-native-title.mjs ui/scripts/native-title-allowlist.json scripts/
COPY ui/src/ src/
RUN bun run typecheck && touch /ui-typecheck-passed

FROM scratch AS deploy-gates
COPY --from=backend-tests /backend-tests-passed /
COPY --from=backend-typecheck /backend-typecheck-passed /
COPY --from=contract-tests /contract-tests-passed /
COPY --from=contract-typecheck /contract-typecheck-passed /
COPY --from=ui-tests /ui-tests-passed /
COPY --from=ui-typecheck /ui-typecheck-passed /
COPY --from=frontend-build /ui-build-passed /

# Production dependencies stay separate so development tools do not enter the
# final image.
FROM bun-dev AS production-deps

RUN apk add --no-cache bash libstdc++ libgcc

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# ── Fast local runtime stage ──────────────────────────────────────
FROM dhi.io/bun:1.4.4-alpine3.23@sha256:a869de0c70874053e763c6cfbab740fd85849bba12b5140a29f6795cd717ff15 AS runtime

USER 0

ARG GIT_COMMIT=unknown

LABEL org.opencontainers.image.title="carapa-board" \
      org.opencontainers.image.description="Kanban board + chat UI for CarapaBot" \
      org.opencontainers.image.version="0.1.0"

# Temporarily mount the matching builder's apk and libraries. Install runtime
# tools into this image's existing package database so scanners see the complete
# inventory, without shipping apk or the development image. Bootstrap only the
# shell that apk's package scripts need; busybox is then installed as a package.
# Retry apk add: a mirror fetch can fail transiently (e.g. "TLS: unspecified
# error"). apk add is idempotent, so a retry installs whatever is still missing.
RUN --mount=from=bun-dev,source=/,target=/builder,ro \
    ["/builder/bin/busybox", "sh", "-ec", \
    "/builder/bin/busybox mkdir -p /bin; \
    /builder/bin/busybox cp /builder/bin/busybox /bin/busybox; \
    /bin/busybox ln -sf busybox /bin/sh; \
    for attempt in 1 2 3 4 5; do \
    LD_LIBRARY_PATH=/builder/usr/lib:/builder/lib /builder/sbin/apk \
    --keys-dir /builder/etc/apk/keys --repositories-file /builder/etc/apk/repositories \
    add --no-cache busybox bash ca-certificates libstdc++ libgcc wget ffmpeg ripgrep openssl \
    && exit 0; \
    [ $attempt -lt 5 ] || break; \
    echo apk add failed on attempt $attempt, retrying; \
    /builder/bin/busybox sleep $((attempt * 5)); \
    done; exit 1"]

WORKDIR /app

# Backend: source + deps (Bun runs TS directly)
COPY --from=production-deps /app/node_modules node_modules/
COPY package.json bun.lock tsconfig.json ./
COPY src/ src/
COPY prompts/ prompts/
# Drizzle migrations (and the meta/_journal.json that migrate() needs)
COPY drizzle/ drizzle/

# Frontend: built assets only
COPY --from=frontend-build /app/ui/dist ui/dist/
COPY ui/android/native-shell-version.json ui/android/native-shell-version.json

# Record the identity of the complete server + web artifact. CarapaBox may
# supply a Git commit; otherwise derive a stable fingerprint from the files
# that actually enter the runtime image. The timestamp stays cached with an
# unchanged artifact rather than changing on every no-op Docker invocation.
RUN build_version="$GIT_COMMIT"; \
    if [ -z "$build_version" ] || [ "$build_version" = "unknown" ]; then \
      build_version="$(find package.json bun.lock src prompts drizzle ui/dist ui/android/native-shell-version.json -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-12)"; \
    fi; \
    printf '%s\n' "$build_version" > /app/VERSION; \
    date -u '+%Y-%m-%dT%H:%M:%SZ' > /app/BUILD_TIME

# Entrypoint: tees stdout/stderr to log files while keeping Docker log capture
COPY scripts/ scripts/
RUN chmod +x /app/scripts/entrypoint.sh

# Non-root user (UID 1000 matches host for bind-mounted SQLite)
RUN adduser -D -u 1000 appuser \
    && chmod +x /app/scripts/entrypoint.sh

# Strip SUID/SGID bits
RUN find / -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-check-certificate -qO- https://localhost:3000/health || exit 1

CMD ["/app/scripts/entrypoint.sh"]

# ── CI-gated deploy image ─────────────────────────────────────────
# docker-compose.yml selects this target by default. A fast local loop can set
# CARAPA_BUILD_TARGET=runtime, while deploy builds must complete the CI stage.
FROM runtime AS deploy

COPY --from=deploy-gates /*-passed /deploy-gates/
