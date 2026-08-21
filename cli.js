#!/usr/bin/env node
// © Vexify 2026 All Rights Reserved.
const yaggs = require('@vexify-org/yaggs');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fetch = require('node-fetch').default || require('node-fetch');

const Daemon = require('./lib/daemon');
const Store = require('./lib/store');
const BuiltinSignaling = require('./lib/builtin-signaling');

// ============================================================
// 常量
// ============================================================
const DAEMON_URL = 'http://127.0.0.1:9527';
const HTTP_PORT = 9527;
const STORE_URL = 'https://raw.githubusercontent.com/vexify-org/mp-store/main';
const PLUGINS_DIR = path.join(os.homedir(), '.minep2p', 'plugins');
const HOME_DIR = path.join(os.homedir(), '.minep2p');
const KNOWN_COMMANDS = [
    'start', 'stop', 'status', 'add', 'send', 'messages', 'logs', 'set', 'get',
    'config', 'config-reset', 'store', 'search', 'install', 'plugins', 'network',
    'peers', 'punch'
];

/** 生成随机房间码: mp-{node}-{随机字符} */
const generateRoomCode = () => {
    const node = 'n1'; // 默认走大容量节点
    const random = crypto.randomBytes(6).toString('base64url'); // 8字符,URL 安全
    return `mp-${node}-${random}`;
};

