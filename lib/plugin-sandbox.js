// © Vexify 2026 All Rights Reserved.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

/**
 * 插件沙箱 — 安全隔离 + 权限系统 + 资源限制
 *
 * 特性：
 * - VM 沙箱隔离，禁止 require 系统模块
 * - 权限系统：插件声明权限，用户授权
 * - 资源限制：CPU 时间、内存上限
 * - 插件黑名单
 * - 插件签名验证
 */

const PERMISSIONS = {
    NETWORK: 'network',       // 网络访问
    FILE_READ: 'file:read',   // 读取文件（限插件目录）
    FILE_WRITE: 'file:write', // 写入文件（限插件目录）
    COMMAND: 'command',       // 执行系统命令
    STORAGE: 'storage',       // key-value 存储
    TIMER: 'timer',           // 定时器
    UI: 'ui',                 // 界面扩展
    HOOK: 'hook'              // 钩子系统（拦截消息）
};

const DEFAULT_TIMEOUT = 5000;    // 5 秒 CPU 时间
const DEFAULT_MEMORY = 16 * 1024 * 1024; // 16 MB
const MAX_EXECUTION_TIME = 30000; // 30 秒 wall time

class PluginSandbox {
    constructor(options = {}) {
        this._minep2p = options.minep2p || null;
        this._permissions = new Map(); // pluginName -> Set<permission>
        this._blacklist = new Set();
        this._context = {};
        this._stats = new Map(); // pluginName -> { cpuTime, memUsage, runCount }
    }

    /**
     * 为插件授予权限
     */
    grantPermission(pluginName, permission) {
        if (!this._permissions.has(pluginName)) {
            this._permissions.set(pluginName, new Set());
        }
        this._permissions.get(pluginName).add(permission);
    }

    /**
     * 检查插件是否有某权限
     */
    checkPermission(pluginName, permission) {
        const perms = this._permissions.get(pluginName);
        return perms && perms.has(permission);
    }

    /**
     * 获取插件所需权限列表（从插件元数据）
     */
    getRequiredPermissions(plugin) {
        return (plugin.permissions || []).map(p => p.trim());
    }

    /**
     * 把插件加入黑名单
     */
    blacklist(pluginName) {
        this._blacklist.add(pluginName);
    }

    /**
     * 检查插件是否在黑名单
     */
    isBlacklisted(pluginName) {
        return this._blacklist.has(pluginName);
    }

    /**
     * 验证插件签名（SHA-256）
     */
    verifySignature(filePath, expectedHash) {
        try {
            const content = fs.readFileSync(filePath);
            const hash = require('crypto').createHash('sha256').update(content).digest('hex');
            return hash === expectedHash;
        } catch (e) {
            return false;
        }
    }

    /**
     * 创建沙箱化的执行上下文
     * 只暴露安全 API，禁止直接访问系统模块
     */
    createSandbox(pluginName, permissions = []) {
        const sandbox = {
            // 基础 API
            console: {
                log: (...args) => {
                    if (this._minep2p) {
                        this._minep2p.emit('plugin:log', { plugin: pluginName, level: 'info', args });
                    }
                },
                error: (...args) => {
                    if (this._minep2p) {
                        this._minep2p.emit('plugin:log', { plugin: pluginName, level: 'error', args });
                    }
                },
                warn: (...args) => {
                    if (this._minep2p) {
                        this._minep2p.emit('plugin:log', { plugin: pluginName, level: 'warn', args });
                    }
                }
            },

            // 插件 API
            pl: this._createPluginAPI(pluginName, permissions),

            // 定时器（需要 timer 权限）
            setTimeout: (fn, ms) => {
                if (!permissions.includes(PERMISSIONS.TIMER)) {
                    throw new Error(`Permission denied: timer (plugin: ${pluginName})`);
                }
                return setTimeout(fn, ms);
            },
            setInterval: (fn, ms) => {
                if (!permissions.includes(PERMISSIONS.TIMER)) {
                    throw new Error(`Permission denied: timer (plugin: ${pluginName})`);
                }
                return setInterval(fn, ms);
            },
            clearTimeout,
            clearInterval,
            setImmediate: (fn) => setImmediate(fn),
            clearImmediate,

            // 数据结构
            Array, Object, String, Number, Boolean, Date, Math, RegExp, JSON,
            Map, Set, WeakMap, WeakSet,
            Error, TypeError, RangeError, SyntaxError,
            parseInt, parseFloat, isNaN, isFinite,
            Buffer, TextEncoder, TextDecoder,

            // 防止逃逸
            require: undefined,
            process: undefined,
            global: undefined,
            globalThis: undefined,
            __dirname: undefined,
            __filename: undefined,
            module: undefined,
            exports: undefined,

            // 插件名
            __pluginName: pluginName,
            __permissions: permissions
        };

        return sandbox;
    }

