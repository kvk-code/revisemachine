/**
 * Playwright-based article scraper for X/Twitter articles.
 * Uses cookie-based authentication to access article content including code blocks.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_TOKEN_FILE = path.join(__dirname, '..', 'x_auth_token.txt');

/**
 * Load auth_token from file or environment variable.
 * Supports: plain token value, or JSON with token field
 * @returns {string|null} - The auth_token value or null
 */
function loadAuthToken() {
  // First check environment variable
  if (process.env.X_AUTH_TOKEN) {
    return process.env.X_AUTH_TOKEN.trim();
  }
  
  // Then check file
  if (!fs.existsSync(AUTH_TOKEN_FILE)) {
    return null;
  }
  
  const content = fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
  
  // If it looks like JSON, try to parse it
  if (content.startsWith('{')) {
    try {
      const data = JSON.parse(content);
      return data.auth_token || data.token || null;
    } catch (e) {
      // Not valid JSON, treat as plain token
    }
  }
  
  // Plain token value
  return content || null;
}

/**
 * Build minimal cookies array from auth_token.
 * @param {string} authToken - The auth_token value
 * @returns {Array} - Playwright-compatible cookies array
 */
function buildCookiesFromToken(authToken) {
  return [
    {
      name: 'auth_token',
      value: authToken,
      domain: 'x.com',
      path: '/',
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax'
    }
  ];
}

/**
 * Scrape article content from X article page using Playwright with cookies.
 * @param {string} articleUrl - The X article URL (e.g., https://x.com/i/article/...)
 * @param {object} options - Optional settings
 * @returns {Promise<{title: string, content: string, coverImage: string}>}
 */
