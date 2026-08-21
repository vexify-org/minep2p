# MineP2P

A Node.js P2P networking library with UDP hole punching, virtual LAN for game multiplayer, resumable file transfer, and a Python-style plugin DSL.

> 架构：基于 `wrtc-neo`（WebRTC）+ UDP 打洞，实现 NAT 穿透与虚拟局域网。全部核心功能通过内置信令服务与外部信令（PHP API）双通道支持。

## Features

- **UDP Hole Punching** - STUN NAT 穿透，直连对端
- **Virtual LAN** - 一条命令创建虚拟局域网，游戏联机
- **Room Integration** - 加入同一房间后自动互联所有对端
- **File Transfer v2** - 分块传输、断点续传、Merkle Tree 校验、限速
- **Plugin System** - Python 风格 DSL 插件（命令/消息/事件触发）
- **Plugin Sandbox** - 权限系统、黑名单、统计
- **Chat** - 内置私聊与广播
- **Signaling** - 内置信令服务器 + 外部 PHP 信令，自动回退
- **Daemon** - 常驻后台进程，HTTP IPC 通信
- **Storage** - 本地持久化存储与配置管理
- **IPv6 检测** - 多端点公网 IPv6 探测 + 重试
- **Game Multiplayer** - OVPN / TUN 虚拟网卡游戏联机（Minecraft / Terraria）

## Installation

```bash
npm install minep2p -g
```

## Usage

### 1. Join a Room

```bash
mp start --room my-game-room
```

### 2. Start Virtual LAN

```bash
mp network
```

That's it! All peers in the room will be automatically connected via virtual IPs.

### Output Example

```
✓ Network started

Virtual LAN:
  Local IP: 10.0.0.2
  Public:   1.2.3.4:12345

Connecting to room peers...
✓ Connected to 3 peers

Game Multiplayer Ready:
  10.0.0.3 → abc12345...
  10.0.0.4 → def67890...
  10.0.0.5 → ghi13579...

Minecraft: connect to 10.0.0.2:25565
Terraria:  connect to 10.0.0.2:7777
```

## Commands

| Command | Description |
|---------|-------------|
| `mp start [room]` | 后台启动 daemon 并加入房间（无房间号自动生成） |
| `mp stop` | 停止 daemon |
| `mp status` | 查看 daemon 状态 |
| `mp add <room>` | 添加/加入一个新房间 |
| `mp send <message>` | 向所有对端发送消息 |
| `mp messages [room]` | 查看已存储消息（`--limit`） |
| `mp logs` | 查看 daemon 日志 |
| `mp set <key> <value>` | 设置配置值 |
| `mp get [key]` | 查看当前配置 |
| `mp config` | 打开配置管理 |
| `mp config-reset [key]` | 重置配置（不传 key 则全部重置） |
| `mp store` | 浏览插件商店 |
| `mp search <query>` | 搜索插件 |
| `mp install <name>` | 安装插件 |
| `mp plugins` | 列出已安装插件 |
| `mp network` | **启动虚拟局域网并自动连接房间对端** |
| `mp network -c -s <host> -p <port> [-k <key>]` | 以客户端连接远程 OVPN 服务器 |
| `mp peers` | 列出虚拟局域网中的对端 |
| `mp punch <address> <port>` | 向指定地址打洞建立直连 |
| `mp tun-install` | 安装 TUN 驱动（虚拟网卡） |
| `mp ovpn-install` | 检查/安装 OpenVPN + TAP 驱动 |
| `mp ovpn-status` | 显示 OVPN 虚拟网卡状态 |
| `mp ovpn-key` | 显示 OVPN 分享用的静态密钥 |
| `mp sandbox <action> [plugin]` | 沙箱管理（`blacklist`/`stats`/`permissions`，`--permission`） |

## Game Multiplayer

**One command**: `mp network`

1. Join same room: `mp start --room my-room`
2. Run: `mp network`
3. Connect to virtual IP in game

### Supported Games

- Minecraft (`10.0.0.x:25565`)
- Terraria (`10.0.0.x:7777`)
- Any LAN game

## Plugin System

插件使用 Python 风格的 DSL，放在 `~/.minep2p/plugins/` 目录（扩展名 `.mp`）。支持：

- 元信息（`name` / `version` / `author` / `desc`）
- 条件判断（`command` / `message` / `event` / `args` / else 分支）
- 动作方法（`pl.print` / `pl.broadcast` / `pl.log` / `pl.set` / `pl.run`）
- 模板变量（`{peer}` `{room}` `{time}` `{date}` `{rand:1-6}` `{coin}` `{pick:A,B}` `{arg:1}` `{var:key}` 等）

事件：`join`、`leave`、`message`。详细指南见 [plugins/README.md](plugins/README.md)。

```mp
name: "hello"
version: "1.0.0"
author: "你"
desc: "打招呼插件"

if command == "/hello":
    pl.print("你好，世界！")
```

## File Transfer (v2)

分块传输，支持：

- 断点续传（可恢复）
- Merkle Tree / SHA256 完整性校验
- 带宽限速

## License

Apache-2.0 - Copyright (c) Vexify 2026