# MineP2P 插件开发指南

MineP2P 插件使用 Python 风格的 DSL（领域特定语言），语法简洁直观。

## 目录

- [快速开始](#快速开始)
- [插件结构](#插件结构)
- [条件判断](#条件判断)
- [动作方法](#动作方法)
- [模板变量](#模板变量)
- [完整示例](#完整示例)
- [插件安装](#插件安装)

---

## 快速开始

创建一个文件 `hello.mp`，内容如下：

```mp
# 我的第一个插件
name: "hello"
version: "1.0.0"
author: "你的名字"
desc: "简单的打招呼插件"

if command == "/hello":
    pl.print("你好，世界！")
```

把它放到 `~/.minep2p/plugins/` 目录，然后在 MineP2P 中输入 `/hello` 即可看到回复。

---

## 插件结构

每个 `.mp` 文件由两部分组成：

### 1. 元信息（必填）

```mp
name: "插件名称"        # 必填，唯一标识
version: "1.0.0"        # 版本号
author: "作者名"         # 作者
desc: "插件描述"         # 描述
```

### 2. 逻辑代码

Python 风格的条件判断和动作调用：

```mp
if command == "/xxx":
    pl.print("回复内容")
```

---

## 条件判断

### 命令判断

当用户输入 `/命令名` 时触发：

```mp
if command == "/hello":
    pl.print("你好！")

if command == "/dice":
    if args == "":
        pl.print("用法: /dice <数字>")
    else:
        pl.print("你掷出了 {rand:1-6} 点")
```

**说明**：
- `command` 是 `/` 开头的命令名
- `args` 是命令后面的参数（`/dice 6` 中的 `6`）

### 事件判断

```mp
if event == "join":
    pl.broadcast("欢迎新用户！")

if event == "leave":
    pl.broadcast("有人离开了")

if event == "message":
    if "你好" in message:
        pl.print("你好呀！")
```

**支持的事件**：
| 事件 | 触发时机 |
|------|----------|
| `join` | 有用户加入房间 |
| `leave` | 有用户离开房间 |
| `message` | 收到普通消息（非命令） |

### 消息判断

```mp
if message == "ping":
    pl.print("pong!")

if message != "ping":
    pl.print("你说的不是 ping")

if "你好" in message:
    pl.print("你好！")

if message == "hello" or message == "hi":
    pl.print("哈喽！")
```

### 参数判断

```mp
if args == "":
    pl.print("请提供参数")

if args != "":
    pl.print("你输入了: {args}")

if args == "石头" or args == "rock":
    pl.print("你出了石头")
```

### else 分支

```mp
if args == "":
    pl.print("用法: /dice <数字>")
else:
    pl.print("你掷出了 {rand:1-6} 点")
```

---

## 动作方法

### pl.print(message)

私聊回复发送者（仅对方可见）。

```mp
pl.print("这是私聊消息")
pl.print("你的ID是 {peer}")
```

### pl.broadcast(message)

广播给房间所有人。

```mp
pl.broadcast("🎉 {peer} 加入了房间！")
pl.broadcast("系统公告: 服务器将在 5 分钟后维护")
```

### pl.log(message)

在控制台打印日志（用户不可见，用于调试）。

```mp
pl.log("调试信息: {message}")
log.log("用户 {peer} 执行了命令 {command}")
```

### pl.set(key, value)

存储变量，后续可通过 `{var:键名}` 读取。

```mp
pl.set("mood", "开心")
pl.print("当前心情: {var:mood}")
```

### pl.run(command)

执行另一条命令（用于命令嵌套）。

```mp
if command == "/随机":
    pl.run("/dice")
```

---

## 模板变量

在字符串中使用 `{变量名}` 插入动态内容。

### 上下文变量

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{peer}` | 用户 ID 前 8 位 | `abc12345` |
| `{room}` | 房间名 | `mp-n1-x7z9` |
| `{message}` | 完整消息内容 | `hello world` |
| `{args}` | 命令参数 | `6` |
| `{command}` | 命令名 | `/dice` |
| `{time}` | 当前时间 | `14:30:00` |
| `{date}` | 当前日期 | `2026/7/16` |
| `{timestamp}` | 时间戳 | `1721123400` |

### 随机类变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `{rand:min-max}` | 随机整数 | `{rand:1-6}` → `4` |
| `{coin}` | 抛硬币 | `{coin}` → `正面` 或 `反面` |
| `{pick:A,B,C}` | 随机选择 | `{pick:石头,剪刀,布}` → `剪刀` |

### 参数提取

| 变量 | 说明 | 示例 |
|------|------|------|
| `{arg:1}` | 第 1 个参数 | `/test a b c` → `a` |
| `{arg:2}` | 第 2 个参数 | `/test a b c` → `b` |

### 变量引用

```mp
pl.set("count", "10")
pl.print("计数: {var:count}")    # → 计数: 10
```

---

## 完整示例

### 示例 1：骰子插件

```mp
# 骰子插件
name: "dice"
version: "1.0.0"
author: "Vexify"
desc: "掷骰子游戏"

if command == "/dice":
    if args == "":
        pl.print("🎲 你掷出了 {rand:1-6} 点!")
    else:
        pl.print("🎲 {args}: {rand:1-6} 点!")

if command == "/coin":
    pl.print("🪙 {coin}!")

if command == "/roll":
    if args == "":
        pl.print("🎲 你掷出了 {rand:1-100} 点!")
    else:
        pl.print("🎲 {args}: {rand:1-100} 点!")
```

### 示例 2：欢迎插件

```mp
# 欢迎插件
name: "welcome"
version: "1.0.0"
author: "Vexify"
desc: "自动欢迎新用户"

if event == "join":
    pl.broadcast("🎉 {peer} 加入了房间 {room}!")
    pl.log("新用户加入: {peer} @ {time}")

if event == "leave":
    pl.broadcast("👋 {peer} 离开了房间")

if event == "message":
    if "你好" in message or "hello" in message:
        pl.print("你好！欢迎来到这里！")
    if "help" in message:
        pl.print("可用命令: /dice /coin /roll")
```

### 示例 3：翻译插件

```mp
# 翻译插件
name: "translate"
version: "1.0.0"
author: "Vexify"
desc: "中英短语互译"

if command == "/en":
    if args == "你好":
        pl.print("📝 你好 → Hello")
    else:
        if args == "谢谢":
            pl.print("📝 谢谢 → Thank you")
        else:
            if args == "":
                pl.print("用法: /en <中文>")
            else:
                pl.print("📝 暂无翻译: {args}")
```

### 示例 4：石头剪刀布

```mp
# 石头剪刀布
name: "rps"
version: "1.0.0"
author: "Vexify"
desc: "对战机器人"

if command == "/rps":
    if args == "":
        pl.print("用法: /rps <石头|剪刀|布>")
    else:
        pl.print("🤖 对手出 {pick:石头,剪刀,布} | 你出 {args}")

if command == "/guess":
    if args == "":
        pl.print("🎮 猜数字！用 /guess <1-10> 来猜")
    else:
        pl.print("🎲 我的数字是 {rand:1-10} | 你猜了 {args}")
```

---

## 插件安装

### 内置插件

MineP2P 启动时自动加载 `minep2p/plugins/` 目录下的所有 `.mp` 文件。

### 用户插件

把 `.mp` 文件放到以下目录：

| 系统 | 目录 |
|------|------|
| Windows | `C:\Users\<用户名>\.minep2p\plugins\` |
| macOS | `~/.minep2p/plugins/` |
| Linux | `~/.minep2p/plugins/` |

### 从插件商店安装

```bash
mp install <插件名>
```

### 查看已安装插件

```bash
mp plugins
```

---

## 调试技巧

1. 使用 `pl.log()` 在控制台输出调试信息
2. 检查 `{peer}`、`{room}` 等变量是否正确传递
3. 确保缩进是 4 个空格（不要用 Tab）
4. 条件必须以 `:` 结尾

---

## 注意事项

1. **文件后缀**：必须是 `.mp`
2. **缩进**：统一使用 4 个空格
3. **字符串**：用双引号 `"`
4. **条件检查**：
   - `event` 和 `command` 不能同时触发
   - 用户输入 `/xxx` 时，先匹配 `command`，再触发 `event: message`
5. **变量求值**：`{xxx}` 在 `pl.print()`、`pl.broadcast()`、`pl.log()` 中自动求值

---

## 更多帮助

- GitHub: https://github.com/vexify-org/mp-store
- 问题反馈: https://github.com/vexify-org/mp-store/issues

---

© Vexify 2026 All Rights Reserved.