// ============================================================
// Daemon 模式: 内置信令 HTTP 服务 + 常驻进程
// ============================================================
const runDaemon = async (room) => {
    try {
        console.log(`[${new Date().toISOString()}] Running daemon for room: ${room}`);
        const MineP2P = require('./lib/client');
        const http = require('http');

        // 内置信令服务器(先于 client 创建)
        const signaling = new BuiltinSignaling();

        // HTTP 服务器(先启动,因为 client 的 signaling 需要访问 HTTP API)
        const server = http.createServer(async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            const url = new URL(req.url, `http://${req.headers.host}`);
            const send = (status, body) => {
                res.statusCode = status;
                res.end(JSON.stringify(body));
            };
            const readBody = () => new Promise((resolve) => {
                let body = '';
                req.on('data', c => body += c);
                req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve({}); } });
            });

            try {
                if (req.method === 'POST' && req.url === '/network/start') {
                    send(200, await client.startNetwork({ tun: true }));

                } else if (req.method === 'POST' && req.url === '/network/start-server') {
                    send(200, await client.startNetworkAsServer());

                } else if (req.method === 'POST' && req.url === '/network/connect-client') {
                    const { serverHost, serverPort, staticKey } = await readBody();
                    send(200, await client.startNetworkAsClient(serverHost, serverPort, staticKey));

                } else if (req.method === 'POST' && req.url === '/network/connect-room') {
                    send(200, { peers: await client.connectRoomNetwork() });

                } else if (req.method === 'GET' && req.url === '/network/status') {
                    send(200, client.getNetworkStatus());

                } else if (req.method === 'POST' && req.url === '/sandbox') {
                    const { action, plugin } = await readBody();
                    const sandbox = client.pluginLoader ? client.pluginLoader.sandbox : null;
                    if (!sandbox) { send(200, { error: 'Sandbox not available' }); return; }

                    if (action === 'blacklist' && plugin) {
                        sandbox.blacklist(plugin);
                        send(200, { blacklisted: plugin, blacklist: sandbox.getBlacklist() });
                    } else if (action === 'stats') {
                        send(200, sandbox.getAllStats());
                    } else if (action === 'permissions' && plugin) {
                        send(200, { plugin, permissions: sandbox.getPermissions(plugin) });
                    } else {
                        send(200, { error: 'Unknown action' });
                    }

                } else if (req.method === 'POST' && req.url === '/signal/join') {
                    const { room: r, peerId } = await readBody();
                    send(200, signaling.join(r, peerId));

                } else if (req.method === 'POST' && req.url === '/signal/leave') {
                    const { room: r, peerId } = await readBody();
                    signaling.leave(r, peerId);
                    send(200, { ok: true });

                } else if (req.method === 'GET' && req.url.startsWith('/signal/poll')) {
                    const room = url.searchParams.get('room');
                    const peerId = url.searchParams.get('peerId');
                    const timeout = parseInt(url.searchParams.get('timeout') || '30000', 10);
                    if (!room || !peerId) { send(400, { error: 'Missing room or peerId' }); return; }
                    send(200, await signaling.poll(room, peerId, timeout));

                } else if (req.method === 'POST' && req.url === '/signal/message') {
                    const { room: r, fromPeerId, targetPeerId, message } = await readBody();
                    if (targetPeerId) {
                        signaling.sendMessage(r, targetPeerId, message);
                    } else {
                        signaling.broadcastMessage(r, fromPeerId, message);
                    }
                    send(200, { ok: true });

                } else if (req.method === 'GET' && req.url.startsWith('/signal/peers')) {
                    const room = url.searchParams.get('room');
                    send(200, { peers: room ? signaling.getPeers(room) : [] });

                } else if (req.method === 'POST' && req.url === '/signal/switch-hub') {
                    const { hubUrl, room: targetRoom } = await readBody();
                    for (const [r, sig] of client.signalings) {
                        sig.stopPolling();
                        sig.setHubUrl(hubUrl);
                        await sig.join(r);
                        sig.startPolling();
                    }
                    if (targetRoom && !client.rooms.has(targetRoom)) {
                        await client.start(targetRoom);
                    }
                    send(200, { ok: true, hubUrl, room: targetRoom });

                } else {
                    send(404, { error: 'Not found' });
                }
            } catch (e) {
                send(500, { error: e.message });
            }
        });

        // 启动 HTTP 服务器
        await new Promise((resolve, reject) => {
            server.listen(HTTP_PORT, '0.0.0.0', () => {
                console.log(`[${new Date().toISOString()}] HTTP server listening on 0.0.0.0:${HTTP_PORT}`);
                resolve();
            });
            server.on('error', reject);
        });

        // 创建 client,使用内置信令
        let client = new MineP2P({ signalingHub: `${DAEMON_URL}` });
        console.log(`[${new Date().toISOString()}] Client created, peerId: ${client.peerId.substring(0, 8)}...`);

        // 加载插件(内置 + 用户)
        const BUILTIN_PLUGINS = path.join(__dirname, 'plugins');
        client.loadPlugins(BUILTIN_PLUGINS);
        client.loadPlugins(PLUGINS_DIR);

        client.on('connect', () => {
            const status = Daemon.getStatus();
            status.status = 'connected';
            fs.writeFileSync(path.join(HOME_DIR, 'daemon.json'), JSON.stringify(status, null, 2));
        });

        client.on('peerConnect', (peerId) => {
            console.log(`[${new Date().toISOString()}] Peer connected: ${peerId.substring(0, 8)}...`);
        });

        client.on('peerDisconnect', (peerId) => {
            console.log(`[${new Date().toISOString()}] Peer disconnected: ${peerId.substring(0, 8)}...`);
        });

        client.on('message', (peerId, message) => {
            console.log(`[${new Date().toISOString()}] [${peerId.substring(0, 8)}] ${JSON.stringify(message)}`);
            Store.saveMessage(room, {
                from: peerId.substring(0, 8),
                content: message.content,
                type: message.type,
                timestamp: Date.now()
            });
        });

        client.on('error', (error) => {
            console.log(`[${new Date().toISOString()}] Error: ${error.message}`);
        });

        // 启动客户端并注册到内置信令
        try {
            await client.start(room);
            console.log(`[${new Date().toISOString()}] Client started successfully`);
            signaling.join(room, client.peerId);
            console.log(`[${new Date().toISOString()}] Registered in builtin signaling: ${client.peerId.substring(0, 8)}...`);
        } catch (err) {
            console.log(`[${new Date().toISOString()}] Client start failed: ${err.message}`);
            console.log(`[${new Date().toISOString()}] Running in offline/LAN-only mode`);
        }

        // 轮询命令文件(daemon 间通信)
        setInterval(async () => {
            const command = Daemon.getCommand();
            if (command) {
                console.log(`[${new Date().toISOString()}] Received command: ${JSON.stringify(command)}`);
                if (command.action === 'add') {
                    console.log(`[${new Date().toISOString()}] Adding room: ${command.room}`);
                    await client.start(command.room);
                } else if (command.action === 'send') {
                    client.plugins.handleMessage(command.message, { peerId: null, room });
                    client.broadcast({ type: 'chat', content: command.message });
                    Store.saveMessage(room, {
                        from: 'me', content: command.message, type: 'chat', timestamp: Date.now()
                    });
                }
            }
        }, 1000);

        // 常驻(永不退出),保持事件循环活跃
        await new Promise(() => {});
    } catch (error) {
        console.log(`[${new Date().toISOString()}] Daemon error: ${error.message}`);
        console.log(`[${new Date().toISOString()}] Error stack: ${error.stack}`);
        process.exit(1);
    }
};

// ============================================================
// CLI 辅助
// ============================================================
const printHeader = () => {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║           MineP2P - Vexify 2026          ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════╝'));
    console.log(chalk.gray('Copyright (c) Vexify 2026'));
    console.log(chalk.gray('License: Apache-2.0'));
    console.log('');
};

const formatTimestamp = (ts) => ts ? new Date(ts).toLocaleString() : 'N/A';

// ============================================================
// 生命周期命令
// ============================================================
const startCommand = async (argv) => {
    printHeader();

    // 自动生成房间码(未指定或 argv.room 被 yaggs 错误赋值为命令名时)
    const room = (argv.room && !KNOWN_COMMANDS.includes(argv.room)) ? argv.room : generateRoomCode();

    try {
        const status = await Daemon.start(room);

        console.log(chalk.green('✓ MineP2P daemon started successfully!'));
        console.log('');
        console.log(chalk.cyan('Room Code:'));
        console.log(`  ${chalk.yellow.bold(room)}`);
        console.log('');
        console.log(chalk.cyan('Daemon Status:'));
        console.log(`  PID: ${status.pid}`);
        console.log(`  Started at: ${formatTimestamp(status.startedAt)}`);
        console.log('');
        console.log(chalk.gray('Share this room code with others to join!'));
        console.log('');
        console.log(chalk.yellow('Use "mp stop" to stop the daemon'));
        console.log(chalk.yellow('Use "mp status" to check status'));
        console.log(chalk.yellow('Use "mp add <room>" to join another room'));
    } catch (error) {
        console.log(chalk.red(`✗ Failed to start: ${error.message}`));
        process.exit(1);
    }
};

