const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

// Helper to download file
async function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(filepath);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

// Helper to expand t.co URLs in text
function expandUrls(text, entities) {
  if (!entities || !entities.urls) return text;
  let expandedText = text;
  for (const urlEntity of entities.urls) {
    if (urlEntity.url && urlEntity.expanded_url) {
      expandedText = expandedText.replace(urlEntity.url, urlEntity.expanded_url);
    }
  }
  return expandedText;
}

// Helper to format hashtags as links
function formatHashtags(text, entities) {
  if (!entities || !entities.hashtags) return text;
  let formattedText = text;
  for (const hashtag of entities.hashtags) {
    const tag = hashtag.text;
    formattedText = formattedText.replace(
      new RegExp(`#${tag}\\b`, 'g'),
      `[#${tag}](https://twitter.com/hashtag/${tag})`
    );
  }
  return formattedText;
}

// Helper to format mentions as links
function formatMentions(text, entities) {
  if (!entities || !entities.user_mentions) return text;
  let formattedText = text;
  for (const mention of entities.user_mentions) {
    const username = mention.screen_name;
    formattedText = formattedText.replace(
      new RegExp(`@${username}\\b`, 'gi'),
      `[@${username}](https://twitter.com/${username})`
    );
  }
  return formattedText;
}

async function processTweet() {
  const tweetData = JSON.parse(fs.readFileSync('tweet_response.json', 'utf8'));
  const tweet = tweetData.tweets[0];
  
  const tweetId = tweet.id;
  const datePrefix = process.argv[2] || new Date().toISOString().split('T')[0];
  const mediaDir = `tweets/media/${tweetId}`;
  
  // Create media directory for this tweet
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
  
  // Process text - expand URLs, format hashtags and mentions
  let processedText = tweet.text || '';
  processedText = expandUrls(processedText, tweet.entities);
  processedText = formatHashtags(processedText, tweet.entities);
  processedText = formatMentions(processedText, tweet.entities);
  
  // Download media
  const mediaFiles = [];
  const extendedEntities = tweet.extendedEntities || {};
  const mediaItems = extendedEntities.media || [];
  
  for (let i = 0; i < mediaItems.length; i++) {
    const media = mediaItems[i];
    const mediaType = media.type;
    
    try {
      if (mediaType === 'photo') {
        const imageUrl = media.media_url_https || media.media_url;
        if (imageUrl) {
          const ext = path.extname(imageUrl.split('?')[0]) || '.jpg';
          const filename = `image_${i + 1}${ext}`;
          const filepath = `${mediaDir}/${filename}`;
          await downloadFile(imageUrl, filepath);
          mediaFiles.push({ type: 'image', path: filepath, alt: `Image ${i + 1}` });
          console.log(`Downloaded: ${filepath}`);
        }
      } else if (mediaType === 'video' || mediaType === 'animated_gif') {
        const videoInfo = media.video_info;
        if (videoInfo && videoInfo.variants) {
          // Get highest quality MP4
          const mp4Variants = videoInfo.variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          
          if (mp4Variants.length > 0) {
            const videoUrl = mp4Variants[0].url;
            const filename = `video_${i + 1}.mp4`;
            const filepath = `${mediaDir}/${filename}`;
            await downloadFile(videoUrl, filepath);
            mediaFiles.push({ type: 'video', path: filepath, alt: `Video ${i + 1}` });
            console.log(`Downloaded: ${filepath}`);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to download media: ${err.message}`);
      // Fall back to direct URL
      if (media.media_url_https) {
        mediaFiles.push({ type: 'image', path: media.media_url_https, alt: `Image ${i + 1}`, external: true });
      }
    }
  }
  
  // Download author profile picture
  let profilePicPath = tweet.author.profilePicture;
  try {
    if (tweet.author.profilePicture) {
      const profileUrl = tweet.author.profilePicture.replace('_normal', '_400x400');
      const profileFilename = `${mediaDir}/profile.jpg`;
      await downloadFile(profileUrl, profileFilename);
      profilePicPath = profileFilename;
      console.log(`Downloaded profile pic: ${profileFilename}`);
    }
  } catch (err) {
    console.error(`Failed to download profile pic: ${err.message}`);
  }
  
  // Generate markdown
  const filename = `tweets/${datePrefix}-${tweetId}.md`;
  
  let markdown = `---
tweet_id: "${tweet.id}"
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
is_thread: false
media_count: ${mediaFiles.length}
saved_at: "${new Date().toISOString()}"
---

# Tweet by ${tweet.author.name} (@${tweet.author.userName})

<img src="${profilePicPath}" alt="Profile Picture" width="48" height="48" style="border-radius: 50%;">

**[@${tweet.author.userName}](https://twitter.com/${tweet.author.userName})** · ${tweet.createdAt}

---

## Content

${processedText}

`;
  
  // Add media section
  if (mediaFiles.length > 0) {
    markdown += `\n## Media\n\n`;
    for (const media of mediaFiles) {
      if (media.type === 'image') {
        markdown += `![${media.alt}](${media.path})\n\n`;
      } else if (media.type === 'video') {
        markdown += `🎬 **Video**: [${media.alt}](${media.path})\n\n`;
      }
    }
  }
  
  // Add quoted tweet if present
  if (tweet.quoted_tweet) {
    markdown += `\n## Quoted Tweet\n\n`;
    markdown += `> **@${tweet.quoted_tweet.author?.userName || 'unknown'}**: ${tweet.quoted_tweet.text || ''}\n`;
    markdown += `> [View quoted tweet](${tweet.quoted_tweet.url || ''})\n\n`;
  }
  
  // Add metadata
  markdown += `---

## Engagement

| Metric | Count |
|--------|-------|
| ❤️ Likes | ${tweet.likeCount || 0} |
| 🔁 Retweets | ${tweet.retweetCount || 0} |
| 💬 Replies | ${tweet.replyCount || 0} |
| 👁️ Views | ${tweet.viewCount || 0} |
| 🔖 Bookmarks | ${tweet.bookmarkCount || 0} |
| 💭 Quotes | ${tweet.quoteCount || 0} |

## Source

- **Original Tweet**: [View on Twitter](${tweet.url})
- **Archived**: ${new Date().toISOString()}
`;
  
  fs.writeFileSync(filename, markdown);
  console.log(`Generated: ${filename}`);
  
  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `filename=${filename}\n`);
  }
}

processTweet().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
