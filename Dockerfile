# ============================================
# YNAB MCP Server - Multi-stage Docker Build
# ============================================

# Stage 1: Builder
FROM node:20-alpine3.21 AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Stage 2: Production
FROM node:20-alpine3.21 AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init=1.2.5-r3

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

# MCP servers communicate via stdio
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