const stopCommand = async () => {
    printHeader();
    try {
        await Daemon.stop();
        console.log(chalk.green('✓ MineP2P daemon stopped successfully'));
        console.log('');
    } catch (error) {
        console.log(chalk.yellow(`Note: ${error.message}`));
    }
};

const statusCommand = () => {
    printHeader();
    const status = Daemon.getStatus();

    if (status.running) {
        console.log(chalk.green('Status: Running'));
        console.log(chalk.cyan('Daemon Info:'));
        console.log(`  PID: ${status.pid}`);
        console.log(`  Main Room: ${status.room}`);
        console.log(`  Joined Rooms: ${status.rooms.length > 0 ? status.rooms.join(', ') : 'None'}`);
        console.log(`  Started at: ${formatTimestamp(status.startedAt)}`);

        printLocalStorage();
    } else {
        console.log(chalk.yellow('Status: Stopped'));
        console.log('');
        printLocalStorage();
    }
};

const printLocalStorage = () => {
    console.log(chalk.cyan('Local Storage:'));
    const rooms = Store.getAllRooms();
    if (rooms.length > 0) {
        rooms.forEach(room => {
            const stats = Store.getRoomStats(room);
            console.log(`  - ${room}: ${stats.messageCount} messages`);
        });
    } else {
        console.log('  No stored messages');
    }
};

const addCommand = async (argv) => {
    printHeader();
    const room = argv.room;

    try {
        Daemon.addRoom(room);
        console.log(chalk.green(`✓ Room "${room}" added`));
        console.log('');
        console.log(chalk.yellow('The daemon will join this room shortly'));
    } catch (error) {
        console.log(chalk.red(`✗ Failed to add room: ${error.message}`));
        process.exit(1);
    }
};

const sendCommand = async (argv) => {
    printHeader();
    const message = argv.message || 'Hello from MineP2P';

    try {
        Daemon.sendMessage(message);
        console.log(chalk.green(`✓ Message sent: "${message}"`));
    } catch (error) {
        console.log(chalk.red(`✗ Failed to send message: ${error.message}`));
        process.exit(1);
    }
};

const messagesCommand = (argv) => {
    printHeader();
    const room = argv.room || 'minep2p-default';
    const limit = argv.limit || 20;
    const messages = Store.getMessages(room, limit);

    console.log(chalk.cyan(`Messages in room: ${room}`));
    console.log('');

    if (messages.length > 0) {
        messages.forEach((msg) => {
            const time = formatTimestamp(msg.timestamp);
            const from = msg.from === 'me' ? chalk.green(msg.from) : chalk.cyan(msg.from);
            console.log(`${from} [${time}]: ${msg.content}`);
        });
    } else {
        console.log(chalk.yellow('No messages found'));
    }
};

const logsCommand = () => {
    printHeader();
    const logFile = path.join(HOME_DIR, 'daemon.log');

    try {
        if (fs.existsSync(logFile)) {
            console.log(chalk.cyan('Daemon Logs:'));
            console.log('');
            console.log(fs.readFileSync(logFile, 'utf8'));
        } else {
            console.log(chalk.yellow('No logs found'));
        }
    } catch (error) {
        console.log(chalk.red(`✗ Failed to read logs: ${error.message}`));
        process.exit(1);
    }
};

// ============================================================
// 配置命令
// ============================================================
const printConfigKeys = () => {
    console.log('');
    console.log(chalk.cyan('Available keys:'));
    Object.entries(Store.getConfigurableKeys()).forEach(([k, v]) => {
        console.log(`  ${chalk.yellow(k)} - ${v.desc} (${v.type})`);
    });
};

const setCommand = (argv) => {
    printHeader();
    const key = argv.key || argv._[0];
    const value = argv.value || argv._[1];

    if (!key) {
        console.log(chalk.red('✗ Missing config key'));
        printConfigKeys();
        process.exit(1);
    }
    if (!value) {
        console.log(chalk.red('✗ Missing value'));
        console.log('');
        console.log(chalk.cyan(`Usage: mp set ${key} <value>`));
        process.exit(1);
    }

    try {
        const result = Store.setConfig(key, value);
        console.log(chalk.green(`✓ Config updated: ${key} = ${result}`));
    } catch (error) {
        console.log(chalk.red(`✗ ${error.message}`));
        printConfigKeys();
        process.exit(1);
    }
};

