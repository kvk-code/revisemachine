/**
 * Playwright-based tweet scraper — replaces twitterapi.io entirely.
 *
 * Strategy: Navigate to tweet URL with auth_token cookie, intercept X's
 * internal GraphQL `TweetDetail` API response, and parse the structured
 * JSON. Falls back to DOM parsing if interception fails.
 *
 * Exports:
 *   scrapeTweet(tweetUrl, options) → { tweet, threadTweets, article }
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_TOKEN_FILE = path.join(__dirname, '..', 'x_auth_token.txt');

// ─── Auth Token Loading ──────────────────────────────────────────────────────

function loadAuthToken() {
  if (process.env.X_AUTH_TOKEN) {
    return process.env.X_AUTH_TOKEN.trim();
  }
  if (!fs.existsSync(AUTH_TOKEN_FILE)) return null;
  const content = fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
  if (content.startsWith('{')) {
    try {
      const data = JSON.parse(content);
      return data.auth_token || data.token || null;
    } catch (e) { /* treat as plain token */ }
  }
  return content || null;
}

function buildCookies(authToken) {
  return [{
    name: 'auth_token',
    value: authToken,
    domain: 'x.com',
    path: '/',
    expires: -1,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax'
  }];
}

// ─── GraphQL Response Parsing ────────────────────────────────────────────────

/**
 * Parse a TweetDetail GraphQL response into a clean tweet object.
 */
function parseTweetResult(result) {
  if (!result) return null;

  // Navigate the nested result structure
  const tweet = result.core?.user_results?.result
    ? parseTweetFromGraphQL(result)
    : null;
  return tweet;
}

function parseTweetFromGraphQL(result) {
  // X wraps tweet results in various container types
  // Handle: TweetWithVisibilityResults, TimelineTweet, etc.
  if (result.__typename === 'TweetWithVisibilityResults') {
    result = result.tweet || result;
  }

  const legacy = result.legacy || {};
  const coreOuter = result.core || {};  // outer core = { user_results: { result: ... } }
  const userResult = coreOuter.user_results?.result || {};
  // X nests user name/screen_name inside userResult.core (NOT userResult.legacy)
  const userCore = userResult.core || {};   // { name, screen_name, created_at }
  const userLegacy = userResult.legacy || {}; // { description, followers_count, ... }
  const userAvatar = userResult.avatar || {}; // { image_url }
  const views = result.views || {};

  // For long tweets, full text may be in note_tweet
  const noteTweet = result.note_tweet?.note_tweet_results?.result;
  const fullText = noteTweet?.text || legacy.full_text || legacy.text || '';

  // Build entities
  const entities = legacy.entities || {};
  const extendedEntities = legacy.extended_entities || {};

  // Build media from extended_entities
  const mediaItems = (extendedEntities.media || []).map(m => ({
    type: m.type,
    media_url_https: m.media_url_https,
    media_url: m.media_url_https || m.media_url,
    url: m.url,
    expanded_url: m.expanded_url,
    video_info: m.video_info ? {
      variants: (m.video_info.variants || []).map(v => ({
        content_type: v.content_type,
        url: v.url,
        bitrate: v.bitrate
      }))
    } : undefined
  }));

  // Parse engagement counts (handle "1.2K" format from DOM fallback)
  const likeCount = legacy.favorite_count || 0;
  const retweetCount = legacy.retweet_count || 0;
  const replyCount = legacy.reply_count || 0;
  const quoteCount = legacy.quote_count || 0;
  const bookmarkCount = legacy.bookmark_count || 0;
  const viewCount = parseInt(views.count) || 0;

  // Parse quoted tweet
  let quotedTweet = null;
  if (result.quoted_status_result?.result) {
    const qr = result.quoted_status_result.result;
    // Handle tombstone (deleted/unavailable quoted tweets)
    if (qr.__typename !== 'TweetTombstone') {
      const qtResult = qr.tweet || qr;
      quotedTweet = parseTweetFromGraphQL(qtResult);
    }
  }

  // Extract article data if present (X embeds full article in GraphQL)
  let articleData = null;
  if (result.article?.article_results?.result) {
    const artResult = result.article.article_results.result;
    articleData = {
      title: artResult.title || '',
      coverImage: artResult.cover_image?.original_img_url || '',
      blocks: artResult.content_state?.blocks || [],
      entityMap: artResult.content_state?.entityMap || {},
      previewText: artResult.preview_text || '',
      restId: artResult.rest_id || ''
    };
  }

  const screenName = userCore.screen_name || userLegacy.screen_name || '';

  return {
    id: legacy.id_str || result.rest_id,
    text: fullText,
    createdAt: legacy.created_at || userCore.created_at || '',
    url: `https://x.com/${screenName}/status/${legacy.id_str || result.rest_id}`,
    conversationId: legacy.conversation_id_str || '',
    inReplyToId: legacy.in_reply_to_status_id_str || null,
    inReplyToUserId: legacy.in_reply_to_user_id_str || null,
    author: {
      name: userCore.name || userLegacy.name || '',
      userName: screenName,
      profilePicture: (userAvatar.image_url || userLegacy.profile_image_url_https || '').replace('_normal', '_400x400'),
      verified: userResult.is_blue_verified || userLegacy.verified || false,
      description: userResult.profile_bio?.description || userLegacy.description || ''
    },
    articleData,
    entities: {
      urls: (entities.urls || []).map(u => ({
        url: u.url,
        expanded_url: u.expanded_url,
        display_url: u.display_url
      })),
      hashtags: (entities.hashtags || []).map(h => ({
        text: h.text
      })),
      user_mentions: (entities.user_mentions || []).map(m => ({
        screen_name: m.screen_name,
        name: m.name
      }))
    },
    extendedEntities: {
      media: mediaItems
    },
    likeCount,
    retweetCount,
    replyCount,
    viewCount,
    bookmarkCount,
    quoteCount,
    quoted_tweet: quotedTweet,
    isArticle: !!articleData || 
               (entities.urls || []).some(u => 
                 (u.expanded_url || '').includes('/i/article/'))
  };
}

