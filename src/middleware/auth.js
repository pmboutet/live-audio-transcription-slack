/**
 * Authentication middleware
 * Handles JWT token validation and API key authentication
 */

const jwt = require('jsonwebtoken');
const { getConfig } = require('../config/environment');
const { logger } = require('../utils/logger');
const { globalRateLimiter } = require('../utils/security');

/**
 * JWT authentication middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
function authMiddleware(req, res, next) {
  try {
    const config = getConfig();
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        error: 'Authorization header required',
        code: 'MISSING_AUTH_HEADER',
      });
    }
    
    // Check for Bearer token
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({
        error: 'Invalid authorization format. Use: Bearer <token>',
        code: 'INVALID_AUTH_FORMAT',
      });
    }
    
    const token = match[1];
    
    // Verify JWT token
    try {
      const decoded = jwt.verify(token, config.security.jwtSecret);
      req.user = decoded;
      
      logger.debug('User authenticated', {
        userId: decoded.sub,
        requestId: req.id,
      });
      
      next();
    } catch (jwtError) {
      logger.warn('JWT verification failed', {
        error: jwtError.message,
        token: token.substring(0, 20) + '...',
        ip: req.ip,
      });
      
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN',
      });
    }
    
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({
      error: 'Authentication service error',
      code: 'AUTH_SERVICE_ERROR',
    });
  }
}

/**
 * API key authentication middleware (alternative to JWT)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
function apiKeyMiddleware(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({
        error: 'API key required',
        code: 'MISSING_API_KEY',
      });
    }
    
    // Validate API key format
    if (!apiKey.match(/^[a-zA-Z0-9_-]{32,128}$/)) {
      return res.status(401).json({
        error: 'Invalid API key format',
        code: 'INVALID_API_KEY_FORMAT',
      });
    }
    
    // In a real implementation, you would check against a database
    // For now, we'll check against environment variable
    const validApiKey = process.env.API_KEY;
    
    if (!validApiKey || apiKey !== validApiKey) {
      logger.warn('Invalid API key attempt', {
        providedKey: apiKey.substring(0, 8) + '...',
        ip: req.ip,
      });
      
      return res.status(401).json({
        error: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });
    }
    
    // Set user context for API key
    req.user = {
      type: 'api_key',
      keyId: apiKey.substring(0, 8),
    };
    
    logger.debug('API key authenticated', {
      keyId: req.user.keyId,
      requestId: req.id,
    });
    
    next();
    
  } catch (error) {
    logger.error('API key authentication error:', error);
    res.status(500).json({
      error: 'Authentication service error',
      code: 'AUTH_SERVICE_ERROR',
    });
  }
}

/**
 * Optional authentication middleware (allows both authenticated and unauthenticated requests)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];
  
  if (!authHeader && !apiKey) {
    // No authentication provided, continue without user context
    req.user = null;
    return next();
  }
  
  // Try API key first, then JWT
  if (apiKey) {
    apiKeyMiddleware(req, res, (err) => {
      if (err) {
        // If API key fails, try JWT
        if (authHeader) {
          authMiddleware(req, res, next);
        } else {
          next(err);
        }
      } else {
        next();
      }
    });
  } else {
    authMiddleware(req, res, next);
  }
}

/**
 * Rate limiting middleware with authentication awareness
 * @param {Object} options - Rate limiting options
 * @returns {Function} Middleware function
 */
function rateLimitMiddleware(options = {}) {
  const {
    maxRequests = 100,
    windowMs = 60000,
    skipAuthenticated = false,
  } = options;
  
  return (req, res, next) => {
    // Skip rate limiting for authenticated users if configured
    if (skipAuthenticated && req.user) {
      return next();
    }
    
    const clientId = req.user?.sub || req.ip;
    const isRateLimited = globalRateLimiter.isRateLimited(clientId, maxRequests, windowMs);
    
    if (isRateLimited) {
      logger.warn('Rate limit exceeded', {
        clientId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      
      return res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    }
    
    next();
  };
}

/**
 * Generate JWT token for user
 * @param {Object} payload - Token payload
 * @param {Object} options - Token options
 * @returns {string} JWT token
 */
function generateToken(payload, options = {}) {
  const config = getConfig();
  const {
    expiresIn = '24h',
    issuer = 'transcription-service',
    audience = 'transcription-api',
  } = options;
  
  return jwt.sign(
    payload,
    config.security.jwtSecret,
    {
      expiresIn,
      issuer,
      audience,
      subject: payload.sub || payload.userId,
    }
  );
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token payload
 */
function verifyToken(token) {
  const config = getConfig();
  
  return jwt.verify(token, config.security.jwtSecret);
}

/**
 * Role-based access control middleware
 * @param {Array|string} roles - Required roles
 * @returns {Function} Middleware function
 */
function requireRole(roles) {
  const requiredRoles = Array.isArray(roles) ? roles : [roles];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    }
    
    const userRoles = req.user.roles || [];
    const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));
    
    if (!hasRequiredRole) {
      logger.warn('Insufficient permissions', {
        userId: req.user.sub,
        userRoles,
        requiredRoles,
        requestId: req.id,
      });
      
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'INSUFFICIENT_PERMISSIONS',
        required: requiredRoles,
      });
    }
    
    next();
  };
}

/**
 * Admin access middleware
 */
const requireAdmin = requireRole(['admin']);

/**
 * User or admin access middleware
 */
const requireUserOrAdmin = requireRole(['user', 'admin']);

module.exports = {
  authMiddleware,
  apiKeyMiddleware,
  optionalAuthMiddleware,
  rateLimitMiddleware,
  generateToken,
  verifyToken,
  requireRole,
  requireAdmin,
  requireUserOrAdmin,
};