const getCommand = (argv) => {
    printHeader();
    const key = argv.key || argv._[0];

    if (key) {
        try {
            const value = Store.getConfig(key);
            if (value !== null) {
                console.log(chalk.cyan(`Config: ${key}`));
                console.log(`  Value: ${chalk.yellow(value)}`);
            } else {
                console.log(chalk.yellow(`Config "${key}" is not set (using default)`));
            }
        } catch (error) {
            console.log(chalk.red(`✗ ${error.message}`));
            process.exit(1);
        }
    } else {
        const config = Store.getAllConfig();
        console.log(chalk.cyan('All Config:'));
        console.log('');

        Object.entries(Store.getConfigurableKeys()).forEach(([k, v]) => {
            const value = config[k];
            if (value !== undefined) {
                console.log(`  ${chalk.yellow(k)}: ${chalk.green(value)} (${v.desc})`);
            } else {
                console.log(`  ${chalk.gray(k)}: ${chalk.gray('(default)')} (${v.desc})`);
            }
        });

        if (Object.keys(config).length === 0) {
            console.log(chalk.gray('  No custom config set'));
        }
    }
};

const configCommand = () => {
    printHeader();
    const keys = Store.getConfigurableKeys();
    const config = Store.getAllConfig();
    const defaultConfig = require('./lib/config');

    console.log(chalk.cyan('Configuration Manager:'));
    console.log('');

    Object.entries(keys).forEach(([key, info]) => {
        const customValue = config[key];
        console.log(`  ${chalk.yellow(key)}`);
        console.log(`    Description: ${info.desc}`);
        console.log(`    Type: ${info.type}`);
        console.log(`    Default: ${chalk.gray(defaultConfig[key])}`);
        if (customValue !== undefined) {
            console.log(`    Current: ${chalk.green(customValue)}`);
        }
        console.log('');
    });

    console.log(chalk.cyan('Commands:'));
    console.log(`  ${chalk.yellow('mp set <key> <value>')} - Set a config value`);
    console.log(`  ${chalk.yellow('mp get [key]')} - View current config`);
    console.log(`  ${chalk.yellow('mp config reset [key]')} - Reset to default`);
};

const resetCommand = (argv) => {
    printHeader();
    const key = argv.key;

    try {
        Store.resetConfig(key);
        if (key) {
            console.log(chalk.green(`✓ Config "${key}" reset to default`));
        } else {
            console.log(chalk.green('✓ All config reset to default'));
        }
    } catch (error) {
        console.log(chalk.red(`✗ ${error.message}`));
        process.exit(1);
    }
};

// ============================================================
// 插件商店命令
// ============================================================
const storeCommand = async () => {
    printHeader();
    console.log(chalk.cyan('🔌 MineP2P Plugin Store'));
    console.log('');
    console.log(chalk.gray('Store: https://github.com/vexify-org/mp-store'));

    try {
        const response = await fetch(`${STORE_URL}/index.json`);
        if (!response.ok) {
            throw new Error('Failed to fetch plugin index');
        }
        const plugins = (await response.json()).plugins || [];

        if (plugins.length === 0) {
            console.log(chalk.yellow('No plugins available'));
            return;
        }

        console.log('');
        console.log(chalk.cyan('Available Plugins:'));
        console.log('');
        for (const plugin of plugins) {
            console.log(`  ${chalk.green(plugin.name)} ${chalk.gray(`v${plugin.version}`)}`);
            console.log(`    ${chalk.gray(plugin.description || 'No description')}`);
            console.log(`    ${chalk.yellow('mp install ' + plugin.name)}`);
            console.log('');
        }
        printStoreCommands();
    } catch (error) {
        console.log(chalk.red(`✗ Failed to connect to store: ${error.message}`));
    }
};

const printStoreCommands = () => {
    console.log(chalk.cyan('Commands:'));
    console.log(`  ${chalk.yellow('mp store')}          - 列出所有插件`);
    console.log(`  ${chalk.yellow('mp search <name>')}  - 搜索插件`);
    console.log(`  ${chalk.yellow('mp install <name>')} - 安装插件`);
    console.log(`  ${chalk.yellow('mp plugins')}        - 查看已安装`);
};

const searchCommand = async (argv) => {
    printHeader();
    const query = argv.query.toLowerCase();

    try {
        const response = await fetch(`${STORE_URL}/index.json`);
        const plugins = ((await response.json()).plugins || []).filter(p =>
            p.name.toLowerCase().includes(query) ||
            (p.description && p.description.toLowerCase().includes(query))
        );

        console.log(chalk.cyan(`Search results for "${query}":`));
        console.log('');

        if (plugins.length === 0) {
            console.log(chalk.yellow('No plugins found'));
            return;
        }

        for (const plugin of plugins) {
            console.log(`  ${chalk.green(plugin.name)} ${chalk.gray(`v${plugin.version}`)}`);
            console.log(`    ${chalk.gray(plugin.description || 'No description')}`);
            console.log('');
        }
    } catch (error) {
        console.log(chalk.red(`✗ Search failed: ${error.message}`));
    }
};