/**
 * Extract all tweet entries from a TweetDetail GraphQL response.
 * Returns { mainTweet, conversationTweets[] }
 */
function parseGraphQLResponse(data) {
  const instructions = data?.data?.tweetResult?.result 
    ? null  // Single tweet endpoint
    : data?.data?.threaded_conversation_with_injections_v2?.instructions 
      || data?.data?.tweet_result_by_rest_id?.result
      || null;

  // Case 1: Direct tweet result
  if (data?.data?.tweetResult?.result) {
    const result = data.data.tweetResult.result;
    const tweetData = result.tweet || result;
    return {
      mainTweet: parseTweetFromGraphQL(tweetData),
      conversationTweets: []
    };
  }

  // Case 2: Threaded conversation
  if (instructions && Array.isArray(instructions)) {
    const tweets = [];
    
    for (const instruction of instructions) {
      const entries = instruction.entries || [];
      for (const entry of entries) {
        // Process tweet entries
        const content = entry.content;
        if (!content) continue;

        if (content.entryType === 'TimelineTimelineItem' || content.__typename === 'TimelineTimelineItem') {
          const itemContent = content.itemContent;
          if (itemContent?.tweet_results?.result) {
            const result = itemContent.tweet_results.result;
            const tweetData = result.tweet || result;
            if (tweetData.legacy || tweetData.core) {
              const parsed = parseTweetFromGraphQL(tweetData);
              if (parsed) tweets.push(parsed);
            }
          }
        }

        // Process conversation module (thread tweets grouped together)
        if (content.entryType === 'TimelineTimelineModule' || content.__typename === 'TimelineTimelineModule') {
          const items = content.items || [];
          for (const item of items) {
            const itemContent = item.item?.itemContent;
            if (itemContent?.tweet_results?.result) {
              const result = itemContent.tweet_results.result;
              const tweetData = result.tweet || result;
              if (tweetData.legacy || tweetData.core) {
                const parsed = parseTweetFromGraphQL(tweetData);
                if (parsed) tweets.push(parsed);
              }
            }
          }
        }
      }
    }

    // The main tweet is the one matching the URL's tweet ID
    return { mainTweet: tweets[0] || null, conversationTweets: tweets };
  }

  // Case 3: Single tweet result
  if (data?.data?.tweet_result_by_rest_id?.result) {
    const result = data.data.tweet_result_by_rest_id.result;
    const tweetData = result.tweet || result;
    return {
      mainTweet: parseTweetFromGraphQL(tweetData),
      conversationTweets: []
    };
  }

  return { mainTweet: null, conversationTweets: [] };
}

// ─── DOM Fallback Parsing ────────────────────────────────────────────────────

