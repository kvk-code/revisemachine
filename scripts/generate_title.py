#!/usr/bin/env python3
"""
Generate a concise title for a tweet/thread using a local LLM.
If the tweet is non-English, translates it to English and rewrites the markdown file
with English as the primary body and the original text appended.

Uses Qwen/Qwen2.5-0.5B-Instruct for fast, lightweight inference.

Usage:
  python generate_title.py <markdown_file>

Outputs the generated title to stdout (slugified, ready for filename).
Also rewrites the markdown file in-place if translation occurs.
"""

import sys
import re
import json

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

def is_likely_english(text):
    """Check if text is likely English using ASCII character ratio."""
    if not text:
        return True
    ascii_chars = sum(1 for c in text if ord(c) < 128)
    ratio = ascii_chars / len(text)
    return ratio > 0.92  # >92% ASCII = likely English

def detect_language_name(text):
    """Rough language name detection based on character ranges."""
    if not text:
        return 'Unknown'
    
    sample = text[:500]
    
    # Count character ranges
    chinese = sum(1 for c in sample if '\u4e00' <= c <= '\u9fff')
    japanese_hiragana = sum(1 for c in sample if '\u3040' <= c <= '\u309f')
    japanese_katakana = sum(1 for c in sample if '\u30a0' <= c <= '\u30ff')
    korean = sum(1 for c in sample if '\uac00' <= c <= '\ud7af')
    arabic = sum(1 for c in sample if '\u0600' <= c <= '\u06ff')
    cyrillic = sum(1 for c in sample if '\u0400' <= c <= '\u04ff')
    thai = sum(1 for c in sample if '\u0e00' <= c <= '\u0e7f')
    devanagari = sum(1 for c in sample if '\u0900' <= c <= '\u097f')
    
    total_non_ascii = len(sample) - sum(1 for c in sample if ord(c) < 128)
    if total_non_ascii == 0:
        return 'English'
    
    lang_scores = {
        'Chinese': chinese,
        'Japanese': japanese_hiragana + japanese_katakana,
        'Korean': korean,
        'Arabic': arabic,
        'Russian': cyrillic,
        'Thai': thai,
        'Hindi': devanagari,
    }
    
    top_lang = max(lang_scores, key=lang_scores.get)
    if lang_scores[top_lang] > total_non_ascii * 0.3:
        return top_lang
    
    return 'Foreign'

def load_model():
    """Load Qwen model once, reuse for both translation and title generation."""
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
    except ImportError:
        print("transformers not installed", file=sys.stderr)
        return None, None
    
    model_name = "Qwen/Qwen2.5-0.5B-Instruct"
    
    print(f"Loading model {model_name}...", file=sys.stderr)
    
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
        trust_remote_code=True
    )
    
    return model, tokenizer

def run_inference(model, tokenizer, prompt, max_new_tokens=256):
    """Run model inference with a given prompt."""
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

def translate_to_english(model, tokenizer, text):
    """Translate text to English using Qwen model."""
    prompt = f"""Translate the following text to English. Preserve the original meaning, tone, and any links/URLs. Output ONLY the English translation, nothing else.

Text:
{text[:2000]}

English translation:"""
    
    translation = run_inference(model, tokenizer, prompt, max_new_tokens=512)
    print(f"Translation: {translation[:100]}...", file=sys.stderr)
    return translation

def generate_title(model, tokenizer, tweet_text):
    """Generate a concise title for the tweet."""
    prompt = f"""Generate a concise 5-8 word title summarizing this tweet. Output ONLY the title, nothing else.

Tweet:
{tweet_text[:1500]}

Title:"""
    
    response = run_inference(model, tokenizer, prompt, max_new_tokens=30)
    title = response.split('\n')[0].strip('\"\'')
    print(f"Generated title: {title}", file=sys.stderr)
    return title

def rewrite_markdown_with_translation(md_path, frontmatter, body, english_text, original_text, lang_name):
    """Rewrite the markdown file: English as main body, original appended."""
    with open(md_path, 'r', encoding='utf-8') as f:
        original_content = f.read()
    
    # Replace the body text with English translation
    # Find the first occurrence of the original body text and replace it
    # We need to be careful to only replace the tweet content, not images/media references
    
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
    
    slug = text.lower()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = slug.strip()
    slug = re.sub(r'\s+', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    slug = slug[:max_length].rstrip('-')
    
    return slug or 'untitled'

def fallback_title(tweet_text):
    """Simple extraction fallback if LLM fails."""
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
    clean_text = re.sub(r'\*\*([^*]+)\*\*', r'\1', clean_text)  # Remove bold
    clean_text = re.sub(r'\n{2,}', '\n', clean_text)  # Collapse newlines
    tweet_text = clean_text.strip()[:2000]
    
    if not tweet_text:
        print("untitled")
        sys.exit(0)
    
    # Load model once
    model, tokenizer = load_model()
    
    if model is None:
        # Fallback without model
        title = fallback_title(tweet_text)
        slug = slugify(title)
        print(slug)
        sys.exit(0)
    
    # Check language
    if is_likely_english(tweet_text):
        # English tweet — just generate title
        print("Language: English (no translation needed)", file=sys.stderr)
        title = generate_title(model, tokenizer, tweet_text)
    else:
        # Non-English — translate first, then generate title
        lang_name = detect_language_name(tweet_text)
        print(f"Language: {lang_name} (translating to English...)", file=sys.stderr)
        
        # Translate to English
        english_text = translate_to_english(model, tokenizer, tweet_text)
        
        if not english_text or len(english_text) < 5:
            print("Translation failed or too short, using original text for title", file=sys.stderr)
            title = generate_title(model, tokenizer, tweet_text)
        else:
            # Rewrite the markdown file with English as primary
            rewrite_markdown_with_translation(
                md_path, frontmatter, body, english_text, tweet_text, lang_name
            )
            # Generate title from English text
            title = generate_title(model, tokenizer, english_text)
    
    if not title:
        title = fallback_title(tweet_text)
    
    slug = slugify(title)
    print(slug)

if __name__ == "__main__":
    main()
