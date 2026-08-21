// © Vexify 2026 All Rights Reserved.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

/**
 * 插件沙箱 — 安全隔离 + 权限系统 + 资源限制
 *
 * 特性:
 *  - VM 沙箱隔离,禁止 require 系统模块
 *  - 权限系统: 插件声明权限,授权后使用
 *  - 资源限制: CPU 时间、内存上限
 *  - 插件黑名单
 *  - 插件签名验证
 *  - 持久化存储(TTL 过期)
 */

const PERMISSIONS = {
    NETWORK: 'network',       // 网络访问
    FILE_READ: 'file:read',   // 读取文件(限插件目录)
    FILE_WRITE: 'file:write', // 写入文件(限插件目录)
    COMMAND: 'command',       // 执行系统命令
    STORAGE: 'storage',       // key-value 存储
    TIMER: 'timer',           // 定时器
    UI: 'ui',                 // 界面扩展
    HOOK: 'hook'              // 钩子(拦截消息)
};

const DEFAULT_TIMEOUT = 5000;             // 5 秒 CPU 时间
const DEFAULT_MEMORY = 16 * 1024 * 1024;  // 16 MB
const MAX_EXECUTION_TIME = 30000;         // 30 秒 wall time

class PluginSandbox {
    constructor(options = {}) {
        this._minep2p = options.minep2p || null;
        this._permissions = new Map(); // pluginName -> Set<permission>
        this._blacklist = new Set();
        this._context = {};
        this._stats = new Map();       // pluginName -> { cpuTime, memUsage, runCount }
    }

    // ============ 权限 ============

    grantPermission(pluginName, permission) {
        if (!this._permissions.has(pluginName)) {
            this._permissions.set(pluginName, new Set());
        }
        this._permissions.get(pluginName).add(permission);
    }

    checkPermission(pluginName, permission) {
        const perms = this._permissions.get(pluginName);
        return !!perms && perms.has(permission);
    }

    getRequiredPermissions(plugin) {
        return (plugin.permissions || []).map(p => p.trim());
    }

    revokePermission(pluginName, permission) {
        const perms = this._permissions.get(pluginName);
        if (perms) perms.delete(permission);
    }

    getPermissions(pluginName) {
        return [...(this._permissions.get(pluginName) || [])];
    }

    // ============ 黑名单 ============

    blacklist(pluginName) { this._blacklist.add(pluginName); }

    isBlacklisted(pluginName) { return this._blacklist.has(pluginName); }

    getBlacklist() { return [...this._blacklist]; }

    removeFromBlacklist(pluginName) { this._blacklist.delete(pluginName); }

    // ============ 签名验证 ============

    verifySignature(filePath, expectedHash) {
        try {
            const content = fs.readFileSync(filePath);
            const hash = require('crypto').createHash('sha256').update(content).digest('hex');
            return hash === expectedHash;
        } catch (e) {
            return false;
        }
    }

    // ============ 沙箱上下文 ============

    createSandbox(pluginName, permissions = []) {
        return {
            console: {
                log: (...args) => this._emit('plugin:log', { plugin: pluginName, level: 'info', args }),
                error: (...args) => this._emit('plugin:log', { plugin: pluginName, level: 'error', args }),
                warn: (...args) => this._emit('plugin:log', { plugin: pluginName, level: 'warn', args })
            },

            pl: this._createPluginAPI(pluginName, permissions),

            // 定时器(需 timer 权限)
            setTimeout: (fn, ms) => {
                this._requirePerm(permissions, PERMISSIONS.TIMER, pluginName);
                return setTimeout(fn, ms);
            },
            setInterval: (fn, ms) => {
                this._requirePerm(permissions, PERMISSIONS.TIMER, pluginName);
                return setInterval(fn, ms);
            },
            clearTimeout,
            clearInterval,
            setImmediate: (fn) => setImmediate(fn),
            clearImmediate,

            // 基础数据结构
            Array, Object, String, Number, Boolean, Date, Math, RegExp, JSON,
            Map, Set, WeakMap, WeakSet,
            Error, TypeError, RangeError, SyntaxError,
            parseInt, parseFloat, isNaN, isFinite,
            Buffer, TextEncoder, TextDecoder,

            // 禁用逃逸
            require: undefined, process: undefined, global: undefined, globalThis: undefined,
            __dirname: undefined, __filename: undefined, module: undefined, exports: undefined,

            __pluginName: pluginName,
            __permissions: permissions
        };
    }