/**
 * Extract tweet data from the rendered DOM as a fallback.
 */
async function extractFromDOM(page, tweetId) {
  return await page.evaluate((targetId) => {
    function parseMetricText(text) {
      if (!text) return 0;
      text = text.replace(/,/g, '').trim();
      if (text.endsWith('K')) return Math.round(parseFloat(text) * 1000);
      if (text.endsWith('M')) return Math.round(parseFloat(text) * 1000000);
      return parseInt(text) || 0;
    }

    // Find the main tweet article
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let mainArticle = null;
    
    for (const article of articles) {
      // Find the article that matches our tweet (look for status link)
      const links = article.querySelectorAll('a[href*="/status/"]');
      for (const link of links) {
        if (link.href.includes(`/status/${targetId}`)) {
          mainArticle = article;
          break;
        }
      }
      if (mainArticle) break;
    }

    if (!mainArticle) mainArticle = articles[0]; // fallback to first tweet
    if (!mainArticle) return null;

    // Extract text
    const textEl = mainArticle.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText : '';

    // Extract author info
    const userNameEl = mainArticle.querySelector('[data-testid="User-Name"]');
    let authorName = '';
    let authorUserName = '';
    if (userNameEl) {
      const spans = userNameEl.querySelectorAll('span');
      for (const span of spans) {
        if (span.textContent.startsWith('@')) {
          authorUserName = span.textContent.replace('@', '');
        } else if (span.textContent && !span.textContent.startsWith('@') && span.textContent !== '·') {
          if (!authorName) authorName = span.textContent;
        }
      }
    }

    // Extract profile picture
    const avatarImg = mainArticle.querySelector('img[src*="profile_images"]');
    const profilePicture = avatarImg ? avatarImg.src.replace('_normal', '_400x400') : '';

    // Extract time
    const timeEl = mainArticle.querySelector('time');
    const createdAt = timeEl ? timeEl.getAttribute('datetime') : '';

    // Extract media
    const media = [];
    const photos = mainArticle.querySelectorAll('[data-testid="tweetPhoto"] img');
    photos.forEach((img, i) => {
      if (img.src && !img.src.includes('profile_images')) {
        media.push({
          type: 'photo',
          media_url_https: img.src,
          media_url: img.src
        });
      }
    });

    // Extract engagement metrics
    const metrics = {};
    const metricGroups = mainArticle.querySelectorAll('[role="group"] button');
    metricGroups.forEach(btn => {
      const label = btn.getAttribute('aria-label') || '';
      const match = label.match(/(\d[\d,.]*[KMB]?)\s+(repl|repost|like|view|bookmark)/i);
      if (match) {
        const count = parseMetricText(match[1]);
        const type = match[2].toLowerCase();
        if (type.startsWith('repl')) metrics.replies = count;
        if (type.startsWith('repost')) metrics.retweets = count;
        if (type.startsWith('like')) metrics.likes = count;
        if (type.startsWith('view')) metrics.views = count;
        if (type.startsWith('bookmark')) metrics.bookmarks = count;
      }
    });

    return {
      id: targetId,
      text,
      createdAt,
      url: `https://x.com/${authorUserName}/status/${targetId}`,
      author: {
        name: authorName,
        userName: authorUserName,
        profilePicture
      },
      entities: { urls: [], hashtags: [], user_mentions: [] },
      extendedEntities: { media },
      likeCount: metrics.likes || 0,
      retweetCount: metrics.retweets || 0,
      replyCount: metrics.replies || 0,
      viewCount: metrics.views || 0,
      bookmarkCount: metrics.bookmarks || 0,
      quoteCount: 0,
      quoted_tweet: null
    };
  }, tweetId);
}

// ─── Article from GraphQL Blocks ─────────────────────────────────────────────

/**
 * Convert GraphQL article content_state blocks into markdown.
 * Block types: unstyled, blockquote, code-block, header-one, header-two,
 *              header-three, ordered-list-item, unordered-list-item, atomic
 */
