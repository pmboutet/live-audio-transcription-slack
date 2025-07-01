/**
 * Environment configuration and validation
 * Ensures all required environment variables are present and valid
 */

const Joi = require('joi');
require('dotenv').config();

// Environment schema validation
const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  
  // Deepgram configuration
  DEEPGRAM_API_KEY: Joi.string().required(),
  
  // Slack configuration
  SLACK_BOT_TOKEN: Joi.string().pattern(/^xoxb-/).required(),
  SLACK_APP_TOKEN: Joi.string().pattern(/^xapp-/).required(),
  SLACK_SIGNING_SECRET: Joi.string().required(),
  
  // Security
  JWT_SECRET: Joi.string().min(32).required(),
  API_RATE_LIMIT: Joi.number().default(100),
  
  // Audio processing
  MAX_AUDIO_DURATION: Joi.number().default(300),
  MAX_FILE_SIZE: Joi.string().default('50MB'),
  SUPPORTED_FORMATS: Joi.string().default('wav,mp3,m4a,flac'),
  
  // Slack settings
  DEFAULT_CHANNEL: Joi.string().default('#transcriptions'),
  MAX_MESSAGE_LENGTH: Joi.number().default(4000),
  TRANSCRIPTION_THREAD: Joi.boolean().default(true),
  
  // Optional configurations
  REDIS_URL: Joi.string().uri().optional(),
  VERCEL_URL: Joi.string().uri().optional(),
  ELESTIO_URL: Joi.string().uri().optional(),
}).unknown();

/**
 * Validates environment variables against schema
 * @throws {Error} If validation fails
 */
function validateEnvironment() {
  const { error, value } = envSchema.validate(process.env);
  
  if (error) {
    throw new Error(`Environment validation failed: ${error.details.map(x => x.message).join(', ')}`);
  }
  
  // Override process.env with validated values
  Object.assign(process.env, value);
  
  return value;
}

/**
 * Get environment configuration
 * @returns {Object} Validated environment configuration
 */
function getConfig() {
  return {
    app: {
      env: process.env.NODE_ENV,
      port: parseInt(process.env.PORT),
      rateLimit: parseInt(process.env.API_RATE_LIMIT),
    },
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY,
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      defaultChannel: process.env.DEFAULT_CHANNEL,
      maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH),
      useThreads: process.env.TRANSCRIPTION_THREAD === 'true',
    },
    audio: {
      maxDuration: parseInt(process.env.MAX_AUDIO_DURATION),
      maxFileSize: process.env.MAX_FILE_SIZE,
      supportedFormats: process.env.SUPPORTED_FORMATS.split(','),
    },
    security: {
      jwtSecret: process.env.JWT_SECRET,
    },
    redis: {
      url: process.env.REDIS_URL,
    },
  };
}

module.exports = {
  validateEnvironment,
  getConfig,
};
