# eVS Wiki Chat Server

基于 Claude CLI 的 Web 聊天服务器，支持流式输出、知识库问答、多用户并发和语义缓存。

## 功能特性

- WebSocket 实时流式对话
- 知识库上下文（CLI 模式读取本地文档）
- 左侧文件浏览器：浏览 / 上传 / 新建文件夹 / 删除文件 / 查看内容
- 问答语义缓存：相似问题自动命中，减少 API 调用
- 满意 / 补充机制：满意存入缓存，不满意补充正确知识入库
- 文件摄入：上传 PDF/DOCX/XLSX/PPTX/MD/TXT/CSV 到 upload/，一键格式化为知识库文档
- 多用户隔离：各自使用自己的 API Key
- 管理员鉴权：登录后可删除文件（默认 admin/admin）
- 使用说明弹窗：点击 "?" 帮助查看完整操作指南
- `.env` 配置：所有参数可通过环境变量调整
- 暗色主题界面 + Markdown 渲染

## 系统要求

- Node.js >= 18.0.0
- Claude CLI（`@anthropic-ai/claude-code`）
- Ollama（可选，用于 Embedding 向量匹配）

## 快速开始

### 1. 安装 Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### 2. 配置 Claude CLI

```bash
# 查看配置文件位置
claude config

# 编辑 settings.json
# Windows: %USERPROFILE%\.claude\settings.json
# Linux/macOS: ~/.claude/settings.json
```

settings.json 示例：
```json
{
  "apiKey": "your-api-key",
  "baseUrl": "http://192.168.1.100:8080",
  "model": "MiniMax-M2.7"
}
```

### 3. 安装依赖并配置

```bash
cd claude_web_server
npm install
cp .env.example .env      # 复制配置文件
# 编辑 .env，填入知识库路径
```

### 4. 启动

```bash
npm start
# 浏览器访问 http://localhost:3000
```

## 配置 (.env)

复制 `.env.example` 为 `.env`，修改实际值：

```bash
cp .env.example .env
```

### 必填

| 变量 | 说明 | 示例 |
|------|------|------|
| `CLAUDE_WORK_DIR` | 知识库工作目录 | `/data/knowledge-base` |
| `SYSTEM_PROMPT_FILE` | CLAUDE.md 文件路径 | `/data/knowledge-base/CLAUDE.md` |

### 服务器

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 服务端口 |

### CLI 行为控制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_HISTORY` | false | 启用对话历史上下文 |
| `ENABLE_HOOKS` | false | 启用 hooks |
| `ENABLE_PERMISSIONS` | false | 启用权限检查 |
| `ENABLE_TOOLS` | false | 启用工具调用 Read/Bash |
| `MAX_HISTORY_MESSAGES` | 5 | 最大历史消息数 |
| `CLAUDE_RUN_USER` | (空) | root 下 Claude CLI 运行用户 |

### Embedding 向量匹配（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `USE_EMBEDDING` | false | 启用向量相似度 |
| `OLLAMA_URL` | http://localhost:11434 | Ollama 地址 |
| `EMBEDDING_MODEL` | qwen3-embedding:0.6b | 中文推荐此模型 |

### 缓存控制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CACHE_MAX_SIZE` | 500 | 最大缓存条目数 |
| `CACHE_QUESTION_SIMILARITY` | 0.88 | 问题命中阈值 |
| `CACHE_ANSWER_HIGH` | 0.95 | 回答自动关联阈值 |
| `CACHE_ANSWER_MERGE` | 0.90 | 回答合并确认阈值 |
| `CACHE_ANSWER_HEAD_LEN` | 250 | 答案 Embedding 截断头长度 |
| `CACHE_ANSWER_TAIL_LEN` | 250 | 答案 Embedding 截断尾长度 |
| `CACHE_EMBEDDING_LRU_SIZE` | 200 | Embedding LRU 缓存大小 |
| `CACHE_SAVE_DEBOUNCE_MS` | 500 | 磁盘写入防抖延迟(ms) |

### 知识库摄入

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KNOWLEDGE_UPLOAD_DIR` | `<工作目录>/upload` | 文件摄入上传目录 |

## 项目结构

```
claude_web_server/
├── server.js              # Express + WebSocket 主服务器
├── package.json           # 项目依赖
├── .env.example           # 环境变量模板
├── README.md              # 项目说明
├── db/
│   ├── schema.sql         # 数据库表结构
│   └── database.js        # SQLite 操作模块
├── services/
│   ├── claude.js          # Claude CLI 服务（spawn 子进程）
│   ├── qaCache.js         # 问答语义缓存
│   ├── knowledgeIngest.js # 知识库摄入服务
│   └── logger.js          # 摄入日志（JSONL）
├── routes/
│   └── api.js             # REST API + 管理员鉴权
├── public/
│   ├── index.html         # 前端页面
│   ├── style.css          # 暗色主题样式
│   └── app.js             # WebSocket + UI 逻辑
└── data/
    ├── chat.db            # SQLite 会话数据
    └── ingest.log         # 摄入操作日志