function articleBlocksToMarkdown(blocks, entityMap) {
  if (!blocks || !blocks.length) return null;
  
  // Build entity lookup: entityMap is { "0": { key, value: { data, type } }, ... }
  // But the blocks reference entities by entityRanges[].key
  const entityLookup = {};
  if (entityMap) {
    for (const [idx, entry] of Object.entries(entityMap)) {
      const key = entry.key || idx;
      entityLookup[key] = entry.value || entry;
    }
  }

  /**
   * Process inline entity ranges (links, etc.) within block text.
   * entityRanges: [{ offset, length, key }, ...]
   * Returns text with markdown links applied.
   */
  function applyInlineEntities(text, entityRanges) {
    if (!entityRanges || entityRanges.length === 0) return text;
    
    // Sort by offset descending so we can replace from end to start
    // (avoids offset shifting issues)
    const sorted = [...entityRanges].sort((a, b) => b.offset - a.offset);
    
    let result = text;
    for (const range of sorted) {
      const entity = entityLookup[range.key] || entityLookup[String(range.key)];
      if (!entity) continue;
      
      const entityType = entity.type || '';
      const entityData = entity.data || {};
      
      if (entityType === 'LINK' && entityData.url) {
        const linkText = result.substring(range.offset, range.offset + range.length);
        const markdownLink = `[${linkText}](${entityData.url})`;
        result = result.substring(0, range.offset) + markdownLink + result.substring(range.offset + range.length);
      }
    }
    
    return result;
  }

  const parts = [];
  let hasCodeBlocks = false;
  let inCodeBlock = false;
  let codeLines = [];
  let codeLang = '';

  function flushCodeBlock() {
    if (codeLines.length > 0) {
      hasCodeBlocks = true;
      parts.push('```' + codeLang + '\n' + codeLines.join('\n') + '\n```');
      codeLines = [];
      codeLang = '';
      inCodeBlock = false;
    }
  }

  for (const block of blocks) {
    const text = block.text || '';
    const type = block.type || 'unstyled';
    const entityRanges = block.entityRanges || [];

    if (type === 'code-block') {
      if (!inCodeBlock) {
        inCodeBlock = true;
        const trimmed = text.trim().toLowerCase();
        const knownLangs = ['javascript', 'js', 'python', 'py', 'bash', 'shell', 'sh',
          'typescript', 'ts', 'json', 'yaml', 'html', 'css', 'sql', 'go', 'rust',
          'java', 'c', 'cpp', 'ruby', 'php', 'solidity', 'markdown', 'toml'];
        if (knownLangs.includes(trimmed) && text.trim().length < 20) {
          codeLang = trimmed;
          continue;
        }
      }
      codeLines.push(text);
      continue;
    }

    // Flush any pending code block when we hit a non-code block
    flushCodeBlock();

    if (type === 'atomic') {
      // Atomic blocks reference entities via entityRanges
      for (const ref of entityRanges) {
        const entity = entityLookup[ref.key] || entityLookup[String(ref.key)];
        if (!entity) continue;
        
        const entityType = entity.type || '';
        const entityData = entity.data || {};

        if (entityType === 'MARKDOWN' && entityData.markdown) {
          // Code blocks stored as markdown entities
          hasCodeBlocks = true;
          parts.push(entityData.markdown.trim());
        } else if (entityType === 'IMAGE' || entityType === 'MEDIA') {
          const imgUrl = entityData.src || entityData.url || '';
          if (imgUrl) parts.push(`![Image](${imgUrl})`);
        } else if (entityType === 'DIVIDER') {
          parts.push('---');
        } else if (entityType === 'LINK' && entityData.url) {
          // Standalone link in atomic block
          const linkText = text.trim() || entityData.url;
          parts.push(`[${linkText}](${entityData.url})`);
        }
      }
      continue;
    }

    // Apply inline links to text content
    const processedText = applyInlineEntities(text, entityRanges);

    switch (type) {
      case 'header-one':
        parts.push('# ' + processedText);
        break;
      case 'header-two':
        parts.push('## ' + processedText);
        break;
      case 'header-three':
        parts.push('### ' + processedText);
        break;
      case 'blockquote':
        parts.push(processedText.split('\n').map(l => '> ' + l).join('\n'));
        break;
      case 'ordered-list-item':
        parts.push('- ' + processedText);
        break;
      case 'unordered-list-item':
        parts.push('- ' + processedText);
        break;
      default:
        if (processedText.trim()) parts.push(processedText);
        break;
    }
  }

  flushCodeBlock();

  return {
    content: parts.join('\n\n'),
    hasCodeBlocks
  };
}

// ─── Article Scraping ────────────────────────────────────────────────────────

/**
 * Scrape article content including code blocks from an X article page.
 */
