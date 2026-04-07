# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY src ./src
COPY config ./config

# Build
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config

# Create non-root user
RUN mkdir -p /var/log/squire && \
    addgroup -S -g 1000 squire 2>/dev/null || true && \
    adduser -S -u 1000 -G squire squire 2>/dev/null || true && \
    chown -R 1000:1000 /app /var/log/squire

USER squire

# Expose ports
EXPOSE 4001 9090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]
