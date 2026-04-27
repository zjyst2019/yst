# eVS Wiki Chat Server

一个基于 Claude API 的 Web 聊天服务器，支持流式输出、多用户并发和知识库上下文。

## 功能特性

- 基于 WebSocket 的实时流式输出
- SQLite 数据库存储聊天历史
- 支持多用户并发使用（不同设备自动隔离）
- 暗色主题聊天界面
- Markdown 渲染支持
- **系统提示预加载**：启动时加载 CLAUDE.md，所有用户共享
- **对话历史上下文**：自动带入最近 5 条历史消息
- **清空对话功能**：用户可手动开始新对话
- 支持 SDK 模式（高效）和 CLI 模式（动态读取文档）

## 系统要求

- Node.js >= 18.0.0
- Anthropic API Key 或私网模型网关

## 安装步骤

### 1. 安装 Node.js

从 [https://nodejs.org/](https://nodejs.org/) 下载并安装 Node.js。

### 2. 安装项目依赖

```bash
cd claude_web_server
npm install
```

### 3. 配置环境变量

```bash
# Windows
set ANTHROPIC_API_KEY=your_api_key
set ANTHROPIC_BASE_URL=http://your-gateway:8080
set CLAUDE_MODEL=your_model_name
set SYSTEM_PROMPT_FILE=path\to\CLAUDE.md

# Linux/macOS
export ANTHROPIC_API_KEY=your_api_key
export ANTHROPIC_BASE_URL=http://your-gateway:8080
export CLAUDE_MODEL=your_model_name
export SYSTEM_PROMPT_FILE=/path/to/CLAUDE.md
```

### 4. 启动服务器

```bash
npm start
```

## 运行方式

### 基本启动

```bash
npm start
```

服务器将在 `http://localhost:3000` 启动。

### 私网模型配置示例

```bash
# Windows
set ANTHROPIC_BASE_URL=http://192.168.1.100:8080
set ANTHROPIC_API_KEY=sk-xxx
set CLAUDE_MODEL=MiniMax-M2.7
set SYSTEM_PROMPT_FILE=D:\knowledge\CLAUDE.md
npm start

# Linux/macOS
ANTHROPIC_BASE_URL=http://192.168.1.100:8080 ANTHROPIC_API_KEY=sk-xxx CLAUDE_MODEL=MiniMax-M2.7 SYSTEM_PROMPT_FILE=/path/to/CLAUDE.md npm start
```

### 指定端口

```bash
# Windows
set PORT=8080
npm start

# Linux/macOS
PORT=8080 npm start
```

### 开发模式（自动重启）

```bash
npm run dev
```

## 系统提示（知识库上下文）

### 什么是系统提示？

系统提示（System Prompt）是在启动时加载的 CLAUDE.md 文件，让模型了解知识库结构和文档位置。加载后：

- **只读取一次**：启动时加载到内存，不重复读取
- **全局共享**：所有用户共享系统提示
- **独立对话**：每个用户有独立的对话历史

### 配置方法

```bash
# Windows
set SYSTEM_PROMPT_FILE=C:\path\to\CLAUDE.md

# Linux/macOS
SYSTEM_PROMPT_FILE=/path/to/CLAUDE.md
```

如果不设置，会尝试加载当前目录下的 `CLAUDE.md`。

### 对话历史策略

- 默认保留最近 **5 条** 历史消息
- 可通过 `MAX_HISTORY_MESSAGES` 调整
- 用户可点击 **"清空对话"** 按钮重置

## 两种模式对比

| 特性 | SDK 模式 | CLI 模式 |
|------|----------|----------|
| 响应速度 | 快（直接 API） | 较慢（启动进程） |
| 系统提示 | 支持（预加载） | 支持（目录扫描） |
| 动态读取文档 | 不支持 | 支持 |
| 连接方式 | HTTP API | 进程调用 |
| 配置要求 | API Key | API Key + Claude CLI |

**推荐使用 SDK 模式**，响应更快。

## 项目结构

```
claude_web_server/
├── server.js              # Express + WebSocket 服务器
├── package.json           # 项目依赖配置
├── README.md              # 项目说明
├── requirements.txt       # 系统要求说明
├── db/
│   ├── schema.sql         # 数据库表结构
│   └── database.js        # SQLite 操作模块
├── services/
│   └── claude.js          # Claude API/CLI 服务模块
├── routes/
│   └── api.js             # REST API 路由
├── public/
│   ├── index.html         # 前端 HTML
│   ├── style.css          # 前端样式
│   └── app.js             # 前端 JavaScript
└── data/
    └── chat.db            # SQLite 数据库文件
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务器端口 | 3000 |
| `ANTHROPIC_API_KEY` | API Key | 必须 |
| `ANTHROPIC_BASE_URL` | API 网关地址 | Anthropic 官方 |
| `CLAUDE_MODEL` | 模型名称 | claude-sonnet-4-20250514 |
| `SYSTEM_PROMPT_FILE` | 系统提示文件路径 | ./CLAUDE.md |
| `MAX_HISTORY_MESSAGES` | 最大历史消息数 | 5 |
| `USE_SDK` | 是否使用 SDK 模式 | true |
| `CLAUDE_WORK_DIR` | CLI 模式工作目录 | 当前目录 |

## API 接口

### REST API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | POST | 创建新会话 |
| `/api/sessions/:id/messages` | GET | 获取会话消息历史 |
| `/api/sessions/:id` | DELETE | 删除会话 |

### WebSocket 消息类型

**客户端发送：**

| 类型 | 说明 |
|------|------|
| `join` | 加入会话，携带 `session_id` |
| `chat` | 发送消息，携带 `content` |
| `stop` | 停止生成 |
| `clear` | 清空对话历史 |

**服务端发送：**

| 类型 | 说明 |
|------|------|
| `connected` | 连接成功 |
| `joined` | 加入会话成功 |
| `stream` | 流式输出片段 |
| `complete` | 消息完成 |
| `error` | 错误信息 |
| `stopped` | 已停止生成 |
| `cleared` | 对话已清空 |

## 使用说明

1. 启动服务器后，打开浏览器访问 `http://localhost:3000`
2. 页面会自动生成一个会话 ID（存储在 localStorage）
3. 输入问题，Claude 会以流式方式返回答案
4. 刷新页面可恢复之前的聊天历史
5. 点击 **"Stop"** 可停止正在生成的回复
6. 点击 **"清空对话"** 可开始新的对话

## 多用户说明

- 不同设备/浏览器会自动分配不同的会话 ID
- 每个用户只能看到自己的聊天历史
- 同一浏览器的多个标签页共享同一会话
- 系统提示对所有用户共享（知识库上下文）

## 常见问题

### Q: 启动时提示 "System prompt: not loaded"

A: 确认 `CLAUDE.md` 文件存在：
- 默认路径：项目根目录下的 `CLAUDE.md`
- 自定义路径：通过 `SYSTEM_PROMPT_FILE` 指定

### Q: API 调用失败

A: 检查环境变量配置：
- `ANTHROPIC_API_KEY` 是否正确
- `ANTHROPIC_BASE_URL` 是否可访问（私网网关）
- `CLAUDE_MODEL` 是否匹配网关支持的模型

### Q: 对话没有上下文

A: 检查历史消息限制：
- 默认保留 5 条，可通过 `MAX_HISTORY_MESSAGES` 增加
- 确认数据库正常工作（检查 `data/chat.db`）