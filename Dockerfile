# Multi-stage build so the runtime image doesn't carry TypeScript / devDeps.
# Glama's introspection: docker build → docker run → stdin/stdout JSON-RPC
# (initialize, then tools/list, etc.). Stdio is the default transport.

# ── build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Install deps first for docker-layer caching.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Bring in the source and compile.
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Non-root user for a mild defence-in-depth win.
RUN addgroup -S mcp && adduser -S mcp -G mcp

COPY --from=builder --chown=mcp:mcp /build/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /build/dist ./dist
COPY --chown=mcp:mcp package.json ./

ENV NODE_ENV=production

USER mcp

# Default transport is stdio — Glama and other MCP hosts drive it over the
# container's stdin / stdout. For HTTP mode, override with:
#   docker run -e MCP_TRANSPORT=http -e MCP_HTTP_HOST=0.0.0.0 -p 8080:8080 ...
ENTRYPOINT ["node", "dist/index.js"]
