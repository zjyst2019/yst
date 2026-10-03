# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WebSocket-based chat server wrapping Claude CLI (`@anthropic-ai/claude-code`) as backend LLM. Provides web UI for streaming conversations, knowledge-base RAG, semantic caching with QA similarity matching, and file ingestion (PDF/DOCX/XLSX/PPTX/MD/TXT/CSV).

## File-by-File Reference

### `server.js` — Entry point, Express + WebSocket server

```
wss.on('connection') → per-connection closure { currentSessionId, userConfig, supplementQuestion }
```

**Key structures:**
- `sessionConnections` (`Map<sessionId, Set<WebSocket>>`) — tracks multiple tabs sharing same sessionId. Only calls `stopClaude()` when last connection for a sessionId closes.
- Per-connection closure vars: `currentSessionId`, `userConfig` (apiKey/baseUrl/model), `supplementQuestion`

**WebSocket message handlers:**
| Type | Trigger | Key Logic |
|------|---------|-----------|
| `join` | Client connects/refreshes | Create/get session in SQLite, store userConfig, track in sessionConnections |
| `chat` | User sends message | Check cache first (qaCache.findSimilarCache), if miss → executeClaudeCLI with streaming callbacks |
| `stop` | User clicks Stop | `claudeService.stopClaude(sessionId)` — kills child process |
| `clear` | User clicks 清空对话 | `db.clearSessionMessages(sessionId)` |
| `save_cache` | User clicks 满意 ✓ | `qaCache.setCache(question, answer)` |
| `merge_cache` | User confirms merge | `qaCache.mergeAnswers()` via Claude CLI, then `updateMergedAnswer()` |
| `supplement_start` | User clicks 补充知识 | Record question being supplemented |
| `supplement_knowledge` | User submits correction | Save to `improve/` dir, parse template (knowledge + requirement) via regex or AI fallback, call `knowledgeIngest.ingest()` with separated content |

**After `chat` completes, background check runs:** `qaCache.getAnswerEmbedding()` → `qaCache.findSimilarAnswer()` → if similarity >= 95% auto-link, if 90-95% prompt merge, else nothing.

### `services/claude.js` — Claude CLI child process manager

```
activeRequests: Map<sessionId, ChildProcess>  (module-level singleton)
```

**Key functions:**
- `executeClaudeCLI(sessionId, prompt, history, userConfig, onStream, onComplete, onError)` — Spawns `claude -p - --output-format stream-json [--bare] [--dangerously-skip-permissions] [--model X] --append-system-prompt-file CLAUDE.md`
  - Pipes prompt via stdin (`child.stdin.write(fullPrompt); child.stdin.end()`)
  - Uses `shell: true` for spawning
  - Parses stdout line-by-line for JSON lines of type `assistant` (streaming text blocks) and `result` (final)
  - Strips `<thinking>`/`<think>` blocks via `createThinkingFilter()` stateful parser
  - Builds env with `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` from userConfig
- `stopClaude(sessionId)` — `child.kill('SIGTERM')`, deletes from `activeRequests`
- `isActive(sessionId)` — checks if session has running request
- `loadSystemPrompt(filePath)` — loads system prompt once at startup, caches globally

**Important:** `MAX_HISTORY` (env `MAX_HISTORY_MESSAGES`, default 5). History is prepended to the prompt as labeled user/assistant text blocks. History context is disabled by default (`ENABLE_HISTORY=false`).

### `services/qaCache.js` — Semantic QA cache (singleton)

```
cache: Map<key, CacheEntry>  (in-memory, persisted to .qa_cache.json)
```

**CacheEntry structure:**
```js
{
  answer: string,
  answerEmbedding: number[],  // from Ollama (optional)
  questions: string[],        // multiple questions can link to one answer
  questionEmbeddings: number[][],
  timestamp: number,
  mergedCount: number         // incremented on each merge
}
```

**Key functions:**
- `init(workDir)` — scan KB files, load cache from disk, check Ollama availability
- `findSimilarCache(question)` → `{ answer, score, key } | null` — keyword Jaccard similarity (always available) or cosine similarity on Ollama embeddings. Threshold: `CACHE_QUESTION_SIMILARITY` (default 0.88).
- `findSimilarAnswer(answerEmbedding)` → for post-answer auto-link/merge check. Thresholds: `CACHE_ANSWER_HIGH` (0.95 auto-link), `CACHE_ANSWER_MERGE` (0.90 prompt merge).
- `setCache(question, answer)` — create new entry with keyword keywords + optional embeddings
- `getEmbedding(text)` — calls `Ollama /api/embeddings`, LRU cached (max `CACHE_EMBEDDING_LRU_SIZE`=200)
- `linkQuestion(key, question, embedding)` — add question to existing entry (≥95% similarity)
- `mergeAnswers(oldAnswer, newAnswer, userConfig)` — uses Claude CLI to merge, fallback to concatenation
- `updateMergedAnswer(key, question, mergedAnswer, ...)` — update entry with merged content
- `scanKnowledgeBase()` / `checkKnowledgeBaseUpdate()` — file hash tracking for auto-cache-invalidation
- `clearCacheByFiles(files)` — remove cache entries whose questions match filenames
- Extracts Chinese+English keywords (length > 2) for keyword-based similarity (Jaccard 0.7 + length ratio 0.3)

