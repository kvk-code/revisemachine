const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { scrapeTweet } = require('./scrape_tweet');

// FIXED: Import new utility modules for security and validation
const { 
  sanitizeGitHubOutput, 
  createSafeFilename, 
  sanitizeAndValidateId 
} = require('./utils/sanitize');

const { 
  parseTweetUrl, 
  isArticleUrl, 
  extractContentId,
  createSyntheticId,
  extractAndValidateContentId 
} = require('./utils/url_patterns');

const { 
  validateAuthRequirements 
} = require('./utils/auth_validation');

const API_KEY = process.env.TWITTER_API_KEY || '';
const AUTH_TOKEN = process.env.X_AUTH_TOKEN || '';
const TWEET_URL = process.env.TWEET_URL;

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, filepath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(filepath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(filepath); });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Twitter API Helpers (fallback when Playwright fails) ────────────────────

async function fetchTweet(tweetId) {
  const res = await httpGet(
    `https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`,
    { 'X-API-Key': API_KEY }
  );
  const data = JSON.parse(res.body);
  if (data.status !== 'success' || !data.tweets || !data.tweets.length) {
    throw new Error(`Failed to fetch tweet ${tweetId}: ${JSON.stringify(data)}`);
  }
  return data.tweets[0];
}

async function advancedSearch(query, cursor = null) {
  let url = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const res = await httpGet(url, { 'X-API-Key': API_KEY });
  return JSON.parse(res.body);
}

// ─── Text Processing ────────────────────────────────────────────────────────

function expandUrls(text, entities) {
  if (!entities || !entities.urls) return text;
  let out = text;
  for (const u of entities.urls) {
    if (u.url && u.expanded_url) {
      out = out.replace(u.url, u.expanded_url);
    }
  }
  return out;
}

function formatHashtags(text, entities) {
  if (!entities || !entities.hashtags) return text;
  let out = text;
  for (const h of entities.hashtags) {
    out = out.replace(new RegExp(`#${h.text}\\b`, 'g'), `[#${h.text}](https://x.com/hashtag/${h.text})`);
  }
  return out;
}

function formatMentions(text, entities) {
  if (!entities || !entities.user_mentions) return text;
  let out = text;
  for (const m of entities.user_mentions) {
    out = out.replace(new RegExp(`@${m.screen_name}\\b`, 'gi'), `[@${m.screen_name}](https://x.com/${m.screen_name})`);
  }
  return out;
}

function stripMediaUrls(text, extendedEntities) {
  // Media t.co URLs appear in the tweet text as placeholders. Since we embed
  // media directly in the markdown, strip them from the text.
  if (!extendedEntities || !extendedEntities.media) return text;
  let out = text;
  for (const m of extendedEntities.media) {
    if (m.url) {
      out = out.replace(m.url, '').trim();
    }
  }
  return out;
}

function processText(text, entities, extendedEntities) {
  let out = text || '';
  out = stripMediaUrls(out, extendedEntities);
  out = expandUrls(out, entities);
  out = formatHashtags(out, entities);
  out = formatMentions(out, entities);
  return out.trim();
}

function generateSlug(text, maxLength = 60) {
  if (!text) return 'untitled';
  
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
    .trim()
    .replace(/\s+/g, '-')         // Replace spaces with hyphens
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .substring(0, maxLength)      // Limit length
    .replace(/-+$/, '');          // Remove trailing hyphens
}

// ─── Media Handling ─────────────────────────────────────────────────────────

