# 长连接上下文架构改造方案

## 目标

1. 启动时预加载 CLAUDE.md 作为全局系统提示
2. 每个用户独立的对话历史（消息上下文）
3. 共享 SDK 客户端（复用连接）
4. 对话连续性（用户可以基于历史继续提问）

## 架构变更

### 当前架构
```
用户请求 → WebSocket → Claude Service → API 调用（无上下文） → 返回
                              ↓
                         SQLite 存储（仅历史记录）
```

### 目标架构
```
启动 → 加载 CLAUDE.md → 系统提示缓存

用户请求 → WebSocket → Claude Service → 构建 Messages（系统提示 + 用户历史） → API 调用 → 返回
                              ↓
                         SQLite 存储 + 内存缓存对话历史
```

## 需要修改的文件

### 1. services/claude.js（核心改造）

**新增功能：**
- `loadSystemPrompt()` - 启动时加载 CLAUDE.md
- `getSystemPrompt()` - 获取系统提示
- `buildMessages(sessionId, userMessage)` - 构建完整消息列表（系统提示 + 历史 + 新消息）

**关键变更：**
- API 调用时传递完整 messages 数组，而非单个 prompt
- 维护内存中的对话历史缓存（可选，或从数据库读取）

### 2. server.js

**新增功能：**
- 启动时调用 `loadSystemPrompt()`
- 显示加载的系统提示信息

### 3. db/database.js（可选扩展）

**新增功能：**
- `getConversationHistory(sessionId, limit)` - 获取最近 N 条消息用于上下文
- 可选：对话轮次管理（区分不同对话主题）

### 4. 新增配置文件（可选）

- `config.js` - 配置系统提示文件路径、历史消息限制等

## 数据结构

### Messages 格式（Anthropic API）
```javascript
const messages = [
    // 系统提示（每次都发送）
    {
        role: 'system',
        content: 'CLAUDE.md 内容...'
    },
    // 用户历史消息
    {
        role: 'user',
        content: '之前的问题...'
    },
    // Assistant 历史回复
    {
        role: 'assistant',
        content: '之前的回答...'
    },
    // 当前用户消息
    {
        role: 'user',
        content: '新问题...'
    }
];
```

## 实现步骤

### Step 1: 加载系统提示
- 修改 claude.js，添加 loadSystemPrompt() 函数
- 在 server.js 启动时调用

### Step 2: 构建完整消息列表
- 修改 executeClaude() 函数
- 从数据库读取历史消息
- 组装：系统提示 + 历史 + 新消息

### Step 3: API 调用改造
- 使用 messages API 的 messages 参数
- 而非单个 prompt 字符串

### Step 4: 历史消息限制
- 添加配置：最大历史消息数（避免 token 超限）
- 默认保留最近 10-20 条

### Step 5: 对话轮次管理（可选）
- 支持用户"新建对话"
- 不同对话独立历史

## 配置项

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `SYSTEM_PROMPT_FILE` | 系统提示文件路径 | `./CLAUDE.md` |
| `MAX_HISTORY_MESSAGES` | 最大历史消息数 | 20 |
| `ENABLE_CONTEXT` | 是否启用上下文 | true |

## 预期效果

1. **启动时：**
   ```
   Loading system prompt from: CLAUDE.md
   System prompt loaded: 1234 characters
   Claude mode: SDK
   Server running at http://localhost:3000
   ```

2. **问答时：**
   - Claude 知识库上下文一次性加载
   - 用户历史对话自动带入
   - 多轮对话连续性

3. **性能：**
   - 避免每次请求重新扫描知识库
   - 系统提示复用，减少 token 消耗（如有缓存）
   - API 调用更快（无 CLI 启动开销）

## 注意事项

1. **Token 限制：**
   - 系统提示 + 历史消息可能超出模型限制
   - 需控制历史消息数量

2. **私网模型兼容：**
   - 需确认私网网关支持 messages API 格式
   - 系统提示格式可能需要调整（部分模型不支持 system role）

3. **内存管理：**
   - 可选：内存缓存对话历史 vs 每次从数据库读取
   - 高并发场景需考虑内存占用