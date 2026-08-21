// © Vexify 2026 All Rights Reserved.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const PluginSandbox = require('./plugin-sandbox');

/**
 * 插件 DSL 解释器
 *
 * MineP2P 插件使用类 Python 语法,支持命令/事件/消息/参数的条件判断、模板变量、
 * pl.* 动作调用。阅读 plugins/README.md 获取完整文档。
 */

class PluginLoader {
    constructor(minep2p) {
        this.minep2p = minep2p;
        this.plugins = new Map();
        this.commands = new Map();
        this.variables = new Map();
        this.sandbox = new PluginSandbox({ minep2p });
    }

    // ============================================================
    // 解析
    // ============================================================
    parse(content) {
        const plugin = {
            name: 'unknown',
            version: '1.0',
            author: '',
            desc: '',
            permissions: '',
            lines: []
        };

        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;

            const metaMatch = line.match(/^(name|version|author|desc|permissions):\s*"(.+)"$/);
            if (metaMatch) {
                plugin[metaMatch[1]] = metaMatch[2];
                continue;
            }

            plugin.lines.push(line);
        }

        return plugin;
    }

    /** 求值一个常量/表达式 */
    evaluate(expr, ctx) {
        expr = expr.trim();

        if (expr.startsWith('"') && expr.endsWith('"')) return expr.slice(1, -1);
        if (expr === 'true') return true;
        if (expr === 'false') return false;
        if (expr === 'null') return null;

        const num = Number(expr);
        if (!isNaN(num) && expr !== '') return num;

        if (expr.startsWith('f"') && expr.endsWith('"')) {
            return this.renderTemplate(expr.slice(2, -1), ctx);
        }
        if (expr.includes('{')) {
            return this.renderTemplate(expr, ctx);
        }
        return expr;
    }

    /** 渲染模板字符串中的 {表达式} */
    renderTemplate(str, ctx) {
        return str.replace(/\{([^}]+)\}/g, (match, expr) => {
            expr = expr.trim();

            if (expr.startsWith('rand:')) {
                const [min, max] = expr.slice(5).split('-').map(Number);
                if (!isNaN(min) && !isNaN(max)) {
                    return String(Math.floor(Math.random() * (max - min + 1)) + min);
                }
            }
            if (expr === 'coin') return Math.random() > 0.5 ? '正面' : '反面';
            if (expr.startsWith('pick:')) {
                const items = expr.slice(5).split(',');
                return items[Math.floor(Math.random() * items.length)].trim();
            }
            if (expr.startsWith('arg:')) {
                const n = parseInt(expr.slice(4), 10);
                return String((ctx.args || '').split(/\s+/)[n - 1] || '');
            }
            if (expr.startsWith('var:')) {
                return this.variables.get(expr.slice(4)) || '';
            }

            const builtins = {
                peer: ctx.peerId ? ctx.peerId.substring(0, 8) : 'unknown',
                room: ctx.room || 'unknown',
                message: ctx.message || '',
                args: ctx.args || '',
                time: new Date().toLocaleTimeString(),
                date: new Date().toLocaleDateString(),
                timestamp: String(Date.now()),
                command: ctx.command || '',
                sender: ctx.sender || ''
            };
            if (builtins[expr] !== undefined) return String(builtins[expr]);
            return match;
        });
    }

    exec(plugin, ctx) {
        const lines = plugin.lines;
        for (let i = 0; i < lines.length; i++) {
            i = this.execLine(lines, i, ctx);
        }
    }

    // ============================================================
    // 逐行执行(返回新的游标位置)
    // ============================================================
    execLine(lines, i, ctx) {
        const line = lines[i];

        // if command == "/xxx":
        const cmdEq = line.match(/^if\s+command\s*==\s*"([^"]+)"\s*:$/);
        if (cmdEq) {
            return this._runBranch(lines, i, ctx, ctx.command === cmdEq[1]);
        }

        // if command != "/xxx":
        const cmdNe = line.match(/^if\s+command\s*!=\s*"([^"]+)"\s*:$/);
        if (cmdNe) {
            return this._runBranch(lines, i, ctx, ctx.command !== cmdNe[1]);
        }

        // elif command == "/xxx": (由上层 if 处理,独立出现则跳过)
        if (line.match(/^elif\s+command\s*==\s*"([^"]+)"\s*:$/)) {
            return this._skipBlock(lines, i) - 1;
        }

        // if event == "join": / "leave": / "message":
        const evt = line.match(/^if\s+event\s*==\s*"([^"]+)"\s*:$/);
        if (evt) {
            return this._runBranch(lines, i, ctx, ctx.event === evt[1]);
        }

        // if args == "x" or args == "y":
        const argsOr = line.match(/^if\s+args\s*==\s*"([^"]*)"\s+or\s+args\s*==\s*"([^"]*)"\s*:$/);
        if (argsOr) {
            const a = ctx.args || '';
            return this._runBranch(lines, i, ctx, a === argsOr[1] || a === argsOr[2]);
        }

        // if args == "x":
        const argsEq = line.match(/^if\s+args\s*==\s*"([^"]*)"\s*:$/);
        if (argsEq) {
            return this._runBranch(lines, i, ctx, (ctx.args || '') === argsEq[1]);
        }

        // if args != "x":
        const argsNe = line.match(/^if\s+args\s*!=\s*"([^"]*)"\s*:$/);
        if (argsNe) {
            return this._runBranch(lines, i, ctx, (ctx.args || '') !== argsNe[1]);
        }

        // if message == "x" or message == "y":
        const msgOr = line.match(/^if\s+message\s*==\s*"([^"]*)"\s+or\s+message\s*==\s*"([^"]*)"\s*:$/);
        if (msgOr) {
            const m = ctx.message || '';
            return this._runBranch(lines, i, ctx, m === msgOr[1] || m === msgOr[2]);
        }

        // if message == "x":
        const msgEq = line.match(/^if\s+message\s*==\s*"([^"]*)"\s*:$/);
        if (msgEq) {
            return this._runBranch(lines, i, ctx, (ctx.message || '') === msgEq[1]);
        }

        // if message != "x":
        const msgNe = line.match(/^if\s+message\s*!=\s*"([^"]*)"\s*:$/);
        if (msgNe) {
            return this._runBranch(lines, i, ctx, (ctx.message || '') !== msgNe[1]);
        }

        // if "x" in message: / if "x" in args:
        const inM = line.match(/^if\s+"([^"]+)"\s+in\s+(message|args)\s*:$/);
        if (inM) {
            const haystack = inM[2] === 'message' ? (ctx.message || '') : (ctx.args || '');
            return this._runBranch(lines, i, ctx, haystack.includes(inM[1]));
        }

        // else: (由父级 _runBranch 处理)
        if (line.match(/^else\s*:$/)) {
            return i;
        }

        // 提取 (和 )之间的内容
        const extractCall = (prefix) => {
            if (!line.startsWith(prefix)) return null;
            const start = line.indexOf('(');
            const end = line.lastIndexOf(')');
            if (start === -1 || end === -1 || end <= start) return null;
            return line.substring(start + 1, end).trim();
        };

        // pl.print("x")
        const printArg = extractCall('pl.print(');
        if (printArg !== null) {
            const msg = this.evaluate(printArg, ctx);
            if (ctx.peerId) {
                this.minep2p.sendToPeer(ctx.peerId, { type: 'chat', content: msg });
            } else {
                console.log(`[Plugin] ${msg}`);
            }
            return i;
        }

        // pl.broadcast("x")
        const bcArg = extractCall('pl.broadcast(');
        if (bcArg !== null) {
            this.minep2p.broadcast({ type: 'chat', content: this.evaluate(bcArg, ctx) });
            return i;
        }

        // pl.log("x")
        const logArg = extractCall('pl.log(');
        if (logArg !== null) {
            console.log(`[Plugin] ${this.evaluate(logArg, ctx)}`);
            return i;
        }

        // pl.set("key", "value")
        const setArg = extractCall('pl.set(');
        if (setArg !== null) {
            const commaIdx = setArg.indexOf(',');
            if (commaIdx !== -1) {
                const key = this.evaluate(setArg.substring(0, commaIdx).trim(), ctx);
                const value = this.evaluate(setArg.substring(commaIdx + 1).trim(), ctx);
                this.variables.set(String(key), String(value));
            }
            return i;
        }

        // pl.run("cmd")
        const runArg = extractCall('pl.run(');
        if (runArg !== null) {
            this.handleMessage(this.evaluate(runArg, ctx), ctx);
            return i;
        }

        // pl.http.get("url") — 结果存入 _httpResult
        const httpGetArg = extractCall('pl.http.get(');
        if (httpGetArg !== null) {
            try {
                this.variables.set('_httpResult', this._syncHttpGet(this.evaluate(httpGetArg, ctx)));
                this.variables.set('_httpStatus', '200');
            } catch (e) {
                this.variables.set('_httpResult', '');
                this.variables.set('_httpStatus', '0');
                this.variables.set('_httpError', e.message);
            }
            return i;
        }

        // pl.http.post("url", "body")
        const httpPostArg = extractCall('pl.http.post(');
        if (httpPostArg !== null) {
            const parts = this._splitArgs(httpPostArg);
            const body = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            try {
                this.variables.set('_httpResult', this._syncHttpPost(this.evaluate(parts[0], ctx), body));
                this.variables.set('_httpStatus', '200');
            } catch (e) {
                this.variables.set('_httpResult', '');
                this.variables.set('_httpStatus', '0');
                this.variables.set('_httpError', e.message);
            }
            return i;
        }

        // pl.storage.get/set/del/keys/clear — 结果存入 _storageResult
        const storageGetArg = extractCall('pl.storage.get(');
        if (storageGetArg !== null) {
            const val = this.sandbox._getStorage(ctx._pluginName || 'dsl', this.evaluate(storageGetArg, ctx));
            this.variables.set('_storageResult', val !== null ? String(val) : '');
            return i;
        }

        const storageSetArg = extractCall('pl.storage.set(');
        if (storageSetArg !== null) {
            const parts = this._splitArgs(storageSetArg);
            const value = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            this.sandbox._setStorage(ctx._pluginName || 'dsl', this.evaluate(parts[0], ctx), value);
            this.variables.set('_storageResult', 'ok');
            return i;
        }

        const storageDelArg = extractCall('pl.storage.del(');
        if (storageDelArg !== null) {
            this.sandbox._deleteStorage(ctx._pluginName || 'dsl', this.evaluate(storageDelArg, ctx));
            this.variables.set('_storageResult', 'ok');
            return i;
        }

        const storageKeysArg = extractCall('pl.storage.keys(');
        if (storageKeysArg !== null) {
            this.variables.set('_storageResult', this.sandbox._getStorageKeys(ctx._pluginName || 'dsl').join(', '));
            return i;
        }

        const storageClearArg = extractCall('pl.storage.clear(');
        if (storageClearArg !== null) {
            this.sandbox._clearStorage(ctx._pluginName || 'dsl');
            this.variables.set('_storageResult', 'ok');
            return i;
        }

        // pl.file.read/write/delete/list — 结果存入 _fileResult
        const fileReadArg = extractCall('pl.file.read(');
        if (fileReadArg !== null) {
            try {
                this.variables.set('_fileResult', fs.readFileSync(this.evaluate(fileReadArg, ctx), 'utf8'));
            } catch (e) {
                this.variables.set('_fileResult', '');
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        const fileWriteArg = extractCall('pl.file.write(');
        if (fileWriteArg !== null) {
            const parts = this._splitArgs(fileWriteArg);
            const content = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            try {
                fs.writeFileSync(this.evaluate(parts[0], ctx), content, 'utf8');
                this.variables.set('_fileResult', 'ok');
            } catch (e) {
                this.variables.set('_fileResult', '');
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        const fileDeleteArg = extractCall('pl.file.delete(');
        if (fileDeleteArg !== null) {
            try {
                const filePath = this.evaluate(fileDeleteArg, ctx);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                this.variables.set('_fileResult', 'ok');
            } catch (e) {
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        const fileListArg = extractCall('pl.file.list(');
        if (fileListArg !== null) {
            try {
                this.variables.set('_fileResult', fs.readdirSync(this.evaluate(fileListArg, ctx) || '.').join(', '));
            } catch (e) {
                this.variables.set('_fileResult', '');
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        // pl.ui.print / pl.ui.notify / pl.ui.setStatus
        const uiPrintArg = extractCall('pl.ui.print(');
        if (uiPrintArg !== null) {
            const text = this.evaluate(uiPrintArg, ctx);
            console.log(`[Plugin UI] ${text}`);
            this.minep2p.emit('plugin:uiPrint', { plugin: ctx._pluginName || 'dsl', text });
            return i;
        }

        const uiNotifyArg = extractCall('pl.ui.notify(');
        if (uiNotifyArg !== null) {
            const parts = this._splitArgs(uiNotifyArg);
            const title = this.evaluate(parts[0], ctx);
            const message = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            this.minep2p.emit('plugin:notify', { plugin: ctx._pluginName || 'dsl', title, message });
            return i;
        }

        const uiSetStatusArg = extractCall('pl.ui.setStatus(');
        if (uiSetStatusArg !== null) {
            this.minep2p.emit('plugin:setStatus', { plugin: ctx._pluginName || 'dsl', text: this.evaluate(uiSetStatusArg, ctx) });
            return i;
        }

        // pl.send("peerId", "message")
        const plSendArg = extractCall('pl.send(');
        if (plSendArg !== null) {
            const parts = this._splitArgs(plSendArg);
            const content = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            this.minep2p.sendToPeer(this.evaluate(parts[0], ctx), { type: 'chat', content });
            return i;
        }

        // pl.getPeers()
        const plGetPeersArg = extractCall('pl.getPeers(');
        if (plGetPeersArg !== null) {
            const peers = [...this.minep2p.peers.keys()];
            this.variables.set('_peers', peers.join(', '));
            this.variables.set('_peerCount', String(peers.length));
            return i;
        }

        // pl.timer.delay(ms) — 同步等待(限制 30s)
        const timerDelayArg = extractCall('pl.timer.delay(');
        if (timerDelayArg !== null) {
            const ms = parseInt(this.evaluate(timerDelayArg, ctx), 10);
            if (!isNaN(ms) && ms > 0 && ms <= 30000) {
                const end = Date.now() + ms;
                while (Date.now() < end) { /* spin */ }
            }
            return i;
        }

        return i;
    }

    /**
     * 执行条件分支: 命中则执行缩进块,否则跳到 else 块
     * @param {boolean} matched
     * @returns {number} 处理后停在的游标
     */
    _runBranch(lines, i, ctx, matched) {
        if (matched) {
            i++;
            while (i < lines.length && lines[i].startsWith('    ')) {
                i = this.execLine(lines, i, ctx);
            }
        } else {
            i = this._skipBlock(lines, i);
            // 检查是否有 else 分支
            if (i < lines.length && lines[i].match(/^else\s*:$/)) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            }
        }
        return i - 1;
    }

    /** 跳过一整个缩进块,返回块结束后的行号 */
    _skipBlock(lines, i) {
        i++;
        while (i < lines.length && lines[i].startsWith('    ')) i++;
        return i;
    }

    /** 解析函数参数,支持引号内的逗号不分割 */
    _splitArgs(str) {
        const args = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
                continue;
            }
            if (ch === ',' && !inQuotes) {
                args.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim()) args.push(current.trim());
        return args;
    }

    _syncHttpGet(url) {
        try {
            return execSync(`curl -sL --max-time 10 "${url}"`, { encoding: 'utf8' });
        } catch (e) {
            throw new Error(`HTTP GET failed: ${e.message}`);
        }
    }

    _syncHttpPost(url, body) {
        try {
            const escapedBody = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return execSync(`curl -sL --max-time 10 -X POST -d "${escapedBody}" "${url}"`, { encoding: 'utf8' });
        } catch (e) {
            throw new Error(`HTTP POST failed: ${e.message}`);
        }
    }

    // ============================================================
    // 加载
    // ============================================================
    load(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const plugin = this.parse(content);

            if (this.sandbox.isBlacklisted(plugin.name)) {
                console.log(`[Plugin] 插件 ${plugin.name} 已被列入黑名单,跳过加载`);
                return null;
            }

            if (plugin.permissions) {
                const requiredPerms = plugin.permissions.split(',').map(p => p.trim());
                for (const perm of requiredPerms) {
                    this.sandbox.grantPermission(plugin.name, perm);
                }
                console.log(`[Plugin] ${plugin.name} 权限: ${requiredPerms.join(', ')}`);
            }

            this.plugins.set(plugin.name, plugin);

            // 注册命令(command == "/xxx")
            for (const line of plugin.lines) {
                const cmdMatch = line.match(/^if\s+command\s*==\s*"([^"]+)"\s*:$/);
                if (cmdMatch) {
                    this.commands.set(cmdMatch[1].replace('/', ''), plugin);
                }
            }

            console.log(`[Plugin] 加载插件: ${plugin.name} v${plugin.version}`);
            return plugin;
        } catch (error) {
            console.error(`[Plugin] 加载失败: ${error.message}`);
            return null;
        }
    }

    loadDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            return;
        }
        for (const file of fs.readdirSync(dirPath)) {
            if (file.endsWith('.mp')) {
                this.load(path.join(dirPath, file));
            }
        }
    }

    // ============================================================
    // 消息分发
    // ============================================================
    handleMessage(message, context) {
        context = context || {};
        context.message = message;

        if (message && message.startsWith('/')) {
            const parts = message.slice(1).split(/\s+/);
            context.command = '/' + parts[0];
            context.args = parts.slice(1).join(' ');

            for (const [, plugin] of this.plugins) {
                this.exec(plugin, { ...context });
            }
            return true;
        }

        for (const [, plugin] of this.plugins) {
            this.exec(plugin, { ...context, event: 'message' });
        }
        return false;
    }

    handleEvent(event, context) {
        for (const [, plugin] of this.plugins) {
            this.exec(plugin, { ...context, event });
        }
    }

    getPlugins() {
        return Array.from(this.plugins.values()).map(p => ({
            name: p.name,
            version: p.version,
            desc: p.desc || '',
            author: p.author || ''
        }));
    }
}

module.exports = PluginLoader;