# ============================================
# YNAB MCP Server - Multi-stage Docker Build
# ============================================

# Stage 1: Builder
FROM node:24-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including dev for build) without running any install
# script, so no compiler is needed. better-sqlite3 ships Node-API prebuilds for
# linuxmusl-x64 and linuxmusl-arm64 inside its npm tarball (pinned by the
# lockfile's integrity hash) and loads them at runtime. The only other install
# scripts in the tree belong to dev-only packages (esbuild, fsevents) that the
# TypeScript build doesn't use.
RUN npm ci --ignore-scripts

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev --ignore-scripts

# Fail the build if the SQLite driver can't load on this platform.
RUN node -e "new (require('better-sqlite3'))(':memory:').close()"

# Stage 2: Production
FROM node:24-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init=1.2.5-r4

# Create non-root user for security
RUN addgroup -g 1001 -S mcp && \
    adduser -u 1001 -S mcp -G mcp

WORKDIR /app

# Copy built files and production dependencies from builder
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --from=builder --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /app/package.json ./

# Switch to non-root user
USER mcp

# OCI Labels for GitHub Container Registry auto-linking
LABEL org.opencontainers.image.title="YNAB MCP Server"
LABEL org.opencontainers.image.description="MCP server providing complete YNAB API coverage for Claude integration"
LABEL org.opencontainers.image.url="https://github.com/auzroz/ynab-mcp"
LABEL org.opencontainers.image.source="https://github.com/auzroz/ynab-mcp"
LABEL org.opencontainers.image.vendor="auzroz"
LABEL org.opencontainers.image.licenses="MIT"
LABEL io.modelcontextprotocol.server.name="io.github.auzroz/ynab-mcp"

# Default transport is stdio. For remote/HTTP mode, run with MCP_TRANSPORT=http
# and publish the port (default 3000).
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
