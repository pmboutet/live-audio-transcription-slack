/**
 * Logging utility with structured logging and different levels
 * Provides centralized logging for the entire application
 */

const fs = require('fs');
const path = require('path');

/**
 * Logger class with multiple levels and output targets
 */
class Logger {
  constructor() {
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };
    
    this.currentLevel = process.env.LOG_LEVEL || 'info';
    this.logToFile = process.env.LOG_TO_FILE === 'true' || process.env.NODE_ENV === 'production';
    this.logDir = path.join(process.cwd(), 'logs');
    
    // Ensure log directory exists
    if (this.logToFile && !fs.existsSync(this.logDir)) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
      } catch (error) {
        console.error('Failed to create log directory:', error);
        this.logToFile = false;
      }
    }
  }

  /**
   * Check if a log level should be output
   * @param {string} level - Log level to check
   * @returns {boolean} True if level should be logged
   */
  shouldLog(level) {
    return this.levels[level] <= this.levels[this.currentLevel];
  }

  /**
   * Format log entry
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   * @returns {Object} Formatted log entry
   */
  formatLog(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      pid: process.pid,
      ...meta,
    };

    // Add stack trace for errors
    if (level === 'error' && meta instanceof Error) {
      entry.stack = meta.stack;
      entry.message = meta.message || message;
    }

    return entry;
  }

  /**
   * Write log entry to console
   * @param {Object} entry - Log entry
   */
  writeToConsole(entry) {
    const colors = {
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m',  // Yellow
      INFO: '\x1b[36m',  // Cyan
      DEBUG: '\x1b[90m', // Gray
    };
    
    const reset = '\x1b[0m';
    const color = colors[entry.level] || '';
    
    const timestamp = entry.timestamp;
    const level = `${color}[${entry.level}]${reset}`;
    const message = entry.message;
    
    console.log(`${timestamp} ${level} ${message}`);
    
    // Log additional metadata if present
    if (Object.keys(entry).length > 4) { // More than timestamp, level, message, pid
      const meta = { ...entry };
      delete meta.timestamp;
      delete meta.level;
      delete meta.message;
      delete meta.pid;
      
      if (Object.keys(meta).length > 0) {
        console.log(`${color}[${entry.level}]${reset} Metadata:`, JSON.stringify(meta, null, 2));
      }
    }
    
    // Log stack trace for errors
    if (entry.stack) {
      console.log(`${color}[${entry.level}]${reset} Stack:`, entry.stack);
    }
  }

  /**
   * Write log entry to file
   * @param {Object} entry - Log entry
   */
  writeToFile(entry) {
    if (!this.logToFile) return;
    
    try {
      const date = new Date().toISOString().split('T')[0];
      const filename = path.join(this.logDir, `app-${date}.log`);
      const logLine = JSON.stringify(entry) + '\n';
      
      fs.appendFileSync(filename, logLine);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  /**
   * Core logging method
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  log(level, message, meta = {}) {
    if (!this.shouldLog(level)) return;
    
    const entry = this.formatLog(level, message, meta);
    
    this.writeToConsole(entry);
    this.writeToFile(entry);
  }

  /**
   * Log error message
   * @param {string} message - Error message
   * @param {Object|Error} meta - Error object or metadata
   */
  error(message, meta = {}) {
    this.log('error', message, meta);
  }

  /**
   * Log warning message
   * @param {string} message - Warning message
   * @param {Object} meta - Additional metadata
   */
  warn(message, meta = {}) {
    this.log('warn', message, meta);
  }

  /**
   * Log info message
   * @param {string} message - Info message
   * @param {Object} meta - Additional metadata
   */
  info(message, meta = {}) {
    this.log('info', message, meta);
  }

  /**
   * Log debug message
   * @param {string} message - Debug message
   * @param {Object} meta - Additional metadata
   */
  debug(message, meta = {}) {
    this.log('debug', message, meta);
  }

  /**
   * Log HTTP request
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {number} duration - Request duration in ms
   */
  logRequest(req, res, duration) {
    const meta = {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
    };
    
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    this.log(level, `${req.method} ${req.url} ${res.statusCode}`, meta);
  }

  /**
   * Log WebSocket connection events
   * @param {string} event - Event type
   * @param {string} connectionId - Connection ID
   * @param {Object} meta - Additional metadata
   */
  logWebSocket(event, connectionId, meta = {}) {
    this.info(`WebSocket ${event}`, {
      connectionId,
      ...meta,
    });
  }

  /**
   * Log Slack API calls
   * @param {string} method - API method
   * @param {Object} params - API parameters
   * @param {Object} result - API result
   */
  logSlackAPI(method, params, result) {
    const meta = {
      method,
      channel: params.channel,
      success: result.ok,
      error: result.error,
    };
    
    const level = result.ok ? 'info' : 'warn';
    this.log(level, `Slack API: ${method}`, meta);
  }

  /**
   * Log Deepgram events
   * @param {string} event - Event type
   * @param {string} sessionId - Session ID
   * @param {Object} data - Event data
   */
  logDeepgram(event, sessionId, data = {}) {
    this.info(`Deepgram ${event}`, {
      sessionId,
      ...data,
    });
  }

  /**
   * Log performance metrics
   * @param {string} operation - Operation name
   * @param {number} duration - Duration in milliseconds
   * @param {Object} meta - Additional metadata
   */
  logPerformance(operation, duration, meta = {}) {
    const level = duration > 1000 ? 'warn' : 'debug';
    this.log(level, `Performance: ${operation}`, {
      duration: `${duration}ms`,
      ...meta,
    });
  }

  /**
   * Create a child logger with additional context
   * @param {Object} context - Additional context to include in all logs
   * @returns {Object} Child logger
   */
  child(context) {
    const parent = this;
    
    return {
      error: (message, meta = {}) => parent.error(message, { ...context, ...meta }),
      warn: (message, meta = {}) => parent.warn(message, { ...context, ...meta }),
      info: (message, meta = {}) => parent.info(message, { ...context, ...meta }),
      debug: (message, meta = {}) => parent.debug(message, { ...context, ...meta }),
    };
  }
}

// Create singleton logger instance
const logger = new Logger();

// Express middleware for request logging
function requestLogger(req, res, next) {
  const start = Date.now();
  
  // Add request ID for tracing
  req.id = require('uuid').v4();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.logRequest(req, res, duration);
  });
  
  next();
}

// Error logging middleware
function errorLogger(err, req, res, next) {
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    requestId: req.id,
  });
  
  next(err);
}

module.exports = {
  Logger,
  logger,
  requestLogger,
  errorLogger,
};
