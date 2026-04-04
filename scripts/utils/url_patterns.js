/**
 * URL pattern matching utilities with strict validation
 * @module utils/url_patterns
 */

/**
 * Strict regex for matching Twitter/X tweet URLs
 * FIXED: Proper anchoring to prevent partial matches and injection
 * FIXED: Handle query parameters and fragments
 * 
 * Matches:
 * - https://twitter.com/username/status/123456789
 * - https://x.com/username/status/123456789
 * - https://www.twitter.com/username/status/123456789
 * - https://www.x.com/username/status/123456789
 * - https://mobile.twitter.com/username/status/123456789
 * 
 * @type {RegExp}
 */
const TWEET_URL_REGEX = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w{1,15}\/status\/(\d{1,19})(?:\/|[?#]|$)/;

/**
 * Strict regex for matching Twitter/X article URLs
 * FIXED: Handle query parameters and fragments
 * 
 * Matches:
 * - https://twitter.com/i/article/123456789
 * - https://x.com/i/article/123456789
 * - https://mobile.twitter.com/i/article/123456789
 * - https://mobile.x.com/i/article/123456789
 * - https://www.twitter.com/i/article/123456789
 * 
 * @type {RegExp}
 */
const ARTICLE_URL_REGEX = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/i\/article\/(\d{1,19})(?:\/|[?#]|$)/;

/**
 * Combined regex for any Twitter/X content URL
 * @type {RegExp}
 */
const CONTENT_URL_REGEX = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:\w{1,15}\/status|i\/article)\/(\d{1,19})\/?$/;

/**
 * Validates and extracts ID from a tweet URL
 * 
 * @param {string} url - URL to validate
 * @returns {{valid: boolean, id: string|null, type: string|null}}
 */
function parseTweetUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, id: null, type: null };
  }
  
  // Check for tweet URL
  const tweetMatch = url.match(TWEET_URL_REGEX);
  if (tweetMatch) {
    return { 
      valid: true, 
      id: tweetMatch[1], 
      type: 'tweet',
      url: url 
    };
  }
  
  // Check for article URL
  const articleMatch = url.match(ARTICLE_URL_REGEX);
  if (articleMatch) {
    return { 
      valid: true, 
      id: articleMatch[1], 
      type: 'article',
      url: url 
    };
  }
  
  return { valid: false, id: null, type: null };
}

/**
 * Validates if a URL is a valid Twitter/X URL
 * 
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
function isValidTwitterUrl(url) {
  return parseTweetUrl(url).valid;
}

/**
 * Validates if a URL is a Twitter/X article URL
 * 
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
function isArticleUrl(url) {
  const parsed = parseTweetUrl(url);
  return parsed.valid && parsed.type === 'article';
}

/**
 * Validates if a URL is a Twitter/X tweet URL
 * 
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
function isTweetUrl(url) {
  const parsed = parseTweetUrl(url);
  return parsed.valid && parsed.type === 'tweet';
}

/**
 * Extracts the content ID from a Twitter/X URL
 * 
 * @param {string} url - URL to extract ID from
 * @returns {string|null} - The content ID or null if invalid
 */
function extractContentId(url) {
  const parsed = parseTweetUrl(url);
  return parsed.valid ? parsed.id : null;
}

/**
 * Creates a synthetic ID for article URLs without parent tweets
 * 
 * @param {string} articleId - The article ID
 * @returns {string} - Synthetic ID in format "article-{id}"
 */
function createSyntheticId(articleId) {
  return articleId ? `article-${articleId}` : `article-${Date.now()}`;
}

/**
 * Extracts and validates content ID from URL with detailed error handling
 * FIXED: Null/undefined input handling with actionable error messages
 * 
 * @param {string} url - URL to extract from
 * @returns {Object} - Result with id, type, and error info
 * @throws {Error} - If URL is invalid, null, or undefined
 */
function extractAndValidateContentId(url) {
  // FIXED: Explicit null/undefined check
  if (url == null) {
    throw new Error('URL is required but was null or undefined');
  }
  
  if (typeof url !== 'string') {
    throw new Error(`URL must be a string, got ${typeof url}`);
  }
  
  const trimmedUrl = url.trim();
  
  if (trimmedUrl.length === 0) {
    throw new Error('URL is empty after trimming whitespace');
  }
  
  const parsed = parseTweetUrl(trimmedUrl);
  
  if (!parsed.valid) {
    // FIXED: Actionable error message with examples
    throw new Error(
      `Invalid URL format: "${trimmedUrl.substring(0, 100)}"\n\n` +
      `Expected formats:\n` +
      `  - Tweet: https://x.com/username/status/123456789\n` +
      `  - Tweet: https://twitter.com/username/status/123456789\n` +
      `  - Article: https://x.com/i/article/123456789\n` +
      `  - Article: https://twitter.com/i/article/123456789\n\n` +
      `Note: Query parameters (like ?s=20) are allowed.`
    );
  }
  
  return {
    id: parsed.id,
    type: parsed.type,
    isArticle: parsed.type === 'article',
    originalUrl: trimmedUrl
  };
}

module.exports = {
  TWEET_URL_REGEX,
  ARTICLE_URL_REGEX,
  CONTENT_URL_REGEX,
  parseTweetUrl,
  isValidTwitterUrl,
  isArticleUrl,
  isTweetUrl,
  extractContentId,
  createSyntheticId,
  extractAndValidateContentId
};
