/**
 * Authentication validation utilities
 * @module utils/auth_validation
 */

const { isArticleUrl } = require('./url_patterns');

/**
 * Validates authentication requirements before processing
 * FIXED: Check for AUTH_TOKEN before attempting article URL processing
 * 
 * @param {Object} params - Processing parameters
 * @param {string} params.url - URL to process
 * @param {string} params.authToken - Available auth token (or null)
 * @returns {Object} - Validation result with canProceed flag
 */
function validateAuthRequirements({ url, authToken }) {
  const urlIsArticle = isArticleUrl(url);
  
  // FIXED: Add case for article URL without AUTH_TOKEN before other strategies
  if (urlIsArticle && !authToken) {
    return {
      canProceed: false,
      error: 'AUTH_TOKEN_REQUIRED',
      message: `Article URLs require AUTH_TOKEN for processing. URL: "${url}"`,
      suggestion: 'Set the X_AUTH_TOKEN environment variable or GitHub secret. ' +
                  'You can obtain an auth token from your Twitter/X browser session ' +
                  '(look for the "auth_token" cookie).',
      urlType: 'article',
      requiresAuth: true
    };
  }
  
  // Tweet URLs can proceed without auth (public tweets)
  if (!urlIsArticle) {
    return {
      canProceed: true,
      warning: authToken 
        ? null 
        : 'No AUTH_TOKEN provided. Protected tweets may not be accessible.',
      urlType: 'tweet',
      requiresAuth: false
    };
  }
  
  // Article URL with auth token
  return {
    canProceed: true,
    urlType: 'article',
    requiresAuth: true,
    hasAuth: true
  };
}

/**
 * Validates that a string is a non-empty auth token
 * 
 * @param {string} token - Token to validate
 * @returns {boolean}
 */
function isValidAuthToken(token) {
  return typeof token === 'string' && token.length > 0;
}

/**
 * Gets auth token from environment with validation
 * 
 * @returns {string|null} - Valid auth token or null
 */
function getAuthToken() {
  const token = process.env.X_AUTH_TOKEN || process.env.AUTH_TOKEN || '';
  return isValidAuthToken(token) ? token : null;
}

module.exports = {
  validateAuthRequirements,
  isValidAuthToken,
  getAuthToken
};
