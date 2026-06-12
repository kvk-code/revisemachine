/**
 * Web page archiver — saves any public http(s) page as clean markdown.
 *
 * Extraction tiers (first one that yields enough content wins):
 *   1. Playwright render + Mozilla Readability (reader mode) + Turndown
 *   2. Jina Reader fallback (https://r.jina.ai/<url>)
 *   3. Optional LLM extraction (OpenAI-compatible endpoint, e.g. DashScope
 *      qwen3.7-plus) — only runs when DASHSCOPE_API_KEY / LLM_API_KEY is set
 *
 * Output: pages/<host-slug>_<title-slug>.md with YAML frontmatter,
 * images localized to pages/media/<page_id>/.
 *
 * Env:
 *   PAGE_URL           (required) page to archive
 *   DASHSCOPE_API_KEY  (optional) enables LLM extraction tier
 *   LLM_API_KEY        (optional) alias for DASHSCOPE_API_KEY
 *   LLM_BASE_URL       (optional) OpenAI-compatible base URL
 *                      default: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *   LLM_MODEL          (optional) default: qwen3.7-plus
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { chromium } = require('playwright');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const { extractAndValidateWebUrl } = require('./utils/url_patterns');

const PAGE_URL = process.env.PAGE_URL;
const LLM_API_KEY = process.env.DASHSCOPE_API_KEY || process.env.LLM_API_KEY || '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.7-plus';

const PAGES_DIR = path.join(__dirname, '..', 'pages');
const MIN_WORDS = 100;          // below this, the tier is considered failed
const MAX_IMAGES = 30;          // cap image downloads per page
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const NAV_TIMEOUT_MS = 60000;

// ─── Small helpers ───────────────────────────────────────────────────────────

function wordCount(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

/**
 * Filesystem-safe slug: lowercase alphanumerics and hyphens only.
 * Prevents path traversal — no dots, slashes, or unicode tricks survive.
 */
function slugify(text, maxLen = 60) {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug || 'untitled';
}

function yamlEscape(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.request(url, { method, headers }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpRequest(new URL(res.headers.location, url).toString(), { method, headers, body, timeout })
          .then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`Timeout after ${timeout}ms: ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadFile(url, filepath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 revisemachine-archiver',
      'Accept': 'image/*,*/*'
    };
    const req = protocol.get(url, { headers: reqHeaders }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return downloadFile(new URL(res.headers.location, url).toString(), filepath, redirectsLeft - 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const len = parseInt(res.headers['content-length'] || '0', 10);
      if (len > MAX_IMAGE_BYTES) {
        res.resume();
        return reject(new Error(`Image too large (${len} bytes): ${url}`));
      }
      const file = fs.createWriteStream(filepath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(filepath); });
      file.on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
    });
    req.setTimeout(60000, () => req.destroy(new Error(`Timeout downloading ${url}`)));
    req.on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
  });
}

// ─── Tier 1: Playwright + Readability ────────────────────────────────────────

async function extractWithReadability(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 1024 }
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(2500);

    // Nudge lazy-loaded content without crawling infinite feeds
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const meta = await page.evaluate(() => {
      const pick = (sel, attr = 'content') => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute(attr) || '').trim() : '';
      };
      return {
        docTitle: document.title || '',
        ogTitle: pick('meta[property="og:title"]'),
        author: pick('meta[name="author"]') || pick('meta[property="article:author"]'),
        published: pick('meta[property="article:published_time"]') || pick('meta[name="date"]'),
        siteName: pick('meta[property="og:site_name"]')
      };
    });

    await page.addScriptTag({ path: require.resolve('@mozilla/readability/Readability.js') });
    const article = await page.evaluate(() => {
      try {
        // eslint-disable-next-line no-undef
        return new Readability(document.cloneNode(true), { keepClasses: false }).parse();
      } catch (e) {
        return { __error: e.message };
      }
    });

    if (!article || article.__error || !article.content) {
      throw new Error(`Readability failed: ${article && article.__error ? article.__error : 'no content'}`);
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
    });
    turndown.use(gfm);
    const markdown = turndown.turndown(article.content);

    return {
      markdown,
      title: article.title || meta.ogTitle || meta.docTitle,
      author: article.byline || meta.author,
      published: meta.published,
      siteName: article.siteName || meta.siteName,
      excerpt: article.excerpt || '',
      method: 'readability',
      rawText: article.textContent || ''
    };
  } finally {
    await browser.close();
  }
}

// ─── Tier 2: Jina Reader ─────────────────────────────────────────────────────

async function extractWithJina(url) {
  const res = await httpRequest(`https://r.jina.ai/${url}`, {
    headers: { 'Accept': 'text/plain', 'User-Agent': 'revisemachine-archiver' }
  });
  if (res.statusCode !== 200 || !res.body) {
    throw new Error(`Jina Reader returned HTTP ${res.statusCode}`);
  }
  // Jina prefixes "Title:", "URL Source:", "Markdown Content:" headers
  let body = res.body;
  let title = '';
  const titleMatch = body.match(/^Title:\s*(.+)$/m);
  if (titleMatch) title = titleMatch[1].trim();
  const contentIdx = body.indexOf('Markdown Content:');
  if (contentIdx !== -1) body = body.slice(contentIdx + 'Markdown Content:'.length);

  return {
    markdown: body.trim(),
    title,
    author: '',
    published: '',
    siteName: '',
    excerpt: '',
    method: 'jina',
    rawText: body
  };
}

