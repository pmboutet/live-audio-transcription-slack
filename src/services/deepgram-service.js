/**
 * Deepgram streaming transcription service
 * Handles real-time audio transcription using Deepgram's streaming API
 */

const { createClient } = require('@deepgram/sdk');
const { getConfig } = require('../config/environment');
const { logger } = require('../utils/logger');
const { SlackService } = require('./slack-service');

class DeepgramService {
  constructor() {
    const config = getConfig();
    this.deepgram = createClient(config.deepgram.apiKey);
    this.activeConnections = new Map();
    this.slackService = new SlackService();
  }

  /**
   * Create a new streaming connection for live transcription
   * @param {Object} options - Transcription options
   * @param {string} options.sessionId - Unique session identifier
   * @param {string} options.slackChannel - Slack channel for results
   * @param {string} options.conversationId - Conversation identifier
   * @param {Function} options.onTranscript - Callback for transcription results
   * @param {Function} options.onError - Error callback
   * @returns {Object} Connection object with methods
   */
  async createStreamingConnection(options) {
    const {
      sessionId,
      slackChannel,
      conversationId,
      onTranscript,
      onError,
      language = 'en-US',
      model = 'nova-2',
    } = options;

    try {
      // Create Deepgram streaming connection
      const connection = this.deepgram.listen.live({
        model: model,
        language: language,
        smart_format: true,
        interim_results: true,
        endpointing: 300,
        punctuate: true,
        diarize: true,
        filler_words: false,
        multichannel: false,
        alternatives: 1,
        numerals: true,
        profanity_filter: false,
        redact: false,
        replace: '',
        search: '',
        tag: [sessionId, conversationId].filter(Boolean),
        tier: 'enhanced',
        version: 'latest',
      });

      // Handle connection open
      connection.on('open', () => {
        logger.info(`Deepgram connection opened for session: ${sessionId}`);
      });

      // Handle transcription results
      connection.on('transcript', async (data) => {
        try {
          const transcript = data.channel?.alternatives?.[0];
          if (!transcript?.transcript) return;

          const result = {
            sessionId,
            conversationId,
            transcript: transcript.transcript,
            confidence: transcript.confidence,
            is_final: data.is_final,
            duration: data.duration,
            start: data.start,
            channel: data.channel_index,
            words: transcript.words || [],
            timestamp: new Date().toISOString(),
          };

          // Call custom callback if provided
          if (onTranscript) {
            await onTranscript(result);
          }

          // Send to Slack if final result and channel specified
          if (data.is_final && slackChannel && transcript.transcript.trim()) {
            await this.sendToSlack({
              channel: slackChannel,
              transcript: transcript.transcript,
              confidence: transcript.confidence,
              sessionId,
              conversationId,
              duration: data.duration,
            });
          }

          logger.debug(`Transcript received: ${transcript.transcript}`);
        } catch (error) {
          logger.error('Error processing transcript:', error);
          if (onError) onError(error);
        }
      });

      // Handle metadata
      connection.on('metadata', (data) => {
        logger.debug(`Metadata received for session ${sessionId}:`, data);
      });

      // Handle connection close
      connection.on('close', () => {
        logger.info(`Deepgram connection closed for session: ${sessionId}`);
        this.activeConnections.delete(sessionId);
      });

      // Handle errors
      connection.on('error', (error) => {
        logger.error(`Deepgram connection error for session ${sessionId}:`, error);
        if (onError) onError(error);
      });

      // Store connection reference
      this.activeConnections.set(sessionId, {
        connection,
        sessionId,
        slackChannel,
        conversationId,
        createdAt: new Date(),
      });

      return {
        connection,
        sendAudio: (audioData) => {
          if (connection.readyState === 1) {
            connection.send(audioData);
          }
        },
        close: () => {
          connection.close();
        },
        isConnected: () => connection.readyState === 1,
      };
    } catch (error) {
      logger.error('Failed to create Deepgram connection:', error);
      throw error;
    }
  }

  /**
   * Send transcription result to Slack
   * @param {Object} data - Transcription data
   */
  async sendToSlack(data) {
    try {
      const { channel, transcript, confidence, sessionId, conversationId, duration } = data;
      
      const message = {
        channel: channel,
        text: `🎤 *Live Transcription*\n${transcript}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🎤 *Live Transcription*\n${transcript}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Confidence: ${Math.round(confidence * 100)}% | Session: ${sessionId}${conversationId ? ` | Conversation: ${conversationId}` : ''} | Duration: ${duration?.toFixed(2)}s`,
              },
            ],
          },
        ],
      };

      await this.slackService.sendMessage(message);
    } catch (error) {
      logger.error('Failed to send transcription to Slack:', error);
    }
  }

  /**
   * Transcribe audio file (non-streaming)
   * @param {Buffer} audioBuffer - Audio file buffer
   * @param {Object} options - Transcription options
   * @returns {Object} Transcription result
   */
  async transcribeFile(audioBuffer, options = {}) {
    try {
      const {
        language = 'en-US',
        model = 'nova-2',
        smart_format = true,
        punctuate = true,
        diarize = true,
      } = options;

      const response = await this.deepgram.listen.prerecorded.transcribeFile(
        audioBuffer,
        {
          model,
          language,
          smart_format,
          punctuate,
          diarize,
          filler_words: false,
          multichannel: false,
          alternatives: 1,
          numerals: true,
          profanity_filter: false,
        }
      );

      return {
        success: true,
        transcript: response.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '',
        confidence: response.result?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0,
        words: response.result?.results?.channels?.[0]?.alternatives?.[0]?.words || [],
        metadata: response.result?.metadata || {},
      };
    } catch (error) {
      logger.error('File transcription failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get active connection by session ID
   * @param {string} sessionId - Session identifier
   * @returns {Object|null} Connection object or null
   */
  getConnection(sessionId) {
    return this.activeConnections.get(sessionId) || null;
  }

  /**
   * Close connection by session ID
   * @param {string} sessionId - Session identifier
   */
  closeConnection(sessionId) {
    const connectionData = this.activeConnections.get(sessionId);
    if (connectionData) {
      connectionData.connection.close();
      this.activeConnections.delete(sessionId);
      logger.info(`Closed connection for session: ${sessionId}`);
    }
  }

  /**
   * Get statistics about active connections
   * @returns {Object} Connection statistics
   */
  getConnectionStats() {
    return {
      activeConnections: this.activeConnections.size,
      connections: Array.from(this.activeConnections.values()).map(conn => ({
        sessionId: conn.sessionId,
        slackChannel: conn.slackChannel,
        conversationId: conn.conversationId,
        createdAt: conn.createdAt,
        uptime: Date.now() - conn.createdAt.getTime(),
      })),
    };
  }

  /**
   * Cleanup inactive connections
   */
  cleanupConnections() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, connectionData] of this.activeConnections) {
      if (now - connectionData.createdAt.getTime() > maxAge) {
        logger.info(`Cleaning up inactive connection: ${sessionId}`);
        this.closeConnection(sessionId);
      }
    }
  }
}

// Singleton instance
let deepgramService = null;

/**
 * Create or get Deepgram service instance
 * @returns {DeepgramService} Service instance
 */
function createDeepgramService() {
  if (!deepgramService) {
    deepgramService = new DeepgramService();
    
    // Setup cleanup interval
    setInterval(() => {
      deepgramService.cleanupConnections();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
  return deepgramService;
}

module.exports = {
  DeepgramService,
  createDeepgramService,
};