async function scrapeArticle(articleUrl, options = {}) {
  const { headless = true, timeout = 30000, authToken = null } = options;
  
  // Load auth token
  const token = authToken || loadAuthToken();
  if (!token) {
    console.log('  [Playwright] No auth_token found.');
    console.log('  [Playwright] Please save your X auth_token to: x_auth_token.txt');
    console.log('  [Playwright] Or set X_AUTH_TOKEN environment variable');
    return { title: '', coverImage: '', content: null, needsAuth: true };
  }
  
  // Build cookies from token
  const cookies = buildCookiesFromToken(token);
  console.log(`  [Playwright] Using auth_token (${token.substring(0, 8)}...)`);
  
  let browser = null;
  try {
    console.log(`  [Playwright] Launching browser for: ${articleUrl}`);
    
    browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    });
    
    // Add cookies before navigation
    await context.addCookies(cookies);
    
    const page = await context.newPage();
    
    // Navigate and wait for content - use domcontentloaded since X has continuous network activity
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout });
    
    // Wait for article content to load - try multiple selectors
    const articleLoaded = await Promise.race([
      page.waitForSelector('article', { timeout: 20000 }),
      page.waitForSelector('[data-testid="article"]', { timeout: 20000 }),
      page.waitForSelector('[role="article"]', { timeout: 20000 }),
      page.waitForTimeout(20000) // Fallback timeout
    ]).catch(() => null);
    
    if (!articleLoaded) {
      console.log('  [Playwright] Waiting for dynamic content...');
    }
    
    // Give extra time for JavaScript to render content
    await page.waitForTimeout(5000);
    
    // First check if we got a login wall or empty page
    const pageContent = await page.content();
    const hasLoginWall = pageContent.includes('Log in') && pageContent.includes('Sign up');
    
    if (hasLoginWall) {
      console.log('  [Playwright] Login wall detected - X requires authentication');
    }
    
    // Try to extract from __NEXT_DATA__ or similar SSR data first
    const ssrData = await page.evaluate(() => {
      // Check for Next.js SSR data
      const nextData = document.querySelector('script#__NEXT_DATA__');
      if (nextData) {
        try {
          return { type: 'nextjs', data: JSON.parse(nextData.textContent) };
        } catch (e) {}
      }
      
      // Check for any JSON data in scripts
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data.article || data.contents) {
            return { type: 'json', data };
          }
        } catch (e) {}
      }
      
      return null;
    });
    
    if (ssrData) {
      console.log(`  [Playwright] Found SSR data (${ssrData.type})`);
    }
    
    // Extract article content from the rendered DOM
    const result = await page.evaluate(() => {
      // Try to find the article title
      const titleEl = document.querySelector('h1') || 
                      document.querySelector('[data-testid="tweetText"]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      
      // Try to find cover image
      const coverImg = document.querySelector('article img[src*="pbs.twimg.com"]') ||
                       document.querySelector('[data-testid="tweetPhoto"] img');
      const coverImage = coverImg ? coverImg.src : '';
      
      // Extract structured content from the article
      const contentParts = [];
      const seenTexts = new Set();
      
      // Find the main article container
      const articleContainer = document.querySelector('article') || 
                               document.querySelector('[role="article"]') ||
                               document.querySelector('main');
      
      if (!articleContainer) {
        return { title, coverImage, content: '', bodyText: document.body.innerText.substring(0, 3000) };
      }
      
      // Process elements in order to maintain structure
      const processElement = (el) => {
        const tag = el.tagName?.toLowerCase();
        if (!tag) return;
        
        // Skip non-content elements
        if (['script', 'style', 'nav', 'button', 'svg', 'path', 'noscript'].includes(tag)) return;
        
        // Handle code blocks - look for pre, code, or monospace font elements
        if (tag === 'pre' || tag === 'code') {
          const codeText = el.textContent.trim();
          if (codeText && codeText.length > 5 && !seenTexts.has(codeText)) {
            seenTexts.add(codeText);
            // Try to detect language from class
            const langMatch = el.className.match(/language-(\w+)/);
            const lang = langMatch ? langMatch[1] : '';
            contentParts.push({ type: 'code', lang, text: codeText });
          }
          return; // Don't recurse into code blocks
        }
        
        // Handle headers
        if (/^h[1-6]$/.test(tag)) {
          const headerText = el.textContent.trim();
          if (headerText && !seenTexts.has(headerText)) {
            seenTexts.add(headerText);
            const level = parseInt(tag[1]);
            contentParts.push({ type: 'header', level, text: headerText });
          }
          return;
        }
        
        // Handle paragraphs and divs with direct text
        if (tag === 'p' || tag === 'span' || tag === 'div') {
          // Check if this element has monospace styling (often used for code)
          const style = window.getComputedStyle(el);
          const isMonospace = style.fontFamily.toLowerCase().includes('mono') ||
                              style.fontFamily.toLowerCase().includes('courier');
          
          const text = el.textContent.trim();
          if (text && text.length > 10 && !seenTexts.has(text)) {
            // Only add if this is a leaf-ish node (not containing other block elements)
            const hasBlockChildren = el.querySelector('p, div, pre, h1, h2, h3, h4, h5, h6');
            if (!hasBlockChildren) {
              seenTexts.add(text);
              if (isMonospace && text.length > 20) {
                contentParts.push({ type: 'code', lang: '', text });
              } else {
                contentParts.push({ type: 'text', text });
              }
              return;
            }
          }
        }
        
        // Handle list items
        if (tag === 'li') {
          const text = el.textContent.trim();
          if (text && !seenTexts.has(text)) {
            seenTexts.add(text);
            contentParts.push({ type: 'list', text });
          }
          return;
        }
        
        // Handle blockquotes
        if (tag === 'blockquote') {
          const text = el.textContent.trim();
          if (text && !seenTexts.has(text)) {
            seenTexts.add(text);
            contentParts.push({ type: 'quote', text });
          }
          return;
        }
        
        // Recurse into children
        for (const child of el.children) {
          processElement(child);
        }
      };
      
      processElement(articleContainer);
      
      // Convert to markdown
      const markdown = contentParts.map(part => {
        switch (part.type) {
          case 'code':
            return '```' + part.lang + '\n' + part.text + '\n```';
          case 'header':
            return '#'.repeat(part.level) + ' ' + part.text;
          case 'list':
            return '- ' + part.text;
          case 'quote':
            return '> ' + part.text;
          default:
            return part.text;
        }
      }).join('\n\n');
      
      return {
        title,
        coverImage,
        content: markdown,
        bodyText: document.body.innerText.substring(0, 3000),
        hasCodeBlocks: contentParts.some(p => p.type === 'code')
      };
    });
    
    // If we got minimal content, log the body text for debugging
    if (result.content.length < 100) {
      console.log(`  [Playwright] Low content (${result.content.length} chars), page body preview:`);
      console.log(`  ${(result.bodyText || '').substring(0, 200)}...`);
    }
    
    console.log(`  [Playwright] Scraped: "${result.title}" (${result.content.length} chars)`);
    
    await browser.close();
    return result;
    
  } catch (error) {
    console.error(`  [Playwright] Error: ${error.message}`);
    if (browser) await browser.close();
    return { title: '', coverImage: '', content: null };
  }
}

/**
 * Check if article content has missing code blocks (empty whitespace blocks).
 * @param {string} apiContent - Content from twitterapi.io
 * @param {Array} rawContents - Raw contents array from API
 * @returns {boolean}
 */
function hasEmptyCodeBlocks(rawContents) {
  if (!rawContents || !Array.isArray(rawContents)) return false;
  
  // Count empty/whitespace-only blocks
  const emptyBlocks = rawContents.filter(c => {
    const text = (c.text || '').trim();
    return text === '' || text === ' ';
  }).length;
  
  // If more than 3 empty blocks, likely has stripped code blocks
  return emptyBlocks >= 3;
}

module.exports = {
  scrapeArticle,
  hasEmptyCodeBlocks,
  loadAuthToken,
  buildCookiesFromToken
};

// CLI support for testing
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node scrape_article.js <article-url>');
    console.log('Example: node scrape_article.js "https://x.com/i/article/2029411158365442048"');
    process.exit(1);
  }
  
  scrapeArticle(url, { headless: true })
    .then(result => {
      console.log('\n=== SCRAPED CONTENT ===\n');
      console.log('Title:', result.title);
      console.log('Cover:', result.coverImage);
      console.log('\nContent:\n', result.content);
    })
    .catch(console.error);
}
