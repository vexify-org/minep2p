// © Vexify 2026 All Rights Reserved.
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Signaling = require('./signaling');
const Peer = require('./peer');
const IPv6 = require('./ipv6');
const Store = require('./store');
const PluginLoader = require('./plugin-loader');
const FileTransfer = require('./file-transfer');
const NetworkManager = require('./network-manager');
const defaultConfig = require('./config');

// 合并默认配置和用户自定义配置
const getConfig = () => {
    const userConfig = Store.getAllConfig();
    return { ...defaultConfig, ...userConfig };
};

class MineP2P {
    constructor(options = {}) {
        this.peerId = uuidv4();
        this.signalings = new Map();
        this.peers = new Map();
        this.rooms = new Set();
        this.status = 'disconnected';
        this.options = options;
        this._signalingHub = options.signalingHub || null;  // 内置信令 URL

        // 插件系统
        this.plugins = new PluginLoader(this);

        // 文件传输
        this.fileTransfer = new FileTransfer(this);

        // 网络管理器（打洞 + 虚拟局域网）
        this.network = new NetworkManager(this);

        this.callbacks = {
            connect: [],
            disconnect: [],
            peerConnect: [],
            peerDisconnect: [],
            message: [],
            statusChange: [],
            error: [],
            reconnect: []
        };
    }

    /**
     * 加载插件
     */
    loadPlugin(filePath) {
        return this.plugins.load(filePath);
    }

    /**
     * 加载插件目录
     */
    loadPlugins(dirPath) {
        this.plugins.loadDir(dirPath);
    }

    async start(room = null) {
        const config = getConfig();
        const targetRoom = room || config.defaultRoom;

        if (this.rooms.has(targetRoom)) {
            return;
        }

        this.rooms.add(targetRoom);

        const signaling = new Signaling(this.peerId, { hubUrl: this._signalingHub });
        this.signalings.set(targetRoom, signaling);

        signaling.on('peerJoined', (peerId) => {
            this._handlePeerJoined(peerId, targetRoom);
        });

        signaling.on('peerLeft', (peerId) => {
            this._handlePeerLeft(peerId);
        });

        signaling.on('message', (message) => {
            this._handleMessage(message, targetRoom);
        });

        try {
            await signaling.join(targetRoom);
            this.status = 'connecting';
            this._emitStatusChange();
            signaling.startPolling();

            if (this.signalings.size === 1) {
                const ipv6 = await IPv6.getIPv6WithRetry();
                console.log(`IPv6 Address: ${ipv6 || 'Not available'}`);
            }

            this.status = 'connected';
            this._emitStatusChange();
            this.callbacks.connect.forEach(cb => cb(targetRoom));

        } catch (error) {
            this.rooms.delete(targetRoom);
            this.signalings.delete(targetRoom);

            if (this.signalings.size === 0) {
                this.status = 'error';
                this._emitStatusChange();
            }
            this.callbacks.error.forEach(cb => cb(error));
            throw error;
        }
    }

    async stop(room = null) {
        if (room) {
            const signaling = this.signalings.get(room);
            if (signaling) {
                signaling.stopPolling();
                await signaling.leave();
                this.signalings.delete(room);
                this.rooms.delete(room);
            }
        } else {
            for (const signaling of this.signalings.values()) {
                signaling.stopPolling();
                await signaling.leave();
            }
            this.signalings.clear();
            this.rooms.clear();
        }

        for (const peer of this.peers.values()) {
            peer.close();
        }
        this.peers.clear();

        this.status = 'disconnected';
        this._emitStatusChange();
        this.callbacks.disconnect.forEach(cb => cb());
    }