// ─── Tier 3: LLM extraction (optional) ───────────────────────────────────────

function stripHtmlForLlm(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{3,}/g, ' ');
}

/**
 * Verbatim-extraction hallucination check: sample word 8-grams from the LLM
 * output and verify they appear in the source text. Markdown syntax is
 * stripped before sampling so formatting differences don't count as misses.
 */
function verifyLlmExtraction(llmMarkdown, sourceText) {
  const normalize = (t) => t.toLowerCase().replace(/[#*_`>\[\]()|\\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = normalize(llmMarkdown);
  const src = normalize(sourceText);
  const words = out.split(' ').filter(Boolean);
  if (words.length < 24) return { verified: false, overlap: 0 };

  const samples = 20;
  let hits = 0;
  const step = Math.max(1, Math.floor((words.length - 8) / samples));
  let total = 0;
  for (let i = 0; i + 8 <= words.length && total < samples; i += step, total++) {
    if (src.includes(words.slice(i, i + 8).join(' '))) hits++;
  }
  const overlap = total ? hits / total : 0;
  return { verified: overlap >= 0.9, overlap };
}

async function extractWithLlm(url, pageHtml, pageText) {
  if (!LLM_API_KEY) throw new Error('No LLM API key configured (set DASHSCOPE_API_KEY) — skipping LLM tier');

  const source = stripHtmlForLlm(pageHtml || '').slice(0, 600000);
  const prompt =
    'Extract the main article content from the following web page source, VERBATIM, as GitHub-flavored Markdown. ' +
    'Preserve headings, code blocks, tables, lists and image alt text. Do NOT summarize, paraphrase, translate, or add ' +
    'anything not present in the source. Skip navigation, ads, cookie banners, footers and comment sections.\n' +
    'Start your response with exactly these three lines, then a blank line, then the markdown body:\n' +
    'TITLE: <page title>\nAUTHOR: <author or empty>\nPUBLISHED: <ISO date or empty>\n\n' +
    `PAGE URL: ${url}\n\nPAGE SOURCE:\n${source}`;

  const res = await httpRequest(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 32768
    }),
    timeout: 300000
  });

  if (res.statusCode !== 200) {
    throw new Error(`LLM endpoint returned HTTP ${res.statusCode}: ${res.body.slice(0, 300)}`);
  }
  const content = JSON.parse(res.body).choices[0].message.content || '';

  const headerMatch = content.match(/^TITLE:\s*(.*)\nAUTHOR:\s*(.*)\nPUBLISHED:\s*(.*)\n\n?([\s\S]*)$/);
  const title = headerMatch ? headerMatch[1].trim() : '';
  const author = headerMatch ? headerMatch[2].trim() : '';
  const published = headerMatch ? headerMatch[3].trim() : '';
  const markdown = (headerMatch ? headerMatch[4] : content).trim();

  const { verified, overlap } = verifyLlmExtraction(markdown, pageText || stripHtmlForLlm(pageHtml).replace(/<[^>]+>/g, ' '));
  console.log(`LLM extraction n-gram overlap: ${(overlap * 100).toFixed(0)}% → verified=${verified}`);

  return {
    markdown, title, author, published,
    siteName: '', excerpt: '',
    method: `llm-${LLM_MODEL}`,
    rawText: markdown,
    verified
  };
}

// ─── Image localization ──────────────────────────────────────────────────────

