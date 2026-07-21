# MineP2P

A Node.js P2P networking library with UDP hole punching and virtual LAN for game multiplayer.

## Features

- **UDP Hole Punching** - NAT traversal via STUN
- **Virtual LAN** - Create a virtual local network for game multiplayer
- **Room Integration** - Auto-connect all peers in room with one command
- **File Transfer** - Chunked file transfer with SHA256 verification
- **Plugin System** - Python-style plugin DSL
- **Chat** - Built-in chat functionality

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
| `mp start --room <room>` | Join room |
| `mp stop` | Stop client |
| `mp status` | Check status |
| `mp network` | **Start virtual LAN + auto-connect room peers** |
| `mp peers` | List connected peers |
| `mp send <msg>` | Send chat message |
| `mp plugins` | List plugins |
| `mp store` | Browse plugin store |

## Game Multiplayer

**One command**: `mp network`

1. Join same room: `mp start --room my-room`
2. Run: `mp network`
3. Connect to virtual IP in game

### Supported Games

- Minecraft (`10.0.0.x:25565`)
- Terraria (`10.0.0.x:7777`)
- Any LAN game

## License

Apache-2.0 - Copyright (c) Vexify 2026