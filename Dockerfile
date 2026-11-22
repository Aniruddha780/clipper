# Build stage: install dependencies and build the Vite/React frontend
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./
COPY dashboard/package.json ./dashboard/

RUN npm install --no-audit --no-fund

COPY . .

RUN npm run build

# Runtime stage: lightweight Node 22 + FFmpeg server
FROM node:22-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
COPY dashboard/package.json ./dashboard/

RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/dashboard/public ./dashboard/public

RUN mkdir -p /tmp/openshorts/uploads /tmp/openshorts/output/thumbnails

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:${PORT}/health/ready > /dev/null || exit 1

CMD ["node", "server.js"]