async function scrapeArticleContent(page, articleUrl) {
  console.log(`  [Playwright] Navigating to article: ${articleUrl}`);
  
  await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // Wait for article content to render
  await page.waitForTimeout(3000);
  
  // Try multiple selectors for article content
  const selectors = [
    'article',
    '[data-testid="article"]',
    '[role="article"]',
    'div[class*="article"]',
    'main'
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      break;
    } catch { continue; }
  }

  // Wait a bit more for dynamic content
  await page.waitForTimeout(2000);

  const result = await page.evaluate(() => {
    // Find article container
    const articleEl = document.querySelector('article') || 
                      document.querySelector('[data-testid="article"]') ||
                      document.querySelector('[role="article"]') ||
                      document.querySelector('main');
    
    if (!articleEl) return { title: '', coverImage: '', content: null, hasCodeBlocks: false };

    // Extract title
    const h1 = articleEl.querySelector('h1') || document.querySelector('h1');
    const title = h1 ? h1.innerText.trim() : '';

    // Extract cover image
    const coverImg = articleEl.querySelector('img[src*="pbs.twimg.com"]') ||
                     articleEl.querySelector('img[src*="media"]');
    const coverImage = coverImg ? coverImg.src : '';

    // Extract content with structure
    const contentParts = [];
    let hasCodeBlocks = false;

    function processNode(node, depth = 0) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) contentParts.push(text);
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();
      const style = window.getComputedStyle(node);

      // Skip hidden elements
      if (style.display === 'none' || style.visibility === 'hidden') return;

      // Code blocks
      if (tag === 'pre' || tag === 'code' || 
          style.fontFamily.includes('monospace') ||
          node.classList.contains('code-block')) {
        const codeText = node.innerText.trim();
        if (codeText && codeText.length > 10) {
          hasCodeBlocks = true;
          // Try to detect language from class
          const langClass = Array.from(node.classList).find(c => 
            c.startsWith('language-') || c.startsWith('lang-'));
          const lang = langClass ? langClass.replace(/^(language-|lang-)/, '') : '';
          contentParts.push('```' + lang + '\n' + codeText + '\n```');
          return; // Don't recurse into code blocks
        }
      }

      // Headers
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1]);
        contentParts.push('#'.repeat(level) + ' ' + node.innerText.trim());
        return;
      }

      // Lists
      if (tag === 'li') {
        const parent = node.parentElement;
        const isOrdered = parent && parent.tagName.toLowerCase() === 'ol';
        const index = isOrdered ? Array.from(parent.children).indexOf(node) + 1 : 0;
        const prefix = isOrdered ? `${index}. ` : '- ';
        contentParts.push(prefix + node.innerText.trim());
        return;
      }

      // Blockquotes
      if (tag === 'blockquote') {
        const lines = node.innerText.trim().split('\n');
        contentParts.push(lines.map(l => '> ' + l).join('\n'));
        return;
      }

      // Paragraphs and divs
      if (tag === 'p' || tag === 'div') {
        // Check if this is a code-like block
        if (style.fontFamily.includes('monospace') && node.innerText.trim().length > 20) {
          hasCodeBlocks = true;
          contentParts.push('```\n' + node.innerText.trim() + '\n```');
          return;
        }
      }

      // Images
      if (tag === 'img') {
        const src = node.src;
        const alt = node.alt || 'Image';
        if (src && !src.includes('emoji') && !src.includes('profile_images')) {
          contentParts.push(`![${alt}](${src})`);
        }
        return;
      }

      // Recurse into children
      for (const child of node.childNodes) {
        processNode(child, depth + 1);
      }

      // Add spacing after block elements
      if (['p', 'div', 'section', 'ul', 'ol', 'pre'].includes(tag)) {
        contentParts.push('');
      }
    }

    processNode(articleEl);

    // Clean up: remove consecutive empty strings, join
    const cleaned = [];
    let lastEmpty = false;
    for (const part of contentParts) {
      if (part === '') {
        if (!lastEmpty) cleaned.push('');
        lastEmpty = true;
      } else {
        cleaned.push(part);
        lastEmpty = false;
      }
    }

    return {
      title,
      coverImage,
      content: cleaned.join('\n\n').trim(),
      hasCodeBlocks
    };
  });

  return result;
}

// ─── Main Scraper ────────────────────────────────────────────────────────────

/**
 * Scrape a tweet and all related data using Playwright.
 *
 * @param {string} tweetUrl - Full tweet URL (e.g., https://x.com/user/status/123)
 * @param {object} options - { headless, timeout, authToken }
 * @returns {Promise<{ tweet, threadTweets, article }>}
 */
