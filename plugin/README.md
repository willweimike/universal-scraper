# Universal Scraper Plugin

Agent-native web access: `web_read`, `web_act`, `web_extract`, and `web_sessions` replace `curl`, HTML parsers, and manual browser drivers. Static pages are read over plain HTTP; JavaScript pages escalate to a headless browser automatically; interactive pages provide stable element handles (`e1`, `e2`, ...).

## Features

- **Progressive Escalation**: Plain HTTP fetch first; switches to headless Chromium automatically only when JavaScript rendering is required.
- **Stable Element Handles**: Returns interactive handles (`e1`, `e2`, ...) for reliable clicks, typing, and selections without brittle selectors.
- **Structured Extraction**: Extract tables, lists, links, attributes, and JSON-LD/OpenGraph metadata directly into structured formats.
- **Security & Safety Guardrails**: SSRF protection blocks private IPs and metadata endpoints. All extracted text is wrapped in `<web_content untrusted>` blocks to prevent prompt injection. Bot challenges are cleanly reported rather than bypassed.

## Tools Provided (MCP)

- `web_read`: Fetch web page, API response, or file. Supports HTTP methods, headers, body, cursor pagination, and `interactive: true`.
- `web_act`: Perform interactive actions (click, type, hover, select, scroll, wait) using stable handles.
- `web_extract`: Extract structured data (tables, lists, structured metadata, links, text, attributes).
- `web_sessions`: List or close active browser sessions.

## Quick Start & Verification

```bash
# Check environment and browser availability
node dist/cli.js doctor

# Optional: Download chrome-headless-shell if no local browser is installed
node dist/cli.js setup
```

## Antigravity Installation

This plugin can be installed globally to `~/.gemini/config/plugins/universal-scraper` or scoped to a workspace under `.agents/plugins/universal-scraper`.
Rebuild bundle assets anytime via:
```bash
npm run build:plugin
```
