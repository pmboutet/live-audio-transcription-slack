/**
 * Validation utilities for audio files and streams
 * Provides comprehensive validation for audio data and parameters
 */

const { logger } = require('./logger');

/**
 * Validate audio file upload
 * @param {Object} file - Multer file object
 * @returns {Object} Validation result
 */
function validateAudioFile(file) {
  const errors = [];
  
  if (!file) {
    errors.push('No file provided');
    return { isValid: false, errors };
  }
  
  // Check file size
  const maxSize = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB default
  if (file.size > maxSize) {
    errors.push(`File too large: ${Math.round(file.size / 1024 / 1024)}MB (max: ${Math.round(maxSize / 1024 / 1024)}MB)`);
  }
  
  if (file.size < 1024) { // 1KB minimum
    errors.push('File too small: minimum 1KB required');
  }
  
  // Check MIME type
  const supportedFormats = (process.env.SUPPORTED_FORMATS || 'wav,mp3,m4a,flac').split(',');
  const allowedMimeTypes = supportedFormats.map(format => {
    switch (format.toLowerCase()) {
      case 'wav': return 'audio/wav';
      case 'mp3': return 'audio/mpeg';
      case 'm4a': return 'audio/m4a';
      case 'flac': return 'audio/flac';
      case 'ogg': return 'audio/ogg';
      default: return `audio/${format}`;
    }
  });
  
  if (!allowedMimeTypes.includes(file.mimetype)) {
    errors.push(`Unsupported audio format: ${file.mimetype}. Supported: ${allowedMimeTypes.join(', ')}`);
  }
  
  // Check filename
  if (!file.originalname || file.originalname.length > 255) {
    errors.push('Invalid filename');
  }
  
  // Check for dangerous filename patterns
  const dangerousPatterns = [
    /\.\.[\/\\]/, // Path traversal
    /[<>:"|?*]/, // Invalid chars
    /^\.|\.$/, // Hidden files or ending with dot
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(file.originalname)) {
      errors.push('Invalid filename format');
      break;
    }
  }
  
  // Basic audio file validation
  if (file.buffer) {
    const validation = validateAudioBuffer(file.buffer);
    if (!validation.isValid) {
      errors.push(...validation.errors);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate audio buffer content
 * @param {Buffer} buffer - Audio buffer
 * @returns {Object} Validation result
 */
function validateAudioBuffer(buffer) {
  const errors = [];
  
  if (!Buffer.isBuffer(buffer)) {
    errors.push('Invalid audio buffer');
    return { isValid: false, errors };
  }
  
  if (buffer.length === 0) {
    errors.push('Empty audio buffer');
    return { isValid: false, errors };
  }
  
  // Check for common audio file headers
  const headers = {
    wav: [0x52, 0x49, 0x46, 0x46], // 'RIFF'
    mp3: [0xFF, 0xFB], // MP3 frame sync
    mp3_alt: [0xFF, 0xFA], // MP3 frame sync alternative
    flac: [0x66, 0x4C, 0x61, 0x43], // 'fLaC'
    ogg: [0x4F, 0x67, 0x67, 0x53], // 'OggS'
  };
  
  let validHeader = false;
  for (const [format, header] of Object.entries(headers)) {
    if (buffer.length >= header.length) {
      const match = header.every((byte, index) => buffer[index] === byte);
      if (match) {
        validHeader = true;
        break;
      }
    }
  }
  
  // For MP4/M4A, check for ftyp box
  if (!validHeader && buffer.length >= 8) {
    const ftyp = buffer.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') {
      validHeader = true;
    }
  }
  
  if (!validHeader) {
    errors.push('Invalid audio file format or corrupted header');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate audio stream chunk
 * @param {Buffer} chunk - Audio data chunk
 * @param {Object} options - Validation options
 * @returns {Object} Validation result
 */
function validateAudioStream(chunk, options = {}) {
  const {
    maxChunkSize = 8192,
    minChunkSize = 160,
    allowEmpty = false,
  } = options;
  
  const errors = [];
  
  if (!Buffer.isBuffer(chunk)) {
    errors.push('Invalid chunk format: expected Buffer');
    return { isValid: false, errors };
  }
  
  if (chunk.length === 0 && !allowEmpty) {
    errors.push('Empty audio chunk');
    return { isValid: false, errors };
  }
  
  if (chunk.length > maxChunkSize) {
    errors.push(`Chunk too large: ${chunk.length} bytes (max: ${maxChunkSize})`);
  }
  
  if (chunk.length < minChunkSize && chunk.length > 0) {
    errors.push(`Chunk too small: ${chunk.length} bytes (min: ${minChunkSize})`);
  }
  
  // Check for null or corrupted data
  if (chunk.length > 0) {
    const nonZeroBytes = chunk.filter(byte => byte !== 0).length;
    const silenceRatio = 1 - (nonZeroBytes / chunk.length);
    
    if (silenceRatio > 0.95) {
      logger.debug('High silence ratio detected in audio chunk', { silenceRatio });
      // Don't treat as error, just log
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate transcription parameters
 * @param {Object} params - Transcription parameters
 * @returns {Object} Validation result
 */
function validateTranscriptionParams(params) {
  const errors = [];
  
  // Validate language code
  if (params.language) {
    const validLanguages = [
      'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'en-NZ', 'en-ZA',
      'es-ES', 'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-PE', 'es-VE',
      'fr-FR', 'fr-CA',
      'de-DE', 'de-AT', 'de-CH',
      'it-IT',
      'pt-BR', 'pt-PT',
      'nl-NL', 'nl-BE',
      'ja-JP',
      'ko-KR',
      'zh-CN', 'zh-TW',
      'ru-RU',
      'ar-SA',
      'hi-IN',
      'tr-TR',
      'sv-SE',
      'da-DK',
      'no-NO',
      'fi-FI',
      'pl-PL',
      'cs-CZ',
      'sk-SK',
      'hu-HU',
      'ro-RO',
      'bg-BG',
      'hr-HR',
      'sl-SI',
      'et-EE',
      'lv-LV',
      'lt-LT',
      'mt-MT',
      'el-GR',
      'cy-GB',
      'ga-IE',
    ];
    
    if (!validLanguages.includes(params.language)) {
      errors.push(`Unsupported language: ${params.language}`);
    }
  }
  
  // Validate model
  if (params.model) {
    const validModels = ['nova-2', 'nova', 'enhanced', 'base', 'whisper'];
    if (!validModels.includes(params.model)) {
      errors.push(`Unsupported model: ${params.model}`);
    }
  }
  
  // Validate channel format
  if (params.channel) {
    if (typeof params.channel !== 'string') {
      errors.push('Channel must be a string');
    } else if (!params.channel.match(/^[#@]?[a-zA-Z0-9_-]+$/)) {
      errors.push('Invalid channel format');
    }
  }
  
  // Validate session ID
  if (params.session) {
    if (typeof params.session !== 'string') {
      errors.push('Session ID must be a string');
    } else if (params.session.length > 100 || params.session.length < 3) {
      errors.push('Session ID must be between 3 and 100 characters');
    } else if (!params.session.match(/^[a-zA-Z0-9_-]+$/)) {
      errors.push('Session ID contains invalid characters');
    }
  }
  
  // Validate conversation ID
  if (params.conversation) {
    if (typeof params.conversation !== 'string') {
      errors.push('Conversation ID must be a string');
    } else if (params.conversation.length > 100) {
      errors.push('Conversation ID too long (max 100 characters)');
    } else if (!params.conversation.match(/^[a-zA-Z0-9_-]+$/)) {
      errors.push('Conversation ID contains invalid characters');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate WebSocket connection parameters
 * @param {Object} params - Connection parameters
 * @returns {Object} Validation result
 */
function validateWebSocketParams(params) {
  const errors = [];
  
  // Required parameters
  if (!params.channel) {
    errors.push('Channel parameter is required');
  }
  
  if (!params.session) {
    errors.push('Session parameter is required');
  }
  
  // Validate all parameters using transcription validation
  const transcriptionValidation = validateTranscriptionParams(params);
  if (!transcriptionValidation.isValid) {
    errors.push(...transcriptionValidation.errors);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate Slack message content
 * @param {Object} message - Slack message object
 * @returns {Object} Validation result
 */
function validateSlackMessage(message) {
  const errors = [];
  
  if (!message.channel) {
    errors.push('Channel is required');
  }
  
  if (!message.text && !message.blocks) {
    errors.push('Either text or blocks is required');
  }
  
  if (message.text && message.text.length > 4000) {
    errors.push('Message text too long (max 4000 characters)');
  }
  
  if (message.blocks && !Array.isArray(message.blocks)) {
    errors.push('Blocks must be an array');
  }
  
  if (message.blocks && message.blocks.length > 50) {
    errors.push('Too many blocks (max 50)');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate environment configuration
 * @param {Object} env - Environment variables
 * @returns {Object} Validation result
 */
function validateEnvironmentConfig(env) {
  const errors = [];
  const required = [
    'DEEPGRAM_API_KEY',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    'JWT_SECRET',
  ];
  
  for (const key of required) {
    if (!env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }
  
  // Validate token formats
  if (env.SLACK_BOT_TOKEN && !env.SLACK_BOT_TOKEN.startsWith('xoxb-')) {
    errors.push('Invalid Slack bot token format');
  }
  
  if (env.SLACK_APP_TOKEN && !env.SLACK_APP_TOKEN.startsWith('xapp-')) {
    errors.push('Invalid Slack app token format');
  }
  
  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
    errors.push('JWT secret too short (minimum 32 characters)');
  }
  
  // Validate numeric values
  if (env.PORT && (isNaN(env.PORT) || parseInt(env.PORT) < 1 || parseInt(env.PORT) > 65535)) {
    errors.push('Invalid port number');
  }
  
  if (env.MAX_AUDIO_DURATION && (isNaN(env.MAX_AUDIO_DURATION) || parseInt(env.MAX_AUDIO_DURATION) < 1)) {
    errors.push('Invalid max audio duration');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

module.exports = {
  validateAudioFile,
  validateAudioBuffer,
  validateAudioStream,
  validateTranscriptionParams,
  validateWebSocketParams,
  validateSlackMessage,
  validateEnvironmentConfig,
};