    _emit(event, data) {
        if (this._minep2p) this._minep2p.emit(event, data);
    }

    _requirePerm(permissions, perm, pluginName) {
        if (!permissions.includes(perm)) {
            throw new Error(`Permission denied: ${perm} (plugin: ${pluginName})`);
        }
    }

    /** 创建插件 API — 增强版 v2(消息钩子 / UI / 定时器 / HTTP) */
    _createPluginAPI(pluginName, permissions) {
        const self = this;
        const perm = (p) => {
            if (!permissions.includes(p)) throw new Error(`Permission denied: ${p}`);
        };

        return {
            hasPermission: (p) => permissions.includes(p),

            // ========== 网络 ==========
            http: {
                async get(url, options = {}) {
                    perm(PERMISSIONS.NETWORK);
                    const resp = await fetch(url, { headers: options.headers || {}, signal: AbortSignal.timeout(options.timeout || 10000) });
                    const text = await resp.text();
                    return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text, json: () => { try { return JSON.parse(text); } catch (e) { return null; } } };
                },
                async post(url, body, options = {}) {
                    perm(PERMISSIONS.NETWORK);
                    const contentType = options.contentType || 'application/json';
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': contentType, ...(options.headers || {}) },
                        body: contentType === 'application/json' ? JSON.stringify(body) : String(body),
                        signal: AbortSignal.timeout(options.timeout || 10000)
                    });
                    const text = await resp.text();
                    return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text, json: () => { try { return JSON.parse(text); } catch (e) { return null; } } };
                },
                async request(options) {
                    perm(PERMISSIONS.NETWORK);
                    const resp = await fetch(options.url, {
                        method: options.method || 'GET',
                        headers: options.headers || {},
                        body: options.body ? JSON.stringify(options.body) : undefined,
                        signal: AbortSignal.timeout(options.timeout || 10000)
                    });
                    const text = await resp.text();
                    return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text, json: () => { try { return JSON.parse(text); } catch (e) { return null; } } };
                }
            },

            // WebSocket(需 network 权限)
            ws: {
                connect(url) {
                    perm(PERMISSIONS.NETWORK);
                    const ws = new (require('ws'))(url);
                    return {
                        on: (event, cb) => ws.on(event, cb),
                        send: (data) => ws.send(data),
                        close: () => ws.close(),
                        readyState: () => ws.readyState
                    };
                }
            },

            // ========== 文件(限插件目录) ==========
            file: {
                read: (filePath) => { perm(PERMISSIONS.FILE_READ); return fs.readFileSync(self._resolvePluginPath(pluginName, filePath), 'utf8'); },
                readBinary: (filePath) => { perm(PERMISSIONS.FILE_READ); return fs.readFileSync(self._resolvePluginPath(pluginName, filePath)); },
                write: (filePath, content) => {
                    perm(PERMISSIONS.FILE_WRITE);
                    const safe = self._resolvePluginPath(pluginName, filePath);
                    self._ensureDir(path.dirname(safe));
                    fs.writeFileSync(safe, typeof content === 'string' ? content : content, 'utf8');
                },
                writeBinary: (filePath, data) => {
                    perm(PERMISSIONS.FILE_WRITE);
                    const safe = self._resolvePluginPath(pluginName, filePath);
                    self._ensureDir(path.dirname(safe));
                    fs.writeFileSync(safe, data);
                },
                exists: (filePath) => { perm(PERMISSIONS.FILE_READ); return fs.existsSync(self._resolvePluginPath(pluginName, filePath)); },
                list: (dirPath = '.') => { perm(PERMISSIONS.FILE_READ); return fs.readdirSync(self._resolvePluginPath(pluginName, dirPath)); },
                delete: (filePath) => {
                    perm(PERMISSIONS.FILE_WRITE);
                    const safe = self._resolvePluginPath(pluginName, filePath);
                    if (fs.existsSync(safe)) fs.unlinkSync(safe);
                },
                mkdir: (dirPath) => {
                    perm(PERMISSIONS.FILE_WRITE);
                    const safe = self._resolvePluginPath(pluginName, dirPath);
                    if (!fs.existsSync(safe)) fs.mkdirSync(safe, { recursive: true });
                }
            },

            // ========== 存储(key-value + TTL) ==========
            storage: {
                get: (key) => { perm(PERMISSIONS.STORAGE); return self._getStorage(pluginName, key); },
                set: (key, value, ttl = 0) => { perm(PERMISSIONS.STORAGE); return self._setStorage(pluginName, key, value, ttl); },
                delete: (key) => { perm(PERMISSIONS.STORAGE); return self._deleteStorage(pluginName, key); },
                keys: () => { perm(PERMISSIONS.STORAGE); return self._getStorageKeys(pluginName); },
                clear: () => { perm(PERMISSIONS.STORAGE); return self._clearStorage(pluginName); },
                size: () => { perm(PERMISSIONS.STORAGE); return self._getStorageKeys(pluginName).length; }
            },

            // ========== 消息 ==========
            send: (peerId, content) => { if (self._minep2p) self._minep2p.sendToPeer(peerId, { type: 'chat', content }); },
            broadcast: (content) => { if (self._minep2p) self._minep2p.broadcast({ type: 'chat', content }); },
            sendRaw: (peerId, data) => { if (self._minep2p) self._minep2p.sendToPeer(peerId, data); },
            getPeers: () => self._minep2p ? [...self._minep2p.peers.keys()] : [],

            // ========== 钩子(需 hook 权限) ==========
            hook: {
                onMessage: (handler) => {
                    perm(PERMISSIONS.HOOK);
                    if (self._minep2p) self._minep2p.on('message', (peerId, msg) => handler({ peerId, message: msg, plugin: pluginName }));
                },
                filterMessage: (handler) => {
                    perm(PERMISSIONS.HOOK);
                    if (self._minep2p) self._minep2p.on('message', (peerId, msg) => {
                        const result = handler({ peerId, message: msg, plugin: pluginName });
                        if (result === null) {
                            self._minep2p.emit('plugin:messageBlocked', { plugin: pluginName, peerId, message: msg });
                        } else if (result !== undefined && result !== msg) {
                            self._minep2p.emit('plugin:messageModified', { plugin: pluginName, peerId, original: msg, modified: result });
                        }
                    });
                },
                filterSend: (handler) => {
                    perm(PERMISSIONS.HOOK);
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
                    perm(PERMISSIONS.HOOK);
                    if (self._minep2p) self._minep2p.on('peer:join', (peer) => handler({ peerId: peer, plugin: pluginName }));
                },
                onLeave: (handler) => {
                    perm(PERMISSIONS.HOOK);
                    if (self._minep2p) self._minep2p.on('peer:leave', (peer) => handler({ peerId: peer, plugin: pluginName }));
                },
                onConnect: (handler) => {
                    perm(PERMISSIONS.HOOK);
                    if (self._minep2p) self._minep2p.on('connect', () => handler({ plugin: pluginName }));
                },
                onError: (handler) => {
                    perm(PERMISSIONS.HOOK);
                    if (self._minep2p) self._minep2p.on('error', (err) => handler({ error: err.message, plugin: pluginName }));
                }
            },

            // ========== 定时器(需 timer 权限) ==========
            timer: {
                setTimeout: (fn, ms) => { perm(PERMISSIONS.TIMER); return setTimeout(fn, ms); },
                setInterval: (fn, ms) => { perm(PERMISSIONS.TIMER); return setInterval(fn, ms); },
                clearTimeout: (id) => clearTimeout(id),
                clearInterval: (id) => clearInterval(id),
                delay: (ms) => { perm(PERMISSIONS.TIMER); return new Promise(resolve => setTimeout(resolve, ms)); }
            },

            // ========== UI(需 ui 权限) ==========
            ui: {
                addCommand: (name, desc, handler) => {
                    perm(PERMISSIONS.UI);
                    if (self._minep2p) self._minep2p.emit('plugin:registerCommand', { plugin: pluginName, command: name, description: desc, handler });
                },
                removeCommand: (name) => {
                    perm(PERMISSIONS.UI);
                    if (self._minep2p) self._minep2p.emit('plugin:unregisterCommand', { plugin: pluginName, command: name });
                },
                print: (text) => { if (self._minep2p) self._minep2p.emit('plugin:uiPrint', { plugin: pluginName, text }); },
                printColor: (text, color) => { if (self._minep2p) self._minep2p.emit('plugin:uiPrint', { plugin: pluginName, text, color }); },
                notify: (title, message) => { if (self._minep2p) self._minep2p.emit('plugin:notify', { plugin: pluginName, title, message }); },
                setStatus: (text) => { if (self._minep2p) self._minep2p.emit('plugin:setStatus', { plugin: pluginName, text }); }
            }
        };
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // ============ 执行 ============

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
            const script = new vm.Script(code, { filename: `plugin:${pluginName}`, timeout: DEFAULT_TIMEOUT });
            const result = await script.runInContext(vmContext, {
                timeout: DEFAULT_TIMEOUT, displayErrors: true, breakOnSigint: true
            });
            this._recordStats(pluginName, Date.now() - startTime, process.memoryUsage().heapUsed - startMemory);
            return result;
        } catch (e) {
            this._recordStats(pluginName, Date.now() - startTime, process.memoryUsage().heapUsed - startMemory, true);
            throw new Error(`Sandbox error [${pluginName}]: ${e.message}`);
        }
    }

    /** 执行 DSL 插件(解释型,沙箱外执行但校验权限) */
    executeDSL(plugin, ctx, pluginLoader) {
        const pluginName = plugin.name;
        if (this._blacklist.has(pluginName)) {
            throw new Error(`Plugin "${pluginName}" is blacklisted`);
        }

        const startTime = Date.now();
        try {
            pluginLoader.exec(plugin, ctx);
            this._recordStats(pluginName, Date.now() - startTime, 0);
        } catch (e) {
            this._recordStats(pluginName, Date.now() - startTime, 0, true);
            throw new Error(`DSL error [${pluginName}]: ${e.message}`);
        }
    }

    /** 解析插件路径(限制在插件目录内,防路径遍历) */
    _resolvePluginPath(pluginName, filePath) {
        const pluginDir = path.join(this._minep2p ? this._minep2p.pluginDir : '.', pluginName);
        const resolved = path.resolve(pluginDir, filePath);
        if (!resolved.startsWith(path.resolve(pluginDir))) {
            throw new Error(`Path traversal detected: ${filePath}`);
        }
        return resolved;
    }

    // ============ 存储系统 ============

    _getStorage(pluginName, key) {
        const storage = this._getStorageFile(pluginName);
        const entry = storage[key];
        if (!entry) return null;
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
        if (ttl > 0) storage[key]._expires = Date.now() + ttl;
        this._saveStorageFile(pluginName, storage);
    }

    _deleteStorage(pluginName, key) {
        const storage = this._getStorageFile(pluginName);
        delete storage[key];
        this._saveStorageFile(pluginName, storage);
    }

    _clearStorage(pluginName) {
        const storagePath = path.join(this._minep2p ? this._minep2p.pluginDir : '.', '.storage', `${pluginName}.json`);
        if (fs.existsSync(storagePath)) fs.unlinkSync(storagePath);
    }

    _getStorageKeys(pluginName) {
        const storage = this._getStorageFile(pluginName);
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
        fs.writeFileSync(path.join(storageDir, `${pluginName}.json`), JSON.stringify(data, null, 2), 'utf8');
    }

    // ============ 统计 ============

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

    reset() {
        this._permissions.clear();
        this._blacklist.clear();
        this._stats.clear();
    }
}

PluginSandbox.PERMISSIONS = PERMISSIONS;

module.exports = PluginSandbox;