async function downloadMedia(tweet, mediaDir) {
  const mediaFiles = [];
  const extEntities = tweet.extendedEntities || {};
  const mediaItems = extEntities.media || [];

  for (let i = 0; i < mediaItems.length; i++) {
    const media = mediaItems[i];
    try {
      if (media.type === 'photo') {
        const imageUrl = media.media_url_https || media.media_url;
        if (imageUrl) {
          const ext = path.extname(imageUrl.split('?')[0]) || '.jpg';
          const filename = `image_${i + 1}${ext}`;
          const filepath = `${mediaDir}/${filename}`;
          await downloadFile(imageUrl, filepath);
          mediaFiles.push({ type: 'photo', localPath: filepath, originalUrl: imageUrl });
          console.log(`  Downloaded photo: ${filepath}`);
        }
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const vi = media.video_info;
        if (vi && vi.variants) {
          const mp4s = vi.variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (mp4s.length > 0) {
            const filename = media.type === 'animated_gif' ? `gif_${i + 1}.mp4` : `video_${i + 1}.mp4`;
            const filepath = `${mediaDir}/${filename}`;
            try {
              await downloadFile(mp4s[0].url, filepath);
              mediaFiles.push({ type: media.type, localPath: filepath, originalUrl: mp4s[0].url });
              console.log(`  Downloaded ${media.type}: ${filepath}`);
            } catch (dlErr) {
              console.error(`  Video download failed, linking instead: ${dlErr.message}`);
              mediaFiles.push({ type: media.type, localPath: null, originalUrl: mp4s[0].url });
            }
          }
        }
        // Also save the video thumbnail
        if (media.media_url_https) {
          const thumbPath = `${mediaDir}/thumb_${i + 1}.jpg`;
          try {
            await downloadFile(media.media_url_https, thumbPath);
            mediaFiles[mediaFiles.length - 1].thumbPath = thumbPath;
          } catch (e) { /* ignore */ }
        }
      }
    } catch (err) {
      console.error(`  Failed to download media ${i}: ${err.message}`);
      const fallbackUrl = media.media_url_https || media.media_url || '';
      if (fallbackUrl) {
        mediaFiles.push({ type: media.type || 'photo', localPath: null, originalUrl: fallbackUrl });
      }
    }
  }
  return mediaFiles;
}

async function downloadProfilePic(tweet, mediaDir) {
  if (!tweet.author || !tweet.author.profilePicture) return null;
  try {
    const url = tweet.author.profilePicture.replace('_normal', '_400x400');
    const filepath = `${mediaDir}/profile.jpg`;
    await downloadFile(url, filepath);
    console.log(`  Downloaded profile pic: ${filepath}`);
    return filepath;
  } catch (e) {
    console.error(`  Profile pic download failed: ${e.message}`);
    return tweet.author.profilePicture;
  }
}

// ─── Thread Detection & Fetching (API fallback) ─────────────────────────────
// Primary: handled inside scrapeTweet() via GraphQL interception.
// Fallback: fetchThreadTweets() uses twitterapi.io advanced search.

async function fetchThreadTweets(tweet) {
  const authorUsername = tweet.author.userName;
  const conversationId = tweet.conversationId || tweet.id;
  const allCandidates = [];

  const query = `from:${authorUsername} conversation_id:${conversationId}`;
  console.log(`  Searching thread with: ${query}`);
  let cursor = null;
  let pages = 0;
  const maxPages = 3;

  do {
    try {
      await sleep(5500);
      const data = await advancedSearch(query, cursor);
      const tweets = data.tweets || [];
      for (const tw of tweets) allCandidates.push(tw);
      cursor = data.has_next_page ? data.next_cursor : null;
      pages++;
      console.log(`  Page ${pages}: ${tweets.length} tweets found, ${allCandidates.length} total candidates`);
    } catch (e) {
      console.error(`  Error searching thread: ${e.message}`);
      break;
    }
  } while (cursor && pages < maxPages);

  // Filter to self-reply chain using inReplyToId
  const tweetMap = new Map();
  tweetMap.set(tweet.id, tweet);
  for (const tw of allCandidates) tweetMap.set(tw.id, tw);

  const hasReplyInfo = allCandidates.some(tw => tw.inReplyToId);

  if (hasReplyInfo) {
    const childrenOf = new Map();
    for (const [, tw] of tweetMap) {
      if (tw.inReplyToId && tw.author && tw.author.userName === authorUsername) {
        if (!childrenOf.has(tw.inReplyToId)) childrenOf.set(tw.inReplyToId, []);
        childrenOf.get(tw.inReplyToId).push(tw);
      }
    }

    let start = tweet;
    const backVisited = new Set();
    while (start.inReplyToId && tweetMap.has(start.inReplyToId) && !backVisited.has(start.inReplyToId)) {
      const parent = tweetMap.get(start.inReplyToId);
      if (parent.author && parent.author.userName === authorUsername) {
        backVisited.add(start.id);
        start = parent;
      } else break;
    }

    const chain = [start];
    const fwdVisited = new Set([start.id]);
    let current = start;
    while (chain.length < 50) {
      const children = childrenOf.get(current.id) || [];
      const selfReply = children.find(c => !fwdVisited.has(c.id));
      if (!selfReply) break;
      chain.push(selfReply);
      fwdVisited.add(selfReply.id);
      current = selfReply;
    }

    console.log(`  Self-reply chain: ${chain.length} tweets (filtered from ${allCandidates.length} candidates)`);
    return chain;
  }

  allCandidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set();
  return allCandidates.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  }).slice(0, 50);
}

