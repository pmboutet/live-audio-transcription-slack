/**
 * API routes configuration
 * Defines all REST API endpoints for the transcription service
 */

const express = require('express');
const transcriptionRoutes = require('./transcription');
const slackRoutes = require('./slack');
const statusRoutes = require('./status');
const { authMiddleware } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validation');
const { errorHandler } = require('../middleware/error-handler');

/**
 * Setup all API routes
 * @param {express.Application} app - Express application
 */
function setupRoutes(app) {
  // API base route
  const apiRouter = express.Router();
  
  // Add request validation middleware
  apiRouter.use(validateRequest);
  
  // Health check (no auth required)
  apiRouter.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
    });
  });
  
  // Public routes
  apiRouter.use('/slack', slackRoutes);
  apiRouter.use('/status', statusRoutes);
  
  // Protected routes (require authentication)
  apiRouter.use('/transcription', authMiddleware, transcriptionRoutes);
  
  // Mount API router
  app.use('/api', apiRouter);
  
  // Error handling middleware
  app.use(errorHandler);
}

module.exports = {
  setupRoutes,
};
