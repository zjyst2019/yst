# eVS Wiki Chat Server

一个基于 Claude API 的 Web 聊天服务器，支持流式输出和多用户并发。

## 功能特性

- 基于 WebSocket 的实时流式输出
- SQLite 数据库存储聊天历史
- 支持多用户并发使用（不同设备自动隔离）
- 暗色主题聊天界面
- Markdown 渲染支持
- 支持 SDK 模式（高效）和 CLI 模式（知识库上下文）

## 系统要求

- Node.js >= 18.0.0
- Anthropic API Key

## 安装步骤

### 1. 安装 Node.js

从 [https://nodejs.org/](https://nodejs.org/) 下载并安装 Node.js。

### 2. 安装项目依赖

```bash
cd claude_web_server
npm install
```

### 3. 配置 API Key

```bash
# Windows
set ANTHROPIC_API_KEY=your_api_key

# Linux/macOS
export ANTHROPIC_API_KEY=your_api_key
```

## 运行方式

### 基本启动（SDK 模式）

```bash
npm start
```

SDK 模式直接调用 Anthropic API，响应速度快，适合纯问答场景。

### CLI 模式（支持知识库上下文）

如果需要 Claude 能读取本地知识库文档：

```bash
# Windows
set USE_SDK=false
set CLAUDE_WORK_DIR=C:\path\to\your\knowledge-base
set ANTHROPIC_API_KEY=your_api_key
npm start

# Linux/macOS
USE_SDK=false CLAUDE_WORK_DIR=/path/to/knowledge-base ANTHROPIC_API_KEY=your_api_key npm start
```

CLI 模式使用 Claude CLI，可以在指定目录下执行，让 Claude 访问本地文档作为上下文。

### 指定端口

```bash
# Windows
set PORT=8080
npm start

# Linux/macOS
PORT=8080 npm start
```

### 指定模型

```bash
# Windows
set CLAUDE_MODEL=claude-opus-4-20250514
npm start

# Linux/macOS
CLAUDE_MODEL=claude-opus-4-20250514 npm start
```

### 开发模式（自动重启）

```bash
npm run dev
```

## 两种模式对比

| 特性 | SDK 模式 | CLI 模式 |
|------|----------|----------|
| 响应速度 | 快（直接 API） | 较慢（启动进程） |
| 知识库支持 | 无 | 有（读取本地文档） |
| 连接方式 | HTTP API | 进程调用 |
| 配置要求 | API Key | API Key + Claude CLI |

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
| `ANTHROPIC_API_KEY` | Claude API Key | 必须 |
| `ANTHROPIC_BASE_URL` | 自定义 API 网关（私网模型） | Anthropic 官方 |
| `USE_SDK` | 是否使用 SDK 模式 | true |
| `CLAUDE_WORK_DIR` | CLI 模式工作目录 | 当前目录 |
| `CLAUDE_MODEL` | Claude 模型 | claude-sonnet-4-20250514 |

## 私网模型支持

如果使用私网部署的 Claude 模型，设置 `ANTHROPIC_BASE_URL` 环境变量：

```bash
# Windows
set ANTHROPIC_API_KEY=your_private_api_key
set ANTHROPIC_BASE_URL=http://your-gateway:port/v1
npm start

# Linux/macOS
ANTHROPIC_API_KEY=your_private_api_key ANTHROPIC_BASE_URL=http://your-gateway:port/v1 npm start
```

示例：
```bash
# 常见的私网网关格式
set ANTHROPIC_BASE_URL=http://192.168.1.100:8080/v1
set ANTHROPIC_BASE_URL=https://internal-api.company.com/v1
```

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