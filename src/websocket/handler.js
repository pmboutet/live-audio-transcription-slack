/**
 * WebSocket handler for real-time audio streaming
 * Manages audio stream connections and integrates with Deepgram
 */

const WebSocket = require('ws');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const { createDeepgramService } = require('../services/deepgram-service');
const { getSlackService } = require('../services/slack-service');
const { logger } = require('../utils/logger');
const { validateAudioStream } = require('../utils/validation');
const { sanitizeInput } = require('../utils/security');

/**
 * Setup WebSocket server and handlers
 * @param {WebSocket.Server} wss - WebSocket server instance
 */
function setupWebSocket(wss) {
  const deepgramService = createDeepgramService();
  const activeStreams = new Map();

  wss.on('connection', async (ws, req) => {
    try {
      // Parse URL parameters
      const queryParams = url.parse(req.url, true).query;
      const connectionId = uuidv4();
      
      // Sanitize and validate parameters
      const params = sanitizeConnectionParams(queryParams);
      const validation = validateConnectionParams(params);
      
      if (!validation.isValid) {
        ws.close(1008, `Invalid parameters: ${validation.errors.join(', ')}`);
        return;
      }

      logger.info(`New WebSocket connection: ${connectionId}`, {
        params,
        ip: req.socket.remoteAddress,
      });

      // Initialize connection state
      const connectionState = {
        id: connectionId,
        ws,
        params,
        deepgramConnection: null,
        isActive: true,
        startTime: new Date(),
        audioChunks: 0,
        totalBytes: 0,
      };

      activeStreams.set(connectionId, connectionState);

      // Create Deepgram streaming connection
      const deepgramConnection = await deepgramService.createStreamingConnection({
        sessionId: params.session,
        slackChannel: params.channel,
        conversationId: params.conversation,
        language: params.language || 'en-US',
        model: params.model || 'nova-2',
        onTranscript: async (result) => {
          // Send transcript back to client
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'transcript',
              data: result,
            }));
          }
        },
        onError: (error) => {
          logger.error(`Deepgram error for connection ${connectionId}:`, error);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Transcription service error',
            }));
          }
        },
      });

      connectionState.deepgramConnection = deepgramConnection;

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        connectionId,
        sessionId: params.session,
        message: 'Connected to transcription service',
      }));

      // Handle incoming messages
      ws.on('message', async (data) => {
        try {
          await handleWebSocketMessage(connectionState, data);
        } catch (error) {
          logger.error(`Error handling WebSocket message for ${connectionId}:`, error);
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Failed to process audio data',
          }));
        }
      });

      // Handle connection close
      ws.on('close', (code, reason) => {
        logger.info(`WebSocket connection closed: ${connectionId}`, {
          code,
          reason: reason.toString(),
          duration: Date.now() - connectionState.startTime.getTime(),
          chunksProcessed: connectionState.audioChunks,
          totalBytes: connectionState.totalBytes,
        });

        cleanup(connectionId, activeStreams);
      });

      // Handle connection errors
      ws.on('error', (error) => {
        logger.error(`WebSocket error for ${connectionId}:`, error);
        cleanup(connectionId, activeStreams);
      });

      // Setup ping/pong for connection health
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);

      ws.on('pong', () => {
        logger.debug(`Pong received from ${connectionId}`);
      });

    } catch (error) {
      logger.error('Error setting up WebSocket connection:', error);
      ws.close(1011, 'Internal server error');
    }
  });

  // Periodic cleanup of inactive connections
  setInterval(() => {
    cleanupInactiveConnections(activeStreams);
  }, 60000); // Every minute

  logger.info('WebSocket server setup completed');
}

/**
 * Handle incoming WebSocket messages
 * @param {Object} connectionState - Connection state object
 * @param {Buffer|string} data - Incoming data
 */