    async sendToPeer(peerId, message) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.send(message);
        }
    }

    broadcast(message) {
        for (const peer of this.peers.values()) {
            peer.send(message);
        }

        for (const signaling of this.signalings.values()) {
            signaling.sendMessage({
                type: 'chat',
                content: message.content,
                fromPeerId: this.peerId
            }).catch(() => {});
        }
    }

    getPeers() {
        return Array.from(this.peers.keys());
    }

    getRooms() {
        return Array.from(this.rooms);
    }

    getStatus() {
        return {
            status: this.status,
            peerId: this.peerId,
            rooms: this.getRooms(),
            peerCount: this.peers.size
        };
    }

    /**
     * 启动网络功能（打洞 + 虚拟局域网）
     */
    async startNetwork(options) {
        return await this.network.start(options);
    }

    /**
     * 主机模式：启动 OVPN 服务器
     */
    async startNetworkAsServer(options = {}) {
        return await this.network.startAsServer(options);
    }

    /**
     * 客户端模式：连接 OVPN 服务器
     */
    async startNetworkAsClient(serverHost, serverPort, staticKey, options = {}) {
        return await this.network.startAsClient(serverHost, serverPort, staticKey, options);
    }

    /**
     * 自动连接房间内所有节点（一键联机）
     */
    async connectRoomNetwork() {
        return await this.network.connectRoomPeers();
    }

    /**
     * 获取本机公网信息（分享给其他玩家）
     */
    getNetworkShareInfo() {
        return this.network.getShareInfo();
    }

    /**
     * 获取网络状态
     */
    getNetworkStatus() {
        return this.network.getStatus();
    }

    // ============================================================
    // 文件传输 v2 API
    // ============================================================
    async sendFile(peerId, filePath, options) {
        return await this.fileTransfer.sendFile(peerId, filePath, options);
    }

    async sendFolder(peerId, folderPath, options) {
        return await this.fileTransfer.sendFolder(peerId, folderPath, options);
    }

    shareFile(filePath, fileName) {
        return this.fileTransfer.shareFile(filePath, fileName);
    }

    unshareFile(fileName) {
        return this.fileTransfer.unshareFile(fileName);
    }

    getSharedFiles() {
        return this.fileTransfer.getSharedFiles();
    }

    searchFile(query, options) {
        return this.fileTransfer.searchFile(query, options);
    }

    getTransferStatus(fileId) {
        return this.fileTransfer.getTransferStatus(fileId);
    }

    getAllTransfers() {
        return this.fileTransfer.getAllTransfers();
    }

    pauseTransfer(fileId) {
        return this.fileTransfer.pauseTransfer(fileId);
    }

    resumeTransfer(fileId) {
        return this.fileTransfer.resumeTransfer(fileId);
    }

    cancelTransfer(fileId) {
        return this.fileTransfer.cancelTransfer(fileId);
    }

    setSpeedLimit(fileId, bytesPerSecond) {
        return this.fileTransfer.setSpeedLimit(fileId, bytesPerSecond);
    }

    /**
     * 通过打洞连接到对端
     */
    async connectPeer(peerId, address, port) {
        return await this.network.connect(peerId, address, port);
    }

    /**
     * 发送数据到虚拟 IP
     */
    sendToVirtualIP(virtualIP, data) {
        return this.network.sendToVirtualIP(virtualIP, data);
    }

    on(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event].push(callback);
        }
    }

    off(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
        }
    }

    async _handlePeerJoined(peerId, room) {
        if (peerId === this.peerId) return;

        if (!this.peers.has(peerId)) {
            const signaling = this.signalings.get(room);
            const peer = new Peer(peerId, signaling);
            this.peers.set(peerId, peer);

            peer.on('connect', () => {
                this.callbacks.peerConnect.forEach(cb => cb(peerId));
                // 触发插件事件
                this.plugins.handleEvent('join', { peerId, room });
            });

            peer.on('disconnect', () => {
                this._handlePeerLeft(peerId);
            });

            peer.on('message', (data) => {
                this.callbacks.message.forEach(cb => cb(peerId, data));
                // 触发插件系统（支持命令和消息事件）
                if (data.type === 'chat') {
                    this.plugins.handleMessage(data.content, {
                        peerId,
                        room
                    });
                }
            });

            peer.on('error', (error) => {
                this.callbacks.error.forEach(cb => cb(error));
            });

            await peer.connect(true);
        }
    }

    _handlePeerLeft(peerId) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.close();
            this.peers.delete(peerId);
            // 触发插件事件
            const room = this.rooms.values().next().value;
            this.plugins.handleEvent('leave', { peerId, room });
            this.callbacks.peerDisconnect.forEach(cb => cb(peerId));
        }
    }

    async _handleMessage(message, room) {
        const { type, fromPeerId, sdp, candidate, content } = message;

        if (type === 'chat' && fromPeerId && content) {
            this.callbacks.message.forEach(cb => cb(fromPeerId, { type: 'chat', content: content }));
            this.plugins.handleMessage(content, {
                peerId: fromPeerId,
                room
            });
            return;
        }

        if (!this.peers.has(fromPeerId)) {
            const signaling = this.signalings.get(room);
            const peer = new Peer(fromPeerId, signaling);
            this.peers.set(fromPeerId, peer);

            peer.on('connect', () => {
                this.callbacks.peerConnect.forEach(cb => cb(fromPeerId));
            });

            peer.on('disconnect', () => {
                this._handlePeerLeft(fromPeerId);
            });

            peer.on('message', (data) => {
                this.callbacks.message.forEach(cb => cb(fromPeerId, data));
            });

            peer.on('error', (error) => {
                this.callbacks.error.forEach(cb => cb(error));
            });

            await peer.connect(false);
        }

        const peer = this.peers.get(fromPeerId);

        switch (type) {
            case 'offer':
                await peer.handleOffer(sdp);
                break;
            case 'answer':
                await peer.handleAnswer(sdp);
                break;
            case 'ice':
                await peer.handleIceCandidate(candidate);
                break;
            // 文件传输 v2
            case 'file-header-v2':
            case 'file-chunk-v2':
            case 'file-done-v2':
            case 'file-resume-request':
            case 'file-search':
            case 'file-search-result':
                this.fileTransfer.handleMessage(fromPeerId, message);
                break;
        }
    }

    _emitStatusChange() {
        this.callbacks.statusChange.forEach(cb => cb(this.status));
    }
}

module.exports = MineP2P;