// ─── Markdown Generation ────────────────────────────────────────────────────

// Media is stored at tweets/media/... on disk, but the markdown file lives
// inside tweets/, so relative references must strip the tweets/ prefix.
function mdRelativePath(fsPath) {
  if (!fsPath) return fsPath;
  if (fsPath.startsWith('tweets/')) return fsPath.substring('tweets/'.length);
  return fsPath;
}

function renderMediaMarkdown(mediaFiles) {
  if (!mediaFiles.length) return '';
  let md = '\n### Media\n\n';
  for (const m of mediaFiles) {
    const src = m.localPath ? mdRelativePath(m.localPath) : m.originalUrl;
    if (m.type === 'photo') {
      md += `![Image](${src})\n\n`;
    } else if (m.type === 'video') {
      if (m.thumbPath) {
        md += `[![Video Thumbnail](${mdRelativePath(m.thumbPath)})](${src})\n\n`;
      }
      if (m.localPath) {
        md += `**Video**: [Download](${src})\n\n`;
      } else {
        md += `**Video**: [Watch on Twitter](${m.originalUrl})\n\n`;
      }
    } else if (m.type === 'animated_gif') {
      if (m.localPath) {
        md += `**GIF**: [View](${src})\n\n`;
      } else {
        md += `**GIF**: [View on Twitter](${m.originalUrl})\n\n`;
      }
    }
  }
  return md;
}

function renderSingleTweet(tweet, processedText, mediaFiles, profilePicPath, index, total) {
  let md = '';
  if (total > 1) {
    md += `### Tweet ${index + 1} of ${total}\n\n`;
  }

  md += processedText + '\n';
  md += renderMediaMarkdown(mediaFiles);
  return md;
}

// ─── Article Handling ───────────────────────────────────────────────────────
// Article scraping is now handled inside scrapeTweet() via Playwright.
// The scraper returns article: { title, coverImage, content, hasCodeBlocks }

function detectArticleUrl(tweet) {
  const urls = (tweet.entities || {}).urls || [];
  for (const u of urls) {
    const expanded = u.expanded_url || '';
    if (expanded.includes('x.com/i/article/') || expanded.includes('twitter.com/i/article/')) {
      return expanded;
    }
  }
  return null;
}

// ─── Merge Logic ────────────────────────────────────────────────────────────
// When both Playwright and API return data, merge to get the most complete result.

function mergeMediaItems(pwMedia, apiMedia) {
  // Union of media from both sources, deduplicate by media_url_https
  const seen = new Set();
  const merged = [];
  for (const m of [...(pwMedia || []), ...(apiMedia || [])]) {
    const key = m.media_url_https || m.media_url || m.url || JSON.stringify(m);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(m);
    }
  }
  return merged;
}

