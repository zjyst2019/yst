# Claude CLI Chat Server

一个基于 Claude CLI 的 Web 聊天服务器，支持流式输出和多用户并发。

## 功能特性

- 基于 WebSocket 的实时流式输出
- SQLite 数据库存储聊天历史
- 支持多用户并发使用（不同设备自动隔离）
- 暗色主题聊天界面
- Markdown 渲染支持

## 系统要求

- Node.js >= 18.0.0
- Claude CLI (`@anthropic-ai/claude-code`)
- Claude API Key 或 Claude 订阅账号

## 安装步骤

### 1. 安装 Node.js

从 [https://nodejs.org/](https://nodejs.org/) 下载并安装 Node.js。

### 2. 安装 Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### 3. 认证 Claude CLI

```bash
# 方式一：登录认证
claude auth login

# 方式二：设置 API Key 环境变量
# Windows
set ANTHROPIC_API_KEY=your_api_key

# Linux/macOS
export ANTHROPIC_API_KEY=your_api_key
```

### 4. 安装项目依赖

```bash
cd claude_web_server
npm install
```

## 运行方式

### 基本启动

```bash
npm start
```

服务器将在 `http://localhost:3000` 启动。

### 指定端口

```bash
# Windows
set PORT=8080
npm start

# Linux/macOS
PORT=8080 npm start
```

### 配置知识库目录

如果需要让 Claude CLI 在特定目录执行（如包含知识库文档的目录）：

```bash
# Windows
set CLAUDE_WORK_DIR=C:\path\to\your\knowledge-base
npm start

# Linux/macOS
CLAUDE_WORK_DIR=/path/to/your/knowledge-base npm start
```

### 开发模式（自动重启）

```bash
npm run dev
```

## 项目结构

```
claude_web_server/
├── server.js              # Express + WebSocket 服务器
├── package.json           # 项目依赖配置
├── requirements.txt       # 系统要求说明
├── db/
│   ├── schema.sql         # 数据库表结构
│   └── database.js        # SQLite 操作模块
├── services/
│   └── claude.js          # Claude CLI 服务模块
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
| `CLAUDE_WORK_DIR` | Claude CLI 工作目录（知识库目录） | 当前目录 |
| `ANTHROPIC_API_KEY` | Claude API Key | - |

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

**服务端发送：**

| 类型 | 说明 |
|------|------|
| `connected` | 连接成功 |
| `joined` | 加入会话成功 |
| `stream` | 流式输出片段 |
| `complete` | 消息完成 |
| `error` | 错误信息 |
| `stopped` | 已停止生成 |

## 使用说明

1. 启动服务器后，打开浏览器访问 `http://localhost:3000`
2. 页面会自动生成一个会话 ID（存储在 localStorage）
3. 输入问题，Claude 会以流式方式返回答案
4. 刷新页面可恢复之前的聊天历史
5. 点击 "Stop" 可停止正在生成的回复

## 多用户说明

- 不同设备/浏览器会自动分配不同的会话 ID
- 每个用户只能看到自己的聊天历史
- 同一浏览器的多个标签页共享同一会话