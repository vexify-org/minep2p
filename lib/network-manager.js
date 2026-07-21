// © Vexify 2026 All Rights Reserved.
const wrtc = require('wrtc-neo');

class NetworkManager {
    constructor(minep2p) {
        this.minep2p = minep2p;
        this.holePuncher = new wrtc.HolePuncher();
        this.vlan = new wrtc.VirtualLAN();
        this.state = 'closed';
        this.publicInfo = null;
        this._ovpnInfo = null; // 服务器模式下保存 OVPN 连接信息
    }

    /**
     * 启动网络管理器（自动检测 OVPN 或 UDP 模式）
     */
    async start(options = {}) {
        // 启动打洞器
        await this.holePuncher.start();
        console.log('[NetworkManager] HolePuncher started on port', this.holePuncher.getLocalPort());

        // 通过 STUN 获取公网地址（带超时）
        const stunServers = [
            ['stun.cloudflare.com', 3478],
            ['stun.l.google.com', 19302]
        ];

        for (const [host, port] of stunServers) {
            try {
                const info = await Promise.race([
                    this.holePuncher.discoverPublicAddress(host, port),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                ]);
                console.log('[NetworkManager] Public address:', info.address, ':', info.port);
                this.publicInfo = info;
                break;
            } catch (e) {
                console.warn(`[NetworkManager] STUN ${host}:${port} failed:`, e.message);
            }
        }

        if (!this.publicInfo) {
            console.warn('[NetworkManager] All STUN servers failed. Running in LAN-only mode.');
        }

        // 启动虚拟局域网
        const vlanOpts = { ovpn: options.ovpn !== false, port: options.port || 1194 };

        if (options.server) {
            // 主机模式：启动 OVPN 服务器
            vlanOpts.server = true;
            vlanOpts.port = options.port || 1194;
        } else if (options.serverHost && options.serverPort) {
            // 客户端模式：连接到 OVPN 服务器
            vlanOpts.serverHost = options.serverHost;
            vlanOpts.serverPort = options.serverPort;
            vlanOpts.staticKey = options.staticKey || null;
            vlanOpts.localIP = options.localIP || null;
        }

        const vlanInfo = await this.vlan.start(this.minep2p.peerId, vlanOpts);
        console.log('[NetworkManager] VirtualLAN started, local IP:', vlanInfo.ip, ', mode:', vlanInfo.mode);

        this.state = 'running';

        return {
            publicAddress: this.publicInfo,
            virtualIP: vlanInfo.ip,
            port: vlanInfo.port,
            mode: vlanInfo.mode,
            ovpnInfo: this._ovpnInfo
        };
    }

    /**
     * 主机模式：启动 OVPN 服务器
     * 其他人通过 startAsClient 连接进来
     */
    async startAsServer(options = {}) {
        this._ovpnInfo = null;
        const result = await this.start({ ...options, server: true, ovpn: true });

        // 保存 OVPN 共享信息
        if (this.vlan.isOvpnMode) {
            this._ovpnInfo = {
                staticKey: this.vlan.getStaticKey(),
                serverHost: this.publicInfo?.address || '127.0.0.1',
                serverPort: result.port,
                virtualIP: result.virtualIP
            };
        }

        return { ...result, ovpnInfo: this._ovpnInfo };
    }

    /**
     * 客户端模式：连接到 OVPN 服务器
     */
    async startAsClient(serverHost, serverPort, staticKey, options = {}) {
        return await this.start({
            ...options,
            server: false,
            ovpn: true,
            serverHost,
            serverPort,
            staticKey
        });
    }

    /**
     * 自动连接房间内所有对端
     */
    async connectRoomPeers() {
        if (this.state !== 'running') {
            await this.start();
        }

        const peers = this.minep2p.getPeers();
        const results = [];

        console.log(`[NetworkManager] Connecting to ${peers.length} peers in room...`);

        for (const peer of peers) {
            const peerId = peer.peerId || peer.id;
            const address = peer.publicAddress || peer.address;
            const port = peer.publicPort || peer.port;

            if (address && port) {
                try {
                    const virtualIP = await this.connect(peerId, address, port);
                    results.push({ peerId, virtualIP, success: true });
                } catch (e) {
                    console.error(`[NetworkManager] Failed to connect ${peerId.substring(0, 8)}:`, e.message);
                    results.push({ peerId, success: false, error: e.message });
                }
            }
        }

        return results;
    }

    /**
     * 获取本机公网信息（分享给其他玩家）
     */
    getShareInfo() {
        const info = {
            peerId: this.minep2p.peerId,
            publicAddress: this.publicInfo?.address,
            publicPort: this.publicInfo?.port || this.holePuncher.getLocalPort(),
            virtualIP: this.vlan.localIP,
            mode: this.vlan.isOvpnMode ? 'ovpn' : 'udp'
        };

        // OVPN 模式下附带静态密钥
        if (this.vlan.isOvpnMode && this._ovpnInfo) {
            info.ovpnStaticKey = this._ovpnInfo.staticKey;
            info.ovpnServerPort = this._ovpnInfo.serverPort;
        }

        return info;
    }

    /**
     * 连接到对端节点（打洞）
     */
    async connect(peerId, address, port) {
        // 打洞
        this.holePuncher.punch(address, port, peerId);
        console.log(`[NetworkManager] Punching ${address}:${port} for peer ${peerId.substring(0, 8)}...`);

        // 分配虚拟 IP
        const virtualIP = await this.vlan.allocateIP(peerId);
        this.vlan.addPeer(peerId, virtualIP, address, port);

        console.log(`[NetworkManager] Peer ${peerId.substring(0, 8)}... assigned ${virtualIP}`);

        return virtualIP;
    }

    /**
     * 发送数据到虚拟 IP
     */
    sendToVirtualIP(virtualIP, data) {
        return this.vlan.sendPacket(virtualIP, data);
    }

    /**
     * 广播到所有节点
     */
    broadcast(data) {
        this.vlan.broadcast(data);
    }

    /**
     * 获取局域网状态
     */
    getStatus() {
        return {
            state: this.state,
            mode: this.vlan.isOvpnMode ? 'OVPN' : 'UDP',
            holePuncher: {
                localPort: this.holePuncher.getLocalPort(),
                publicAddress: this.holePuncher.getPublicAddress()
            },
            vlan: this.vlan.getStatus(),
            peers: this.vlan.listPeers()
        };
    }

    /**
     * 为游戏端口创建转发
     * 游戏连 127.0.0.1:localPort 即可访问虚拟局域网内 virtualIP:virtualPort
     */
    forwardGamePort(localPort, virtualIP, virtualPort, protocol = 'tcp') {
        return this.vlan.addGamePortForward(localPort, virtualIP, virtualPort, protocol);
    }

    /**
     * 停止网络管理器
     */
    stop() {
        this.holePuncher.stop();
        this.vlan.stop();
        this._ovpnInfo = null;
        this.state = 'closed';
    }
}

module.exports = NetworkManager;