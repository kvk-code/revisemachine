# ReviseMachine - Save Tweets to Your GitHub Repository

A fully decentralized, self-hosted, open-source solution to save tweets as markdown files in your GitHub repository.

## ✨ Features

- **Dual-Mode Scraping**: Uses Playwright (auth_token) as primary, with twitterapi.io API as fallback — runs both in parallel and merges best results
- **Article Code Blocks**: Full article extraction including code blocks (API-only solutions strip them)
- **Large Video Support**: Git LFS automatically handles videos over 100MB — no more push failures
- **Smart Filenames**: Local LLM generates semantic titles like `author_building-a-cli-tool.md` instead of generic timestamps
- **Privacy First**: All credentials stored locally in your browser - never sent to any server
- **IPFS Ready**: Static frontend can be hosted on IPFS for censorship resistance
- **Markdown Output**: Tweets saved as clean markdown with full metadata
- **Thread Support**: Automatically detects and archives all tweets in a thread by the same author
- **Media Downloads**: Downloads images, videos, and thumbnails to your repository
- **GitHub Actions**: Processing happens in your own GitHub repository
- **Dark/Light Theme**: Futuristic cybernetic design with a theme toggle that persists across sessions

## 🚀 Quick Start

### 1. Create Your Own Copy of This Repository

**Option A: Use Template (Recommended)**
1. Click the green **"Use this template"** button at the top of this repo
2. Name your new repository (e.g., `my-saved-tweets`)
3. **Important**: Set visibility to **Private** to keep your tweets private

**Option B: Fork & Make Private**
1. Fork this repository
2. Go to **Settings** → **General** → **Danger Zone** → **Change visibility** → **Make private**

### 2. Get Your X Auth Token (Primary) — FREE

The **X auth_token** is the primary scraping method — it's free and provides full article content including code blocks.

