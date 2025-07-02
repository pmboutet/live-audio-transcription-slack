/**
 * Status and monitoring routes
 * Provides system health and metrics endpoints
 */

const express = require('express');
const { createDeepgramService } = require('../services/deepgram-service');
const { getSlackService } = require('../services/slack-service');
const { logger } = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/status
 * Get overall system status
 */
router.get('/', async (req, res) => {
  try {
    const status = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      services: {},
      system: {
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        platform: process.platform,
        nodeVersion: process.version,
      },
    };

    // Check Deepgram service
    try {
      const deepgramService = createDeepgramService();
      const connectionStats = deepgramService.getConnectionStats();
      
      status.services.deepgram = {
        status: 'healthy',
        activeConnections: connectionStats.activeConnections,
        totalConnections: connectionStats.connections.length,
      };
    } catch (error) {
      status.services.deepgram = {
        status: 'unhealthy',
        error: error.message,
      };
    }

    // Check Slack service
    try {
      const slackService = getSlackService();
      status.services.slack = {
        status: slackService && slackService.isInitialized ? 'healthy' : 'initializing',
        connected: !!slackService,
      };
    } catch (error) {
      status.services.slack = {
        status: 'unhealthy',
        error: error.message,
      };
    }

    // Determine overall health
    const allServicesHealthy = Object.values(status.services)
      .every(service => service.status === 'healthy');
    
    status.health = allServicesHealthy ? 'healthy' : 'degraded';

    res.json(status);

  } catch (error) {
    logger.error('Error getting system status:', error);
    res.status(500).json({
      error: 'Failed to get system status',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/status/deepgram
 * Get Deepgram service status
 */
router.get('/deepgram', async (req, res) => {
  try {
    const deepgramService = createDeepgramService();
    const stats = deepgramService.getConnectionStats();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      statistics: stats,
      configuration: {
        maxConnections: 100, // This could be configurable
        supportedLanguages: ['en-US', 'en-GB', 'fr-FR', 'es-ES', 'de-DE'],
        supportedModels: ['nova-2', 'nova', 'enhanced', 'base'],
      },
    });

  } catch (error) {
    logger.error('Error getting Deepgram status:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/status/slack
 * Get Slack service status
 */
router.get('/slack', async (req, res) => {
  try {
    const slackService = getSlackService();
    
    if (!slackService) {
      return res.status(503).json({
        status: 'unavailable',
        message: 'Slack service not initialized',
        timestamp: new Date().toISOString(),
      });
    }

    // Test Slack connection
    try {
      const authTest = await slackService.webClient.auth.test();
      
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        connection: {
          team: authTest.team,
          user: authTest.user,
          userId: authTest.user_id,
          teamId: authTest.team_id,
          url: authTest.url,
        },
        features: {
          socketMode: slackService.socketClient ? 'enabled' : 'disabled',
          webhooks: 'enabled',
          slashCommands: 'enabled',
          interactiveComponents: 'enabled',
        },
      });
      
    } catch (authError) {
      res.status(503).json({
        status: 'unhealthy',
        error: 'Authentication failed',
        details: authError.message,
        timestamp: new Date().toISOString(),
      });
    }

  } catch (error) {
    logger.error('Error getting Slack status:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/status/metrics
 * Get detailed system metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const deepgramService = createDeepgramService();
    const connectionStats = deepgramService.getConnectionStats();
    
    const metrics = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        ...process.memoryUsage(),
        usage: {
          heap: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100),
          rss: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100, // MB
        },
      },
      cpu: process.cpuUsage(),
      connections: {
        active: connectionStats.activeConnections,
        total: connectionStats.connections.length,
        distribution: connectionStats.connections.reduce((acc, conn) => {
          const channel = conn.slackChannel || 'unknown';
          acc[channel] = (acc[channel] || 0) + 1;
          return acc;
        }, {}),
      },
      transcription: {
        sessionsToday: 0, // This would be tracked in a real implementation
        totalMessages: 0, // This would be tracked in a real implementation
        averageConfidence: 0, // This would be calculated from recent transcriptions
      },
      errors: {
        rate: 0, // Error rate per hour
        recent: [], // Recent errors (last 10)
      },
    };

    res.json(metrics);

  } catch (error) {
    logger.error('Error getting metrics:', error);
    res.status(500).json({
      error: 'Failed to get metrics',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/status/live
 * Server-Sent Events endpoint for live status updates
 */
router.get('/live', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial status
  const sendStatus = async () => {
    try {
      const deepgramService = createDeepgramService();
      const stats = deepgramService.getConnectionStats();
      
      const status = {
        timestamp: new Date().toISOString(),
        activeConnections: stats.activeConnections,
        totalConnections: stats.connections.length,
        memory: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100),
        uptime: process.uptime(),
      };
      
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message, timestamp: new Date().toISOString() })}\n\n`);
    }
  };

  // Send initial status
  sendStatus();

  // Send updates every 5 seconds
  const interval = setInterval(sendStatus, 5000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });

  req.on('aborted', () => {
    clearInterval(interval);
    res.end();
  });
});

module.exports = router;