```

## API 接口

### REST API

| 接口 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/auth/login` | POST | 管理员登录 | - |
| `/api/auth/logout` | POST | 管理员注销 | Token |
| `/api/auth/status` | GET | 检查登录状态 | Token |
| `/api/sessions` | POST | 创建会话 | - |
| `/api/sessions/:id/messages` | GET | 获取消息历史 | - |
| `/api/sessions/:id` | DELETE | 删除会话 | - |
| `/api/files` | GET | 获取文件列表 | - |
| `/api/files/content` | GET | 获取文件内容 | - |
| `/api/files/upload` | POST | 上传文件 | - |
| `/api/files` | DELETE | 删除文件/目录 | 管理员 |
| `/api/files/create-directory` | POST | 创建文件夹 | - |
| `/api/knowledge/ingest` | POST | 文件摄入知识库 | - |
| `/api/knowledge/logs` | GET | 查看摄入日志 | - |
| `/api/cache/stats` | GET | 获取缓存统计 | - |
| `/api/cache` | DELETE | 清空缓存 | - |
| `/api/cache/refresh` | POST | 刷新缓存 | - |

### WebSocket 消息

**客户端 → 服务端：**

| 类型 | 说明 |
|------|------|
| `join` | 加入会话，携带 `session_id` 和 `config` |
| `chat` | 发送消息 |
| `stop` | 停止生成 |
| `clear` | 清空对话 |
| `save_cache` | 保存问答到缓存 |
| `merge_cache` | 合并相似缓存 |
| `supplement_start` | 开始补充知识 |
| `supplement_knowledge` | 提交补充内容 |

**服务端 → 客户端：**

| 类型 | 说明 |
|------|------|
| `connected` | 连接成功 |
| `joined` | 加入会话成功 |
| `stream` | 流式输出片段 |
| `complete` | 消息完成（含 `cached`/`needCache`/`needMerge` 标识） |
| `cache_status` | 后台 Embedding 检查结果 |
| `supplement_done` | 补充知识摄入完成 |
| `error` | 错误信息 |
| `stopped` | 已停止生成 |
| `cleared` | 对话已清空 |

## 使用说明

1. 启动后访问 `http://<服务器IP>:3000`
2. 首次使用弹出配置窗口，填写 API Key / 网关 / 模型
3. 输入问题，Claude 流式返回答案
4. **满意 ✓** — 存入缓存，后续相似问题直接返回
5. **补充知识** — 点击"补充知识"，按模板格式输入正确内容更新知识库：
   - `需要补充的知识：` — 填写实际知识内容
   - `摄入知识的要求：` — 可选，填写对提取/整理的要求（如"提取关键参数"）
   - 未按模板输入时，AI 会自动分析并分离知识内容与指令
6. **管理员登录** — 点击 `🔒 登录`，默认 admin/admin，登录后可删除文件
7. **使用帮助** — 点击 `? 帮助` 查看完整操作说明
8. **摄入知识库** — 上传文件到 upload/ 目录后点击摄入
9. **Stop** — 停止生成 | **清空对话** — 开始新对话

## 管理员鉴权

文件删除操作需要管理员登录：

- 默认账号密码：`admin` / `admin`
- 未登录时所有功能正常使用，仅不显示删除按钮
- 登录后 Header 显示 `🔓 注销`，文件列表出现 `×` 删除按钮
- 注销后删除按钮消失

如需修改管理员密码，在 `routes/api.js` 中修改 `ADMIN_USER` / `ADMIN_PASS`。

## 部署注意事项

### Linux root 用户

Claude CLI 在 root 下禁止使用 `--dangerously-skip-permissions`。

**方案一：普通用户运行（推荐）**

```bash
sudo useradd -m -s /bin/bash appuser
sudo chown -R appuser:appuser /path/to/claude_web_server
sudo chown -R appuser:appuser /path/to/knowledge-base
sudo su - appuser
npm start
```

**方案二：指定运行用户**

```bash
# .env 中设置
CLAUDE_RUN_USER=claudeuser
```

### 外部访问

服务器绑定 `0.0.0.0`，防火墙需开放端口：

```bash
# firewalld
sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload
# ufw
sudo ufw allow 3000/tcp
```

### Embedding 配置（可选）

```bash
# 安装 Ollama
curl -fsSL https://ollama.com/install.sh | sh
# 下载中文 Embedding 模型
ollama pull qwen3-embedding:0.6b
# .env 中启用
USE_EMBEDDING=true
```

## 常见问题

### Q: 启动时提示 "System prompt: not loaded"

确认 `.env` 中 `SYSTEM_PROMPT_FILE` 指向的 CLAUDE.md 文件存在。

### Q: Linux root 启动后 Claude CLI 命令被阻止

设置 `CLAUDE_RUN_USER` 指定非 root 用户，或以普通用户身份启动。

### Q: 外部设备无法访问

检查防火墙：`sudo firewall-cmd --add-port=3000/tcp --permanent`

### Q: Embedding 显示 "fallback to keywords"

确认 Ollama 运行中且模型已下载：`ollama list`

### Q: 缓存命中率低

可调整 `.env` 中的 `CACHE_QUESTION_SIMILARITY`（降低阈值），或启用 `USE_EMBEDDING=true` 提升精度。

### Q: 缓存答案不准确

提高相似度阈值或清空缓存：`DELETE /api/cache`