function mergeTweetData(pwTweet, apiTweet) {
  if (!pwTweet) return apiTweet;
  if (!apiTweet) return pwTweet;

  // Merge media: union from both sources
  const mergedMedia = mergeMediaItems(
    (pwTweet.extendedEntities || {}).media,
    (apiTweet.extendedEntities || {}).media
  );

  // Merge entity URLs (union, deduplicate by expanded_url)
  const pwUrls = ((pwTweet.entities || {}).urls || []);
  const apiUrls = ((apiTweet.entities || {}).urls || []);
  const seenUrls = new Set();
  const mergedUrls = [];
  for (const u of [...pwUrls, ...apiUrls]) {
    const key = u.expanded_url || u.url;
    if (!seenUrls.has(key)) { seenUrls.add(key); mergedUrls.push(u); }
  }

  // Engagement: take max from each source
  const maxOf = (a, b) => Math.max(a || 0, b || 0);

  return {
    // Core data: prefer Playwright (handles long tweets via note_tweet)
    id: pwTweet.id || apiTweet.id,
    text: (pwTweet.text || '').length >= (apiTweet.text || '').length ? pwTweet.text : apiTweet.text,
    createdAt: pwTweet.createdAt || apiTweet.createdAt,
    url: pwTweet.url || apiTweet.url,
    conversationId: pwTweet.conversationId || apiTweet.conversationId,
    inReplyToId: pwTweet.inReplyToId || apiTweet.inReplyToId,
    inReplyToUserId: pwTweet.inReplyToUserId || apiTweet.inReplyToUserId,

    // Author: prefer Playwright, fill gaps from API
    author: {
      name: pwTweet.author?.name || apiTweet.author?.name || '',
      userName: pwTweet.author?.userName || apiTweet.author?.userName || '',
      profilePicture: pwTweet.author?.profilePicture || apiTweet.author?.profilePicture || '',
      verified: pwTweet.author?.verified || apiTweet.author?.verified || false,
      description: pwTweet.author?.description || apiTweet.author?.description || ''
    },

    // Article data: always from Playwright (API strips code blocks)
    articleData: pwTweet.articleData || null,

    // Merged entities
    entities: {
      urls: mergedUrls,
      hashtags: [...(pwTweet.entities?.hashtags || []), ...(apiTweet.entities?.hashtags || [])].filter(
        (h, i, arr) => arr.findIndex(x => x.text === h.text) === i
      ),
      user_mentions: [...(pwTweet.entities?.user_mentions || []), ...(apiTweet.entities?.user_mentions || [])].filter(
        (m, i, arr) => arr.findIndex(x => x.screen_name === m.screen_name) === i
      )
    },

    // Merged media (union from both)
    extendedEntities: { media: mergedMedia },

    // Engagement: take the higher values
    likeCount: maxOf(pwTweet.likeCount, apiTweet.likeCount),
    retweetCount: maxOf(pwTweet.retweetCount, apiTweet.retweetCount),
    replyCount: maxOf(pwTweet.replyCount, apiTweet.replyCount),
    viewCount: maxOf(pwTweet.viewCount, apiTweet.viewCount),
    bookmarkCount: maxOf(pwTweet.bookmarkCount, apiTweet.bookmarkCount),
    quoteCount: maxOf(pwTweet.quoteCount, apiTweet.quoteCount),

    // Quoted tweet: prefer whichever has it
    quoted_tweet: pwTweet.quoted_tweet || apiTweet.quoted_tweet || null,

    // Article flag
    isArticle: pwTweet.isArticle || apiTweet.isArticle
  };
}

