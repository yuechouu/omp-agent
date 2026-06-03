# @yuechou/omp-mode

Oh My Pi Mode + Skill + Extension Management System.

Ported from [pi-mode](https://github.com/yuechouu/pi-mode) for Oh My Pi compatibility.

## 安装

```bash
# npm
npm install -g @yuechou/omp-mode

# omp
omp install @yuechou/omp-mode
```

## 配置

通过 omp 标准环境变量自定义目录：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PI_CONFIG_DIR` | `.omp` | 配置根目录 |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | Agent 主目录 |

示例：

```bash
# 使用自定义目录
export PI_CODING_AGENT_DIR="/opt/omp/agent"
omp -e @yuechou/omp-mode
```

## 功能

### 模式管理

- `/mode` — 显示当前模式和可用模式
- `/mode list` — 列出所有模式
- `/mode create <name>` — 创建新模式
- `/mode <name>` — 切换到指定模式

### 系统提示替换

每个模式可以有自己的 `agents.md` 文件，定义该模式的角色和指南：

```
~/.omp/agent/modes/
├── coding/
│   ├── agents.md      ← coding 模式的角色定义
│   ├── skills/        ← coding 模式的技能
│   └── extensions/    ← coding 模式的扩展
├── research/
│   ├── agents.md
│   ├── skills/
│   └── extensions/
└── all/               ← 所有模式共享的基础层
    ├── agents.md
    ├── skills/
    └── extensions/
```

### 扩展上下文标记协议

其他扩展可以用 mode 标签包裹系统提示注入：

```xml
<extension_context mode="coding,research">
...content...
</extension_context>
```

- `mode="all"` 或无 mode 属性 = 始终激活
- `mode="coding,research"` = 仅在 coding 或 research 模式下激活

### 工具过滤

每个模式可以限制可用工具：

```typescript
const MODE_TOOLS = {
  all: [],  // 空 = 所有工具
  coding: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  research: ["read", "grep", "find", "ls"],
};
```

## 工具

| 工具 | 功能 |
|------|------|
| `mode_list` | 列出所有可用模式 |
| `mode_switch` | 切换到指定模式 |
| `mode_create` | 创建新模式 |

## 命令

| 命令 | 功能 |
|------|------|
| `/mode` | 显示当前模式 |
| `/mode list` | 列出所有模式 |
| `/mode create <name>` | 创建新模式 |
| `/mode <name>` | 切换模式 |

## 事件

| 事件 | 说明 |
|------|------|
| `mode_ready` | 会话启动时发布，包含 getCurrentMode, isActiveMode, isActiveForMode |
| `mode_changed` | 模式切换时发布，包含新的 mode 和辅助函数 |

## 与其他扩展集成

其他扩展可以监听模式事件：

```typescript
pi.events.on("mode_ready", (data) => {
  const { getCurrentMode, isActiveMode, isActiveForMode } = data;
  // 使用这些函数检查当前模式
});

pi.events.on("mode_changed", (data) => {
  const { mode } = data;
  // 响应模式切换
});
```

## 目录结构

```
~/.omp/agent/
├── modes/
│   ├── coding/
│   │   ├── agents.md
│   │   ├── skills/
│   │   └── extensions/
│   ├── research/
│   │   ├── agents.md
│   │   ├── skills/
│   │   └── extensions/
│   └── all/
│       ├── agents.md
│       ├── skills/
│       └── extensions/
├── skills/           ← 全局技能
└── extensions/       ← 全局扩展
```

## 相关链接

- [pi-mode](https://github.com/yuechouu/pi-mode) - Pi 版本
- [@yuechou/omp-memory](https://www.npmjs.com/package/@yuechou/omp-memory) - 记忆系统
