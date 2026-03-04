#!/usr/bin/env python3
"""
Generate a concise title for a tweet/thread using a local LLM.
Uses Qwen3.5-0.8B for fast, lightweight inference.

Usage:
  python generate_title.py <markdown_file>

Outputs the generated title to stdout (slugified, ready for filename).
"""

import sys
import re
import json

def extract_tweet_content(md_path):
    """Extract tweet text from the markdown file."""
    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Skip frontmatter
    parts = content.split('---', 2)
    if len(parts) >= 3:
        body = parts[2]
    else:
        body = content
    
    # Remove markdown formatting, keep text
    text = re.sub(r'!\[.*?\]\(.*?\)', '', body)  # Remove images
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)  # Keep link text
    text = re.sub(r'<[^>]+>', '', text)  # Remove HTML
    text = re.sub(r'#{1,6}\s*', '', text)  # Remove headers
    text = re.sub(r'\|.*?\|', '', text)  # Remove tables
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)  # Remove bold
    text = re.sub(r'\n{2,}', '\n', text)  # Collapse newlines
    
    return text.strip()[:2000]  # Limit to 2000 chars for model context

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

def generate_title_with_llm(tweet_text):
    """Generate a title using Qwen model."""
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
    except ImportError:
        print("transformers not installed, falling back to simple extraction", file=sys.stderr)
        return None
    
    model_name = "Qwen/Qwen2.5-0.5B-Instruct"  # Smaller, faster variant
    
    print(f"Loading model {model_name}...", file=sys.stderr)
    
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
        trust_remote_code=True
    )
    
    prompt = f"""Generate a concise 5-8 word title summarizing this tweet. Output ONLY the title, nothing else.

Tweet:
{tweet_text[:1500]}

Title:"""

    messages = [
        {"role": "user", "content": prompt}
    ]
    
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt")
    
    if torch.cuda.is_available():
        inputs = inputs.to("cuda")
    
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=30,
            temperature=0.3,
            do_sample=True,
            pad_token_id=tokenizer.eos_token_id
        )
    
    response = tokenizer.decode(outputs[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True)
    title = response.strip().split('\n')[0].strip('"\'')
    
    print(f"Generated title: {title}", file=sys.stderr)
    return title

def fallback_title(tweet_text):
    """Simple extraction fallback if LLM fails."""
    # Take first sentence or first 60 chars
    first_line = tweet_text.split('\n')[0].strip()
    if len(first_line) > 60:
        first_line = first_line[:60].rsplit(' ', 1)[0]
    return first_line

def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_title.py <markdown_file>", file=sys.stderr)
        sys.exit(1)
    
    md_path = sys.argv[1]
    tweet_text = extract_tweet_content(md_path)
    
    if not tweet_text:
        print("untitled")
        sys.exit(0)
    
    # Try LLM first, fall back to simple extraction
    title = generate_title_with_llm(tweet_text)
    if not title:
        title = fallback_title(tweet_text)
    
    slug = slugify(title)
    print(slug)

if __name__ == "__main__":
    main()
