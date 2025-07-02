/**
 * Request validation middleware
 * Handles input validation and sanitization for all API endpoints
 */

const { validationResult } = require('express-validator');
const { logger } = require('../utils/logger');
const { sanitizeInput } = require('../utils/security');

/**
 * Express-validator error handling middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map(error => ({
      field: error.path || error.param,
      message: error.msg,
      value: error.value,
      location: error.location,
    }));
    
    logger.warn('Validation errors', {
      url: req.url,
      method: req.method,
      errors: errorDetails,
      requestId: req.id,
    });
    
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errorDetails,
    });
  }
  
  next();
}

/**
 * General request validation middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
function validateRequest(req, res, next) {
  try {
    // Add request ID if not present
    if (!req.id) {
      req.id = require('uuid').v4();
    }
    
    // Validate Content-Type for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('content-type') || '';
      
      if (req.path.includes('/upload')) {
        // File upload endpoints should use multipart/form-data
        if (!contentType.includes('multipart/form-data')) {
          return res.status(400).json({
            error: 'Invalid Content-Type for file upload',
            expected: 'multipart/form-data',
            received: contentType,
          });
        }
      } else if (!contentType.includes('application/json') && !contentType.includes('application/x-www-form-urlencoded')) {
        return res.status(400).json({
          error: 'Invalid Content-Type',
          expected: 'application/json or application/x-www-form-urlencoded',
          received: contentType,
        });
      }
    }
    
    // Validate request size
    const contentLength = parseInt(req.get('content-length') || '0');
    const maxSize = 100 * 1024 * 1024; // 100MB
    
    if (contentLength > maxSize) {
      return res.status(413).json({
        error: 'Request too large',
        maxSize: `${maxSize / 1024 / 1024}MB`,
        received: `${Math.round(contentLength / 1024 / 1024)}MB`,
      });
    }
    
    // Sanitize query parameters
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
          req.query[key] = sanitizeInput(value, { maxLength: 1000 });
        }
      }
    }
    
    // Sanitize body parameters (for non-file uploads)
    if (req.body && typeof req.body === 'object' && !req.file && !req.files) {
      sanitizeObjectRecursive(req.body);
    }
    
    next();
    
  } catch (error) {
    logger.error('Request validation error:', error);
    res.status(500).json({
      error: 'Request validation failed',
      code: 'VALIDATION_SERVICE_ERROR',
    });
  }
}

/**
 * Recursively sanitize object properties
 * @param {Object} obj - Object to sanitize
 * @param {number} depth - Current recursion depth
 */
function sanitizeObjectRecursive(obj, depth = 0) {
  // Prevent deep recursion
  if (depth > 10) return;
  
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      obj[key] = sanitizeInput(value, { maxLength: 10000 });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitizeObjectRecursive(value, depth + 1);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'string') {
          value[index] = sanitizeInput(item, { maxLength: 1000 });
        } else if (typeof item === 'object' && item !== null) {
          sanitizeObjectRecursive(item, depth + 1);
        }
      });
    }
  }
}

/**
 * WebSocket parameter validation
 * @param {Object} params - WebSocket query parameters
 * @returns {Object} Validation result
 */
