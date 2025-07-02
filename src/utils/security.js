/**
 * Security utilities for input validation and authentication
 * Provides XSS protection, injection prevention, and Slack signature validation
 */

const crypto = require('crypto');
const { logger } = require('./logger');

/**
 * Sanitize user input to prevent XSS and injection attacks
 * @param {string} input - User input string
 * @param {Object} options - Sanitization options
 * @returns {string} Sanitized input
 */
function sanitizeInput(input, options = {}) {
  if (!input || typeof input !== 'string') {
    return '';
  }

  const {
    maxLength = 1000,
    allowHtml = false,
    allowSpecialChars = true,
  } = options;

  let sanitized = input.trim();

  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  // Remove or escape HTML if not allowed
  if (!allowHtml) {
    sanitized = sanitized
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  // Remove dangerous characters if not allowed
  if (!allowSpecialChars) {
    sanitized = sanitized.replace(/[^a-zA-Z0-9\s\-_@#.]/g, '');
  }

  // Remove null bytes and control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Remove SQL injection patterns
  const sqlPatterns = [
    /('|(\-\-)|(;)|(\||\|)|(\*|\*))/i,
    /(union|select|insert|update|delete|drop|create|alter|exec|execute)/i,
  ];

  for (const pattern of sqlPatterns) {
    if (pattern.test(sanitized)) {
      logger.warn('Potential SQL injection attempt detected', { input: sanitized });
      sanitized = sanitized.replace(pattern, '');
    }
  }

  // Remove script injection patterns
  const scriptPatterns = [
    /<script[^>]*>[\s\S]*?<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
  ];

  for (const pattern of scriptPatterns) {
    if (pattern.test(sanitized)) {
      logger.warn('Potential script injection attempt detected', { input: sanitized });
      sanitized = sanitized.replace(pattern, '');
    }
  }

  return sanitized;
}

/**
 * Validate Slack request signature for webhook security
 * @param {string} signature - X-Slack-Signature header
 * @param {string} timestamp - X-Slack-Request-Timestamp header
 * @param {string} body - Request body
 * @param {string} signingSecret - Slack signing secret
 * @returns {boolean} True if signature is valid
 */
function validateSlackSignature(signature, timestamp, body, signingSecret) {
  try {
    if (!signature || !timestamp || !body || !signingSecret) {
      return false;
    }

    // Check timestamp to prevent replay attacks (within 5 minutes)
    const currentTime = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp);
    
    if (Math.abs(currentTime - requestTime) > 300) {
      logger.warn('Slack request timestamp too old', {
        currentTime,
        requestTime,
        diff: currentTime - requestTime,
      });
      return false;
    }

    // Create signature base string
    const baseString = `v0:${timestamp}:${body}`;
    
    // Generate expected signature
    const expectedSignature = 'v0=' + crypto
      .createHmac('sha256', signingSecret)
      .update(baseString)
      .digest('hex');

    // Compare signatures using timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

  } catch (error) {
    logger.error('Error validating Slack signature:', error);
    return false;
  }
}

/**
 * Generate a secure random token
 * @param {number} length - Token length
 * @returns {string} Random token
 */
function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash a password using bcrypt-like algorithm
 * @param {string} password - Plain text password
 * @param {number} rounds - Salt rounds
 * @returns {string} Hashed password
 */
function hashPassword(password, rounds = 12) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, rounds * 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password
 * @param {string} hashedPassword - Hashed password
 * @returns {boolean} True if password matches
 */
function verifyPassword(password, hashedPassword) {
  try {
    const [salt, hash] = hashedPassword.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 12000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(verifyHash));
  } catch (error) {
    return false;
  }
}

/**
 * Rate limiting tracker
 */
class RateLimiter {
  constructor() {
    this.clients = new Map();
    this.cleanup();
  }

  /**
   * Check if client is rate limited
   * @param {string} clientId - Client identifier
   * @param {number} maxRequests - Maximum requests per window
   * @param {number} windowMs - Time window in milliseconds
   * @returns {boolean} True if rate limited
   */
  isRateLimited(clientId, maxRequests = 100, windowMs = 60000) {
    const now = Date.now();
    const client = this.clients.get(clientId) || { requests: [], blocked: false };
    
    // Remove old requests outside the window
    client.requests = client.requests.filter(time => now - time < windowMs);
    
    // Check if blocked
    if (client.blocked && now - client.blockedAt < windowMs * 2) {
      return true;
    }
    
    // Check request count
    if (client.requests.length >= maxRequests) {
      client.blocked = true;
      client.blockedAt = now;
      logger.warn(`Rate limit exceeded for client: ${clientId}`);
      this.clients.set(clientId, client);
      return true;
    }
    
    // Add current request
    client.requests.push(now);
    client.blocked = false;
    this.clients.set(clientId, client);
    
    return false;
  }

  /**
   * Clean up old entries
   */
  cleanup() {
    setInterval(() => {
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000; // 2 hours
      
      for (const [clientId, client] of this.clients) {
        const lastRequest = Math.max(...client.requests, client.blockedAt || 0);
        if (now - lastRequest > maxAge) {
          this.clients.delete(clientId);
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}

/**
 * Validate file upload security
 * @param {Object} file - Multer file object
 * @returns {Object} Validation result
 */
function validateFileUpload(file) {
  const errors = [];
  
  if (!file) {
    errors.push('No file provided');
    return { isValid: false, errors };
  }
  
  // Check file size (50MB max)
  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    errors.push(`File too large: ${file.size} bytes (max: ${maxSize})`);
  }
  
  // Check MIME type
  const allowedTypes = [
    'audio/wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/m4a',
    'audio/flac',
    'audio/ogg',
  ];
  
  if (!allowedTypes.includes(file.mimetype)) {
    errors.push(`Invalid file type: ${file.mimetype}`);
  }
  
  // Check filename for dangerous patterns
  const dangerousPatterns = [
    /\.\.[\/\\]/,  // Path traversal
    /[<>:"|?*]/,    // Invalid filename characters
    /\.(php|js|exe|bat|cmd|sh)$/i,  // Executable extensions
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(file.originalname)) {
      errors.push('Invalid filename');
      break;
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Create CSRF token
 * @param {string} sessionId - Session identifier
 * @returns {string} CSRF token
 */
function createCSRFToken(sessionId) {
  const timestamp = Date.now().toString();
  const random = crypto.randomBytes(16).toString('hex');
  const data = `${sessionId}:${timestamp}:${random}`;
  
  const secret = process.env.JWT_SECRET || 'default-secret';
  const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  
  return Buffer.from(`${data}:${signature}`).toString('base64');
}

/**
 * Verify CSRF token
 * @param {string} token - CSRF token
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if valid
 */
function verifyCSRFToken(token, sessionId) {
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [session, timestamp, random, signature] = decoded.split(':');
    
    if (session !== sessionId) {
      return false;
    }
    
    // Check token age (max 1 hour)
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > 60 * 60 * 1000) {
      return false;
    }
    
    // Verify signature
    const data = `${session}:${timestamp}:${random}`;
    const secret = process.env.JWT_SECRET || 'default-secret';
    const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('hex');
    
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch (error) {
    return false;
  }
}

// Create global rate limiter instance
const globalRateLimiter = new RateLimiter();

module.exports = {
  sanitizeInput,
  validateSlackSignature,
  generateSecureToken,
  hashPassword,
  verifyPassword,
  RateLimiter,
  globalRateLimiter,
  validateFileUpload,
  createCSRFToken,
  verifyCSRFToken,
};
