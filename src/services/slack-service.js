/**
 * Slack integration service
 * Handles Slack API communication and webhook processing
 */

const { WebClient } = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');
const { getConfig } = require('../config/environment');
const { logger } = require('../utils/logger');
const { validateSlackSignature } = require('../utils/security');

class SlackService {
  constructor() {
    const config = getConfig();
    this.webClient = new WebClient(config.slack.botToken);
    this.socketClient = new SocketModeClient({
      appToken: config.slack.appToken,
    });
    this.config = config.slack;
    this.isInitialized = false;
  }

  /**
   * Initialize Slack service and socket mode
   */
  async initialize() {
    try {
      // Test API connection
      const authResult = await this.webClient.auth.test();
      logger.info(`Connected to Slack as ${authResult.user} in ${authResult.team}`);

      // Setup socket mode event handlers
      this.setupEventHandlers();

      // Start socket mode client
      await this.socketClient.start();
      logger.info('Slack Socket Mode client started');

      this.isInitialized = true;
    } catch (error) {
      logger.error('Failed to initialize Slack service:', error);
      throw error;
    }
  }

  /**
   * Setup Slack event handlers
   */
  setupEventHandlers() {
    // Handle slash commands
    this.socketClient.on('slash_command', async ({ command, ack, say }) => {
      await ack();
      await this.handleSlashCommand(command, say);
    });

    // Handle app mentions
    this.socketClient.on('app_mention', async ({ event, say }) => {
      await this.handleAppMention(event, say);
    });

    // Handle interactive components
    this.socketClient.on('interactive', async ({ payload, ack }) => {
      await ack();
      await this.handleInteractiveComponent(payload);
    });

    // Handle socket mode errors
    this.socketClient.on('error', (error) => {
      logger.error('Slack Socket Mode error:', error);
    });

    // Handle disconnections
    this.socketClient.on('disconnect', () => {
      logger.warn('Slack Socket Mode disconnected');
    });

    // Handle reconnections
    this.socketClient.on('reconnect', () => {
      logger.info('Slack Socket Mode reconnected');
    });
  }

  /**
   * Handle slash commands
   * @param {Object} command - Slash command payload
   * @param {Function} say - Response function
   */
  async handleSlashCommand(command, say) {
    try {
      const { command: cmd, text, user_id, channel_id } = command;

      switch (cmd) {
        case '/transcribe':
          await this.handleTranscribeCommand(text, channel_id, user_id, say);
          break;
        case '/transcribe-status':
          await this.handleStatusCommand(channel_id, say);
          break;
        default:
          await say(`Unknown command: ${cmd}`);
      }
    } catch (error) {
      logger.error('Error handling slash command:', error);
      await say('Sorry, there was an error processing your command.');
    }
  }