const installCommand = async (argv) => {
    printHeader();
    const name = argv.name;
    console.log(chalk.cyan(`Installing plugin: ${name}`));

    try {
        if (!fs.existsSync(PLUGINS_DIR)) {
            fs.mkdirSync(PLUGINS_DIR, { recursive: true });
        }

        const indexResponse = await fetch(`${STORE_URL}/index.json`);
        const plugin = ((await indexResponse.json()).plugins || []).find(p => p.name === name);

        if (!plugin) {
            console.log(chalk.red(`✗ Plugin "${name}" not found`));
            process.exit(1);
        }

        const pluginResponse = await fetch(`${STORE_URL}/plugins/${name}.mp`);
        if (!pluginResponse.ok) {
            throw new Error('Failed to download plugin');
        }

        const pluginContent = await pluginResponse.text();
        const pluginPath = path.join(PLUGINS_DIR, `${name}.mp`);
        fs.writeFileSync(pluginPath, pluginContent);

        console.log(chalk.green(`✓ Plugin "${name}" installed successfully!`));
        console.log('');
        console.log(chalk.gray(`Installed to: ${pluginPath}`));
    } catch (error) {
        console.log(chalk.red(`✗ Install failed: ${error.message}`));
        process.exit(1);
    }
};

const pluginsCommand = () => {
    printHeader();
    console.log(chalk.cyan('Installed Plugins:'));
    console.log('');

    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
        console.log(chalk.gray('  No plugins installed'));
        return;
    }

    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.mp'));

    if (files.length === 0) {
        console.log(chalk.gray('  No plugins installed'));
        return;
    }

    for (const file of files) {
        const content = fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf8');
        const nameMatch = content.match(/name:\s*"(.+)"/);
        const versionMatch = content.match(/version:\s*"(.+)"/);

        const name = nameMatch ? nameMatch[1] : file.replace('.mp', '');
        const version = versionMatch ? versionMatch[1] : 'unknown';

        console.log(`  ${chalk.green(name)} ${chalk.gray(`v${version}`)}`);
    }
};

// ============================================================
// 网络命令
// ============================================================
const networkCommand = async (argv) => {
    printHeader();

    if (!Daemon.isRunning()) {
        console.log(chalk.red('✗ Daemon is not running'));
        console.log(chalk.gray('  Run "mp start --room <room>" first'));
        process.exit(1);
    }

    try {
        const isClient = argv.client;
        const serverHost = argv.server || argv._ ?.[1];
        const serverPort = argv.port || 1194;
        const staticKey = argv.key || '';

        let result;
        if (isClient && serverHost) {
            // 客户端模式: 连接 OVPN 服务器
            console.log(chalk.cyan(`Connecting to OVPN server at ${serverHost}:${serverPort}...`));
            const response = await fetch(`${DAEMON_URL}/network/connect-client`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverHost, serverPort: parseInt(serverPort, 10), staticKey })
            });
            result = await response.json();

            if (!result.error) {
                // 切换信令到主机 daemon,实现 peer 发现
                console.log(chalk.cyan(`Linking signaling to host daemon at ${serverHost}:9527...`));
                try {
                    const switchBody = JSON.stringify({ hubUrl: `http://${serverHost}:9527`, room: null });
                    await fetch(`${DAEMON_URL}/signal/switch-hub`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: switchBody
                    });
                    console.log(chalk.green('✓ Signaling linked to host'));
                } catch (e) {
                    console.log(chalk.yellow(`⚠ Signaling link failed: ${e.message}`));
                }
            }
        } else {
            // 服务器模式(默认)
            const response = await fetch(`${DAEMON_URL}/network/start-server`, { method: 'POST' });
            result = await response.json();
        }

        if (result.error) {
            console.log(chalk.red(`✗ ${result.error}`));
            process.exit(1);
        }

        console.log(chalk.green('✓ Network started'));
        console.log('');
        console.log(chalk.cyan('Virtual LAN:'));
        console.log(`  Local IP: ${chalk.yellow(result.virtualIP)}`);
        console.log(`  Public:   ${result.publicAddress ? result.publicAddress.address : 'unknown'}:${result.publicAddress ? result.publicAddress.port : '?'}`);
        console.log(`  Mode:     ${result.mode === 'ovpn' ? chalk.green('OVPN (virtual NIC)') : chalk.yellow('UDP (proxy)')}`);
        console.log('');

        // OVPN 服务器模式: 显示分享信息
        if (result.ovpnInfo && result.ovpnInfo.staticKey) {
            console.log(chalk.cyan('OVPN Share Info:'));
            console.log(chalk.gray('  Share this with others:'));
            console.log(chalk.yellow(`  mp network --client ${result.ovpnInfo.serverHost} --port ${result.ovpnInfo.serverPort} --key "<key>"`));
            console.log('');
            console.log(chalk.gray('  Static Key (save with "mp ovpn-key"):'));
            console.log(chalk.dim(result.ovpnInfo.staticKey.substring(0, 60) + '...'));
            console.log('');
        }

        // 自动连接房间内所有人
        console.log(chalk.cyan('Connecting to room peers...'));
        const connectResponse = await fetch(`${DAEMON_URL}/network/connect-room`, { method: 'POST' });
        const connectResult = await connectResponse.json();

        if (connectResult.peers && connectResult.peers.length > 0) {
            console.log(chalk.green(`✓ Connected to ${connectResult.peers.filter(p => p.success).length} peers`));
            console.log('');
            console.log(chalk.cyan('Game Multiplayer Ready:'));
            for (const peer of connectResult.peers) {
                if (peer.success) {
                    console.log(`  ${chalk.green(peer.virtualIP)} → ${peer.peerId.substring(0, 8)}...`);
                }
            }
            console.log('');
            if (result.mode === 'ovpn') {
                console.log(chalk.gray('Minecraft: connect to') + chalk.yellow(` ${result.virtualIP}:25565`));
                console.log(chalk.gray('Terraria:  connect to') + chalk.yellow(` ${result.virtualIP}:7777`));
            } else {
                console.log(chalk.yellow('⚠ OVPN not available. Use port forwarding:'));
                console.log(chalk.gray('  mp forward <game> <peer-ip>'));
                console.log(chalk.gray('  Install OpenVPN for full virtual NIC support: mp ovpn-install'));
            }
        } else {
            console.log(chalk.yellow('No peers in room yet'));
            console.log('');
            console.log(chalk.gray('Share this info with other players:'));
            console.log(chalk.gray(`  Public IP: ${result.publicAddress ? result.publicAddress.address : 'unknown'}:${result.publicAddress ? result.publicAddress.port : '?'}`));
        }
    } catch (error) {
        console.log(chalk.red(`✗ Network start failed: ${error.message}`));
        process.exit(1);
    }
};