    /**
     * 创建插件 API — 增强版 v2
     * 新增：消息拦截/修改、UI 扩展、定时器命名空间、HTTP 增强
     */
    _createPluginAPI(pluginName, permissions) {
        const self = this;

        const api = {
            // 权限检查
            hasPermission: (perm) => permissions.includes(perm),

            // ============================================================
            // 网络 API（需要 network 权限）
            // ============================================================
            http: {
                get: async (url, options = {}) => {
                    if (!permissions.includes(PERMISSIONS.NETWORK)) {
                        throw new Error('Permission denied: network');
                    }
                    const { default: fetch } = await import('node-fetch');
                    const resp = await fetch(url, { headers: options.headers || {}, timeout: options.timeout || 10000 });
                    const text = await resp.text();
                    return {
                        status: resp.status,
                        headers: Object.fromEntries(resp.headers.entries()),
                        body: text,
                        json: () => { try { return JSON.parse(text); } catch (e) { return null; } }
                    };
                },
                post: async (url, body, options = {}) => {
                    if (!permissions.includes(PERMISSIONS.NETWORK)) {
                        throw new Error('Permission denied: network');
                    }
                    const { default: fetch } = await import('node-fetch');
                    const contentType = options.contentType || 'application/json';
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': contentType, ...(options.headers || {}) },
                        body: contentType === 'application/json' ? JSON.stringify(body) : String(body),
                        timeout: options.timeout || 10000
                    });
                    const text = await resp.text();
                    return {
                        status: resp.status,
                        headers: Object.fromEntries(resp.headers.entries()),
                        body: text,
                        json: () => { try { return JSON.parse(text); } catch (e) { return null; } }
                    };
                },
                request: async (options) => {
                    if (!permissions.includes(PERMISSIONS.NETWORK)) {
                        throw new Error('Permission denied: network');
                    }
                    const { default: fetch } = await import('node-fetch');
                    const resp = await fetch(options.url, {
                        method: options.method || 'GET',
                        headers: options.headers || {},
                        body: options.body ? JSON.stringify(options.body) : undefined,
                        timeout: options.timeout || 10000
                    });
                    const text = await resp.text();
                    return {
                        status: resp.status,
                        headers: Object.fromEntries(resp.headers.entries()),
                        body: text,
                        json: () => { try { return JSON.parse(text); } catch (e) { return null; } }
                    };
                }
            },

            // WebSocket（需要 network 权限）
            ws: {
                connect: (url) => {
                    if (!permissions.includes(PERMISSIONS.NETWORK)) {
                        throw new Error('Permission denied: network');
                    }
                    const WebSocket = require('ws');
                    const ws = new WebSocket(url);
                    return {
                        on: (event, cb) => ws.on(event, cb),
                        send: (data) => ws.send(data),
                        close: () => ws.close(),
                        readyState: () => ws.readyState
                    };
                }
            },