async function localizeImages(markdown, pageId) {
  const mediaDir = path.join(PAGES_DIR, 'media', pageId);
  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const seen = new Map();
  let counter = 0;
  let result = markdown;

  const matches = [...markdown.matchAll(imageRegex)];
  for (const m of matches) {
    const [full, alt, src] = m;
    if (seen.has(src)) {
      result = result.replace(full, `![${alt}](${seen.get(src)})`);
      continue;
    }
    if (counter >= MAX_IMAGES) {
      console.log(`Image cap (${MAX_IMAGES}) reached — leaving remaining images as remote URLs`);
      break;
    }
    counter++;
    const extMatch = new URL(src).pathname.match(/\.(jpe?g|png|gif|webp|avif|svg)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const localName = `img_${counter}.${ext}`;
    const localRel = `media/${pageId}/${localName}`;
    try {
      fs.mkdirSync(mediaDir, { recursive: true });
      await downloadFile(src, path.join(mediaDir, localName));
      seen.set(src, localRel);
      result = result.replace(full, `![${alt}](${localRel})`);
      console.log(`  ↓ image ${counter}: ${src.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.log(`  ! image skipped (${e.message.slice(0, 80)}): ${src.slice(0, 80)}`);
    }
  }
  return result;
}

// ─── Output ──────────────────────────────────────────────────────────────────

/** Find an existing archive of this page (frontmatter page_id match) for re-archive-in-place. */
function findExistingFile(pageId) {
  if (!fs.existsSync(PAGES_DIR)) return null;
  for (const f of fs.readdirSync(PAGES_DIR)) {
    if (!f.endsWith('.md')) continue;
    const head = fs.readFileSync(path.join(PAGES_DIR, f), 'utf-8').slice(0, 500);
    if (head.includes(`page_id: "${pageId}"`)) return path.join(PAGES_DIR, f);
  }
  return null;
}

function buildMarkdownFile(extraction, urlInfo) {
  const fm = [
    '---',
    `page_id: "${urlInfo.pageId}"`,
    `type: "webpage"`,
    `title: "${yamlEscape(extraction.title)}"`,
    `site: "${yamlEscape(urlInfo.host)}"`,
    `author: "${yamlEscape(extraction.author)}"`,
    `published: "${yamlEscape(extraction.published)}"`,
    `source_url: "${yamlEscape(urlInfo.normalizedUrl)}"`,
    `archived_at: "${new Date().toISOString()}"`,
    `word_count: ${wordCount(extraction.markdown)}`,
    `extraction: "${extraction.method}"`
  ];
  if (extraction.verified !== undefined) fm.push(`verified: ${extraction.verified}`);
  fm.push('---', '');

  const title = extraction.title || urlInfo.host;
  return fm.join('\n') +
    `\n# ${title}\n\n` +
    `> Archived from [${urlInfo.host}](${urlInfo.normalizedUrl}) · extraction: ${extraction.method}\n\n` +
    extraction.markdown + '\n';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!PAGE_URL) {
    console.error('PAGE_URL environment variable is required');
    process.exit(1);
  }

  const urlInfo = extractAndValidateWebUrl(PAGE_URL);
  console.log(`Archiving: ${urlInfo.normalizedUrl} (page_id: ${urlInfo.pageId})`);

  let extraction = null;
  let pageHtml = '';
  let pageText = '';

  // Tier 1: Playwright + Readability (also captures raw HTML for the LLM tier)
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(urlInfo.normalizedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(1500);
      pageHtml = await page.content();
      pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.log(`Raw HTML capture failed (continuing): ${e.message}`);
  }

  try {
    extraction = await extractWithReadability(urlInfo.normalizedUrl);
    if (wordCount(extraction.markdown) < MIN_WORDS) {
      console.log(`Tier 1 (Readability) yielded only ${wordCount(extraction.markdown)} words — below threshold`);
      extraction = null;
    } else {
      console.log(`Tier 1 (Readability) OK: ${wordCount(extraction.markdown)} words`);
    }
  } catch (e) {
    console.log(`Tier 1 (Readability) failed: ${e.message}`);
  }

  if (!extraction) {
    try {
      extraction = await extractWithJina(urlInfo.normalizedUrl);
      if (wordCount(extraction.markdown) < MIN_WORDS) {
        console.log(`Tier 2 (Jina) yielded only ${wordCount(extraction.markdown)} words — below threshold`);
        extraction = null;
      } else {
        console.log(`Tier 2 (Jina Reader) OK: ${wordCount(extraction.markdown)} words`);
      }
    } catch (e) {
      console.log(`Tier 2 (Jina Reader) failed: ${e.message}`);
    }
  }

  if (!extraction) {
    try {
      extraction = await extractWithLlm(urlInfo.normalizedUrl, pageHtml, pageText);
      if (wordCount(extraction.markdown) < MIN_WORDS) throw new Error('LLM output below word threshold');
      console.log(`Tier 3 (LLM ${LLM_MODEL}) OK: ${wordCount(extraction.markdown)} words`);
    } catch (e) {
      console.log(`Tier 3 (LLM) failed or skipped: ${e.message}`);
      extraction = null;
    }
  }

  if (!extraction) {
    console.error('All extraction tiers failed — page not archived');
    process.exit(1);
  }

  fs.mkdirSync(PAGES_DIR, { recursive: true });
  extraction.markdown = await localizeImages(extraction.markdown, urlInfo.pageId);

  const existing = findExistingFile(urlInfo.pageId);
  const hostSlug = slugify(urlInfo.host.replace(/^www\./, ''), 40);
  const titleSlug = slugify(extraction.title, 60);
  const outPath = existing || path.join(PAGES_DIR, `${hostSlug}_${titleSlug}.md`);
  if (existing) console.log(`Re-archiving existing page in place: ${existing}`);

  fs.writeFileSync(outPath, buildMarkdownFile(extraction, urlInfo), 'utf-8');
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
