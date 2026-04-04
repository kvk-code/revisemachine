/**
 * Sanitization utilities for preventing output injection attacks
 * @module utils/sanitize
 */

/**
 * Sanitizes GitHub output by removing dangerous characters
 * Prevents output injection via newlines, carriage returns, and control chars
 * 
 * @param {string} input - The input string to sanitize
 * @returns {string} - Sanitized string safe for GitHub Actions output
 */
function sanitizeGitHubOutput(input) {
  if (input === null || input === undefined) {
    return '';
  }
  
  // Convert to string if not already
  const str = String(input);
  
  // Remove newlines, carriage returns, and other control characters
  // that could break GitHub Actions output format
  return str
    .replace(/[\r\n\t\x00-\x1F\x7F]/g, '')  // Remove control chars
    .replace(/\s+/g, ' ')                    // Collapse whitespace to single space
    .trim();                                  // Trim leading/trailing whitespace
}

/**
 * Validates that an ID is in an acceptable format
 * Accepts: numeric IDs (e.g., "123456789") or synthetic format (e.g., "article-123456789")
 * 
 * @param {string} id - The ID to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function isValidId(id) {
  if (!id || typeof id !== 'string') {
    return false;
  }
  
  // Numeric ID pattern (standard tweet IDs)
  const numericPattern = /^\d{1,19}$/;
  
  // Synthetic ID pattern for articles: article-{numeric}
  const syntheticPattern = /^article-\d{1,19}$/;
  
  return numericPattern.test(id) || syntheticPattern.test(id);
}

/**
 * Creates a safe filename from an ID
 * Prevents path traversal and injection attacks
 * 
 * @param {string} id - The ID to convert to filename
 * @param {string} extension - File extension (without dot)
 * @returns {string} - Safe filename
 * @throws {Error} - If ID is invalid
 */
function createSafeFilename(id, extension = 'json') {
  if (!isValidId(id)) {
    throw new Error(`Invalid ID format: ${id}. Must be numeric or synthetic format (article-{number})`);
  }
  
  // Sanitize the ID for use in filename
  const safeId = sanitizeGitHubOutput(id);
  
  // Validate extension (alphanumeric only)
  if (!/^[a-zA-Z0-9]+$/.test(extension)) {
    throw new Error(`Invalid file extension: ${extension}`);
  }
  
  return `${safeId}.${extension}`;
}

/**
 * Sanitizes and validates an output ID for GitHub Actions
 * FIXED: Explicit null check with clear error message
 * 
 * @param {string} id - The ID to sanitize and validate
 * @returns {string} - Sanitized ID
 * @throws {Error} - If ID is null, undefined, or invalid after sanitization
 */
function sanitizeAndValidateId(id) {
  if (id == null) {
    throw new Error('ID is required but was null or undefined');
  }
  
  const sanitized = sanitizeGitHubOutput(String(id));
  
  if (!isValidId(sanitized)) {
    throw new Error(`Invalid ID format: "${sanitized}". Must be numeric (1-19 digits) or synthetic format (article-{number}).`);
  }
  
  return sanitized;
}

module.exports = {
  sanitizeGitHubOutput,
  isValidId,
  createSafeFilename,
  sanitizeAndValidateId
};
