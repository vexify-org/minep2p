// © Vexify 2026 All Rights Reserved.
const Store = require('./store');
const defaultConfig = require('./config');

// 合并默认配置和用户自定义配置
const getConfig = () => {
    const userConfig = Store.getAllConfig();
    return { ...defaultConfig, ...userConfig };
};

// 解析房间号，返回对应的端点URL
// 格式: mp-{node}-{random}
// node: n1, n2, n3... 或自定义URL
const parseRoomEndpoint = (roomName, config) => {
    // 匹配格式: mp-{node}-{random}
    const match = roomName.match(/^mp-(.+?)-/);

    if (!match) {
        // 不匹配格式，使用默认端点
        return config.apiBaseUrl || defaultConfig.apiBaseUrl;
    }

    const node = match[1].toLowerCase();

    // 检查是否是自定义节点（包含 . 或 : 或 http）
    if (node.includes('.') || node.includes(':') || node.startsWith('http')) {
        // 自定义节点URL
        if (!node.startsWith('http')) {
            return 'https://' + node + '/';
        }
        return node.endsWith('/') ? node : node + '/';
    }

    // 预定义节点
    const endpoints = config.apiEndpoints || defaultConfig.apiEndpoints;

    switch (node) {
        case 'n1':
            return endpoints[0]?.url || 'https://vex-api-2.vexify.qzz.io/';
        case 'n2':
            return endpoints[1]?.url || 'https://api.vexify.top/';
        case 'n3':
        case 'n4':
        case 'n5':
            // 扩展节点支持
            const nodeIndex = parseInt(node.substring(1)) - 1;
            return endpoints[nodeIndex]?.url || endpoints[0]?.url || defaultConfig.apiBaseUrl;
        default:
            return config.apiBaseUrl || defaultConfig.apiBaseUrl;
    }
};

class Signaling {
    /**
     * @param {string} peerId
     * @param {object} options
     * @param {string} options.hubUrl - 使用 daemon 内置信令（http://host:9527）
     */
    constructor(peerId, options = {}) {
        this.peerId = peerId;
        this.room = null;
        this.polling = false;
        this.currentEndpoint = null;
        this._hubUrl = options.hubUrl || null;  // daemon 内置信令 URL
        this._useBuiltin = !!this._hubUrl;
        this.callbacks = {
            message: [],
            peerJoined: [],
            peerLeft: []
        };
    }

    // 获取当前端点
    getEndpoint() {
        if (this._useBuiltin) return this._hubUrl;
        if (!this.currentEndpoint) {
            const config = getConfig();
            this.currentEndpoint = config.apiBaseUrl || defaultConfig.apiBaseUrl;
        }
        return this.currentEndpoint;
    }

    /**
     * 切换信令后端
     * @param {string} hubUrl - daemon URL，如 http://192.168.1.5:9527
     */
    setHubUrl(hubUrl) {
        this._hubUrl = hubUrl;
        this._useBuiltin = true;
        console.log(`[Signaling] Switched to builtin hub: ${hubUrl}`);
    }

    async join(room) {
        this.room = room;

        if (this._useBuiltin) {
            // 使用内置信令
            const response = await this._post('/signal/join', {
                room: room,
                peerId: this.peerId
            });
            // 内置信令返回 { peers: [...] }
            if (response && response.peers) {
                for (const pid of response.peers) {
                    this._handleMessage({ type: 'peerJoined', peerId: pid });
                }
            }
            return response;
        }

        // 默认 PHP 信令
        const config = getConfig();
        this.currentEndpoint = parseRoomEndpoint(room, config);

        const response = await this._post('?action=join', {
            room: room,
            peerId: this.peerId
        });
        return response;
    }

    async leave() {
        if (!this.room) return;

        if (this._useBuiltin) {
            await this._post('/signal/leave', {
                room: this.room,
                peerId: this.peerId
            });
        } else {
            await this._post('?action=leave', {
                room: this.room,
                peerId: this.peerId
            });
        }
        this.room = null;
        this.polling = false;
    }

