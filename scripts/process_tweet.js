const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

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

async function fetchReplies(tweetId, cursor = null) {
  let url = `https://api.twitterapi.io/twitter/tweet/replies?tweetId=${tweetId}`;
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
  const tweetId = tweet.id;
  const authorTweets = [];

  // If this tweet IS the conversation root, fetch replies and filter for author
  // If this tweet is NOT the root, fetch the root first, then replies
  let rootTweet = tweet;
  if (conversationId && conversationId !== tweetId) {
    console.log(`  Fetching conversation root: ${conversationId}`);
    try {
      await sleep(5500); // rate limit
      rootTweet = await fetchTweet(conversationId);
      if (rootTweet.author.userName === authorUsername) {
        authorTweets.push(rootTweet);
      }
    } catch (e) {
      console.error(`  Could not fetch root tweet: ${e.message}`);
    }
  }

  // Fetch replies (paginated) and filter for same-author tweets
  console.log(`  Fetching replies for conversation ${conversationId}...`);
  let cursor = null;
  let pages = 0;
  const maxPages = 5; // limit pagination

  do {
    try {
      await sleep(5500); // rate limit
      const data = await fetchReplies(conversationId, cursor);
      const replies = data.tweets || data.replies || [];
      
      for (const reply of replies) {
        if (reply.author && reply.author.userName === authorUsername) {
          authorTweets.push(reply);
        }
      }

      cursor = data.has_next_page ? data.next_cursor : null;
      pages++;
      console.log(`  Page ${pages}: ${replies.length} replies, ${authorTweets.length} from author so far`);
    } catch (e) {
      console.error(`  Error fetching replies page: ${e.message}`);
      break;
    }
  } while (cursor && pages < maxPages);

  // Sort by ID (chronological)
  authorTweets.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // Deduplicate
  const seen = new Set();
  return authorTweets.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// ─── Markdown Generation ────────────────────────────────────────────────────

function renderMediaMarkdown(mediaFiles) {
  if (!mediaFiles.length) return '';
  let md = '\n### Media\n\n';
  for (const m of mediaFiles) {
    const src = m.localPath || m.originalUrl;
    if (m.type === 'photo') {
      md += `![Image](${src})\n\n`;
    } else if (m.type === 'video') {
      if (m.thumbPath) {
        md += `[![Video Thumbnail](${m.thumbPath})](${src})\n\n`;
      }
      if (m.localPath) {
        md += `**Video**: [Download](${m.localPath})\n\n`;
      } else {
        md += `**Video**: [Watch on Twitter](${m.originalUrl})\n\n`;
      }
    } else if (m.type === 'animated_gif') {
      if (m.localPath) {
        md += `**GIF**: [View](${m.localPath})\n\n`;
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

async function fetchArticleContent(articleUrl) {
  // X/Twitter articles are JavaScript-rendered SPAs. Server-side fetching
  // cannot extract their content. We note this clearly in the markdown.
  console.log(`  Note: X articles require JavaScript rendering - content extraction not possible via server-side fetch`);
  return { title: '', content: null };
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

  // Check for thread: fetch replies and look for same-author tweets
  if (isConversationRoot && (tweet.replyCount > 0 || tweet.quoteCount > 0)) {
    console.log('Checking for thread (same-author replies)...');
    const threadTweets = await fetchThreadTweets(tweet);
    // If we found additional tweets from the same author, it's a thread
    const additional = threadTweets.filter(t => t.id !== tweet.id);
    if (additional.length > 0) {
      isThread = true;
      // Ensure root tweet is first
      allTweets = [tweet, ...additional];
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

  const filename = `tweets/${datePrefix}-${tweetId}.md`;
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
    ? `<img src="${profilePicPath}" alt="@${tweet.author.userName}" width="48" height="48" style="border-radius:50%;vertical-align:middle;"> `
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

  // If article, add article link section
  if (isArticle) {
    md += `---\n\n## Article\n\n`;
    md += `**Read the full article**: [${articleUrl}](${articleUrl})\n\n`;
    md += `> *X/Twitter articles are JavaScript-rendered and cannot be archived server-side. Visit the link above to read the full article.*\n\n`;
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
