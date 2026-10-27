# GridSight on node:22-bookworm-slim + system ffmpeg (probing, thumbnails, WAV norm).
# Multi-stage: deps → build → slim runtime running Next standalone output as non-root.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Standalone server needs no .env at build time; MODEL_API_KEY is runtime-only.
RUN npm run build

# Static ffmpeg/ffprobe (no apt: Debian mirrors may be unreachable; also smaller).
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM node:22-bookworm-slim AS runner
WORKDIR /app
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
RUN useradd -m -u 1001 gridsight && mkdir -p /tmp/opencode/gridsight \
  && chown gridsight:gridsight /tmp/opencode/gridsight
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
USER gridsight
# Next standalone output + static assets (public/ + .next/static are required).
COPY --from=builder --chown=gridsight:gridsight /app/.next/standalone ./
COPY --from=builder --chown=gridsight:gridsight /app/.next/static ./.next/static
# NOTE: no public/ dir in this repo (fonts ship in src/app/fonts). If one is
# added later, copy it here — standalone output does not include it.
# Fixtures power USE_CACHED=true offline demos inside the container.
COPY --from=builder --chown=gridsight:gridsight /app/fixtures ./fixtures
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
