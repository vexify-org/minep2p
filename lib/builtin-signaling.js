// © Vexify 2026 All Rights Reserved.
/**
 * MineP2P 内置信令服务器
 *
 * 不依赖外部 PHP 服务器,直接在 daemon 的 HTTP 服务里提供信令功能。
 *   - 房间管理(join/leave)
 *   - 消息队列 + 长轮询(poll)
 *   - Peer 发现(peers list)
 *
 * 用法: 主机 daemon 绑定 0.0.0.0:9527,客户端通过 HTTP 轮询主机 daemon 交换信令。
 */

// Peer 无心跳超时(毫秒)
const PEER_TIMEOUT = 30000;
const CLEANUP_INTERVAL = 10000;
const POLL_INTERVAL = 500;

class BuiltinSignaling {
    constructor() {
        // room -> { peers: Map<peerId, {joinedAt,lastSeen}>, messages: Map<peerId, []> }
        this._rooms = new Map();
        this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL);
        this._cleanupTimer.unref?.();
    }

    // ============================================================
    // 房间管理
    // ============================================================

    /**
     * Peer 加入房间
     * @returns {object} { peers: string[], peerCount: number }
     */
    join(room, peerId) {
        if (!this._rooms.has(room)) {
            this._rooms.set(room, { peers: new Map(), messages: new Map() });
        }

        const roomData = this._rooms.get(room);
        const isNew = !roomData.peers.has(peerId);

        roomData.peers.set(peerId, { joinedAt: Date.now(), lastSeen: Date.now() });
        roomData.messages.set(peerId, roomData.messages.get(peerId) || []);

        // 通知其他在线 peer
        if (isNew) {
            for (const [otherId] of roomData.peers) {
                if (otherId !== peerId) {
                    this._enqueueMessage(room, otherId, { type: 'peerJoined', peerId, timestamp: Date.now() });
                }
            }
        }

        // 返回房间里已有的 peers(不含自己)
        const existingPeers = [];
        for (const [id] of roomData.peers) {
            if (id !== peerId) existingPeers.push(id);
        }

        return { peers: existingPeers, peerCount: roomData.peers.size };
    }

    leave(room, peerId) {
        const roomData = this._rooms.get(room);
        if (!roomData) return;

        roomData.peers.delete(peerId);
        roomData.messages.delete(peerId);

        for (const [otherId] of roomData.peers) {
            this._enqueueMessage(room, otherId, { type: 'peerLeft', peerId, timestamp: Date.now() });
        }

        // 清理空房间
        if (roomData.peers.size === 0) {
            this._rooms.delete(room);
        }
    }

    /** 心跳: 更新 lastSeen,避免被过期清理移除 */
    heartbeat(room, peerId) {
        const roomData = this._rooms.get(room);
        const peer = roomData && roomData.peers.get(peerId);
        if (!peer) return false;
        peer.lastSeen = Date.now();
        return true;
    }

    // ============================================================
    // 消息
    // ============================================================

    sendMessage(room, targetPeerId, message) {
        this._enqueueMessage(room, targetPeerId, { ...message, timestamp: Date.now() });
        return true;
    }

    /** 广播到房间内所有 peer(除发送者) */
    broadcastMessage(room, fromPeerId, message) {
        const roomData = this._rooms.get(room);
        if (!roomData) return;
        for (const [peerId] of roomData.peers) {
            if (peerId !== fromPeerId) {
                this._enqueueMessage(room, peerId, { ...message, fromPeerId, timestamp: Date.now() });
            }
        }
    }

    // ============================================================
    // 轮询
    // ============================================================

    /**
     * 长轮询获取消息
     * @param {number} timeout - 最长等待毫秒数
     * @returns {Promise<{messages: []}>}
     */
    async poll(room, peerId, timeout = 30000) {
        const roomData = this._rooms.get(room);
        if (!roomData) return { messages: [] };

        this.heartbeat(room, peerId);
        const messages = roomData.messages.get(peerId) || [];

        if (messages.length > 0) {
            return { messages: messages.splice(0, messages.length) };
        }

        // 无消息则等待(长轮询)
        return new Promise((resolve) => {
            const startTime = Date.now();
            const interval = setInterval(() => {
                const msgs = roomData.messages.get(peerId) || [];
                if (msgs.length > 0) {
                    clearInterval(interval);
                    resolve({ messages: msgs.splice(0, msgs.length) });
                } else if (Date.now() - startTime >= timeout) {
                    clearInterval(interval);
                    resolve({ messages: [] });
                }
            }, POLL_INTERVAL);
        });
    }

    // ============================================================
    // 查询
    // ============================================================

    getPeers(room) {
        const roomData = this._rooms.get(room);
        if (!roomData) return [];
        const peers = [];
        for (const [id, info] of roomData.peers) {
            peers.push({ peerId: id, joinedAt: info.joinedAt, lastSeen: info.lastSeen });
        }
        return peers;
    }

    getRooms() {
        const rooms = [];
        for (const [name, data] of this._rooms) {
            rooms.push({ name, peerCount: data.peers.size });
        }
        return rooms;
    }

    // ============================================================
    // 内部
    // ============================================================

    _enqueueMessage(room, peerId, message) {
        const roomData = this._rooms.get(room);
        if (!roomData) return;
        if (!roomData.messages.has(peerId)) {
            roomData.messages.set(peerId, []);
        }
        roomData.messages.get(peerId).push(message);
    }

    /** 定期清理超时的 peer(30 秒无心跳) */
    _cleanup() {
        const now = Date.now();
        for (const [room, roomData] of this._rooms) {
            for (const [peerId, info] of roomData.peers) {
                if (now - info.lastSeen > PEER_TIMEOUT) {
                    this.leave(room, peerId);
                }
            }
        }
    }

    destroy() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        this._rooms.clear();
    }
}

module.exports = BuiltinSignaling;