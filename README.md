# 🐦 GetIt - Save Tweets to Your GitHub Repository

A fully decentralized, self-hosted solution to save tweets as markdown files in your GitHub repository.

## ✨ Features

- **🔒 Privacy First**: All credentials stored locally in your browser - never sent to any server
- **🌐 IPFS Ready**: Static frontend can be hosted on IPFS for censorship resistance
- **📝 Markdown Output**: Tweets saved as clean markdown with full metadata
- **🤖 GitHub Actions**: Processing happens in your own GitHub repository
- **💰 Cost Effective**: Uses twitterapi.io (~$0.15 per 1000 tweets)

## 🚀 Quick Start

### 1. Create Your Own Copy of This Repository

**Option A: Use Template (Recommended)**
1. Click the green **"Use this template"** button at the top of this repo
2. Name your new repository (e.g., `my-saved-tweets`)
3. **Important**: Set visibility to **Private** to keep your tweets private

**Option B: Fork & Make Private**
1. Fork this repository
2. Go to **Settings** → **General** → **Danger Zone** → **Change visibility** → **Make private**

### 2. Get Your Twitter API Key

1. Go to [twitterapi.io/dashboard](https://twitterapi.io/dashboard)
2. Sign up and get your API key (~$0.15 per 1000 tweets)

### 3. Add Twitter API Key as Repository Secret

1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `TWITTER_API_KEY`
4. Value: Your API key from twitterapi.io

### 4. Create a Fine-Grained PAT (Repository-Scoped)

**This is more secure than account-wide tokens!**

1. Go to [GitHub Fine-Grained Tokens](https://github.com/settings/personal-access-tokens/new)
2. **Token name**: `GetIt - my-saved-tweets` (or your repo name)
3. **Expiration**: Choose your preference (90 days recommended)
4. **Repository access**: Select **"Only select repositories"**
5. **Select your GetIt repository** from the dropdown
6. **Permissions** → **Repository permissions**:
   - **Contents**: Read and write
   - **Metadata**: Read-only (auto-selected)
7. Click **Generate token** and copy it

> ⚠️ **Security Note**: This token can ONLY access your GetIt repository, not your other repos!

### 5. Use the Frontend

Open `frontend/index.html` in your browser (or access via IPFS), then:

1. Enter your repository name (e.g., `username/my-saved-tweets`)
2. Paste your **repository-scoped** GitHub PAT
3. Paste your twitterapi.io API key
4. Click "Save Configuration"

Now you can paste any tweet URL and save it!

## 📁 Project Structure

```
getit/
├── .github/
│   └── workflows/
│       └── save-tweet.yml    # GitHub Action that fetches and saves tweets
├── frontend/
│   └── index.html            # Static frontend (IPFS-ready)
├── tweets/                   # Your saved tweets will appear here
└── README.md
```

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
│  │  2. Calls twitterapi.io to fetch tweet          │   │
│  │  3. Generates markdown file                     │   │
│  │  4. Commits to tweets/ folder                   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

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

## 🔐 Security Notes

- **Fine-Grained PAT**: We recommend using a repository-scoped token that can ONLY access your GetIt repo, not your other repositories.
- **GitHub PAT**: Stored only in your browser's localStorage. Never transmitted to any server except GitHub's API.
- **Twitter API Key**: Stored as a GitHub Secret. Only accessible by your GitHub Actions.
- **No Backend**: This project has no server component. Everything runs in your browser or GitHub Actions.
- **Private Repository**: Make your copy private to keep your saved tweets visible only to you.

## 📄 Example Output

When you save a tweet, it creates a file like `tweets/2024-01-15-1234567890.md`:

```markdown
---
tweet_id: "1234567890"
author: "John Doe"
author_username: "@johndoe"
created_at: "2024-01-15T10:30:00Z"
source_url: "https://twitter.com/johndoe/status/1234567890"
likes: 42
retweets: 10
replies: 5
views: 1000
saved_at: "2024-01-15T12:00:00Z"
---

# Tweet by John Doe (@johndoe)

![Profile Picture](https://pbs.twimg.com/profile_images/...)

## Content

This is the tweet content with all the text preserved!

---

## Metadata

- **Posted**: 2024-01-15T10:30:00Z
- **Likes**: 42
- **Retweets**: 10
- **Replies**: 5
- **Views**: 1000

## Original Tweet

[View on Twitter](https://twitter.com/johndoe/status/1234567890)
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📜 License

MIT License - feel free to use this for personal or commercial projects.

## 🙏 Credits

- [twitterapi.io](https://twitterapi.io) - Twitter API provider
- [GitHub Actions](https://github.com/features/actions) - CI/CD platform
- [IPFS](https://ipfs.io) - Decentralized storage
- [Tailwind CSS](https://tailwindcss.com) - Styling