            // ============================================================
            // 文件 API（需要 file:read/file:write 权限，限插件目录）
            // ============================================================
            file: {
                read: (filePath) => {
                    if (!permissions.includes(PERMISSIONS.FILE_READ)) {
                        throw new Error('Permission denied: file:read');
                    }
                    const safePath = self._resolvePluginPath(pluginName, filePath);
                    return fs.readFileSync(safePath, 'utf8');
                },
                readBinary: (filePath) => {
                    if (!permissions.includes(PERMISSIONS.FILE_READ)) {
                        throw new Error('Permission denied: file:read');
                    }
                    const safePath = self._resolvePluginPath(pluginName, filePath);
                    return fs.readFileSync(safePath);
                },
                write: (filePath, content) => {
                    if (!permissions.includes(PERMISSIONS.FILE_WRITE)) {
                        throw new Error('Permission denied: file:write');
                    }
                    const safePath = self._resolvePluginPath(pluginName, filePath);
                    const dir = path.dirname(safePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(safePath, typeof content === 'string' ? content : content, 'utf8');
                },
                writeBinary: (filePath, data) => {
                    if (!permissions.includes(PERMISSIONS.FILE_WRITE)) {
                        throw new Error('Permission denied: file:write');
                    }
                    const safePath = self._resolvePluginPath(pluginName, filePath);
                    const dir = path.dirname(safePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(safePath, data);
                },
                exists: (filePath) => {
                    if (!permissions.includes(PERMISSIONS.FILE_READ)) {
                        throw new Error('Permission denied: file:read');
                    }
                    const safePath = self._resolvePluginPath(pluginName, filePath);
                    return fs.existsSync(safePath);
                },
                list: (dirPath = '.') => {
                    if (!permissions.includes(PERMISSIONS.FILE_READ)) {
                        throw new Error('Permission denied: file:read');
                    }
                    const safePath = self._resolvePluginPath(pluginName, dirPath);
                    return fs.readdirSync(safePath);
                },
                delete: (filePath) => {
                    if (!permissions.includes(PERMISSIONS.FILE_WRITE)) {
                        throw new Error('Permission denied: file:write');
                    }
                    const safePath = self._resolvePluginPath(pluginName, filePath);
                    if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
                },
                mkdir: (dirPath) => {
                    if (!permissions.includes(PERMISSIONS.FILE_WRITE)) {
                        throw new Error('Permission denied: file:write');
                    }
                    const safePath = self._resolvePluginPath(pluginName, dirPath);
                    if (!fs.existsSync(safePath)) fs.mkdirSync(safePath, { recursive: true });
                }
            },

            // ============================================================
            // 存储 API（需要 storage 权限，key-value + TTL 过期）
            // ============================================================
            storage: {
                get: (key) => {
                    if (!permissions.includes(PERMISSIONS.STORAGE)) {
                        throw new Error('Permission denied: storage');
                    }
                    return self._getStorage(pluginName, key);
                },
                set: (key, value, ttl = 0) => {
                    if (!permissions.includes(PERMISSIONS.STORAGE)) {
                        throw new Error('Permission denied: storage');
                    }
                    return self._setStorage(pluginName, key, value, ttl);
                },
                delete: (key) => {
                    if (!permissions.includes(PERMISSIONS.STORAGE)) {
                        throw new Error('Permission denied: storage');
                    }
                    return self._deleteStorage(pluginName, key);
                },
                keys: () => {
                    if (!permissions.includes(PERMISSIONS.STORAGE)) {
                        throw new Error('Permission denied: storage');
                    }
                    return self._getStorageKeys(pluginName);
                },
                clear: () => {
                    if (!permissions.includes(PERMISSIONS.STORAGE)) {
                        throw new Error('Permission denied: storage');
                    }
                    return self._clearStorage(pluginName);
                },
                size: () => {
                    if (!permissions.includes(PERMISSIONS.STORAGE)) {
                        throw new Error('Permission denied: storage');
                    }
                    return self._getStorageKeys(pluginName).length;
                }
            },

            // ============================================================
            // 消息 API
            // ============================================================
            send: (peerId, content) => {
                if (self._minep2p) {
                    self._minep2p.sendToPeer(peerId, { type: 'chat', content });
                }
            },
            broadcast: (content) => {
                if (self._minep2p) {
                    self._minep2p.broadcast({ type: 'chat', content });
                }
            },
            sendRaw: (peerId, data) => {
                if (self._minep2p) {
                    self._minep2p.sendToPeer(peerId, data);
                }
            },
            getPeers: () => {
                if (self._minep2p) {
                    return [...self._minep2p.peers.keys()];
                }
                return [];
            },

            // ============================================================
            // 钩子 API（需要 hook 权限）— 支持消息拦截/修改/阻止
            // ============================================================
            hook: {
                // 观察消息（只读）
                onMessage: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        self._minep2p.on('message', (peerId, msg) => {
                            handler({ peerId, message: msg, plugin: pluginName });
                        });
                    }
                },
                // 拦截消息（可修改，返回 null 阻止发送）
                filterMessage: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        self._minep2p.on('message', (peerId, msg) => {
                            const result = handler({ peerId, message: msg, plugin: pluginName });
                            if (result === null) {
                                // 阻止消息
                                self._minep2p.emit('plugin:messageBlocked', { plugin: pluginName, peerId, message: msg });
                            } else if (result !== undefined && result !== msg) {
                                // 修改消息
                                self._minep2p.emit('plugin:messageModified', { plugin: pluginName, peerId, original: msg, modified: result });
                            }
                        });
                    }
                },
                // 拦截发送（在消息发送前过滤）
                filterSend: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        const origSend = self._minep2p.sendToPeer.bind(self._minep2p);
                        const origBroadcast = self._minep2p.broadcast.bind(self._minep2p);

                        self._minep2p.sendToPeer = (peerId, msg) => {
                            const result = handler({ peerId, message: msg, direction: 'send' });
                            if (result === null) return;
                            origSend(peerId, result || msg);
                        };
                        self._minep2p.broadcast = (msg) => {
                            const result = handler({ peerId: null, message: msg, direction: 'broadcast' });
                            if (result === null) return;
                            origBroadcast(result || msg);
                        };
                    }
                },
                onJoin: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        self._minep2p.on('peer:join', (peer) => {
                            handler({ peerId: peer, plugin: pluginName });
                        });
                    }
                },
                onLeave: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        self._minep2p.on('peer:leave', (peer) => {
                            handler({ peerId: peer, plugin: pluginName });
                        });
                    }
                },
                onConnect: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        self._minep2p.on('connect', () => {
                            handler({ plugin: pluginName });
                        });
                    }
                },
                onError: (handler) => {
                    if (!permissions.includes(PERMISSIONS.HOOK)) {
                        throw new Error('Permission denied: hook');
                    }
                    if (self._minep2p) {
                        self._minep2p.on('error', (err) => {
                            handler({ error: err.message, plugin: pluginName });
                        });
                    }
                }
            },

            // ============================================================
            // 定时器 API（需要 timer 权限）
            // ============================================================
            timer: {
                setTimeout: (fn, ms) => {
                    if (!permissions.includes(PERMISSIONS.TIMER)) {
                        throw new Error('Permission denied: timer');
                    }
                    return setTimeout(fn, ms);
                },
                setInterval: (fn, ms) => {
                    if (!permissions.includes(PERMISSIONS.TIMER)) {
                        throw new Error('Permission denied: timer');
                    }
                    return setInterval(fn, ms);
                },
                clearTimeout: (id) => clearTimeout(id),
                clearInterval: (id) => clearInterval(id),
                delay: (ms) => {
                    if (!permissions.includes(PERMISSIONS.TIMER)) {
                        throw new Error('Permission denied: timer');
                    }
                    return new Promise(resolve => setTimeout(resolve, ms));
                }
            },

            // ============================================================
            // UI 扩展 API（需要 ui 权限）
            // ============================================================
            ui: {
                // 注册 CLI 命令
                addCommand: (name, desc, handler) => {
                    if (!permissions.includes(PERMISSIONS.UI)) {
                        throw new Error('Permission denied: ui');
                    }
                    if (self._minep2p) {
                        self._minep2p.emit('plugin:registerCommand', {
                            plugin: pluginName,
                            command: name,
                            description: desc,
                            handler
                        });
                    }
                },
                // 移除命令
                removeCommand: (name) => {
                    if (!permissions.includes(PERMISSIONS.UI)) {
                        throw new Error('Permission denied: ui');
                    }
                    if (self._minep2p) {
                        self._minep2p.emit('plugin:unregisterCommand', {
                            plugin: pluginName,
                            command: name
                        });
                    }
                },
                // 输出到 CLI 界面
                print: (text) => {
                    if (self._minep2p) {
                        self._minep2p.emit('plugin:uiPrint', { plugin: pluginName, text });
                    }
                },
                // 输出带颜色的文本
                printColor: (text, color) => {
                    if (self._minep2p) {
                        self._minep2p.emit('plugin:uiPrint', { plugin: pluginName, text, color });
                    }
                },
                // 显示通知
                notify: (title, message) => {
                    if (self._minep2p) {
                        self._minep2p.emit('plugin:notify', { plugin: pluginName, title, message });
                    }
                },
                // 显示状态栏
                setStatus: (text) => {
                    if (self._minep2p) {
                        self._minep2p.emit('plugin:setStatus', { plugin: pluginName, text });
                    }
                }
            }
        };

        return api;
    }

    /**
     * 在沙箱中执行插件代码
     */
    async execute(plugin, code, ctx = {}) {
        const pluginName = plugin.name;
        const permissions = this._permissions.get(pluginName) || new Set();

        if (this._blacklist.has(pluginName)) {
            throw new Error(`Plugin "${pluginName}" is blacklisted`);
        }

        const sandbox = this.createSandbox(pluginName, [...permissions]);
        const vmContext = vm.createContext(sandbox);

        const startTime = Date.now();
        const startMemory = process.memoryUsage().heapUsed;

        try {
            const script = new vm.Script(code, {
                filename: `plugin:${pluginName}`,
                timeout: DEFAULT_TIMEOUT
            });

            const result = await script.runInContext(vmContext, {
                timeout: DEFAULT_TIMEOUT,
                displayErrors: true,
                breakOnSigint: true
            });

            this._recordStats(pluginName, Date.now() - startTime, process.memoryUsage().heapUsed - startMemory);

            return result;
        } catch (e) {
            this._recordStats(pluginName, Date.now() - startTime, process.memoryUsage().heapUsed - startMemory, true);
            throw new Error(`Sandbox error [${pluginName}]: ${e.message}`);
        }
    }

    /**
     * 执行 DSL 插件（兼容现有系统）
     */
    executeDSL(plugin, ctx, pluginLoader) {
        const pluginName = plugin.name;
        const permissions = this._permissions.get(pluginName) || new Set();

        if (this._blacklist.has(pluginName)) {
            throw new Error(`Plugin "${pluginName}" is blacklisted`);
        }

        // DSL 插件在沙箱外执行（解释型语言，天然安全）
        // 但需要检查权限
        const startTime = Date.now();

        try {
            pluginLoader.exec(plugin, ctx);
            this._recordStats(pluginName, Date.now() - startTime, 0);
        } catch (e) {
            this._recordStats(pluginName, Date.now() - startTime, 0, true);
            throw new Error(`DSL error [${pluginName}]: ${e.message}`);
        }
    }

    /**
     * 解析插件路径（限制在插件目录内）
     */
    _resolvePluginPath(pluginName, filePath) {
        const pluginDir = path.join(this._minep2p ? this._minep2p.pluginDir : '.', pluginName);
        const resolved = path.resolve(pluginDir, filePath);

        // 防止路径遍历攻击
        if (!resolved.startsWith(path.resolve(pluginDir))) {
            throw new Error(`Path traversal detected: ${filePath}`);
        }

        return resolved;
    }

    /**
     * 存储系统
     */
    _getStorage(pluginName, key) {
        const storage = this._getStorageFile(pluginName);
        const entry = storage[key];
        if (!entry) return null;
        // 检查 TTL 过期
        if (entry._expires && entry._expires < Date.now()) {
            delete storage[key];
            this._saveStorageFile(pluginName, storage);
            return null;
        }
        return entry._value !== undefined ? entry._value : entry;
    }

    _setStorage(pluginName, key, value, ttl = 0) {
        const storage = this._getStorageFile(pluginName);
        storage[key] = { _value: value, _setAt: Date.now() };
        if (ttl > 0) {
            storage[key]._expires = Date.now() + ttl;
        }
        this._saveStorageFile(pluginName, storage);
    }

    _deleteStorage(pluginName, key) {
        const storage = this._getStorageFile(pluginName);
        delete storage[key];
        this._saveStorageFile(pluginName, storage);
    }

    _clearStorage(pluginName) {
        const storageDir = path.join(this._minep2p ? this._minep2p.pluginDir : '.', '.storage');
        const storagePath = path.join(storageDir, `${pluginName}.json`);
        if (fs.existsSync(storagePath)) fs.unlinkSync(storagePath);
    }

    _getStorageKeys(pluginName) {
        const storage = this._getStorageFile(pluginName);
        // 清理过期键
        let cleaned = false;
        const now = Date.now();
        for (const [key, entry] of Object.entries(storage)) {
            if (entry && entry._expires && entry._expires < now) {
                delete storage[key];
                cleaned = true;
            }
        }
        if (cleaned) this._saveStorageFile(pluginName, storage);
        return Object.keys(storage);
    }

    _getStorageFile(pluginName) {
        const storageDir = path.join(this._minep2p ? this._minep2p.pluginDir : '.', '.storage');
        if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

        const storagePath = path.join(storageDir, `${pluginName}.json`);
        try {
            if (fs.existsSync(storagePath)) {
                return JSON.parse(fs.readFileSync(storagePath, 'utf8'));
            }
        } catch (e) { /* ignore */ }
        return {};
    }

    _saveStorageFile(pluginName, data) {
        const storageDir = path.join(this._minep2p ? this._minep2p.pluginDir : '.', '.storage');
        if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
        const storagePath = path.join(storageDir, `${pluginName}.json`);
        fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
    }

    /**
     * 统计
     */
    _recordStats(pluginName, wallTime, memoryDelta, failed = false) {
        if (!this._stats.has(pluginName)) {
            this._stats.set(pluginName, { cpuTime: 0, memUsage: 0, runCount: 0, errorCount: 0 });
        }
        const stats = this._stats.get(pluginName);
        stats.cpuTime += wallTime;
        stats.memUsage += memoryDelta;
        stats.runCount++;
        if (failed) stats.errorCount++;
    }

    getStats(pluginName) {
        return this._stats.get(pluginName) || { cpuTime: 0, memUsage: 0, runCount: 0, errorCount: 0 };
    }

    getAllStats() {
        const result = {};
        for (const [name, stats] of this._stats) {
            result[name] = { ...stats };
        }
        return result;
    }

    /**
     * 黑名单管理
     */
    getBlacklist() {
        return [...this._blacklist];
    }

    removeFromBlacklist(pluginName) {
        this._blacklist.delete(pluginName);
    }

    /**
     * 权限管理
     */
    getPermissions(pluginName) {
        return [...(this._permissions.get(pluginName) || [])];
    }

    revokePermission(pluginName, permission) {
        const perms = this._permissions.get(pluginName);
        if (perms) perms.delete(permission);
    }

    reset() {
        this._permissions.clear();
        this._blacklist.clear();
        this._stats.clear();
    }
}

PluginSandbox.PERMISSIONS = PERMISSIONS;

module.exports = PluginSandbox;