const peersCommand = async () => {
    printHeader();

    if (!Daemon.isRunning()) {
        console.log(chalk.red('✗ Daemon is not running'));
        process.exit(1);
    }

    try {
        const result = await (await fetch(`${DAEMON_URL}/network/status`)).json();

        console.log(chalk.cyan('Network Status:'));
        console.log(`  State:     ${result.state}`);
        console.log(`  Local IP:  ${result.vlan ? result.vlan.localIP : 'not started'}`);
        console.log('');

        if (result.peers && result.peers.length > 0) {
            console.log(chalk.cyan('Connected Peers:'));
            for (const peer of result.peers) {
                console.log(`  ${chalk.green(peer.virtualIP)} → ${peer.peerId.substring(0, 8)}... (${peer.address}:${peer.port})`);
            }
        } else {
            console.log(chalk.gray('  No peers connected'));
        }
    } catch (error) {
        console.log(chalk.red(`✗ Failed: ${error.message}`));
        process.exit(1);
    }
};

const punchCommand = async (argv) => {
    printHeader();
    const { address, port } = argv;

    if (!address || !port) {
        console.log(chalk.red('✗ Missing address or port'));
        console.log(chalk.gray('  Usage: mp punch <address> <port>'));
        process.exit(1);
    }
    if (!Daemon.isRunning()) {
        console.log(chalk.red('✗ Daemon is not running'));
        process.exit(1);
    }

    try {
        const response = await fetch(`${DAEMON_URL}/network/punch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, port: parseInt(port, 10) })
        });
        const result = await response.json();

        console.log(chalk.green('✓ Hole punching initiated'));
        console.log(`  Target: ${address}:${port}`);
        console.log(`  Assigned IP: ${result.virtualIP}`);
    } catch (error) {
        console.log(chalk.red(`✗ Punch failed: ${error.message}`));
        process.exit(1);
    }
};

// ============================================================
// TUN / OVPN 命令
// ============================================================
const tunInstallCommand = () => {
    printHeader();
    const { execSync } = require('child_process');

    if (os.platform() !== 'win32') {
        console.log(chalk.green('✓ Linux: TUN is built-in (/dev/net/tun) — no driver needed'));
        console.log(chalk.gray('  Just run: mp network'));
        process.exit(0);
    }

    console.log(chalk.cyan('Installing wintun TUN driver...'));
    console.log('');

    // 查找包内 driver 路径
    const driverPaths = [
        path.join(__dirname, 'node_modules', 'wrtc-neo', 'tun'),
        path.join(process.cwd(), 'node_modules', 'wrtc-neo', 'tun'),
        path.join(require.resolve('wrtc-neo').replace('index.js', ''), 'tun')
    ];

    let tunDir = null;
    for (const p of driverPaths) {
        if (fs.existsSync(path.join(p, 'wintun.dll')) || fs.existsSync(path.join(p, 'install.bat'))) {
            tunDir = p;
            break;
        }
    }

    if (!tunDir) {
        // 下载 wintun
        console.log(chalk.yellow('Downloading wintun driver from wintun.net...'));
        const zipPath = path.join(os.tmpdir(), 'wintun.zip');
        const extractPath = path.join(os.tmpdir(), 'wintun-extract');

        try {
            execSync(`powershell -Command "Invoke-WebRequest -Uri 'https://www.wintun.net/builds/wintun-0.14.1.zip' -OutFile '${zipPath}'"`, { timeout: 30000 });
            execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`, { timeout: 10000 });
            tunDir = extractPath;
        } catch (e) {
            console.log(chalk.red('✗ Failed to download wintun'));
            console.log(chalk.gray('  Manual install: https://www.wintun.net/'));
            console.log(chalk.gray('  Or use proxy mode: mp network (no driver needed)'));
            process.exit(1);
        }
    }

    try {
        const installBat = path.join(tunDir, 'install.bat');
        if (fs.existsSync(installBat)) {
            console.log(chalk.gray('Running installer (requires admin)...'));
            execSync(`"${installBat}"`, { stdio: 'inherit', timeout: 30000 });
        } else {
            console.log(chalk.gray('Installing wintun driver...'));
            console.log(chalk.yellow('⚠ This requires Administrator privileges'));
            console.log(chalk.gray('  Run this command in an admin terminal, or:'));
            console.log(chalk.gray('  1. Copy wintun.dll to C:\\Windows\\System32\\'));
            console.log(chalk.gray('  2. Copy wintun.sys to C:\\Windows\\System32\\drivers\\'));
            console.log(chalk.gray('  3. Restart MineP2P'));
            process.exit(0);
        }
    } catch (e) {
        console.log(chalk.red('✗ Installation failed. Try running as Administrator:'));
        console.log(chalk.yellow('  Right-click Command Prompt → Run as Administrator'));
        console.log(chalk.gray('  Then: mp tun-install'));
        process.exit(1);
    }

    console.log('');
    console.log(chalk.green('✓ TUN driver installed!'));
    console.log(chalk.gray('  Run "mp network" to use virtual NIC'));
    console.log(chalk.gray(`  If TUN mode still doesn't work, restart your computer`));
};