async function scrapeTweet(tweetUrl, options = {}) {
  const { headless = true, timeout = 45000, authToken = null } = options;

  const token = authToken || loadAuthToken();
  if (!token) {
    throw new Error('No auth_token found. Save your X auth_token to x_auth_token.txt or set X_AUTH_TOKEN env var.');
  }

  const cookies = buildCookies(token);
  console.log(`  [Playwright] Using auth_token (${token.substring(0, 8)}...)`);

  // Extract tweet ID from URL
  const idMatch = tweetUrl.match(/status\/(\d+)/);
  if (!idMatch) throw new Error(`Could not extract tweet ID from: ${tweetUrl}`);
  const tweetId = idMatch[1];

  let browser = null;
  let graphqlData = null;

  try {
    browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    });

    await context.addCookies(cookies);

    const page = await context.newPage();

    // Intercept GraphQL responses — catch all tweet-related endpoints
    const graphqlResponses = [];
    const graphqlEndpoints = [];
    
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/graphql/') || url.includes('/i/api/graphql/')) {
        // Log all GraphQL endpoints for debugging
        const endpointMatch = url.match(/graphql\/[^/]+\/([^?]+)/);
        const endpoint = endpointMatch ? endpointMatch[1] : 'unknown';
        graphqlEndpoints.push(endpoint);
        
        // Capture any response that might contain tweet data
        const tweetEndpoints = ['TweetDetail', 'TweetResultByRestId', 'GetTweetDetail',
          'TweetResultsByRestIds', 'ConversationTimeline', 'TweetResult'];
        const isTweetEndpoint = tweetEndpoints.some(ep => url.includes(ep));
        
        // Also capture any response that has tweetResult or threaded_conversation in the data
        try {
          const json = await response.json();
          if (isTweetEndpoint || json?.data?.tweetResult || json?.data?.threaded_conversation_with_injections_v2) {
            graphqlResponses.push(json);
          }
        } catch { /* ignore non-JSON */ }
      }
    });

    // Navigate to tweet
    console.log(`  [Playwright] Navigating to: ${tweetUrl}`);
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout });

    // Wait for tweet content to load
    try {
      await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 });
    } catch {
      console.log('  [Playwright] Tweet element not found, waiting longer...');
      await page.waitForTimeout(5000);
    }

    // Give GraphQL responses time to arrive
    await page.waitForTimeout(3000);

    // Parse GraphQL data if captured
    let mainTweet = null;
    let conversationTweets = [];

    // Log all endpoints seen
    if (graphqlEndpoints.length > 0) {
      console.log(`  [Playwright] GraphQL endpoints hit: ${[...new Set(graphqlEndpoints)].join(', ')}`);
    }

    if (graphqlResponses.length > 0) {
      console.log(`  [Playwright] Captured ${graphqlResponses.length} GraphQL response(s)`);
      
      // Debug: save raw GraphQL response for analysis
      if (process.env.DEBUG_GRAPHQL) {
        for (let ri = 0; ri < graphqlResponses.length; ri++) {
          fs.writeFileSync(`debug_graphql_${ri}.json`, JSON.stringify(graphqlResponses[ri], null, 2));
          console.log(`  [DEBUG] Saved debug_graphql_${ri}.json`);
        }
      }

      for (const resp of graphqlResponses) {
        const parsed = parseGraphQLResponse(resp);
        if (parsed.mainTweet) {
          // Find the tweet matching our ID
          const allTweets = [parsed.mainTweet, ...parsed.conversationTweets];
          const match = allTweets.find(t => t.id === tweetId);
          if (match) {
            mainTweet = match;
            conversationTweets = parsed.conversationTweets;
          } else if (!mainTweet) {
            mainTweet = parsed.mainTweet;
            conversationTweets = parsed.conversationTweets;
          }
        }
      }
    }

    // Fallback to DOM parsing if GraphQL didn't work
    if (!mainTweet) {
      console.log('  [Playwright] GraphQL interception missed, falling back to DOM parsing');
      
      // Diagnostic: what does the page show?
      const pageTitle = await page.title();
      const pageUrl = page.url();
      console.log(`  [Playwright] Page title: "${pageTitle}", URL: ${pageUrl}`);
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || 'EMPTY');
      console.log(`  [Playwright] Page body: ${bodySnippet.substring(0, 200)}`);
      
      // Check if user is logged out
      const hasLoginPrompt = bodySnippet.includes('Sign in') || bodySnippet.includes('Log in') || bodySnippet.includes('Create account');
      if (hasLoginPrompt) {
        console.log('  [Playwright] WARNING: Page shows login prompt — auth_token may be expired!');
      }
      
      // Check for common error states
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      if (pageText.includes('Something went wrong') || pageText.includes('Try again')) {
        console.log('  [Playwright] Page shows error state, retrying navigation...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
      }
      
      // Check for age gate / sensitive content interstitial
      const hasAgeGate = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        return btns.some(b => (b.textContent || '').toLowerCase().includes('view') || 
                               (b.textContent || '').toLowerCase().includes('yes'));
      });
      if (hasAgeGate) {
        console.log('  [Playwright] Age gate/interstitial detected, clicking through...');
        try {
          const viewBtn = await page.$('button:has-text("View"), [role="button"]:has-text("Yes")');
          if (viewBtn) await viewBtn.click();
          await page.waitForTimeout(3000);
        } catch { /* ignore */ }
      }

      // Try waiting for tweet element again
      try {
        await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });
      } catch { /* may not appear */ }

      mainTweet = await extractFromDOM(page, tweetId);
    }

    if (!mainTweet) {
      // Last resort: try to get page screenshot path for debugging
      const errorUrl = page.url();
      const errorTitle = await page.title();
      throw new Error(`Failed to extract tweet data. Page: "${errorTitle}" at ${errorUrl}`);
    }

    console.log(`  [Playwright] Tweet extracted: @${mainTweet.author.userName} - "${(mainTweet.text || '').substring(0, 60)}..."`);

    // ── Thread Detection ──
    // Filter conversation tweets to same-author self-reply chain
    let threadTweets = [];
    if (conversationTweets.length > 1) {
      const authorUsername = mainTweet.author.userName;
      const sameAuthorTweets = conversationTweets.filter(t => 
        t.author.userName === authorUsername
      );

      if (sameAuthorTweets.length > 1) {
        // Build chain using inReplyToId
        const tweetMap = new Map();
        for (const t of sameAuthorTweets) tweetMap.set(t.id, t);

        // Walk backward to find thread start
        let start = mainTweet;
        const visited = new Set();
        while (start.inReplyToId && tweetMap.has(start.inReplyToId) && !visited.has(start.inReplyToId)) {
          visited.add(start.id);
          start = tweetMap.get(start.inReplyToId);
        }

        // Walk forward building the chain
        const childrenOf = new Map();
        for (const t of sameAuthorTweets) {
          if (t.inReplyToId) {
            if (!childrenOf.has(t.inReplyToId)) childrenOf.set(t.inReplyToId, []);
            childrenOf.get(t.inReplyToId).push(t);
          }
        }

        const chain = [start];
        const chainVisited = new Set([start.id]);
        let current = start;

        while (chain.length < 50) {
          const children = (childrenOf.get(current.id) || [])
            .filter(c => !chainVisited.has(c.id));
          if (children.length === 0) break;
          // Prefer the child that's also by the same author
          const next = children.find(c => c.author.userName === authorUsername) || children[0];
          chain.push(next);
          chainVisited.add(next.id);
          current = next;
        }

        if (chain.length > 1) {
          threadTweets = chain;
          console.log(`  [Playwright] Thread detected: ${chain.length} tweets from @${authorUsername}`);
        }
      }
    }

    // If no thread found from GraphQL, check if we should scroll for more
    if (threadTweets.length <= 1 && mainTweet.replyCount > 0) {
      // The tweet might be a thread - check for self-replies in the page
      const conversationId = mainTweet.conversationId || mainTweet.id;
      if (conversationId === mainTweet.id) {
        // This is the conversation root with replies - could be a thread
        // Scroll down to load more tweets
        console.log('  [Playwright] Checking for thread by scrolling...');
        
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await page.waitForTimeout(2000);
        }

        // Wait for any new GraphQL responses
        await page.waitForTimeout(2000);

        // Re-check GraphQL responses
        if (graphqlResponses.length > 0) {
          const allParsed = [];
          for (const resp of graphqlResponses) {
            const parsed = parseGraphQLResponse(resp);
            allParsed.push(...parsed.conversationTweets);
          }

          const authorUsername = mainTweet.author.userName;
          const selfReplies = allParsed.filter(t => 
            t.author.userName === authorUsername && t.id !== mainTweet.id
          );

          if (selfReplies.length > 0) {
            // Rebuild thread chain
            const allThreadTweets = [mainTweet, ...selfReplies];
            const tweetMap = new Map();
            for (const t of allThreadTweets) tweetMap.set(t.id, t);

            const childrenOf = new Map();
            for (const t of allThreadTweets) {
              if (t.inReplyToId) {
                if (!childrenOf.has(t.inReplyToId)) childrenOf.set(t.inReplyToId, []);
                childrenOf.get(t.inReplyToId).push(t);
              }
            }

            const chain = [mainTweet];
            const chainVisited = new Set([mainTweet.id]);
            let current = mainTweet;

            while (chain.length < 50) {
              const children = (childrenOf.get(current.id) || [])
                .filter(c => !chainVisited.has(c.id) && c.author.userName === authorUsername);
              if (children.length === 0) break;
              chain.push(children[0]);
              chainVisited.add(children[0].id);
              current = children[0];
            }

            if (chain.length > 1) {
              threadTweets = chain;
              console.log(`  [Playwright] Thread detected after scroll: ${chain.length} tweets`);
            }
          }
        }
      }
    }

    // ── Article Detection & Content ──
    let article = null;
    
    // Prefer GraphQL article data (has proper block types including code-block)
    if (mainTweet.articleData && mainTweet.articleData.blocks.length > 0) {
      console.log(`  [Playwright] Article found in GraphQL: "${mainTweet.articleData.title}" (${mainTweet.articleData.blocks.length} blocks)`);
      const mdResult = articleBlocksToMarkdown(mainTweet.articleData.blocks, mainTweet.articleData.entityMap);
      if (mdResult && mdResult.content) {
        article = {
          title: mainTweet.articleData.title,
          coverImage: mainTweet.articleData.coverImage,
          content: mdResult.content,
          hasCodeBlocks: mdResult.hasCodeBlocks
        };
        console.log(`  [Playwright] Article converted: ${article.content.length} chars, code blocks: ${article.hasCodeBlocks}`);
      }
    }

    // Fallback to DOM scraping if GraphQL didn't have article data
    if (!article) {
      const articleUrlMatch = (mainTweet.entities?.urls || []).find(u =>
        (u.expanded_url || '').includes('/i/article/')
      );
      
      if (articleUrlMatch) {
        const articlePageUrl = articleUrlMatch.expanded_url;
        console.log(`  [Playwright] Article not in GraphQL, scraping DOM: ${articlePageUrl}`);
        try {
          article = await scrapeArticleContent(page, articlePageUrl);
          if (article.content) {
            console.log(`  [Playwright] Article DOM scraped: "${article.title}" (${article.content.length} chars, code blocks: ${article.hasCodeBlocks})`);
          }
        } catch (err) {
          console.error(`  [Playwright] Article DOM scrape failed: ${err.message}`);
        }
      }
    }

    return { tweet: mainTweet, threadTweets, article };

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  scrapeTweet,
  loadAuthToken,
  scrapeArticleContent,
  parseTweetFromGraphQL,
  parseGraphQLResponse
};

// ─── CLI Support ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node scrape_tweet.js <tweet-url>');
    console.log('Example: node scrape_tweet.js "https://x.com/user/status/123456789"');
    process.exit(1);
  }

  scrapeTweet(url, { headless: true })
    .then(result => {
      console.log('\n=== RESULT ===');
      console.log(`Tweet: @${result.tweet.author.userName}`);
      console.log(`Text: ${result.tweet.text.substring(0, 100)}`);
      console.log(`Likes: ${result.tweet.likeCount}, RT: ${result.tweet.retweetCount}, Views: ${result.tweet.viewCount}`);
      console.log(`Media: ${result.tweet.extendedEntities?.media?.length || 0} items`);
      if (result.threadTweets.length > 1) {
        console.log(`Thread: ${result.threadTweets.length} tweets`);
      }
      if (result.article) {
        console.log(`Article: "${result.article.title}" (${result.article.content?.length || 0} chars)`);
      }
      if (result.tweet.quoted_tweet) {
        console.log(`Quoted: @${result.tweet.quoted_tweet.author.userName}: ${result.tweet.quoted_tweet.text.substring(0, 60)}`);
      }
    })
    .catch(err => {
      console.error('FATAL:', err.message);
      process.exit(1);
    });
}