async function handleWebSocketMessage(connectionState, data) {
  const { id, ws, deepgramConnection, params } = connectionState;

  try {
    // Handle JSON messages (control messages)
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'start':
          logger.info(`Starting transcription for connection ${id}`);
          ws.send(JSON.stringify({
            type: 'status',
            status: 'started',
            message: 'Transcription started',
          }));
          break;
          
        case 'stop':
          logger.info(`Stopping transcription for connection ${id}`);
          if (deepgramConnection) {
            deepgramConnection.close();
          }
          ws.send(JSON.stringify({
            type: 'status',
            status: 'stopped',
            message: 'Transcription stopped',
          }));
          break;
          
        case 'config':
          // Handle configuration updates
          logger.debug(`Config update for connection ${id}:`, message.config);
          break;
          
        default:
          logger.warn(`Unknown message type: ${message.type}`);
      }
      return;
    }

    // Handle binary audio data
    if (Buffer.isBuffer(data)) {
      // Validate audio data
      const audioValidation = validateAudioStream(data, {
        maxChunkSize: 8192, // 8KB chunks
        minChunkSize: 160,  // Minimum viable audio chunk
      });

      if (!audioValidation.isValid) {
        logger.warn(`Invalid audio data from ${id}:`, audioValidation.errors);
        return;
      }

      // Update connection statistics
      connectionState.audioChunks++;
      connectionState.totalBytes += data.length;

      // Send audio to Deepgram
      if (deepgramConnection && deepgramConnection.isConnected()) {
        deepgramConnection.sendAudio(data);
      } else {
        logger.warn(`Deepgram connection not ready for ${id}`);
      }
    }

  } catch (error) {
    logger.error(`Error processing message for connection ${id}:`, error);
    throw error;
  }
}

/**
 * Sanitize connection parameters
 * @param {Object} params - Raw query parameters
 * @returns {Object} Sanitized parameters
 */
function sanitizeConnectionParams(params) {
  return {
    channel: sanitizeInput(params.channel, { maxLength: 100 }),
    session: sanitizeInput(params.session, { maxLength: 100 }),
    conversation: sanitizeInput(params.conversation, { maxLength: 100 }),
    user: sanitizeInput(params.user, { maxLength: 100 }),
    language: sanitizeInput(params.language, { maxLength: 10 }),
    model: sanitizeInput(params.model, { maxLength: 50 }),
  };
}

/**
 * Validate connection parameters
 * @param {Object} params - Sanitized parameters
 * @returns {Object} Validation result
 */
function validateConnectionParams(params) {
  const errors = [];

  // Required parameters
  if (!params.channel) {
    errors.push('channel parameter is required');
  }

  if (!params.session) {
    errors.push('session parameter is required');
  }

  // Validate channel format (Slack channel)
  if (params.channel && !params.channel.match(/^[#@]?[a-zA-Z0-9_-]+$/)) {
    errors.push('invalid channel format');
  }

  // Validate language code
  if (params.language && !params.language.match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
    errors.push('invalid language format');
  }

  // Validate model name
  const validModels = ['nova-2', 'nova', 'enhanced', 'base'];
  if (params.model && !validModels.includes(params.model)) {
    errors.push('invalid model specified');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Cleanup connection resources
 * @param {string} connectionId - Connection identifier
 * @param {Map} activeStreams - Active streams map
 */
function cleanup(connectionId, activeStreams) {
  const connectionState = activeStreams.get(connectionId);
  
  if (connectionState) {
    // Close Deepgram connection
    if (connectionState.deepgramConnection) {
      connectionState.deepgramConnection.close();
    }
    
    // Mark as inactive
    connectionState.isActive = false;
    
    // Remove from active streams
    activeStreams.delete(connectionId);
    
    logger.info(`Cleaned up connection: ${connectionId}`);
  }
}

/**
 * Cleanup inactive connections
 * @param {Map} activeStreams - Active streams map
 */
function cleanupInactiveConnections(activeStreams) {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  for (const [connectionId, connectionState] of activeStreams) {
    const age = now - connectionState.startTime.getTime();
    
    if (!connectionState.isActive || age > maxAge) {
      logger.info(`Cleaning up inactive connection: ${connectionId}`);
      cleanup(connectionId, activeStreams);
    }
  }
}

/**
 * Get statistics about active connections
 * @param {Map} activeStreams - Active streams map
 * @returns {Object} Connection statistics
 */
function getConnectionStats(activeStreams) {
  const stats = {
    totalConnections: activeStreams.size,
    activeConnections: 0,
    totalAudioChunks: 0,
    totalBytes: 0,
    connections: [],
  };

  for (const [connectionId, connectionState] of activeStreams) {
    if (connectionState.isActive) {
      stats.activeConnections++;
    }
    
    stats.totalAudioChunks += connectionState.audioChunks;
    stats.totalBytes += connectionState.totalBytes;
    
    stats.connections.push({
      id: connectionId,
      isActive: connectionState.isActive,
      startTime: connectionState.startTime,
      audioChunks: connectionState.audioChunks,
      totalBytes: connectionState.totalBytes,
      sessionId: connectionState.params.session,
      channel: connectionState.params.channel,
    });
  }

  return stats;
}

module.exports = {
  setupWebSocket,
  getConnectionStats,
};