const ovpnInstallCommand = () => {
    printHeader();
    const OvpnAdapter = require('wrtc-neo').OvpnAdapter || require('wrtc-neo/lib/ovpn-adapter');
    const ovpnDir = path.join(HOME_DIR, 'ovpn');

    if (OvpnAdapter.isInstalled()) {
        console.log(chalk.green('✓ OpenVPN is already installed'));
        console.log(chalk.gray(`  Path: ${OvpnAdapter.findOpenVPN()}`));
        console.log('');
        console.log(chalk.cyan('TAP Adapter Info:'));
        const adapter = new OvpnAdapter({ ovpnDir });
        console.log(`  Name: ${adapter.getTapAdapterName() || 'not found'}`);
        console.log(`  IP:   ${adapter.getTapAdapterIP() || 'not assigned'}`);
        console.log('');
        console.log(chalk.gray('  Run "mp network" to start the virtual LAN'));
        console.log(chalk.gray('  Run "mp ovpn-status" to check OVPN status'));
    } else {
        console.log(chalk.yellow('OpenVPN is not installed'));
        console.log('');
        console.log(chalk.cyan('Installation:'));
        console.log(chalk.gray('  1. Download from: https://openvpn.net/community-downloads/'));
        console.log(chalk.gray('  2. Run installer → check "TAP Virtual Ethernet Adapter"'));
        console.log(chalk.gray('  3. Restart MineP2P daemon'));
        console.log('');
        console.log(chalk.cyan('Quick install (Windows):'));
        console.log(chalk.yellow('  winget install OpenVPNTechnologies.OpenVPN'));
    }
};

const ovpnStatusCommand = async () => {
    printHeader();

    if (!Daemon.isRunning()) {
        console.log(chalk.red('✗ Daemon is not running'));
        console.log(chalk.gray('  Run "mp start --room <room>" first'));
        process.exit(1);
    }

    try {
        const result = await (await fetch(`${DAEMON_URL}/network/status`)).json();

        console.log(chalk.cyan('OVPN Status:'));
        console.log(`  Mode:    ${result.mode === 'OVPN' ? chalk.green('OVPN') : chalk.yellow('UDP')}`);
        console.log(`  State:   ${result.state}`);
        console.log(`  VLAN IP: ${result.vlan ? result.vlan.localIP : 'not started'}`);
        console.log('');

        if (result.vlan && result.vlan.ovpn) {
            const o = result.vlan.ovpn;
            console.log(chalk.cyan('OpenVPN:'));
            console.log(`  Installed: ${o.openvpnInstalled ? chalk.green('Yes') : chalk.red('No')}`);
            console.log(`  Path:      ${o.openvpnPath || 'not found'}`);
            console.log(`  State:     ${o.state}`);
            console.log(`  TAP Name:  ${o.tapAdapter || 'not found'}`);
            console.log(`  TAP IP:    ${o.tapIP || 'not assigned'}`);
        }

        if (result.peers && result.peers.length > 0) {
            console.log('');
            console.log(chalk.cyan('Connected Peers:'));
            for (const peer of result.peers) {
                console.log(`  ${chalk.green(peer.virtualIP)} → ${peer.peerId.substring(0, 8)}...`);
            }
        }
    } catch (error) {
        console.log(chalk.red(`✗ Failed: ${error.message}`));
        process.exit(1);
    }
};

const ovpnKeyCommand = () => {
    printHeader();
    const OvpnAdapter = require('wrtc-neo').OvpnAdapter || require('wrtc-neo/lib/ovpn-adapter');
    const adapter = new OvpnAdapter({ ovpnDir: path.join(HOME_DIR, 'ovpn') });
    const key = adapter.getStaticKey();

    if (key) {
        console.log(chalk.cyan('OVPN Static Key:'));
        console.log(chalk.dim(key));
        console.log('');
        console.log(chalk.gray('Share this key with other players to connect'));
        console.log(chalk.yellow('  mp network --client <host> --port 1194 --key "..."'));
    } else {
        console.log(chalk.yellow('No static key found'));
        console.log(chalk.gray('  Run "mp network" first to generate a key'));
    }
};