    async sendMessage(message) {
        if (!this.room) throw new Error('Not joined to any room');

        if (this._useBuiltin) {
            return await this._post('/signal/message', {
                room: this.room,
                fromPeerId: this.peerId,
                targetPeerId: message.targetPeerId || null,
                message: message
            });
        }

        return await this._post('?action=message', {
            room: this.room,
            peerId: this.peerId,
            message: message
        });
    }

    async getRooms() {
        if (this._useBuiltin) {
            const response = await this._get('/signal/peers?room=' + encodeURIComponent(this.room || ''));
            return response;
        }
        const response = await this._get('?action=rooms');
        return response;
    }

    startPolling() {
        if (this.polling || !this.room) return;
        this.polling = true;
        this._poll();
    }

    stopPolling() {
        this.polling = false;
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

    async _poll() {
        if (!this.polling || !this.room) return;

        const config = getConfig();
        const timeout = this._useBuiltin ? 30000 : (config.pollTimeout || 30000);

        try {
            let response;

            if (this._useBuiltin) {
                // 内置信令：长轮询
                response = await this._get(`/signal/poll?room=${encodeURIComponent(this.room)}&peerId=${encodeURIComponent(this.peerId)}&timeout=${timeout}`);
            } else {
                // PHP 信令
                response = await this._get(`?action=poll&room=${encodeURIComponent(this.room)}&peerId=${encodeURIComponent(this.peerId)}&timeout=${timeout}`);
            }

            if (response && response.messages) {
                for (const msg of response.messages) {
                    this._handleMessage(msg);
                }
            }
        } catch (error) {
            console.log('Poll error:', error.message);
        } finally {
            if (this.polling) {
                setTimeout(() => this._poll(), 1000);
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

    async _post(endpoint, data) {
        const baseUrl = this.getEndpoint();
        try {
            const response = await fetch(baseUrl + endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });
            return await response.json();
        } catch (error) {
            // 提取错误信息（Node.js native fetch 的错误可能在 cause 里）
            const errMsg = error.message || '';
            const causeMsg = error.cause?.message || '';
            const fullMsg = errMsg + causeMsg;

            // 内置信令不尝试 HTTP fallback
            if (this._useBuiltin) {
                console.log('Builtin signaling POST error:', error.message);
                throw error;
            }

            // SSL/HTTPS 错误或通用 fetch 失败时尝试 http fallback
            if (fullMsg.includes('SSL') || fullMsg.includes('certificate') || fullMsg.includes('handshake') || fullMsg.includes('fetch failed') || fullMsg.includes('ECONNREFUSED') || fullMsg.includes('ETIMEDOUT') || fullMsg.includes('ENOTFOUND') || !errMsg) {
                const httpUrl = baseUrl.replace('https://', 'http://');
                console.log(`[Signaling] HTTPS failed (${errMsg || causeMsg || 'unknown'}), trying HTTP: ${httpUrl}`);
                try {
                    const response = await fetch(httpUrl + endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(data)
                    });
                    return await response.json();
                } catch (httpError) {
                    console.log('POST error (http fallback):', httpError.message);
                    throw httpError;
                }
            }
            console.log('POST error:', error.message);
            throw error;
        }
    }

    async _get(endpoint) {
        const baseUrl = this.getEndpoint();
        try {
            const response = await fetch(baseUrl + endpoint);
            return await response.json();
        } catch (error) {
            const errMsg = error.message || '';
            const causeMsg = error.cause?.message || '';
            const fullMsg = errMsg + causeMsg;

            if (this._useBuiltin) {
                console.log('Builtin signaling GET error:', error.message);
                throw error;
            }

            if (fullMsg.includes('SSL') || fullMsg.includes('certificate') || fullMsg.includes('handshake') || fullMsg.includes('fetch failed') || !errMsg) {
                const httpUrl = baseUrl.replace('https://', 'http://');
                console.log(`[Signaling] HTTPS GET failed (${errMsg || causeMsg || 'unknown'}), trying HTTP: ${httpUrl}`);
                try {
                    const response = await fetch(httpUrl + endpoint);
                    return await response.json();
                } catch (httpError) {
                    console.log('GET error (http fallback):', httpError.message);
                    throw httpError;
                }
            }
            console.log('GET error:', error.message);
            throw error;
        }
    }
}

module.exports = Signaling;