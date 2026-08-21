// © Vexify 2026 All Rights Reserved.
const Store = require('./store');
const defaultConfig = require('./config');

// 合并默认配置与用户自定义配置
const getConfig = () => ({ ...defaultConfig, ...Store.getAllConfig() });

/**
 * 解析房间号,返回对应的信令端点 URL。
 * 房间格式: mp-{node}-{random}
 *   - node 为 n1/n2/...: 映射到预定义端点(负载均衡)
 *   - node 含 `.` `:` 或 `http`: 视为自定义信令节点
 *   - 其它: 使用默认端点
 */
const parseRoomEndpoint = (roomName, config) => {
    const match = roomName.match(/^mp-(.+?)-/);
    if (!match) {
        return config.apiBaseUrl || defaultConfig.apiBaseUrl;
    }

    const node = match[1].toLowerCase();

    if (node.includes('.') || node.includes(':') || node.startsWith('http')) {
        if (!node.startsWith('http')) {
            return 'https://' + node + '/';
        }
        return node.endsWith('/') ? node : node + '/';
    }

    const endpoints = config.apiEndpoints || defaultConfig.apiEndpoints;
    switch (node) {
        case 'n1':
            return (endpoints[0] && endpoints[0].url) || 'https://vex-api-2.vexify.qzz.io/';
        case 'n2':
            return (endpoints[1] && endpoints[1].url) || 'https://api.vexify.top/';
        case 'n3':
        case 'n4':
        case 'n5': {
            // 扩展节点支持
            const idx = parseInt(node.substring(1), 10) - 1;
            return (endpoints[idx] && endpoints[idx].url) || (endpoints[0] && endpoints[0].url) || defaultConfig.apiBaseUrl;
        }
        default:
            return config.apiBaseUrl || defaultConfig.apiBaseUrl;
    }
};

class Signaling {
    /**
     * @param {string} peerId
     * @param {object} [options]
     * @param {string} [options.hubUrl] - daemon 内置信令 URL(http://host:9527),设置后使用内置信令
     */
    constructor(peerId, options = {}) {
        this.peerId = peerId;
        this.room = null;
        this.polling = false;
        this.currentEndpoint = null;
        this._hubUrl = options.hubUrl || null;
        this._useBuiltin = !!this._hubUrl;
        this._pollTimer = null;
        this.callbacks = {
            message: [],
            peerJoined: [],
            peerLeft: []
        };
    }

    getEndpoint() {
        if (this._useBuiltin) return this._hubUrl;
        if (!this.currentEndpoint) {
            this.currentEndpoint = getConfig().apiBaseUrl || defaultConfig.apiBaseUrl;
        }
        return this.currentEndpoint;
    }

    /** 切换信令后端到指定 daemon hub */
    setHubUrl(hubUrl) {
        this._hubUrl = hubUrl;
        this._useBuiltin = true;
        console.log(`[Signaling] Switched to builtin hub: ${hubUrl}`);
    }

    async join(room) {
        this.room = room;

        if (this._useBuiltin) {
            const response = await this._post('/signal/join', { room, peerId: this.peerId });
            if (response && response.peers) {
                for (const pid of response.peers) {
                    this._handleMessage({ type: 'peerJoined', peerId: pid });
                }
            }
            return response;
        }

        this.currentEndpoint = parseRoomEndpoint(room, getConfig());
        return await this._post('?action=join', { room, peerId: this.peerId });
    }

    async leave() {
        if (!this.room) return;
        if (this._useBuiltin) {
            await this._post('/signal/leave', { room: this.room, peerId: this.peerId });
        } else {
            await this._post('?action=leave', { room: this.room, peerId: this.peerId });
        }
        this.room = null;
        this.polling = false;
        if (this._pollTimer) clearTimeout(this._pollTimer);
    }

    async sendMessage(message) {
        if (!this.room) throw new Error('Not joined to any room');
        if (this._useBuiltin) {
            return await this._post('/signal/message', {
                room: this.room,
                fromPeerId: this.peerId,
                targetPeerId: message.targetPeerId || null,
                message
            });
        }
        return await this._post('?action=message', {
            room: this.room,
            peerId: this.peerId,
            message
        });
    }

    async getRooms() {
        if (this._useBuiltin) {
            return await this._get('/signal/peers?room=' + encodeURIComponent(this.room || ''));
        }
        return await this._get('?action=rooms');
    }

    startPolling() {
        if (this.polling || !this.room) return;
        this.polling = true;
        this._poll();
    }

    stopPolling() {
        this.polling = false;
        if (this._pollTimer) clearTimeout(this._pollTimer);
    }

    on(event, callback) {
        if (this.callbacks[event]) this.callbacks[event].push(callback);
    }

    off(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
        }
    }

    async _poll() {
        if (!this.polling || !this.room) return;

        const timeout = this._useBuiltin ? 30000 : (getConfig().pollTimeout || 30000);
        const query = this._useBuiltin
            ? `/signal/poll?room=${encodeURIComponent(this.room)}&peerId=${encodeURIComponent(this.peerId)}&timeout=${timeout}`
            : `?action=poll&room=${encodeURIComponent(this.room)}&peerId=${encodeURIComponent(this.peerId)}&timeout=${timeout}`;

        try {
            const response = await this._get(query);
            if (response && response.messages) {
                for (const msg of response.messages) {
                    this._handleMessage(msg);
                }
            }
        } catch (error) {
            console.log('Poll error:', error.message);
        } finally {
            if (this.polling) {
                this._pollTimer = setTimeout(() => this._poll(), 1000);
            }
        }
    }

    _handleMessage(msg) {
        switch (msg.type) {
            case 'peerJoined':
                this.callbacks.peerJoined.forEach(cb => cb(msg.peerId));
                break;
            case 'peerLeft':
                this.callbacks.peerLeft.forEach(cb => cb(msg.peerId));
                break;
            default:
                this.callbacks.message.forEach(cb => cb(msg));
                break;
        }
    }

    // ============ HTTP 请求(含 HTTPS→HTTP 自动降级) ============

    async _post(endpoint, data) {
        return await this._request(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }

    async _get(endpoint) {
        return await this._request(endpoint, { method: 'GET' });
    }

    /** 统一请求入口: 内置信令不做降级,外部信令在 SSL 等错误时回退 http */
    async _request(endpoint, options) {
        const baseUrl = this.getEndpoint();
        try {
            const response = await fetch(baseUrl + endpoint, options);
            return await response.json();
        } catch (error) {
            const errMsg = error.message || '';
            const causeMsg = (error.cause && error.cause.message) || '';
            const fullMsg = errMsg + causeMsg;

            if (this._useBuiltin) {
                console.log('Builtin signaling request error:', error.message);
                throw error;
            }

            // 网络/SSL 类错误尝试 http 降级
            const fallbackReasons = ['SSL', 'certificate', 'handshake', 'fetch failed', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
            if (!errMsg || fallbackReasons.some(k => fullMsg.includes(k))) {
                const httpUrl = baseUrl.replace('https://', 'http://');
                console.log(`[Signaling] HTTPS failed (${errMsg || causeMsg || 'unknown'}), trying HTTP: ${httpUrl}`);
                try {
                    const response = await fetch(httpUrl + endpoint, options);
                    return await response.json();
                } catch (httpError) {
                    console.log('Request error (http fallback):', httpError.message);
                    throw httpError;
                }
            }
            console.log('Request error:', error.message);
            throw error;
        }
    }
}

module.exports = Signaling;
module.exports.parseRoomEndpoint = parseRoomEndpoint;