1. Log into [x.com](https://x.com)
2. Open DevTools (`F12`) → Application → Cookies → `x.com`
3. Find `auth_token` and copy its value
4. See [AUTH_TOKEN_GUIDE.md](AUTH_TOKEN_GUIDE.md) for detailed instructions (Chrome, Safari, mobile)

### 3. Get Twitter API Key (Optional Fallback)

The API key is optional — used as fallback when Playwright fails.

1. Go to [twitterapi.io/dashboard](https://twitterapi.io/dashboard)
2. Sign up and get your API key (~$0.15 per 1000 tweets)

### 4. Create a Fine-Grained PAT (Repository-Scoped)

**This is more secure than account-wide tokens!**

1. Go to [GitHub Fine-Grained Tokens](https://github.com/settings/personal-access-tokens/new)
2. **Token name**: `ReviseMachine - my-saved-tweets` (or your repo name)
3. **Expiration**: Choose your preference (90 days recommended)
4. **Repository access**: Select **"Only select repositories"**
5. **Select your ReviseMachine repository** from the dropdown
6. **Permissions** → **Repository permissions**:
   - **Contents**: Read and write
   - **Secrets**: Read and write (for automatic secret creation)
   - **Actions**: Read and write (to trigger workflows)
   - **Metadata**: Read-only (auto-selected)
7. Click **Generate token** and copy it

> ⚠️ **Security Note**: This token can ONLY access your ReviseMachine repository, not your other repos!

### 5. Use the Frontend to Save Credentials

The frontend can **automatically create the GitHub Secret** for you:

1. Open `frontend/index.html` in your browser
2. Enter your repository, PAT, and Twitter API key
3. Click **"🔐 Save Twitter Key to GitHub Secret"**
4. The secret `TWITTER_API_KEY` will be securely created in your repository

This uses **libsodium encryption** in your browser - the key is encrypted before being sent to GitHub.

### 6. Use the Frontend

Open `frontend/index.html` in your browser (or access via IPFS), then:

1. Enter your repository name (e.g., `username/my-saved-tweets`)
2. Paste your **repository-scoped** GitHub PAT
3. Paste your twitterapi.io API key
4. Click "Save Configuration"

Now you can paste any tweet URL and save it!

## 📁 Project Structure

```
revisemachine/
├── .github/
│   └── workflows/
│       └── save-tweet.yml    # GitHub Action that fetches and saves tweets
├── frontend/
│   ├── index.html            # Static frontend (IPFS-ready, futuristic dark theme)
│   └── interest.html         # Expression-of-interest form (encrypted submissions)
├── scripts/
│   └── process_tweet.js      # Tweet processing logic (threads, articles, media)
├── tweets/                   # Your saved tweets will appear here
│   └── media/                # Downloaded images and videos
├── LICENSE
└── README.md
```

## 🎯 Supported Tweet Types

Just paste any X/Twitter URL — the system automatically detects and handles:

| Type | Detection | What Gets Saved |
|------|-----------|-----------------|
| **Simple Tweet** | Default | Tweet text, media (images/videos), profile pic, engagement stats |
| **Thread** | Author has self-replies | All tweets by the author in chronological order |
| **Article** | Tweet links to `x.com/i/article/` | Full article content (title, body, **code blocks**, cover image) |
| **Video Tweet** | Media type `video` | Video file + thumbnail — large videos (>100MB) handled via Git LFS |

> **No manual selection needed!** The backend automatically determines the tweet type and archives accordingly.

## 🔧 How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    Your Browser                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Frontend (index.html)                          │   │
│  │  - Stores credentials in localStorage           │   │
│  │  - Triggers GitHub repository_dispatch          │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ (repository_dispatch)
┌─────────────────────────────────────────────────────────┐
│              Your GitHub Repository                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │  GitHub Action (save-tweet.yml)                 │   │
│  │  1. Receives tweet URL                          │   │
│  │  2. Runs Playwright + API in parallel           │   │
│  │  3. Merges best results from both               │   │
│  │  4. Generates smart filename via local LLM      │   │
│  │  5. Commits to tweets/ (LFS for large videos)   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Dual-Mode Scraping Strategy

| Credentials Available | Strategy |
|----------------------|----------|
| **Both auth_token + API key** | Run Playwright + API in parallel via `Promise.allSettled`, merge best results |
| **auth_token only** | Playwright only (full article content with code blocks) |
| **API key only** | API only (article text, no code blocks) |
| **Neither** | Error |

**Merge logic**: Longer text wins, max engagement counts, union of media items, Playwright article content preferred.

## 🌐 Deploy Frontend to IPFS

### Using Fleek (Recommended)

1. Go to [fleek.co](https://fleek.co)
2. Connect your GitHub repository
3. Set build settings:
   - **Framework**: Other
   - **Build command**: (leave empty)
   - **Publish directory**: `frontend`
4. Deploy!

### Using IPFS Desktop

1. Install [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/)
2. Import the `frontend` folder
3. Copy the CID
4. Access via `https://ipfs.io/ipfs/<YOUR_CID>/`

### Using Pinata

1. Go to [pinata.cloud](https://pinata.cloud)
2. Upload the `frontend` folder
3. Get your IPFS hash

## 📋 Manual Trigger (Alternative)

You can also trigger the workflow directly from GitHub:

1. Go to your repository → **Actions** tab
2. Select "Save Tweet to Markdown"
3. Click "Run workflow"
4. Enter the tweet URL
5. Click "Run workflow"

## Security Notes

- **Fine-Grained PAT**: We recommend using a repository-scoped token that can ONLY access your ReviseMachine repo, not your other repositories.
- **GitHub PAT**: Stored only in your browser's localStorage. Never transmitted to any server except GitHub's API.
- **Twitter API Key**: Stored as a GitHub Secret. Only accessible by your GitHub Actions.
- **Interest Form Encryption**: The expression-of-interest form encrypts all data client-side using `libsodium crypto_box_seal` (X25519 sealed box) before submission. The server never sees plaintext form data.
- **No Backend**: The self-hosted version has no server component. Everything runs in your browser or GitHub Actions.
- **Private Repository**: Make your copy private to keep your saved tweets visible only to you.

## ⚠️ Google Analytics Tag

The frontend files (`frontend/index.html` and `frontend/interest.html`) include a Google Analytics tag for the original ReviseMachine project. **When you clone this template, you should remove or replace this tag** to avoid sending analytics data to the original project owner.

**To remove:** Delete the following lines from the `<head>` section of both HTML files:

```html
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-C4WZQDC7BM"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-C4WZQDC7BM');
</script>
```

**To replace:** Change `G-C4WZQDC7BM` to your own Google Analytics Measurement ID.

## 📄 Example Output

When you save a tweet, it creates a file like `tweets/author_smart-title.md`:

### Simple Tweet with Media
```markdown
---
tweet_id: "1234567890"
type: "tweet"
author: "John Doe"
author_username: "@johndoe"
created_at: "2024-01-15T10:30:00Z"
source_url: "https://x.com/johndoe/status/1234567890"
likes: 42
retweets: 10
is_thread: false
media_count: 1
---

<img src="media/1234567890/profile.jpg" alt="@johndoe" width="48" height="48"> **John Doe** · [@johndoe](https://x.com/johndoe)

# Tweet by @johndoe

This is the tweet content with all the text preserved!

![Image](media/1234567890/img_1.jpg)

## Engagement
| Metric | Count |
|--------|-------|
| Likes | 42 |
| Retweets | 10 |
```

### Thread (Multiple Tweets)
```markdown
---
type: "thread"
is_thread: true
thread_count: 3
---

# Thread by @johndoe (3 tweets)

### Tweet 1 of 3
First tweet in the thread...

### Tweet 2 of 3
Second tweet continues the story...

### Tweet 3 of 3
Final tweet wraps it up!
```

### Article
```markdown
---
type: "article"
---

## Article Content

**Article URL**: [http://x.com/i/article/...](...)

![Cover](https://pbs.twimg.com/...)

### Article Title Here

Full article text extracted automatically...
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📜 License

MIT License - feel free to use this for personal or commercial projects.

## 🙏 Credits

- [twitterapi.io](https://twitterapi.io) - Twitter API provider
- [GitHub Actions](https://github.com/features/actions) - CI/CD platform
- [IPFS](https://ipfs.io) - Decentralized storage
- [libsodium](https://libsodium.org) - Client-side encryption
- [Tailwind CSS](https://tailwindcss.com) - Styling