### `services/knowledgeIngest.js` — File → KB markdown conversion

- `ingest(question, answer, userConfig, requirement?)` — supplement flow: Claude formats correction as KB markdown. `requirement` is optional processing instructions parsed from template.
- `ingestFile(filePath, userConfig, extraPrompt)` — upload flow: Claude reads file (built-in format support via Read tool), outputs `{ filePath, content }` JSON → saved to KB directory
- `buildFilePrompt(filePath, extraPrompt)` — instructs Claude to Read file, analyze, output structured JSON
- `buildPrompt(question, answer, ingestId, requirement?)` — builds prompt for supplement ingestion. If `requirement` is provided, it's passed as explicit processing guidance instead of being mixed with knowledge content.
- `analyzeContent(rawContent, userConfig)` — AI fallback: when user doesn't follow the structured template, this calls Claude to intelligently separate knowledge content from processing instructions. Returns `{ knowledgeContent, requirement }`.
- Output validated against path traversal (`path.resolve` must start with `workDir`)
- Cleans up `temp/` directory after each ingestion
- Logs all operations via `logger.js` (JSONL to `data/ingest.log`)

### `routes/api.js` — REST API

**Auth:** Token-based, in-memory `Map`. Default admin/admin. AuthMiddleware checks `Authorization: Bearer <token>` header. Some endpoints require admin (file delete).

