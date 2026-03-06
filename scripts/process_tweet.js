const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

// Playwright scraper for authenticated article fetching (code blocks support)
let articleScraper = null;
try {
  articleScraper = require('./scrape_article');
} catch (e) {
  // Playwright not installed - will use API only
}

const API_KEY = process.env.TWITTER_API_KEY;
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

// ─── Twitter API Helpers ────────────────────────────────────────────────────

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

// ─── Thread Detection & Fetching ────────────────────────────────────────────

async function fetchThreadTweets(tweet) {
  const authorUsername = tweet.author.userName;
  const conversationId = tweet.conversationId || tweet.id;
  const allCandidates = [];

  // Use Advanced Search: "from:author conversation_id:id" finds all author tweets in the conversation
  const query = `from:${authorUsername} conversation_id:${conversationId}`;
  console.log(`  Searching thread with: ${query}`);
  let cursor = null;
  let pages = 0;
  const maxPages = 3;

  do {
    try {
      await sleep(5500); // rate limit
      const data = await advancedSearch(query, cursor);
      const tweets = data.tweets || [];

      for (const tw of tweets) {
        allCandidates.push(tw);
      }

      cursor = data.has_next_page ? data.next_cursor : null;
      pages++;
      console.log(`  Page ${pages}: ${tweets.length} tweets found, ${allCandidates.length} total candidates from @${authorUsername}`);
    } catch (e) {
      console.error(`  Error searching thread: ${e.message}`);
      break;
    }
  } while (cursor && pages < maxPages);

  // ── Filter to self-reply chain using inReplyToId ──
  // The broad search returns ALL author tweets in the conversation, but a
  // thread is only the chain of self-replies (each tweet replying to the
  // author's own previous tweet). Without this filter, an author who replies
  // to many different people in a conversation would have all those replies
  // incorrectly treated as thread tweets.

  // Build a map of all candidate tweets (include the original tweet)
  const tweetMap = new Map();
  tweetMap.set(tweet.id, tweet);
  for (const tw of allCandidates) {
    tweetMap.set(tw.id, tw);
  }

  // Check if inReplyToId data is available for chain-walking
  const hasReplyInfo = allCandidates.some(tw => tw.inReplyToId);

  if (hasReplyInfo) {
    // Build parent → children map (same-author children only)
    const childrenOf = new Map();
    for (const [, tw] of tweetMap) {
      if (tw.inReplyToId && tw.author && tw.author.userName === authorUsername) {
        if (!childrenOf.has(tw.inReplyToId)) childrenOf.set(tw.inReplyToId, []);
        childrenOf.get(tw.inReplyToId).push(tw);
      }
    }

    // Walk backward from the submitted tweet to find the thread start
    let start = tweet;
    const backVisited = new Set();
    while (start.inReplyToId && tweetMap.has(start.inReplyToId) && !backVisited.has(start.inReplyToId)) {
      const parent = tweetMap.get(start.inReplyToId);
      if (parent.author && parent.author.userName === authorUsername) {
        backVisited.add(start.id);
        start = parent;
      } else {
        break;
      }
    }

    // Walk forward from the thread start, following self-replies
    const chain = [start];
    const fwdVisited = new Set([start.id]);
    let current = start;
    const maxChain = 50;

    while (chain.length < maxChain) {
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

  // Fallback: inReplyToId not available — return all but capped and sorted
  console.log(`  Warning: inReplyToId not available, returning all ${allCandidates.length} candidates`);
  allCandidates.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

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

// Known code language identifiers that the API may return as separate blocks
const CODE_LANG_IDENTIFIERS = new Set([
  'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'java', 'c', 'cpp', 'c++',
  'csharp', 'c#', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'r',
  'sql', 'html', 'css', 'scss', 'sass', 'less', 'json', 'yaml', 'yml', 'xml',
  'bash', 'shell', 'sh', 'zsh', 'powershell', 'ps1', 'dockerfile', 'docker',
  'markdown', 'md', 'text', 'plaintext', 'txt', 'solidity', 'sol', 'move',
  'graphql', 'gql', 'toml', 'ini', 'conf', 'config', 'env', 'jsx', 'tsx',
  'vue', 'svelte', 'astro', 'prisma', 'hcl', 'terraform', 'nginx', 'apache'
]);

function isCodeLangIdentifier(text) {
  const trimmed = (text || '').trim().toLowerCase();
  return CODE_LANG_IDENTIFIERS.has(trimmed) || /^[a-z]{1,15}$/.test(trimmed);
}

function processArticleContents(contents) {
  // The API returns code blocks as: [{ text: "language" }, { text: "code content" }]
  // We need to detect this pattern and reconstruct proper markdown code blocks
  const result = [];
  let i = 0;

  while (i < contents.length) {
    const block = contents[i];
    const text = (block.text || '').trim();
    
    if (!text) {
      i++;
      continue;
    }

    // Check if this looks like a standalone language identifier
    // (short single word that matches known languages)
    const nextBlock = contents[i + 1];
    const nextText = nextBlock ? (nextBlock.text || '').trim() : '';
    
    if (isCodeLangIdentifier(text) && text.length < 20 && !text.includes(' ') && nextText) {
      // This appears to be a code language identifier followed by code content
      const lang = text.toLowerCase();
      // The next block(s) might be the code content
      // Collect subsequent blocks until we hit another language identifier or a long paragraph
      let codeContent = nextText;
      i += 2;
      
      // Check if subsequent blocks are also part of this code block
      while (i < contents.length) {
        const checkBlock = contents[i];
        const checkText = (checkBlock.text || '').trim();
        
        // Stop if we hit another language identifier or a long paragraph-like text
        if (!checkText || 
            (isCodeLangIdentifier(checkText) && checkText.length < 20 && !checkText.includes(' ')) ||
            (checkText.length > 200 && checkText.includes('. '))) {
          break;
        }
        
        // If this looks like more code (contains code-like characters), add it
        if (checkText.includes('{') || checkText.includes('}') || 
            checkText.includes('(') || checkText.includes(')') ||
            checkText.includes(':') || checkText.includes('=') ||
            checkText.startsWith('-') || checkText.startsWith('#') ||
            /^\d+\./.test(checkText)) {
          codeContent += '\n' + checkText;
          i++;
        } else {
          break;
        }
      }
      
      result.push('```' + lang + '\n' + codeContent + '\n```');
    } else {
      // Regular text block
      result.push(text);
      i++;
    }
  }

  return result.filter(t => t.trim().length > 0).join('\n\n');
}

function hasEmptyCodeBlocks(contents) {
  if (!contents || !Array.isArray(contents)) return false;
  // Count empty/whitespace-only blocks - indicates stripped code blocks
  const emptyBlocks = contents.filter(c => {
    const text = (c.text || '').trim();
    return text === '' || text === ' ';
  }).length;
  return emptyBlocks >= 3;
}

async function fetchArticleContent(tweetId, articleUrl) {
  try {
    console.log(`  Fetching article via twitterapi.io Article API for tweet ${tweetId}...`);
    await sleep(5500); // rate limit
    const res = await httpGet(
      `https://api.twitterapi.io/twitter/article?tweet_id=${tweetId}`,
      { 'X-API-Key': API_KEY }
    );
    const data = JSON.parse(res.body);
    if (data.status !== 'success' || !data.article) {
      console.error(`  Article API returned: ${JSON.stringify(data).substring(0, 200)}`);
      return { title: '', coverImage: '', content: null };
    }

    const article = data.article;
    const title = article.title || '';
    const coverImage = article.cover_media_img_url || '';
    const contents = article.contents || [];

    // Check if API stripped code blocks (returns empty whitespace blocks)
    const emptyBlockCount = contents.filter(c => (c.text || '').trim() === '' || (c.text || '').trim() === ' ').length;
    const codeBlocksStripped = hasEmptyCodeBlocks(contents);
    
    if (codeBlocksStripped) {
      console.log(`  ⚠️  Detected ${emptyBlockCount} empty blocks - code blocks likely stripped by API`);
      
      // Try Playwright scraper with cookies if available
      if (articleScraper && articleUrl) {
        console.log(`  Attempting Playwright scrape with cookies...`);
        try {
          const scraped = await articleScraper.scrapeArticle(articleUrl, { headless: true });
          
          if (scraped.needsCookies) {
            console.log(`  ⚠️  No X cookies found. Export your cookies to x_cookies.json for full article content.`);
          } else if (scraped.content && scraped.content.length > 100) {
            console.log(`  ✓ Playwright scraped: "${scraped.title || title}" (${scraped.content.length} chars)`);
            if (scraped.hasCodeBlocks) {
              console.log(`  ✓ Code blocks successfully extracted!`);
            }
            return {
              title: scraped.title || title,
              coverImage: scraped.coverImage || coverImage,
              content: scraped.content,
              codeBlocksStripped: false
            };
          }
        } catch (scrapeErr) {
          console.error(`  Playwright scrape failed: ${scrapeErr.message}`);
        }
      }
    }

    // Build article text from content blocks with code block reconstruction
    const contentText = processArticleContents(contents);

    console.log(`  Article fetched: "${title}" (${contentText.length} chars, ${contents.length} blocks)`);
    return { title, coverImage, content: contentText || null, codeBlocksStripped };
  } catch (e) {
    console.error(`  Article API failed: ${e.message}`);
    return { title: '', coverImage: '', content: null };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) throw new Error('TWITTER_API_KEY environment variable is required');
  if (!TWEET_URL) throw new Error('TWEET_URL environment variable is required');

  // Extract tweet ID
  const idMatch = TWEET_URL.match(/status\/(\d+)/);
  if (!idMatch) throw new Error(`Could not extract tweet ID from: ${TWEET_URL}`);
  const tweetId = idMatch[1];
  console.log(`Tweet ID: ${tweetId}`);

  // Fetch the main tweet
  const tweet = await fetchTweet(tweetId);
  console.log(`Author: @${tweet.author.userName}`);
  console.log(`Text: ${(tweet.text || '').substring(0, 80)}...`);

  // Determine tweet type
  const articleUrl = detectArticleUrl(tweet);
  const isArticle = !!articleUrl;
  const conversationId = tweet.conversationId || tweet.id;
  const isConversationRoot = conversationId === tweet.id;

  // Setup directories
  const createdDate = tweet.createdAt ? new Date(tweet.createdAt) : new Date();
  const datePrefix = createdDate.toISOString().split('T')[0];
  const mediaDir = `tweets/media/${tweetId}`;
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync('tweets', { recursive: true });

  // Download profile pic
  const profilePicPath = await downloadProfilePic(tweet, mediaDir);

  // ── Handle based on type ──

  let allTweets = [tweet];
  let isThread = false;

  // Check for thread: fetch replies and look for same-author self-reply chain
  if (isConversationRoot && tweet.replyCount > 0) {
    console.log('Checking for thread (same-author replies)...');
    const threadTweets = await fetchThreadTweets(tweet);
    if (threadTweets.length > 1) {
      isThread = true;
      allTweets = threadTweets;
      console.log(`Thread detected: ${allTweets.length} tweets from @${tweet.author.userName}`);
    }
  } else if (!isConversationRoot) {
    // This tweet is a reply in a conversation - check if it's part of a thread by the same author
    console.log('Tweet is part of a conversation, checking for thread...');
    const threadTweets = await fetchThreadTweets(tweet);
    if (threadTweets.length > 1) {
      isThread = true;
      allTweets = threadTweets;
      console.log(`Thread detected: ${allTweets.length} tweets from @${tweet.author.userName}`);
    }
  }

  // Process each tweet
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

  // Generate human-friendly filename: authorname_slug.md
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

  // If article, fetch and embed article content via API
  if (isArticle) {
    md += `---\n\n## Article Content\n\n`;
    md += `**Article URL**: [${articleUrl}](${articleUrl})\n\n`;
    const { title, coverImage, content, codeBlocksStripped } = await fetchArticleContent(tweetId, articleUrl);
    if (coverImage) md += `![Cover](${coverImage})\n\n`;
    if (title) md += `### ${title}\n\n`;
    if (codeBlocksStripped) {
      md += `> ⚠️ **Note**: This article contains code blocks that could not be extracted due to API limitations. Please visit the original article link above to view the complete content with code examples.\n\n`;
    }
    if (content) {
      md += content + '\n\n';
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
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `filename=${filename}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tweet_id=${tweetId}\n`);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
