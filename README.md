# universal-scraper

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

**Agent-native web access: read, act, and extract over a single background daemon.**

`universal-scraper` replaces ad-hoc `curl`, HTML parsers, and brittle browser automation scripts with four clean verbs — exposed as an **MCP server**, a **CLI**, an **Antigravity plugin**, and a **Claude Code plugin**. Static pages are fetched over plain HTTP; JavaScript-heavy pages automatically escalate to headless Chromium; interactive pages return stable element handles (`e1`, `e2`, ...) for reliable clicking, typing, and form submission.

---

## Features

- **Progressive Escalation (HTTP-first, Browser when needed)**  
  Reads start with plain HTTP and convert HTML to clean Markdown (`@mozilla/readability` + `turndown`). When a page requires JavaScript (`empty_spa_shell`, `js_required`, `low_text_ratio`, `challenge`, `rate_limited`, or `interactive: true`), the router automatically escalates to a managed headless Chromium tab.
- **Stable Element Handles**  
  Interactive reads emit short, stable handles (`e1`, `e2`, ...) alongside accessibility roles and names. Actions return diffs marking `(new)` and `(changed)` elements. If the DOM re-renders, handles automatically re-bind — or return `stale_handle` with ranked candidates.
- **Deterministic Extraction**  
  Extract `tables` (JSON rows), `lists`, `structured` metadata (JSON-LD, microdata, OpenGraph), `links`, `text`, and element `attr` without parsing Markdown by hand.
- **APIs, Files & Pagination**  
  Supports custom HTTP `method`, `headers`, and `body` for JSON endpoints, automatic file downloads (returning the saved path), and cursor-based pagination for long pages.
- **Sessions & Persistent Profiles**  
  Keep tabs, cookies, and handles isolated per named `session`, or pass a `profile` to persist cookies across daemon restarts.
- **Safety Defaults**  
  - **SSRF protection**: Refuses private, loopback, and cloud-metadata addresses (`ssrf_blocked`) unless explicitly allowlisted.
  - **Prompt-injection fencing**: Wraps all fetched web content inside `<web_content untrusted>...</web_content>` and escapes embedded fence tags.
  - **Transparent challenge handling**: Reports bot-protection gates as `blocked` and CAPTCHA/OTP flows as `needs_human` rather than attempting to bypass them.

---

## Requirements

- **Node.js >= 22**
- A Chromium-based browser (auto-detected if Chrome/Chromium is installed locally, or downloaded automatically via `scraper setup`)

---

## Quick Start

### 1. Antigravity Plugin

Clone this repository and link or copy the self-contained [plugin/](plugin/) bundle into your Antigravity plugins directory:

```bash
git clone https://github.com/willweimike/universal-scraper.git
ln -s "$(pwd)/universal-scraper/plugin" ~/.gemini/config/plugins/universal-scraper
```

The plugin bundles:
- `plugin.json` & `assets/logo.svg` — Antigravity manifest and icon
- `mcp_config.json` — Registers the `universal-scraper` stdio MCP server (`web_read`, `web_act`, `web_extract`, `web_sessions`)
- `skills/web/SKILL.md` — Progressive web-access skill
- `rules/AGENTS.md` — Web access preference and untrusted-content guardrails

### 2. Claude Code Plugin

```bash
claude plugin marketplace add https://github.com/willweimike/universal-scraper.git
claude plugin install universal-scraper@universal-scraper
```

Or run locally without installing:

```bash
claude --plugin-dir ./plugin
```

### 3. Standalone CLI / Local Development

```bash
git clone https://github.com/willweimike/universal-scraper.git
cd universal-scraper
npm install
npm run build

# Verify Node, data directory, socket path, and browser availability
node dist/frontends/cli.js doctor

# Optional: download chrome-headless-shell if no system browser is available
node dist/frontends/cli.js setup
```

### 4. Claude Desktop / Cursor / Generic MCP Client

You can run the bundled plugin CLI directly as a stdio MCP server without building:

```json
{
  "mcpServers": {
    "universal-scraper": {
      "command": "node",
      "args": [
        "/path/to/universal-scraper/plugin/dist/cli.js",
        "mcp"
      ]
    }
  }
}
```

---

## MCP Tools

Start the stdio MCP server with `scraper mcp` (or `node plugin/dist/cli.js mcp`). It exposes four tools:

