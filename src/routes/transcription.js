/**
 * Transcription API routes
 * Handles file upload transcription and session management
 */

const express = require('express');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const { createDeepgramService } = require('../services/deepgram-service');
const { getSlackService } = require('../services/slack-service');
const { logger } = require('../utils/logger');
const { validateAudioFile } = require('../utils/validation');
const { sanitizeInput } = require('../utils/security');
const { getConfig } = require('../config/environment');

const router = express.Router();
const config = getConfig();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseFileSize(config.audio.maxFileSize),
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = config.audio.supportedFormats.map(ext => `audio/${ext}`);
    if (allowedTypes.some(type => file.mimetype.includes(type.split('/')[1]))) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Allowed: ${config.audio.supportedFormats.join(', ')}`));
    }
  },
});

/**
 * POST /api/transcription/upload
 * Upload and transcribe an audio file
 */
router.post('/upload',
  upload.single('audio'),
  [
    body('channel').optional().isString().isLength({ min: 1, max: 100 }),
    body('conversation').optional().isString().isLength({ min: 1, max: 100 }),
    body('language').optional().isString().matches(/^[a-z]{2}(-[A-Z]{2})?$/),
    body('model').optional().isIn(['nova-2', 'nova', 'enhanced', 'base']),
  ],
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'No audio file provided',
          code: 'MISSING_FILE',
        });
      }

      // Validate audio file
      const fileValidation = validateAudioFile(req.file);
      if (!fileValidation.isValid) {
        return res.status(400).json({
          error: 'Invalid audio file',
          details: fileValidation.errors,
          code: 'INVALID_FILE',
        });
      }

      // Sanitize input parameters
      const params = {
        channel: sanitizeInput(req.body.channel),
        conversation: sanitizeInput(req.body.conversation),
        language: sanitizeInput(req.body.language) || 'en-US',
        model: sanitizeInput(req.body.model) || 'nova-2',
      };

      logger.info('Processing file transcription', {
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        params,
      });

      // Transcribe with Deepgram
      const deepgramService = createDeepgramService();
      const result = await deepgramService.transcribeFile(req.file.buffer, {
        language: params.language,
        model: params.model,
      });

      if (!result.success) {
        return res.status(500).json({
          error: 'Transcription failed',
          details: result.error,
          code: 'TRANSCRIPTION_ERROR',
        });
      }

      // Send to Slack if channel specified
      if (params.channel && result.transcript) {
        try {
          const slackService = getSlackService();
          if (slackService) {
            await slackService.sendMessage({
              channel: params.channel,
              text: `📎 *File Transcription*\n${result.transcript}`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `📎 *File Transcription*\n${result.transcript}`,
                  },
                },
                {
                  type: 'context',
                  elements: [
                    {
                      type: 'mrkdwn',
                      text: `File: ${req.file.originalname} | Confidence: ${Math.round(result.confidence * 100)}%${params.conversation ? ` | Conversation: ${params.conversation}` : ''}`,
                    },
                  ],
                },
              ],
            });
          }
        } catch (slackError) {
          logger.error('Failed to send to Slack:', slackError);
          // Don't fail the request if Slack fails
        }
      }

      res.json({
        success: true,
        transcript: result.transcript,
        confidence: result.confidence,
        words: result.words,
        metadata: {
          filename: req.file.originalname,
          size: req.file.size,
          duration: result.metadata.duration,
          language: params.language,
          model: params.model,
          processedAt: new Date().toISOString(),
        },
      });

    } catch (error) {
      logger.error('File transcription error:', error);
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }
  }
);

/**
 * GET /api/transcription/sessions
 * Get active transcription sessions
 */
router.get('/sessions',
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const offset = parseInt(req.query.offset) || 0;

      const deepgramService = createDeepgramService();
      const stats = deepgramService.getConnectionStats();

      const sessions = stats.connections
        .slice(offset, offset + limit)
        .map(conn => ({
          sessionId: conn.sessionId,
          channel: conn.slackChannel,
          conversationId: conn.conversationId,
          isActive: conn.connection?.readyState === 1,
          createdAt: conn.createdAt,
          uptime: conn.uptime,
        }));

      res.json({
        sessions,
        pagination: {
          total: stats.connections.length,
          limit,
          offset,
          hasMore: offset + limit < stats.connections.length,
        },
        summary: {
          activeConnections: stats.activeConnections,
          totalConnections: stats.connections.length,
        },
      });

    } catch (error) {
      logger.error('Error fetching sessions:', error);
      res.status(500).json({
        error: 'Failed to fetch sessions',
        code: 'FETCH_ERROR',
      });
    }
  }
);

/**
 * DELETE /api/transcription/sessions/:sessionId
 * Stop a transcription session
 */
router.delete('/sessions/:sessionId',
  [
    param('sessionId').isString().isLength({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    try {
      const sessionId = sanitizeInput(req.params.sessionId);
      
      const deepgramService = createDeepgramService();
      const connection = deepgramService.getConnection(sessionId);
      
      if (!connection) {
        return res.status(404).json({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
        });
      }

      deepgramService.closeConnection(sessionId);
      
      logger.info(`Stopped transcription session: ${sessionId}`);
      
      res.json({
        success: true,
        message: 'Session stopped successfully',
        sessionId,
      });

    } catch (error) {
      logger.error('Error stopping session:', error);
      res.status(500).json({
        error: 'Failed to stop session',
        code: 'STOP_ERROR',
      });
    }
  }
);

/**
 * GET /api/transcription/sessions/:sessionId
 * Get session details
 */
router.get('/sessions/:sessionId',
  [
    param('sessionId').isString().isLength({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    try {
      const sessionId = sanitizeInput(req.params.sessionId);
      
      const deepgramService = createDeepgramService();
      const connection = deepgramService.getConnection(sessionId);
      
      if (!connection) {
        return res.status(404).json({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
        });
      }

      res.json({
        sessionId: connection.sessionId,
        channel: connection.slackChannel,
        conversationId: connection.conversationId,
        isActive: connection.connection?.readyState === 1,
        createdAt: connection.createdAt,
        uptime: connection.uptime,
        status: connection.connection?.readyState === 1 ? 'active' : 'inactive',
      });

    } catch (error) {
      logger.error('Error fetching session:', error);
      res.status(500).json({
        error: 'Failed to fetch session',
        code: 'FETCH_ERROR',
      });
    }
  }
);

/**
 * Parse file size string to bytes
 * @param {string} sizeStr - Size string (e.g., '50MB')
 * @returns {number} Size in bytes
 */
function parseFileSize(sizeStr) {
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const match = sizeStr.match(/^(\d+)([A-Z]{1,2})$/);
  
  if (!match) return 50 * 1024 * 1024; // Default 50MB
  
  const [, size, unit] = match;
  return parseInt(size) * (units[unit] || 1);
}

module.exports = router;
