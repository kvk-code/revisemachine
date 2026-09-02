#!/usr/bin/env python3
"""
Generate a concise title for a tweet/thread using an LLM.
If the tweet is non-English, translates it to English and rewrites the markdown file
with English as the primary body and the original text appended.

Language detection uses py3langid. It replaced an ASCII-ratio heuristic that
classified every Latin-script language (Spanish, Turkish, Indonesian, ...) as
English, so those tweets were archived untranslated.

Translation and titling prefer the DASHSCOPE API (qwen3.7-plus by default) and
fall back to a local Qwen2.5-0.5B-Instruct when no API key is present.

Usage:
  python generate_title.py <markdown_file>

Outputs the generated title to stdout (slugified, ready for filename).
Also rewrites the markdown file in-place if translation occurs.
"""

import sys
import re
import os
import json
import unicodedata
import urllib.request

# `or` rather than a get() default: an unset GitHub secret arrives as an empty
# string, which would otherwise blank out the URL and model.
API_KEY = os.environ.get('DASHSCOPE_API_KEY') or ''
BASE_URL = (os.environ.get('LLM_BASE_URL') or 'https://coding-intl.dashscope.aliyuncs.com/v1').rstrip('/')
MODEL = os.environ.get('LLM_MODEL') or 'qwen3.7-plus'
LOCAL_MODEL = os.environ.get('LOCAL_LLM_MODEL') or 'Qwen/Qwen2.5-0.5B-Instruct'

# Languages this archive actually sees. Constraining the classifier is what stops
# short, jargon-heavy English tweets being misread as Latin, Catalan, etc.
CANDIDATE_LANGS = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'tr', 'id',
                   'vi', 'zh', 'ja', 'ko', 'ar', 'ru', 'hi', 'th', 'fa', 'pl', 'uk']

LANG_NAMES = {
    'es': 'Spanish', 'pt': 'Portuguese', 'fr': 'French', 'de': 'German',
    'it': 'Italian', 'nl': 'Dutch', 'tr': 'Turkish', 'id': 'Indonesian',
    'vi': 'Vietnamese', 'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean',
    'ar': 'Arabic', 'ru': 'Russian', 'hi': 'Hindi', 'th': 'Thai',
    'fa': 'Persian', 'pl': 'Polish', 'uk': 'Ukrainian', 'en': 'English',
}


def extract_tweet_content(md_path):
    """Extract tweet text from the markdown file, returning (frontmatter, body, full_content)."""
    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split frontmatter
    parts = content.split('---', 2)
    if len(parts) >= 3:
        frontmatter = parts[0] + '---' + parts[1] + '---'
        body = parts[2]
    else:
        frontmatter = ''
        body = content

    return frontmatter, body, content


def normalize_for_detection(text):
    """Strip the parts of a tweet that mislead a language classifier.

    NFKC folds styled Unicode (bold-sans "AI") back to plain letters, and
    lowercasing stops all-caps English being scored as Vietnamese.
    """
    sample = unicodedata.normalize('NFKC', text)
    sample = re.sub(r'https?://\S+', ' ', sample)      # URLs are language-neutral noise
    sample = re.sub(r'[@#]\w+', ' ', sample)           # handles and hashtags likewise
    sample = re.sub(r'\s+', ' ', sample).strip()
    return sample.lower()


def detect_language(text):
    """Detect the tweet's language. Returns (iso_code, human_name)."""
    try:
        import py3langid as langid
    except ImportError:
        print("py3langid not installed — assuming English (no translation)", file=sys.stderr)
        return 'en', 'English'

    sample = normalize_for_detection(text)
    if len(sample) < 30:
        # Too little signal to classify; treat as English rather than risk a
        # bogus translation of a handful of words.
        return 'en', 'English'

    langid.set_languages(CANDIDATE_LANGS)
    code, _confidence = langid.classify(sample[:2000])
    return code, LANG_NAMES.get(code, code)


def load_model():
    """Load the local Qwen fallback. Only called when the API is unavailable."""
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
    except ImportError:
        print("transformers not installed", file=sys.stderr)
        return None, None

    print(f"Loading local model {LOCAL_MODEL}...", file=sys.stderr)

    tokenizer = AutoTokenizer.from_pretrained(LOCAL_MODEL, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        LOCAL_MODEL,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
        trust_remote_code=True
    )

    return model, tokenizer


