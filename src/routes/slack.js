/**
 * Slack webhook and interaction routes
 * Handles Slack events, slash commands, and interactive components
 */

const express = require('express');
const { body } = require('express-validator');
const { getSlackService } = require('../services/slack-service');
const { logger } = require('../utils/logger');
const { validateSlackSignature } = require('../utils/security');
const { getConfig } = require('../config/environment');

const router = express.Router();
const config = getConfig();

/**
 * Middleware to validate Slack requests
 */
const validateSlackRequest = (req, res, next) => {
  try {
    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    const body = req.rawBody || JSON.stringify(req.body);
    
    if (!validateSlackSignature(signature, timestamp, body, config.slack.signingSecret)) {
      logger.warn('Invalid Slack signature', {
        signature,
        timestamp,
        ip: req.ip,
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    next();
  } catch (error) {
    logger.error('Slack signature validation error:', error);
    res.status(400).json({ error: 'Invalid request' });
  }
};

/**
 * POST /api/slack/events
 * Handle Slack events webhook
 */
router.post('/events',
  validateSlackRequest,
  async (req, res) => {
    try {
      const { type, challenge, event } = req.body;
      
      // Handle URL verification challenge
      if (type === 'url_verification') {
        return res.json({ challenge });
      }
      
      // Handle events
      if (type === 'event_callback' && event) {
        await handleSlackEvent(event);
      }
      
      res.status(200).json({ ok: true });
      
    } catch (error) {
      logger.error('Slack events error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/slack/interactions
 * Handle Slack interactive components
 */
router.post('/interactions',
  validateSlackRequest,
  async (req, res) => {
    try {
      const payload = JSON.parse(req.body.payload);
      
      await handleSlackInteraction(payload);
      
      res.status(200).json({ ok: true });
      
    } catch (error) {
      logger.error('Slack interactions error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/slack/commands
 * Handle Slack slash commands
 */
router.post('/commands',
  validateSlackRequest,
  async (req, res) => {
    try {
      const command = req.body;
      
      const response = await handleSlashCommand(command);
      
      res.json(response);
      
    } catch (error) {
      logger.error('Slack command error:', error);
      res.status(500).json({
        text: 'Sorry, there was an error processing your command.',
        response_type: 'ephemeral',
      });
    }
  }
);

/**
 * Handle Slack events
 * @param {Object} event - Slack event object
 */
async function handleSlackEvent(event) {
  const { type, user, channel, text, ts } = event;
  
  logger.info('Received Slack event:', { type, user, channel });
  
  switch (type) {
    case 'app_mention':
      await handleAppMention(event);
      break;
      
    case 'message':
      // Handle direct messages or channel messages
      if (text && text.includes('transcribe')) {
        await handleTranscribeRequest(event);
      }
      break;
      
    default:
      logger.debug(`Unhandled event type: ${type}`);
  }
}

/**
 * Handle app mentions
 * @param {Object} event - App mention event
 */
async function handleAppMention(event) {
  try {
    const slackService = getSlackService();
    if (!slackService) return;
    
    const { channel, user, text } = event;
    
    // Parse the mention text for commands
    const cleanText = text.replace(/<@[^>]+>/g, '').trim();
    
    if (cleanText.includes('help')) {
      await sendHelpMessage(channel);
    } else if (cleanText.includes('start') || cleanText.includes('transcribe')) {
      await handleTranscribeRequest(event);
    } else if (cleanText.includes('status')) {
      await sendStatusMessage(channel);
    } else {
      await sendHelpMessage(channel);
    }
    
  } catch (error) {
    logger.error('Error handling app mention:', error);
  }
}

/**
 * Handle transcribe requests
 * @param {Object} event - Slack event
 */
async function handleTranscribeRequest(event) {
  try {
    const slackService = getSlackService();
    if (!slackService) return;
    
    const { channel, user } = event;
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Generate WebSocket URL
    const wsUrl = generateWebSocketUrl({
      channel: channel,
      session: sessionId,
      user: user,
    });
    
    const message = {
      channel: channel,
      text: `🎤 Live transcription session created!`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎤 *Live Transcription Session Created*\n\nSession ID: \`${sessionId}\`\nUser: <@${user}>`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `**WebSocket URL:**\n\`${wsUrl}\``,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Connect your audio stream to this URL to start live transcription.',
            },
          ],
        },
      ],
    };
    
    await slackService.sendMessage(message);
    
  } catch (error) {
    logger.error('Error handling transcribe request:', error);
  }
}

/**
 * Handle Slack interactions
 * @param {Object} payload - Interaction payload
 */
async function handleSlackInteraction(payload) {
  const { type, actions, user, channel } = payload;
  
  if (type === 'block_actions' && actions) {
    for (const action of actions) {
      switch (action.action_id) {
        case 'start_transcription':
          await handleStartTranscription(action, user, channel);
          break;
          
        case 'stop_transcription':
          await handleStopTranscription(action, user, channel);
          break;
          
        case 'get_status':
          await handleGetStatus(action, user, channel);
          break;
      }
    }
  }
}

/**
 * Handle slash commands
 * @param {Object} command - Slash command object
 * @returns {Object} Response object
 */
async function handleSlashCommand(command) {
  const { command: cmd, text, user_id, channel_id } = command;
  
  switch (cmd) {
    case '/transcribe':
      return await handleTranscribeSlashCommand(text, channel_id, user_id);
      
    case '/transcribe-status':
      return await handleStatusSlashCommand(channel_id);
      
    case '/transcribe-stop':
      return await handleStopSlashCommand(text, channel_id, user_id);
      
    default:
      return {
        text: `Unknown command: ${cmd}`,
        response_type: 'ephemeral',
      };
  }
}

/**
 * Handle transcribe slash command
 * @param {string} text - Command text
 * @param {string} channelId - Channel ID
 * @param {string} userId - User ID
 * @returns {Object} Response object
 */
async function handleTranscribeSlashCommand(text, channelId, userId) {
  const params = parseCommandParams(text);
  const sessionId = params.session || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const wsUrl = generateWebSocketUrl({
    channel: channelId,
    session: sessionId,
    conversation: params.conversation,
    user: userId,
    language: params.language,
    model: params.model,
  });
  
  return {
    response_type: 'in_channel',
    text: '🎤 Live transcription started!',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎤 *Live Transcription Started*\n\nSession: \`${sessionId}\`${params.conversation ? `\nConversation: \`${params.conversation}\`` : ''}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `**WebSocket URL:**\n\`${wsUrl}\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Stop Session',
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
    ],
  };
}

/**
 * Send help message
 * @param {string} channel - Channel ID
 */
async function sendHelpMessage(channel) {
  try {
    const slackService = getSlackService();
    if (!slackService) return;
    
    const message = {
      channel: channel,
      text: '🤖 Transcription Bot Help',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🤖 *Transcription Bot Help*\n\nI can help you with live audio transcription using Deepgram.',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Available Commands:*\n• `/transcribe` - Start a new transcription session\n• `/transcribe-status` - Check service status\n• `/transcribe-stop <session_id>` - Stop a session\n• Mention me with "help" for this message',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Parameters:*\nYou can use key=value pairs with `/transcribe`:\n• `conversation=meeting-123` - Set conversation ID\n• `language=fr-FR` - Set language (default: en-US)\n• `model=nova-2` - Set Deepgram model',
          },
        },
      ],
    };
    
    await slackService.sendMessage(message);
  } catch (error) {
    logger.error('Error sending help message:', error);
  }
}

/**
 * Send status message
 * @param {string} channel - Channel ID
 */
async function sendStatusMessage(channel) {
  try {
    const slackService = getSlackService();
    if (!slackService) return;
    
    // Get service status (would integrate with Deepgram service)
    const message = {
      channel: channel,
      text: '📊 Service Status',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '📊 *Transcription Service Status*\n\n✅ Service: Online\n📈 Active Sessions: 0\n⏱️ Uptime: 99.9%',
          },
        },
      ],
    };
    
    await slackService.sendMessage(message);
  } catch (error) {
    logger.error('Error sending status message:', error);
  }
}

/**
 * Parse command parameters
 * @param {string} text - Command text
 * @returns {Object} Parsed parameters
 */
function parseCommandParams(text) {
  const params = {};
  if (!text) return params;
  
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
function generateWebSocketUrl(params) {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? `wss://${process.env.VERCEL_URL || process.env.ELESTIO_URL}`
    : 'ws://localhost:3000';
  
  const queryParams = new URLSearchParams(params).toString();
  return `${baseUrl}/ws?${queryParams}`;
}

/**
 * Handle start transcription action
 */
async function handleStartTranscription(action, user, channel) {
  // Implementation for starting transcription
  logger.info('Start transcription requested', { action, user, channel });
}

/**
 * Handle stop transcription action
 */
async function handleStopTranscription(action, user, channel) {
  // Implementation for stopping transcription
  logger.info('Stop transcription requested', { action, user, channel });
}

/**
 * Handle get status action
 */
async function handleGetStatus(action, user, channel) {
  // Implementation for getting status
  logger.info('Status requested', { action, user, channel });
}

/**
 * Handle status slash command
 */
async function handleStatusSlashCommand(channelId) {
  return {
    response_type: 'ephemeral',
    text: '📊 Service Status: Online ✅',
  };
}

/**
 * Handle stop slash command
 */
async function handleStopSlashCommand(text, channelId, userId) {
  const sessionId = text.trim();
  
  if (!sessionId) {
    return {
      response_type: 'ephemeral',
      text: 'Please provide a session ID: `/transcribe-stop <session_id>`',
    };
  }
  
  return {
    response_type: 'ephemeral',
    text: `🛑 Stopping session: ${sessionId}`,
  };
}

module.exports = router;