  /**
   * Handle transcribe command
   * @param {string} text - Command text
   * @param {string} channelId - Channel ID
   * @param {string} userId - User ID
   * @param {Function} say - Response function
   */
  async handleTranscribeCommand(text, channelId, userId, say) {
    const params = this.parseCommandParams(text);
    
    const sessionId = params.session || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const conversationId = params.conversation || null;
    
    // Generate WebSocket URL with parameters
    const wsUrl = this.generateWebSocketUrl({
      channel: channelId,
      session: sessionId,
      conversation: conversationId,
      user: userId,
      ...params,
    });

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎤 *Live Transcription Started*\n\nSession ID: \`${sessionId}\`${conversationId ? `\nConversation: \`${conversationId}\`` : ''}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Connect your audio stream to:\n\`${wsUrl}\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Stop Transcription',
            },
            action_id: 'stop_transcription',
            value: sessionId,
            style: 'danger',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Get Status',
            },
            action_id: 'get_status',
            value: sessionId,
          },
        ],
      },
    ];

    await say({ blocks });
  }

  /**
   * Handle status command
   * @param {string} channelId - Channel ID
   * @param {Function} say - Response function
   */
  async handleStatusCommand(channelId, say) {
    // This would integrate with the Deepgram service to get status
    const message = {
      text: '📊 Transcription Service Status',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '📊 *Transcription Service Status*\n\n• Service: Online\n• Active Sessions: 0\n• Uptime: Available',
          },
        },
      ],
    };

    await say(message);
  }

  /**
   * Handle app mentions
   * @param {Object} event - Mention event
   * @param {Function} say - Response function
   */
  async handleAppMention(event, say) {
    const helpText = {
      text: '👋 Hi! I can help you with live audio transcription.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '👋 *Hi! I can help you with live audio transcription.*\n\nAvailable commands:\n• `/transcribe` - Start a new transcription session\n• `/transcribe-status` - Check service status',
          },
        },
      ],
    };

    await say(helpText);
  }

  /**
   * Handle interactive components
   * @param {Object} payload - Interactive payload
   */
  async handleInteractiveComponent(payload) {
    const { type, actions, response_url } = payload;

    if (type === 'block_actions' && actions?.[0]) {
      const action = actions[0];
      
      switch (action.action_id) {
        case 'stop_transcription':
          await this.handleStopTranscription(action.value, response_url);
          break;
        case 'get_status':
          await this.handleGetSessionStatus(action.value, response_url);
          break;
      }
    }
  }

  /**
   * Send message to Slack
   * @param {Object} message - Message object
   * @returns {Object} Slack API response
   */
  async sendMessage(message) {
    try {
      const result = await this.webClient.chat.postMessage({
        channel: message.channel || this.config.defaultChannel,
        text: message.text,
        blocks: message.blocks,
        thread_ts: message.thread_ts,
        ...message,
      });

      return result;
    } catch (error) {
      logger.error('Failed to send Slack message:', error);
      throw error;
    }
  }

  /**
   * Parse command parameters from text
   * @param {string} text - Command text
   * @returns {Object} Parsed parameters
   */
  parseCommandParams(text) {
    const params = {};
    if (!text) return params;

    // Parse key=value pairs
    const pairs = text.split(' ');
    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key && value) {
        params[key] = value;
      }
    }

    return params;
  }

  /**
   * Generate WebSocket URL with parameters
   * @param {Object} params - URL parameters
   * @returns {string} WebSocket URL
   */
  generateWebSocketUrl(params) {
    const baseUrl = process.env.NODE_ENV === 'production'
      ? `wss://${process.env.VERCEL_URL || process.env.ELESTIO_URL}`
      : 'ws://localhost:3000';
    
    const queryParams = new URLSearchParams(params).toString();
    return `${baseUrl}/ws?${queryParams}`;
  }

  /**
   * Validate incoming Slack request
   * @param {Object} req - Express request object
   * @returns {boolean} Validation result
   */
  validateRequest(req) {
    return validateSlackSignature(
      req.headers['x-slack-signature'],
      req.headers['x-slack-request-timestamp'],
      req.body,
      this.config.signingSecret
    );
  }

  /**
   * Stop transcription session
   */
  async handleStopTranscription(sessionId, responseUrl) {
    // This would integrate with Deepgram service to stop session
    logger.info(`Stopping transcription session: ${sessionId}`);
  }

  /**
   * Get session status
   */
  async handleGetSessionStatus(sessionId, responseUrl) {
    // This would integrate with Deepgram service to get session status
    logger.info(`Getting status for session: ${sessionId}`);
  }
}

// Singleton instance
let slackService = null;

/**
 * Initialize Slack service
 * @returns {SlackService} Service instance
 */
async function initializeSlack() {
  if (!slackService) {
    slackService = new SlackService();
    await slackService.initialize();
  }
  return slackService;
}

/**
 * Get Slack service instance
 * @returns {SlackService} Service instance
 */
function getSlackService() {
  return slackService;
}

module.exports = {
  SlackService,
  initializeSlack,
  getSlackService,
};