| Tool | Purpose | Key Parameters |
| --- | --- | --- |
| `web_read` | Fetch a web page, JSON API, or file | `url`, `cursor`, `mode` (`auto` \| `http` \| `browser`), `interactive`, `wait`, `session`, `profile`, `method`, `headers`, `body`, `maxChars` |
| `web_act` | Run interactive steps in a browser tab | `steps` (`click`, `hover`, `type`, `select`, `press`, `scroll`, `goto`, `wait`), `session`, `tab` |
| `web_extract` | Deterministically extract page data | `kind` (`tables` \| `lists` \| `structured` \| `links` \| `text` \| `attr`), `target`, `attr`, `session`, `tab` |
| `web_sessions` | List active sessions or close one | `close` (session name) |

---

## CLI Usage

```bash
# Read a static or JS-rendered page as Markdown
scraper read https://example.com

# Open in interactive browser mode to inspect element handles (e1, e2, ...)
scraper read https://example.com --interactive --session demo

# Click and type using handles
scraper act --session demo --steps '[{"do":"type","target":"e2","text":"hello"},{"do":"click","target":"e3"}]'

# Extract structured data (tables, lists, structured, links, text, attr)
scraper extract tables --session demo
scraper extract links --session demo --json

# Call a JSON API
scraper read https://api.example.com/items -X POST -H "content-type: application/json" --body '{"q":"test"}'

# Manage sessions and daemon lifecycle
scraper sessions
scraper sessions --close demo
scraper stop
scraper doctor
scraper setup
```

Add `--json` to `read`, `act`, `extract`, or `sessions` for raw JSON output.

---

## Configuration

All settings can be configured through environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `SCRAPER_DATA` | `~/.scraper` | Data directory for persistent profiles and downloads |
| `SCRAPER_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/scraper` or `/tmp/scraper-<uid>` | Directory for the daemon Unix socket and lock file |
| `SCRAPER_TIMEOUT_MS` | `30000` | Request / navigation timeout in milliseconds |
| `SCRAPER_IDLE_MS` | `900000` (15m) | Daemon auto-shutdown idle timeout |
| `SCRAPER_TAB_TTL_MS` | `600000` (10m) | Inactivity timeout before closing a session's browser tabs |
| `SCRAPER_BROWSER` | *(auto-detected)* | Explicit path to a Chrome/Chromium executable |
| `SCRAPER_BROWSER_CACHE` | `~/.cache/universal-scraper/browsers` | Download cache for `chrome-headless-shell` |
| `SCRAPER_NO_INSTALL` | *(unset)* | Set to `1` to disable automatic browser download on first need |
| `SCRAPER_ALLOW_HOSTS` | *(empty)* | Comma-separated hostnames exempt from SSRF private-network blocking |

---

## Error Codes

Every error returns a structured `{ code, message, recoverable, hint }` object:

| Code | Meaning |
| --- | --- |
| `blocked` | Site served a bot-protection challenge (not bypassed) |
| `needs_human` | CAPTCHA or one-time verification code required |
| `ssrf_blocked` | Target resolved to a private, loopback, or metadata address |
| `stale_handle` | Element changed after re-render (includes `candidates` when ambiguous) |
| `not_actionable` | Target element is hidden, disabled, or covered by an overlay |
| `browser_unavailable` | No browser installed or browser crashed (run `scraper setup`) |
| `no_tab` | No active browser tab in the session (run `read --interactive` first) |
| `session_expired` | Background daemon restarted; re-read the page |
| `timeout` / `dns` / `tls` / `http_status` | Network or upstream server error |

---

## Project Structure

```text
.
├── src/
│   ├── router.ts          # Auto HTTP -> Browser escalation router
│   ├── handles.ts         # Stable element handle minting & re-binding
│   ├── protocol.ts        # Shared request/response types & error codes
│   ├── daemon/            # Background Unix-socket daemon, locking & sessions
│   ├── engines/           # Plain HTTP engine & Puppeteer browser engine
│   ├── verbs/             # read, act, extract, and session handlers
│   ├── view/              # Readability/Markdown conversion, extraction & fencing
│   ├── safety/            # SSRF guard and proxy validation
│   ├── session/           # Cookie jars & persistent profiles
│   ├── browser/           # Browser detection, setup & doctor checks
│   └── frontends/         # CLI and stdio MCP server
├── plugin/                # Self-contained Antigravity & Claude Code plugin bundle
├── scripts/               # esbuild plugin bundler (build-plugin.mjs)
└── features/              # Cucumber BDD acceptance test suite
```

---

## Development & Testing

```bash
# Compile TypeScript (to dist/)
npm run build

# Rebuild self-contained plugin bundle (plugin/dist/)
npm run build:plugin

# Run unit tests (Vitest)
npm run test:unit

# Run BDD acceptance tests (Cucumber)
npm run test:bdd

# Run full test suite
npm test
```
