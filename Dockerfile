# syntax=docker/dockerfile:1

# Use Node.js 20 LTS (Alpine for smaller image size)
FROM node:20-alpine AS base

# Install build dependencies for native modules (better-sqlite3)
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies (including native modules)
RUN npm ci --only=production && npm cache clean --force

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080

# Create non-root user for security and data directory for SQLite persistence
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 mtgtimer \
    && mkdir -p /app/data \
    && chown -R mtgtimer:nodejs /app/data

# Copy built dependencies (including native modules)
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY --chown=mtgtimer:nodejs server.js ./
COPY --chown=mtgtimer:nodejs public ./public
COPY --chown=mtgtimer:nodejs lib ./lib

# Switch to non-root user
USER mtgtimer

# Expose port
EXPOSE 8080

# Volume for persistent data
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the application
CMD ["node", "server.js"]