// ============================================================
// 沙箱命令
// ============================================================
const sandboxCommand = async (argv) => {
    printHeader();

    try {
        const resp = await fetch(`${DAEMON_URL}/sandbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: argv.action,
                plugin: argv.plugin,
                permission: argv.permission
            })
        });
        console.log(chalk.green(JSON.stringify(await resp.json(), null, 2)));
    } catch (e) {
        console.log(chalk.yellow('Daemon not running. Sandbox managed at plugin load time.'));
        console.log(chalk.gray('  Start daemon first: mp start'));
        console.log(chalk.gray('  Plugin permissions are declared in the plugin file:'));
        console.log(chalk.gray('    permissions: "network, storage, timer"'));
        console.log(chalk.gray('  Blacklist: mp sandbox blacklist <plugin-name>'));
    }
};

// ============================================================
// Daemon 模式分支
// ============================================================
const isDaemon = process.argv.slice(1).includes('--daemon');

if (isDaemon) {
    const roomArg = process.argv.find((arg, i) => arg === '--room' || arg === '-r');
    const room = roomArg ? process.argv[process.argv.indexOf(roomArg) + 1] : 'minep2p-default';
    runDaemon(room).catch(err => {
        console.error(err);
        process.exit(1);
    });
    // daemon 模式下跳过 CLI 解析,防止与 yaggs 命令冲突
    return;
}

// ============================================================
// CLI 命令注册
// ============================================================
const pkg = require('./package.json');

yaggs({ version: pkg.version })
    .command('start', 'Start MineP2P daemon in background', (y) => {
        y.positional('room', { describe: 'Room code to join (auto-generated if not specified)', type: 'string' });
    }, startCommand)
    .command('stop', 'Stop MineP2P daemon', null, stopCommand)
    .command('status', 'Check daemon status', null, statusCommand)
    .command('add', 'Add/join a new room', (y) => {
        y.positional('room', { describe: 'Room name', type: 'string' });
    }, addCommand)
    .command('send', 'Send a message to all peers', (y) => {
        y.positional('message', { describe: 'Message to send', type: 'string' });
    }, sendCommand)
    .command('messages', 'View stored messages', (y) => {
        y
            .positional('room', { describe: 'Room name', type: 'string', default: 'minep2p-default' })
            .option('limit', { describe: 'Number of messages to show', type: 'number', default: 20 });
    }, messagesCommand)
    .command('logs', 'View daemon logs', null, logsCommand)
    .command('set', 'Set a config value', (y) => {
        y
            .positional('key', { describe: 'Config key', type: 'string' })
            .positional('value', { describe: 'Config value', type: 'string' });
    }, setCommand)
    .command('get', 'View current config', (y) => {
        y.positional('key', { describe: 'Config key (optional)', type: 'string' });
    }, getCommand)
    .command('config', 'Open configuration manager', configCommand)
    .command('config-reset', 'Reset config to default', (y) => {
        y.positional('key', { describe: 'Config key to reset (optional, resets all if not provided)', type: 'string' });
    }, resetCommand)

    // 插件商店命令
    .command('store', 'Browse plugin store', null, storeCommand)
    .command('search', 'Search plugins', (y) => {
        y.positional('query', { describe: 'Search query', type: 'string' });
    }, searchCommand)
    .command('install', 'Install a plugin', (y) => {
        y.positional('name', { describe: 'Plugin name', type: 'string' });
    }, installCommand)
    .command('plugins', 'List installed plugins', null, pluginsCommand)

    // 网络命令
    .command('network', 'Start virtual LAN for game multiplayer (OVPN server)', (y) => {
        y.option('client', { alias: 'c', type: 'boolean', description: 'Connect as client to OVPN server' });
        y.option('server', { alias: 's', type: 'string', description: 'OVPN server host (client mode)' });
        y.option('port', { alias: 'p', type: 'number', description: 'OVPN server port (default: 1194)' });
        y.option('key', { alias: 'k', type: 'string', description: 'OVPN static key (client mode)' });
    }, networkCommand)
    .command('peers', 'List connected peers in virtual LAN', null, peersCommand)
    .command('punch', 'Punch to a peer for direct connection', (y) => {
        y
            .positional('address', { describe: 'Target public address', type: 'string' })
            .positional('port', { describe: 'Target port', type: 'number' });
    }, punchCommand)
    .command('tun-install', 'Install TUN driver for virtual NIC support', null, tunInstallCommand)
    .command('ovpn-install', 'Check/install OpenVPN + TAP driver', null, ovpnInstallCommand)
    .command('ovpn-status', 'Show OVPN virtual NIC status', null, ovpnStatusCommand)
    .command('ovpn-key', 'Show OVPN static key for sharing', null, ovpnKeyCommand)
    .command('sandbox', 'Sandbox management', (y) => {
        y
            .positional('action', { describe: 'Action: blacklist, stats, permissions', type: 'string', default: 'stats' })
            .positional('plugin', { describe: 'Plugin name', type: 'string' })
            .option('permission', { describe: 'Permission to grant/revoke', type: 'string' });
    }, sandboxCommand)

    .help()
    .run()
    .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
    });