class LocalModel:
    """Lazy holder so the torch model is only loaded if the API path is unusable."""
    _loaded = False
    _model = None
    _tokenizer = None

    @classmethod
    def get(cls):
        if not cls._loaded:
            cls._loaded = True
            cls._model, cls._tokenizer = load_model()
        return cls._model, cls._tokenizer


def run_local_inference(prompt, max_new_tokens=256):
    """Run inference on the local fallback model."""
    model, tokenizer = LocalModel.get()
    if model is None:
        return ''

    import torch

    messages = [{"role": "user", "content": prompt}]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt")

    if torch.cuda.is_available():
        inputs = inputs.to("cuda")

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=0.3,
            do_sample=True,
            pad_token_id=tokenizer.eos_token_id
        )

    response = tokenizer.decode(outputs[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True)
    return response.strip()


def run_api_inference(prompt, max_tokens=2000):
    """Run inference against the OpenAI-compatible DASHSCOPE endpoint."""
    req = urllib.request.Request(
        BASE_URL + '/chat/completions',
        data=json.dumps({
            'model': MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'temperature': 0,
            'max_tokens': max_tokens,
        }).encode(),
        headers={'Authorization': 'Bearer ' + API_KEY,
                 'Content-Type': 'application/json',
                 'User-Agent': 'my_tweet_store/generate_title'},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)['choices'][0]['message']['content'].strip()


def run_inference(prompt, max_tokens=2000):
    """Prefer the API model; fall back to the local model on absence or failure."""
    if API_KEY:
        try:
            return run_api_inference(prompt, max_tokens)
        except Exception as e:  # noqa: BLE001 — fall back rather than lose the tweet
            print(f"API inference failed ({e}) — falling back to local model", file=sys.stderr)
    return run_local_inference(prompt, max_new_tokens=min(max_tokens, 512))


def translate_to_english(text, lang_name):
    """Translate tweet text to English. Returns '' if the result can't be trusted."""
    prompt = (
        f"Translate the following {lang_name} social media post into English.\n"
        "Rules:\n"
        "- Output ONLY the English translation. No preamble, no notes, no quotes.\n"
        "- Do NOT repeat the author handle, date, or any header lines.\n"
        "- Preserve line breaks, bullet characters, emoji, and URLs exactly.\n"
        "- Translate every line; do not leave any text in the original language.\n\n"
        f"Post:\n{text[:4000]}"
    )

    translation = run_inference(prompt, max_tokens=2000)
    if not translation:
        return ''

    # Guard against the failure mode where a weak model echoes the source instead
    # of translating it — that previously wrote half-Chinese "English" bodies.
    code, _ = detect_language(translation)
    if code != 'en':
        print(f"Translation still reads as '{code}' — rejecting", file=sys.stderr)
        return ''

    if len(translation) < 5:
        return ''

    print(f"Translation: {translation[:100]}...", file=sys.stderr)
    return translation


def generate_title(tweet_text):
    """Generate a concise English title for the tweet."""
    prompt = (
        "Generate a concise 5-8 word English title summarizing this tweet. "
        "Output ONLY the title, in English, nothing else.\n\n"
        f"Tweet:\n{tweet_text[:1500]}\n\nTitle:"
    )

    response = run_inference(prompt, max_tokens=40)
    if not response:
        return ''
    title = response.split('\n')[0].strip('\"\'')
    print(f"Generated title: {title}", file=sys.stderr)
    return title


def rewrite_markdown_with_translation(md_path, frontmatter, body, english_text, original_text, lang_name):
    """Rewrite the markdown file: English as main body, original appended."""
    # Strategy: keep frontmatter + header info intact, replace the tweet text body
    # The body after frontmatter typically starts with profile pic + author line
    # followed by "# Tweet by @user" and then the actual tweet text

    lines = body.split('\n')

    # Find where the actual tweet text starts (after author line and header)
    text_start_idx = 0
    found_header = False
    for i, line in enumerate(lines):
        if line.startswith('# Tweet by') or line.startswith('# Thread by') or line.startswith('# Article'):
            found_header = True
            text_start_idx = i + 1
            # Skip blank lines after header
            while text_start_idx < len(lines) and lines[text_start_idx].strip() == '':
                text_start_idx += 1
            break

    if not found_header:
        # Fallback: just prepend English and append original
        new_body = english_text + '\n\n## Original (' + lang_name + ')\n\n' + original_text
    else:
        # Find where the original text ends (before engagement stats, images, etc.)
        text_end_idx = len(lines)
        for i in range(text_start_idx, len(lines)):
            line = lines[i].strip()
            # Stop at engagement table, image references, or links that are clearly not part of tweet
            if line.startswith('## Engagement') or line.startswith('| Metric') or line.startswith('![Image]'):
                text_end_idx = i
                break
            # Stop at standalone URLs that look like media links
            if line.startswith('http') and line.endswith(('.jpg', '.png', '.mp4', '.webm')):
                text_end_idx = i
                break

        # Keep the header + prefix lines
        prefix_lines = lines[:text_start_idx]
        # Keep the suffix lines (engagement stats, media, etc.)
        suffix_lines = lines[text_end_idx:]

        # Build new body: prefix + English text + original section + suffix
        new_body = '\n'.join(prefix_lines) + '\n\n' + english_text
        new_body += '\n\n## Original (' + lang_name + ')\n\n' + original_text
        if suffix_lines:
            new_body += '\n\n' + '\n'.join(suffix_lines)

    new_content = frontmatter + '\n' + new_body

    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(new_content)

    print(f"Rewrote markdown: English as primary, Original ({lang_name}) appended", file=sys.stderr)


def slugify(text, max_length=50):
    """Convert text to URL-friendly slug."""
    if not text:
        return 'untitled'

    slug = unicodedata.normalize('NFKC', text).lower()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = slug.strip()
    slug = re.sub(r'\s+', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    slug = slug[:max_length].rstrip('-')

    return slug or 'untitled'


def fallback_title(tweet_text):
    """Simple extraction fallback if the LLM fails."""
    first_line = tweet_text.split('\n')[0].strip()
    if len(first_line) > 60:
        first_line = first_line[:60].rsplit(' ', 1)[0]
    return first_line


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_title.py <markdown_file>", file=sys.stderr)
        sys.exit(1)

    md_path = sys.argv[1]
    frontmatter, body, full_content = extract_tweet_content(md_path)

    # Clean body text for processing (remove markdown formatting)
    clean_text = re.sub(r'!\[.*?\]\(.*?\)', '', body)  # Remove images
    clean_text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', clean_text)  # Keep link text
    clean_text = re.sub(r'<[^>]+>', '', clean_text)  # Remove HTML
    clean_text = re.sub(r'#{1,6}\s*', '', clean_text)  # Remove headers
    clean_text = re.sub(r'\|.*?\|', '', clean_text)  # Remove tables
    clean_text = re.sub(r'\n{2,}', '\n', clean_text)  # Collapse newlines
    tweet_text = clean_text.strip()[:2000]

    if not tweet_text:
        print("untitled")
        sys.exit(0)

    if API_KEY:
        print(f"Inference: API ({MODEL})", file=sys.stderr)
    else:
        print(f"Inference: local ({LOCAL_MODEL}) — no DASHSCOPE_API_KEY set", file=sys.stderr)

    # Detect language before touching any model — py3langid is local and instant.
    code, lang_name = detect_language(tweet_text)

    if code == 'en':
        print("Language: English (no translation needed)", file=sys.stderr)
        title = generate_title(tweet_text)
    else:
        print(f"Language: {lang_name} (translating to English...)", file=sys.stderr)
        english_text = translate_to_english(tweet_text, lang_name)

        if not english_text:
            print("Translation failed — using original text for title", file=sys.stderr)
            title = generate_title(tweet_text)
        else:
            # Rewrite the markdown file with English as primary
            rewrite_markdown_with_translation(
                md_path, frontmatter, body, english_text, tweet_text, lang_name
            )
            # Generate title from English text
            title = generate_title(english_text)

    if not title:
        title = fallback_title(tweet_text)

    slug = slugify(title)
    print(slug)


if __name__ == "__main__":
    main()
