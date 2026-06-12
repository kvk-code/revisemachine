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

// ─── Generic Web Page URLs ──────────────────────────────────────────────────

/**
 * Tracking query parameters stripped during URL normalization so the same
 * page shared through different channels maps to one page_id
 * @type {RegExp}
 */
const TRACKING_PARAM_REGEX = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|msclkid|igshid|mc_cid|mc_eid|ref_src|ref_url|cmpid|s_kwcid|twclid)$/i;

/**
 * Hostnames and IP ranges that must never be fetched by the archiver.
 * The workflow runs on user-supplied URLs, so loopback/link-local/private
 * targets are rejected outright.
 * @type {RegExp[]}
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?f[cd][0-9a-f]{2}:/i
];

/**
 * Validates and normalizes a generic web page URL.
 *
 * Rules:
 * - Scheme must be http or https (rejects file:, javascript:, data:, ftp:)
 * - Loopback / private / link-local hosts are rejected
 * - Twitter/X content URLs are rejected with a hint to use the tweet pipeline
 * - Tracking parameters (utm_*, fbclid, ...) and fragments are stripped
 * - Host is lowercased
 *
 * @param {string} url - URL to validate
 * @returns {{valid: boolean, normalizedUrl: string|null, host: string|null, error: string|null}}
 */
function parseWebUrl(url) {
  if (url == null || typeof url !== 'string' || url.trim().length === 0) {
    return { valid: false, normalizedUrl: null, host: null, error: 'URL is required' };
  }

  const trimmed = url.trim();

  if (parseTweetUrl(trimmed).valid) {
    return {
      valid: false, normalizedUrl: null, host: null,
      error: 'This is a Twitter/X URL — use the tweet pipeline (save-tweet) instead'
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return { valid: false, normalizedUrl: null, host: null, error: `Not a valid URL: ${e.message}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false, normalizedUrl: null, host: null,
      error: `Unsupported scheme "${parsed.protocol}" — only http and https are allowed`
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST_PATTERNS.some(p => p.test(host))) {
    return {
      valid: false, normalizedUrl: null, host: null,
      error: `Host "${host}" is loopback/private and cannot be archived`
    };
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM_REGEX.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.hash = '';
  parsed.hostname = host;

  return { valid: true, normalizedUrl: parsed.toString(), host, error: null };
}

/**
 * Stable content ID for an archived web page: first 12 hex chars of
 * sha256(normalized URL). Re-archiving the same page (even via a different
 * tracking link) maps to the same ID, enabling dedup/versioning.
 *
 * @param {string} normalizedUrl - URL as returned by parseWebUrl().normalizedUrl
 * @returns {string}
 */
function createPageId(normalizedUrl) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 12);
}

/**
 * Extracts and validates a web page URL with detailed error handling,
 * mirroring extractAndValidateContentId() for the tweet pipeline.
 *
 * @param {string} url - URL to validate
 * @returns {{pageId: string, normalizedUrl: string, host: string, originalUrl: string}}
 * @throws {Error} - If the URL is invalid, with an actionable message
 */
function extractAndValidateWebUrl(url) {
  const parsed = parseWebUrl(url);
  if (!parsed.valid) {
    throw new Error(
      `Invalid web page URL: "${String(url).substring(0, 100)}"\n\n` +
      `Reason: ${parsed.error}\n\n` +
      `Expected: any public http(s) page, e.g. https://example.com/blog/post`
    );
  }
  return {
    pageId: createPageId(parsed.normalizedUrl),
    normalizedUrl: parsed.normalizedUrl,
    host: parsed.host,
    originalUrl: url.trim()
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
  extractAndValidateContentId,
  parseWebUrl,
  createPageId,
  extractAndValidateWebUrl
};