**Endpoints:**
| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/auth/login` | — | Returns token on admin/pass match |
| `POST /api/auth/logout` | Token | Invalidates token |
| `GET /api/auth/status` | Token | Check if token valid |
| `GET/POST /api/sessions` | — | Session CRUD |
| `GET /api/sessions/:id/messages` | — | Message history |
| `DELETE /api/sessions/:id` | — | Delete session |
| `GET /api/files` | — | List files (path traversal protected via `safeResolve`) |
| `GET /api/files/content` | — | Read file text (max 5MB) |
| `POST /api/files/upload` | — | Busboy multipart upload (max 10MB per file) |
| `DELETE /api/files` | Admin | Delete file/directory |
| `POST /api/files/create-directory` | — | mkdir |
| `POST /api/knowledge/ingest` | — | Trigger ingestion for files in upload/ dir |
| `GET /api/knowledge/logs` | — | Read recent ingest logs |
| `GET /api/cache/stats` | — | Cache statistics |
| `DELETE /api/cache` | — | Clear all cache |
| `POST /api/cache/refresh` | — | Check KB updates |

### `db/database.js` + `db/schema.sql` — SQLite

```sql
sessions(id TEXT PK, created_at, last_active)
messages(id INTEGER PK AUTOINCREMENT, session_id TEXT FK, role TEXT, content TEXT, created_at)
```

Synchronous API via `better-sqlite3`. File: `data/chat.db`.

Exported functions: `createSession`, `getSession`, `updateLastActive`, `deleteSession`, `addMessage`, `getMessages`, `getRecentMessages(sessionId, limit)`, `clearSessionMessages`.

### `public/index.html` — UI layout

Dark-theme single-page app with: API config modal, file browser panel (left), chat area (right), supplement bar, admin login modal, help modal, ingest file picker modal. Renders markdown via `marked` CDN.

### `public/app.js` — Client-side logic

**Key state variables:** `ws`, `sessionId`, `isProcessing`, `currentAssistantMessage`, `apiConfig`, `adminToken`, `isAdmin`, `lastUserQuestion`, `lastAnswer`, `isSupplementing`.

**Flow:**
1. `connect()` → WebSocket to server → on open, send `join` with sessionId+config → `loadHistory()` via REST
2. `sendMessage()` → add user message to DOM → send `chat` via WS → stream response into `currentAssistantMessage`
3. On `complete` — render markdown, show satisfied/supplement buttons based on cache flags
4. `clearConversation()` — new UUID sessionId → localStorage shared, so other tabs get new sessionId on refresh
5. Auto-reconnect on disconnect (3 second interval)

**Auto-link/merge flow:** On `complete` with `needCache: true`, server runs background embedding check. Results arrive as `cache_status` WS message after render. If 95%+ → auto-link badge. If 90-95% → merge badge + enabled "满意 ✓ (合并)" button.

### `services/logger.js` — JSONL ingest logger

Appends to `data/ingest.log`. Each line: `{ timestamp, source, file|question, status, apiKey, ... }`. `getRecentLogs(limit)` reads last N lines.

### `test_system_prompt.js` — Standalone test

Validates `loadSystemPrompt` works correctly: loads file, compares length/content against original on disk, reports any discrepancies.

## WebSocket Message Protocol

### Client → Server
| Type | Payload | When |
|------|---------|------|
| `join` | `{ session_id, config: { apiKey, baseUrl, model } }` | On connect and on config change |
| `chat` | `{ content, config? }` | User sends message |
| `stop` | `{}` | User clicks Stop |
| `clear` | `{}` | User clicks 清空对话 (client also generates new sessionId) |
| `save_cache` | `{ question, answer }` | User clicks 满意 ✓ |
| `merge_cache` | `{ key, question, newAnswer, existingAnswer }` | User confirms merge |
| `supplement_start` | `{ question }` | User clicks 补充知识 |
| `supplement_knowledge` | `{ question, correctContent }` | User submits correction. `correctContent` can follow template: `需要补充的知识：...\n摄入知识的要求：...` (optional). If no template markers, AI auto-separates knowledge from instructions. |

### Server → Client
| Type | Payload | When |
|------|---------|------|
| `connected` | `{}` | WS opened |
| `joined` | `{ session_id }` | join processed |
| `stream` | `{ content }` | Each text chunk from Claude CLI (after thinking tag filtering) |
| `complete` | `{ content, cached: bool, needCache?: bool, needMerge?: bool, mergeKey?, mergeAnswer?, autoLinked?, answerSimilarity? }` | Generation done |
| `cache_status` | `{ autoLinked?, answerSimilarity?, needMerge?, mergeKey?, mergeAnswer? }` | Late-arriving background embedding result |
| `supplement_done` | `{}` | Supplement ingestion complete |
| `cache_saved` | `{}` | Cache saved |
| `cache_merged` | `{ mergedAnswer }` | Cache merged |
| `error` | `{ message }` | Error during processing |
| `stopped` | `{}` | Stop acknowledged |
| `cleared` | `{}` | Session messages cleared |

## Multi-Connection Behavior (shared localStorage sessionId)

1. **Tab close no longer kills other tabs' requests** — `sessionConnections` refcounting in server.js. Only kills Claude process when **last** connection for sessionId closes.
2. **One concurrent request per sessionId** — `activeRequests` map prevents concurrent `chat`. Tab B must wait.
3. **Any tab can stop any tab's request** — `stop` WS message calls `stopClaude(sessionId)` which kills the child process regardless of which tab started it.
4. **Clear in one tab propagates** — `clearConversation()` generates new UUID, writes to localStorage. Other tabs pick it up on page refresh.
5. **Tab That Initiated Request Closes** — streaming output is lost (goes to closed WebSocket), but process continues to completion, answer saved to DB.

## Cache Entry Lifecycle

```
[chat] → findSimilarCache (question similarity)
   ├── HIT (≥ threshold) → return cached answer directly (cached: true)
   └── MISS → executeClaude → complete
       └── Background: getAnswerEmbedding → findSimilarAnswer
           ├── ≥95% → linkQuestion (auto-link badge)
           ├── 90-95% → prompt user to merge (merge badge + button)
           └── <90% → show 满意 ✓ button → save_cache
```

## Common Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | 3000 | Server port |
| `CLAUDE_WORK_DIR` | cwd | KB root (must be set for file access) |
| `SYSTEM_PROMPT_FILE` | ./CLAUDE.md | Passed via `--append-system-prompt-file` |
| `ENABLE_HISTORY` | false | Adds conversation context to prompt |
| `ENABLE_HOOKS` | false | If true, removes `--bare` flag |
| `ENABLE_PERMISSIONS` | false | If true, removes `--dangerously-skip-permissions` |
| `ENABLE_TOOLS` | false | If true, adds `--tools Read,Bash` |
| `USE_EMBEDDING` | false | Enables Ollama for vector similarity |
| `CACHE_QUESTION_SIMILARITY` | 0.88 | Question hit threshold |
| `CACHE_ANSWER_HIGH` | 0.95 | Auto-link threshold |
| `CACHE_ANSWER_MERGE` | 0.90 | Merge prompt threshold |

## Commands

```bash
npm start              # node server.js
npm run dev            # node --watch server.js (auto-restart on change)
node test_system_prompt.js  # Test system prompt loading vs file on disk
```

## Suggestions for Future Improvements

- **Per-tab session isolation** — generate unique sessionId per tab instead of sharing via localStorage (trade-off: loses page-refresh persistence)
- **Per-connection request tracking** — track active requests by connection ID instead of sessionId to allow truly independent tab operations