function mergeThreads(pwThread, apiThread) {
  // Use whichever found more tweets; if equal, prefer Playwright
  if (!pwThread || pwThread.length === 0) return apiThread || [];
  if (!apiThread || apiThread.length === 0) return pwThread;
  if (pwThread.length >= apiThread.length) return pwThread;
  return apiThread;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!TWEET_URL) throw new Error('TWEET_URL environment variable is required');
  if (!AUTH_TOKEN && !API_KEY) throw new Error('At least one of X_AUTH_TOKEN or TWITTER_API_KEY is required');

  // FIXED: Use shared URL parsing utility with strict validation
  let urlParseResult;
  try {
    urlParseResult = extractAndValidateContentId(TWEET_URL);
  } catch (error) {
    throw new Error(`Invalid URL: ${error.message}`);
  }
  
  const isArticleUrl = urlParseResult.isArticle;
  const articleId = isArticleUrl ? urlParseResult.id : null;
  const tweetId = !isArticleUrl ? urlParseResult.id : null;

  if (isArticleUrl) {
    console.log(`Article URL detected: ${TWEET_URL}`);
    console.log(`Article ID: ${articleId}`);
    // Articles require Playwright (API doesn't support article content)
    if (!AUTH_TOKEN) {
      throw new Error('Article URLs require X_AUTH_TOKEN (Playwright). API-only mode is not supported for articles.');
    }
  } else {
    console.log(`Tweet ID: ${tweetId}`);
  }
  console.log(`Auth token: ${AUTH_TOKEN ? 'available' : 'not set'} | API key: ${API_KEY ? 'available' : 'not set'}`);

  // ── Strategy: Run both methods, merge for most complete result ──
  // Both available → run in parallel, merge results
  // One available → run that method only
  // Articles: always use Playwright content (API strips code blocks)
  
  let pwResult = null;   // Playwright result
  let apiResult = null;  // API result
  let tweet = null;
  let threadTweets = [];
  let article = null;
  let usedMethod = '';

  // ── Run both methods in parallel when both credentials available ──
  // For article URLs: API is skipped (Playwright only)
  if (AUTH_TOKEN && API_KEY && !isArticleUrl) {
    console.log('\n[Strategy] Both credentials available — running Playwright + API in parallel...');

    const [pwOutcome, apiOutcome] = await Promise.allSettled([
      (async () => {
        console.log('  [Playwright] Starting...');
        const result = await scrapeTweet(TWEET_URL, { headless: true });
        console.log('  [Playwright] Done');
        return result;
      })(),
      (async () => {
        console.log('  [API] Starting...');
        const tw = await fetchTweet(tweetId);
        let thread = [];
        const conversationId = tw.conversationId || tw.id;
        const isRoot = conversationId === tw.id;
        if ((isRoot && tw.replyCount > 0) || !isRoot) {
          thread = await fetchThreadTweets(tw);
        }
        console.log('  [API] Done');
        return { tweet: tw, threadTweets: thread };
      })()
    ]);

    if (pwOutcome.status === 'fulfilled') {
      pwResult = pwOutcome.value;
      console.log(`  [Playwright] ✓ Got tweet: @${pwResult.tweet?.author?.userName || '?'}, media: ${(pwResult.tweet?.extendedEntities?.media || []).length}, thread: ${(pwResult.threadTweets || []).length}`);
    } else {
      console.log(`  [Playwright] ✗ Failed: ${pwOutcome.reason?.message || 'unknown'}`);
    }

    if (apiOutcome.status === 'fulfilled') {
      apiResult = apiOutcome.value;
      console.log(`  [API] ✓ Got tweet: @${apiResult.tweet?.author?.userName || '?'}, media: ${(apiResult.tweet?.extendedEntities?.media || []).length}, thread: ${(apiResult.threadTweets || []).length}`);
    } else {
      console.log(`  [API] ✗ Failed: ${apiOutcome.reason?.message || 'unknown'}`);
    }

    // Merge results
    const pwTweet = pwResult?.tweet || null;
    const apiTweet = apiResult?.tweet || null;
    tweet = mergeTweetData(pwTweet, apiTweet);
    threadTweets = mergeThreads(pwResult?.threadTweets, apiResult?.threadTweets);
    article = pwResult?.article || null;

    if (pwTweet && apiTweet) {
      usedMethod = 'merged (playwright+api)';
      const pwMediaCount = (pwTweet.extendedEntities?.media || []).length;
      const apiMediaCount = (apiTweet.extendedEntities?.media || []).length;
      const mergedMediaCount = (tweet.extendedEntities?.media || []).length;
      console.log(`\n[Merge] Media: pw=${pwMediaCount} + api=${apiMediaCount} → merged=${mergedMediaCount}`);
      console.log(`[Merge] Thread: pw=${(pwResult?.threadTweets || []).length} | api=${(apiResult?.threadTweets || []).length} → used=${threadTweets.length}`);
      console.log(`[Merge] Engagement: likes=${tweet.likeCount}, retweets=${tweet.retweetCount}, views=${tweet.viewCount}`);
    } else if (pwTweet) {
      usedMethod = 'playwright';
    } else if (apiTweet) {
      usedMethod = 'api';
    }

  } else if (AUTH_TOKEN && isArticleUrl) {
    // ── Article URL mode: Playwright only ──
    try {
      console.log('\n[Strategy] Article URL — using Playwright only (API not supported for articles)...');
      const result = await scrapeTweet(TWEET_URL, { headless: true });
      
      if (!result) {
        throw new Error('scrapeTweet returned null/undefined');
      }
      
      tweet = result.tweet || null;
      threadTweets = result.threadTweets || [];
      article = result.article || null;
      usedMethod = 'playwright';
      console.log(`[Strategy] Playwright succeeded for article`);
      
      // If we got a tweet from the article scrape, use its ID
      if (tweet && tweet.id && tweet.id !== 'unknown') {
        tweetId = tweet.id;
      }
    } catch (err) {
      console.error(`[Strategy] Playwright failed for article: ${err.message}`);
      throw err;  // Re-throw for article URLs (no fallback available)
    }

  } else if (AUTH_TOKEN) {
    // ── Playwright only ──
    try {
      console.log('\n[Strategy] Auth token only — using Playwright...');
      const result = await scrapeTweet(TWEET_URL, { headless: true });
      tweet = result.tweet;
      threadTweets = result.threadTweets || [];
      article = result.article || null;
      usedMethod = 'playwright';
      console.log(`[Strategy] Playwright succeeded`);
    } catch (err) {
      console.error(`[Strategy] Playwright failed: ${err.message}`);
    }

  } else if (API_KEY) {
    // ── API only ──
    try {
      console.log('\n[Strategy] API key only — using Twitter API...');
      tweet = await fetchTweet(tweetId);
      usedMethod = 'api';
      console.log(`[Strategy] API succeeded`);

      const conversationId = tweet.conversationId || tweet.id;
      const isRoot = conversationId === tweet.id;
      if ((isRoot && tweet.replyCount > 0) || !isRoot) {
        console.log('Checking for thread (API)...');
        const apiThread = await fetchThreadTweets(tweet);
        if (apiThread.length > 1) threadTweets = apiThread;
      }
    } catch (err) {
      console.error(`[Strategy] API failed: ${err.message}`);
    }
  }

  if (!tweet && !article) {
    throw new Error('Failed to fetch tweet/article data. Both Playwright and API failed (or neither credential was provided).');
  }

  // For article URLs without parent tweet: create minimal synthetic tweet
  if (isArticleUrl && !tweet && article) {
    console.log('Article scraped without parent tweet, creating synthetic entry...');
    // FIXED: Use consistent synthetic ID format
    const syntheticId = createSyntheticId(articleId);
    tweet = {
      id: syntheticId,
      type: 'article',  // Type discriminator
      isSynthetic: true,  // Flag to indicate this is not a real tweet
      text: article.title || 'X Article',
      createdAt: new Date().toISOString(),
      url: TWEET_URL,
      articleUrl: TWEET_URL,
      author: {
        name: 'Article Author',  // Placeholder - could be scraped from page
        userName: 'article_bot',
        profilePicture: article.coverImage || '',  // Use article cover as avatar
        verified: false,
        description: ''
      },
      entities: { urls: [{ url: TWEET_URL, expanded_url: TWEET_URL, display_url: 'x.com/i/article/...' }], hashtags: [], user_mentions: [] },
      extendedEntities: { media: article.coverImage ? [{ media_url_https: article.coverImage, type: 'photo' }] : [] },
      likeCount: 0,
      retweetCount: 0,
      replyCount: 0,
      viewCount: 0,
      bookmarkCount: 0,
      quoteCount: 0,
      conversationId: '',
      inReplyToId: null,
      inReplyToUserId: null,
      isArticle: true
    };
  }

  // ── Article handling: Playwright-only ──
  const articleUrl = detectArticleUrl(tweet);
  if (articleUrl && !article && AUTH_TOKEN && usedMethod === 'api') {
    try {
      console.log('\n[Strategy] Article detected — scraping with Playwright for article content...');
      const result = await scrapeTweet(TWEET_URL, { headless: true });
      article = result.article || null;
      if (result.threadTweets && result.threadTweets.length > threadTweets.length) {
        threadTweets = result.threadTweets;
      }
    } catch (err) {
      console.error(`[Strategy] Playwright article scrape failed: ${err.message}`);
    }
  }

  console.log(`\nAuthor: @${tweet.author.userName}`);
  console.log(`Text: ${(tweet.text || '').substring(0, 80)}...`);
  console.log(`Method: ${usedMethod}`);

  // Determine tweet type
  const isArticle = isArticleUrl || !!articleUrl || !!article;
  const isThread = threadTweets.length > 1;
  const allTweets = isThread ? threadTweets : [tweet];

  if (!tweetId) tweetId = tweet.id;

  if (isThread) console.log(`Thread: ${allTweets.length} tweets from @${tweet.author.userName}`);
  if (isArticle) {
    if (article) {
      console.log(`Article scraped: "${article.title}"`);
    } else if (!AUTH_TOKEN) {
      console.log(`Article detected but cannot scrape — X Auth Token is required for article content`);
    } else {
      console.log(`Article detected but scrape failed`);
    }
  }

  // Setup directories
  const mediaDir = `tweets/media/${tweetId}`;
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync('tweets', { recursive: true });

  // Download profile pic
  const profilePicPath = await downloadProfilePic(tweet, mediaDir);

  // Process each tweet (download media, process text)
  const tweetDataList = [];
  for (let i = 0; i < allTweets.length; i++) {
    const tw = allTweets[i];
    console.log(`\nProcessing tweet ${i + 1}/${allTweets.length}: ${tw.id}`);
    
    const twMediaDir = i === 0 ? mediaDir : `tweets/media/${tw.id}`;
    if (i > 0) fs.mkdirSync(twMediaDir, { recursive: true });

    const processedText = processText(tw.text, tw.entities, tw.extendedEntities);
    const mediaFiles = await downloadMedia(tw, twMediaDir);
    
    tweetDataList.push({ tweet: tw, processedText, mediaFiles });
  }

  // ── Generate Markdown ──

  const firstTweetText = allTweets[0].text || '';
  const slug = generateSlug(firstTweetText, 50);
  const authorSlug = generateSlug(tweet.author.userName, 20);
  const filename = `tweets/${authorSlug}_${slug}.md`;
  const totalMedia = tweetDataList.reduce((sum, d) => sum + d.mediaFiles.length, 0);

  let md = `---
tweet_id: "${tweet.id}"
type: "${isArticle ? 'article' : isThread ? 'thread' : 'tweet'}"
author: "${tweet.author.name}"
author_username: "@${tweet.author.userName}"
created_at: "${tweet.createdAt}"
source_url: "${tweet.url}"
likes: ${tweet.likeCount || 0}
retweets: ${tweet.retweetCount || 0}
replies: ${tweet.replyCount || 0}
views: ${tweet.viewCount || 0}
bookmarks: ${tweet.bookmarkCount || 0}
quotes: ${tweet.quoteCount || 0}
is_thread: ${isThread}
thread_count: ${allTweets.length}
media_count: ${totalMedia}
method: "${usedMethod}"
saved_at: "${new Date().toISOString()}"
---

`;

  // Author header
  const authorLine = profilePicPath
    ? `<img src="${mdRelativePath(profilePicPath)}" alt="@${tweet.author.userName}" width="48" height="48" style="border-radius:50%;vertical-align:middle;"> `
    : '';
  md += `${authorLine}**${tweet.author.name}** · [@${tweet.author.userName}](https://x.com/${tweet.author.userName})\n\n`;
  md += `${tweet.createdAt}\n\n`;
  md += `---\n\n`;

  // Title
  if (isThread) {
    md += `# Thread by @${tweet.author.userName} (${allTweets.length} tweets)\n\n`;
  } else if (isArticle) {
    md += `# Article by @${tweet.author.userName}\n\n`;
  } else {
    md += `# Tweet by @${tweet.author.userName}\n\n`;
  }

  // Content
  for (let i = 0; i < tweetDataList.length; i++) {
    const { tweet: tw, processedText, mediaFiles } = tweetDataList[i];
    md += renderSingleTweet(tw, processedText, mediaFiles, profilePicPath, i, allTweets.length);
    if (i < tweetDataList.length - 1) md += '---\n\n';
  }

  // If article, embed scraped article content
  if (isArticle) {
    const artUrl = articleUrl || (article ? '' : '');
    md += `---\n\n## Article Content\n\n`;
    if (artUrl) md += `**Article URL**: [${artUrl}](${artUrl})\n\n`;
    
    if (article && article.content) {
      if (article.coverImage) md += `![Cover](${article.coverImage})\n\n`;
      if (article.title) md += `### ${article.title}\n\n`;
      md += article.content + '\n\n';
    } else if (!AUTH_TOKEN) {
      md += `> *Article content requires X Auth Token for extraction (code blocks cannot be retrieved via API). Visit the link above to read the full article.*\n\n`;
    } else {
      md += `> *Article content could not be extracted. Visit the link above to read the full article.*\n\n`;
    }
  }

  // Quoted tweet
  if (tweet.quoted_tweet && tweet.quoted_tweet.text) {
    md += `---\n\n## Quoted Tweet\n\n`;
    md += `> **${tweet.quoted_tweet.author?.name || 'Unknown'}** (@${tweet.quoted_tweet.author?.userName || 'unknown'}):\n>\n`;
    const qtText = processText(tweet.quoted_tweet.text, tweet.quoted_tweet.entities, tweet.quoted_tweet.extendedEntities);
    for (const line of qtText.split('\n')) {
      md += `> ${line}\n`;
    }
    if (tweet.quoted_tweet.url) {
      md += `>\n> [View original](${tweet.quoted_tweet.url})\n`;
    }
    md += '\n';
  }

  // Engagement
  md += `---\n\n## Engagement\n\n`;
  md += `| Metric | Count |\n|--------|-------|\n`;
  md += `| Likes | ${tweet.likeCount || 0} |\n`;
  md += `| Retweets | ${tweet.retweetCount || 0} |\n`;
  md += `| Replies | ${tweet.replyCount || 0} |\n`;
  md += `| Views | ${tweet.viewCount || 0} |\n`;
  md += `| Bookmarks | ${tweet.bookmarkCount || 0} |\n`;
  md += `| Quotes | ${tweet.quoteCount || 0} |\n\n`;

  // Source
  md += `## Source\n\n`;
  md += `- **Original**: [View on X](${tweet.url})\n`;
  md += `- **Archived**: ${new Date().toISOString()}\n`;

  fs.writeFileSync(filename, md);
  console.log(`\nGenerated: ${filename}`);

  // GitHub Actions output
  // FIXED: Sanitize outputs to prevent injection attacks
  if (process.env.GITHUB_OUTPUT) {
    const outputId = tweetId || articleId;
    if (!outputId) {
      throw new Error('No valid ID available for GitHub Actions output');
    }
    
    try {
      // Sanitize and validate the ID
      const safeOutputId = sanitizeAndValidateId(outputId);
      const safeFilename = sanitizeGitHubOutput(filename);
      
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `filename=${safeFilename}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `tweet_id=${safeOutputId}\n`);
    } catch (error) {
      throw new Error(`GitHub output sanitization failed: ${error.message}`);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
