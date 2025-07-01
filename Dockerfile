# Multi-stage build for production optimization
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Production stage
FROM node:18-alpine AS production

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Copy dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create logs directory
RUN mkdir -p logs && chown -R nextjs:nodejs logs

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node scripts/health-check.js

# Start the application
CMD ["npm", "start"]