function validateWebSocketParams(params) {
  const errors = [];
  const sanitized = {};
  
  // Required parameters
  const required = ['channel', 'session'];
  for (const param of required) {
    if (!params[param]) {
      errors.push(`Missing required parameter: ${param}`);
    } else {
      sanitized[param] = sanitizeInput(params[param], { maxLength: 100 });
    }
  }
  
  // Optional parameters
  const optional = ['conversation', 'user', 'language', 'model'];
  for (const param of optional) {
    if (params[param]) {
      sanitized[param] = sanitizeInput(params[param], { maxLength: 100 });
    }
  }
  
  // Validate channel format
  if (sanitized.channel && !sanitized.channel.match(/^[#@]?[a-zA-Z0-9_-]+$/)) {
    errors.push('Invalid channel format');
  }
  
  // Validate session format
  if (sanitized.session && !sanitized.session.match(/^[a-zA-Z0-9_-]+$/)) {
    errors.push('Invalid session format');
  }
  
  // Validate language code
  if (sanitized.language && !sanitized.language.match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
    errors.push('Invalid language format');
  }
  
  // Validate model
  const validModels = ['nova-2', 'nova', 'enhanced', 'base'];
  if (sanitized.model && !validModels.includes(sanitized.model)) {
    errors.push('Invalid model');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized,
  };
}

/**
 * File upload validation middleware
 * @param {Object} options - Validation options
 * @returns {Function} Middleware function
 */
function validateFileUpload(options = {}) {
  const {
    maxSize = 50 * 1024 * 1024, // 50MB
    allowedTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/m4a', 'audio/flac'],
    required = true,
  } = options;
  
  return (req, res, next) => {
    try {
      if (required && !req.file) {
        return res.status(400).json({
          error: 'No file uploaded',
          code: 'MISSING_FILE',
        });
      }
      
      if (req.file) {
        // Check file size
        if (req.file.size > maxSize) {
          return res.status(400).json({
            error: 'File too large',
            maxSize: `${maxSize / 1024 / 1024}MB`,
            received: `${Math.round(req.file.size / 1024 / 1024)}MB`,
            code: 'FILE_TOO_LARGE',
          });
        }
        
        // Check MIME type
        if (!allowedTypes.includes(req.file.mimetype)) {
          return res.status(400).json({
            error: 'Invalid file type',
            allowed: allowedTypes,
            received: req.file.mimetype,
            code: 'INVALID_FILE_TYPE',
          });
        }
        
        // Check filename
        if (!req.file.originalname || req.file.originalname.length > 255) {
          return res.status(400).json({
            error: 'Invalid filename',
            code: 'INVALID_FILENAME',
          });
        }
        
        // Check for dangerous filename patterns
        const dangerousPatterns = [
          /\.\.[\/\\]/, // Path traversal
          /[<>:"|?*]/, // Invalid chars
          /^\.|\.$/, // Hidden/ending with dot
        ];
        
        for (const pattern of dangerousPatterns) {
          if (pattern.test(req.file.originalname)) {
            return res.status(400).json({
              error: 'Invalid filename format',
              code: 'INVALID_FILENAME_FORMAT',
            });
          }
        }
      }
      
      next();
      
    } catch (error) {
      logger.error('File validation error:', error);
      res.status(500).json({
        error: 'File validation failed',
        code: 'FILE_VALIDATION_ERROR',
      });
    }
  };
}

/**
 * Pagination validation middleware
 * @param {Object} options - Pagination options
 * @returns {Function} Middleware function
 */
function validatePagination(options = {}) {
  const {
    maxLimit = 100,
    defaultLimit = 20,
  } = options;
  
  return (req, res, next) => {
    // Validate limit
    let limit = parseInt(req.query.limit) || defaultLimit;
    if (limit > maxLimit) {
      limit = maxLimit;
    }
    if (limit < 1) {
      limit = 1;
    }
    req.query.limit = limit;
    
    // Validate offset
    let offset = parseInt(req.query.offset) || 0;
    if (offset < 0) {
      offset = 0;
    }
    req.query.offset = offset;
    
    // Validate page (alternative to offset)
    if (req.query.page) {
      let page = parseInt(req.query.page) || 1;
      if (page < 1) {
        page = 1;
      }
      req.query.offset = (page - 1) * limit;
      req.query.page = page;
    }
    
    next();
  };
}

/**
 * JSON schema validation middleware
 * @param {Object} schema - JSON schema object
 * @returns {Function} Middleware function
 */
function validateSchema(schema) {
  return (req, res, next) => {
    try {
      const Joi = require('joi');
      const { error, value } = Joi.validate(req.body, schema);
      
      if (error) {
        const errorDetails = error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message,
          type: detail.type,
        }));
        
        return res.status(400).json({
          error: 'Schema validation failed',
          code: 'SCHEMA_VALIDATION_ERROR',
          details: errorDetails,
        });
      }
      
      req.body = value;
      next();
      
    } catch (validationError) {
      logger.error('Schema validation error:', validationError);
      res.status(500).json({
        error: 'Schema validation service error',
        code: 'SCHEMA_VALIDATION_SERVICE_ERROR',
      });
    }
  };
}

module.exports = {
  handleValidationErrors,
  validateRequest,
  validateWebSocketParams,
  validateFileUpload,
  validatePagination,
  validateSchema,
  sanitizeObjectRecursive,
};
