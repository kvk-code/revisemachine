# How to Get Your X (Twitter) Auth Token

This guide shows you how to extract your `auth_token` from X.com to enable full article scraping with code blocks.

---

## Chrome Desktop

### Step 1: Open X.com and make sure you're logged in
Go to [x.com](https://x.com) and verify you see your home feed.

### Step 2: Open Developer Tools
- Press `F12` or `Ctrl+Shift+I` (Windows/Linux)
- Or press `Cmd+Option+I` (Mac)

### Step 3: Go to Application tab
- Click the **Application** tab at the top of DevTools
- If you don't see it, click `>>` to see more tabs

### Step 4: Find Cookies
- In the left sidebar, expand **Storage** → **Cookies**
- Click on `https://x.com`

### Step 5: Find auth_token
- In the cookie list, look for `auth_token` in the Name column
- You can use the filter box at the top and type `auth_token`

### Step 6: Copy the value
- Click on the `auth_token` row
- Double-click the **Value** field to select it
- Copy it (`Ctrl+C` or `Cmd+C`)

### Step 7: Save it
Create a file named `x_auth_token.txt` in the project root and paste the token value.

---

## Chrome Mobile (Android)

### Step 1: Open Chrome and go to X.com
Make sure you're logged into your X account.

### Step 2: Open Chrome Settings
- Tap the three dots menu `⋮` in the top right
- Tap **Settings**

### Step 3: Go to Site Settings
- Scroll down and tap **Site settings**
- Tap **Cookies**

### Step 4: Find X.com cookies
- Tap **See all cookies and site data** (or similar)
- Use the search box to search for `x.com`
- Tap on `x.com` in the results

### Step 5: Find auth_token
- Look through the list for `auth_token`
- Tap on it to expand

### Step 6: Copy the value
- Long-press on the **Content** value to select it
- Tap **Copy**

### Step 7: Save it
Paste the token into the app when prompted, or save to `x_auth_token.txt`.

---

## Safari Mobile (iOS / iPhone / iPad)

Unfortunately, Safari on iOS does **not** provide direct access to cookies through the browser UI. Here are your options:

### Option A: Use a Desktop Browser
The easiest method is to:
1. Log into X.com on a desktop/laptop browser
2. Follow the Chrome Desktop instructions above
3. Copy the token to your phone via Notes, email, or clipboard sync

### Option B: Use Chrome on iOS
1. Install Chrome from the App Store
2. Log into X.com in Chrome
3. Chrome on iOS also doesn't expose cookies directly, so you'll need to use Option A

### Option C: Use a JavaScript Bookmark (Advanced)
1. In Safari, create a new bookmark with any page
2. Edit the bookmark and replace the URL with:
   ```
   javascript:alert(document.cookie.match(/auth_token=([^;]+)/)?.[1]||'Not found')
   ```
3. Go to x.com (logged in)
4. Tap the bookmark — it will show your auth_token in an alert
5. Screenshot or manually copy it

**Note**: iOS makes cookie access intentionally difficult for security. Desktop is recommended.

---

## Alternative: Chrome Desktop (Using Address Bar)

### Quick Method:
1. Go to [x.com](https://x.com) (make sure you're logged in)
2. Click the lock icon 🔒 in the address bar
3. Click **Cookies**
4. Expand **x.com** → **Cookies**
5. Click on `auth_token`
6. Copy the value from the **Content** field

---

## What the auth_token looks like

The `auth_token` is a long string of letters and numbers, like:

```
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
```

It's typically 40 characters long.

---

## Security Notes

- Your `auth_token` is like a temporary password - keep it private!
- Never share it publicly
- The token expires eventually (usually after several months)
- If you log out of X, the token becomes invalid

---

## Testing Your Token

After saving your token, test it with:

```bash
node scripts/scrape_tweet.js "https://x.com/NickSpisak_/status/2029412739303494131"
```

You should see:
```
[Playwright] Using auth_token (a1b2c3d4...)
[Playwright] Launching browser...
[Playwright] Scraped: "Article Title" (1234 chars)
```
