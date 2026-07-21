// © Vexify 2026 All Rights Reserved.
const fs = require('fs');
const path = require('path');
const PluginSandbox = require('./plugin-sandbox');

class PluginLoader {
    constructor(minep2p) {
        this.minep2p = minep2p;
        this.plugins = new Map();
        this.commands = new Map();
        this.variables = new Map();
        this.sandbox = new PluginSandbox({ minep2p });
    }

    parse(content) {
        const plugin = {
            name: 'unknown',
            version: '1.0',
            author: '',
            desc: '',
            permissions: '',
            lines: []
        };

        const rawLines = content.split('\n');
        for (const rawLine of rawLines) {
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

    evaluate(expr, ctx) {
        expr = expr.trim();

        if (expr.startsWith('"') && expr.endsWith('"')) {
            return expr.slice(1, -1);
        }
        if (expr === 'true') return true;
        if (expr === 'false') return false;
        if (expr === 'null') return null;

        const num = Number(expr);
        if (!isNaN(num) && expr !== '') return num;

        // template string f"..."
        if (expr.startsWith('f"') && expr.endsWith('"')) {
            return this.renderTemplate(expr.slice(2, -1), ctx);
        }

        // {expr} in any string context
        if (expr.includes('{')) {
            return this.renderTemplate(expr, ctx);
        }

        return expr;
    }

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
                const n = parseInt(expr.slice(4));
                return (ctx.args || '').split(/\s+/)[n - 1] || '';
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

    execLine(lines, i, ctx) {
        const line = lines[i];

        // if command == "/xxx":
        const cmdMatch = line.match(/^if\s+command\s*==\s*"([^"]+)"\s*:$/);
        if (cmdMatch) {
            const targetCmd = cmdMatch[1];
            if (ctx.command === targetCmd) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                // skip block, check for elif / else
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if command != "/xxx":
        const cmdNotMatch = line.match(/^if\s+command\s*!=\s*"([^"]+)"\s*:$/);
        if (cmdNotMatch) {
            if (ctx.command !== cmdNotMatch[1]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // elif command == "/xxx":
        const elifCmd = line.match(/^elif\s+command\s*==\s*"([^"]+)"\s*:$/);
        if (elifCmd) {
            // handled by if block above, skip standalone
            i++;
            while (i < lines.length && lines[i].startsWith('    ')) i++;
            return i - 1;
        }

        // if event == "join": / "leave": / "message":
        const eventMatch = line.match(/^if\s+event\s*==\s*"([^"]+)"\s*:$/);
        if (eventMatch) {
            if (ctx.event === eventMatch[1]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if args == "xxx": (supports "x" or "y")
        const argsOrMatch = line.match(/^if\s+args\s*==\s*"([^"]*)"\s+or\s+args\s*==\s*"([^"]*)"\s*:$/);
        if (argsOrMatch) {
            if ((ctx.args || '') === argsOrMatch[1] || (ctx.args || '') === argsOrMatch[2]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if args == "xxx":
        const argsMatch = line.match(/^if\s+args\s*==\s*"([^"]*)"\s*:$/);
        if (argsMatch) {
            if ((ctx.args || '') === argsMatch[1]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if args != "":
        const argsNotMatch = line.match(/^if\s+args\s*!=\s*"([^"]*)"\s*:$/);
        if (argsNotMatch) {
            if ((ctx.args || '') !== argsNotMatch[1]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if message == "xxx" or message == "yyy":
        const msgOrMatch = line.match(/^if\s+message\s*==\s*"([^"]*)"\s+or\s+message\s*==\s*"([^"]*)"\s*:$/);
        if (msgOrMatch) {
            if ((ctx.message || '') === msgOrMatch[1] || (ctx.message || '') === msgOrMatch[2]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if message == "xxx": / if message != "xxx":
        const msgEq = line.match(/^if\s+message\s*==\s*"([^"]*)"\s*:$/);
        if (msgEq) {
            if ((ctx.message || '') === msgEq[1]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        const msgNotEq = line.match(/^if\s+message\s*!=\s*"([^"]*)"\s*:$/);
        if (msgNotEq) {
            if ((ctx.message || '') !== msgNotEq[1]) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // if "xxx" in message: / if "xxx" in args:
        const inMatch = line.match(/^if\s+"([^"]+)"\s+in\s+(message|args)\s*:$/);
        if (inMatch) {
            const haystack = inMatch[2] === 'message' ? (ctx.message || '') : (ctx.args || '');
            if (haystack.includes(inMatch[1])) {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) {
                    i = this.execLine(lines, i, ctx);
                }
            } else {
                i++;
                while (i < lines.length && lines[i].startsWith('    ')) i++;
                if (i < lines.length && lines[i].match(/^else\s*:/)) {
                    i++;
                    while (i < lines.length && lines[i].startsWith('    ')) {
                        i = this.execLine(lines, i, ctx);
                    }
                }
            }
            return i - 1;
        }

        // else:
        if (line.match(/^else\s*:$/)) {
            return i; // parent handles this
        }

        // extract content between first ( and last )
        const extractCall = (prefix) => {
            if (!line.startsWith(prefix)) return null;
            const start = line.indexOf('(');
            const end = line.lastIndexOf(')');
            if (start === -1 || end === -1 || end <= start) return null;
            return line.substring(start + 1, end).trim();
        };

        // pl.print("xxx")
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

        // pl.broadcast("xxx")
        const bcArg = extractCall('pl.broadcast(');
        if (bcArg !== null) {
            const msg = this.evaluate(bcArg, ctx);
            this.minep2p.broadcast({ type: 'chat', content: msg });
            return i;
        }

        // pl.log("xxx")
        const logArg = extractCall('pl.log(');
        if (logArg !== null) {
            const msg = this.evaluate(logArg, ctx);
            console.log(`[Plugin] ${msg}`);
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

        // pl.run("xxx")
        const runArg = extractCall('pl.run(');
        if (runArg !== null) {
            const cmd = this.evaluate(runArg, ctx);
            this.handleMessage(cmd, ctx);
            return i;
        }

        // ============================================================
        // 扩展 API: pl.http.get("url") — 同步 HTTP GET
        // 结果存入变量 _httpResult
        // ============================================================
        const httpGetArg = extractCall('pl.http.get(');
        if (httpGetArg !== null) {
            const url = this.evaluate(httpGetArg, ctx);
            try {
                const result = this._syncHttpGet(url);
                this.variables.set('_httpResult', result);
                this.variables.set('_httpStatus', '200');
            } catch (e) {
                this.variables.set('_httpResult', '');
                this.variables.set('_httpStatus', '0');
                this.variables.set('_httpError', e.message);
            }
            return i;
        }

        // ============================================================
        // 扩展 API: pl.http.post("url", "body") — 同步 HTTP POST
        // ============================================================
        const httpPostArg = extractCall('pl.http.post(');
        if (httpPostArg !== null) {
            const parts = this._splitArgs(httpPostArg);
            const url = this.evaluate(parts[0], ctx);
            const body = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            try {
                const result = this._syncHttpPost(url, body);
                this.variables.set('_httpResult', result);
                this.variables.set('_httpStatus', '200');
            } catch (e) {
                this.variables.set('_httpResult', '');
                this.variables.set('_httpStatus', '0');
                this.variables.set('_httpError', e.message);
            }
            return i;
        }

        // ============================================================
        // 扩展 API: pl.storage.get/set/del/keys/clear
        // 结果存入 _storageResult
        // ============================================================
        const storageGetArg = extractCall('pl.storage.get(');
        if (storageGetArg !== null) {
            const key = this.evaluate(storageGetArg, ctx);
            const val = this.sandbox._getStorage(ctx._pluginName || 'dsl', key);
            this.variables.set('_storageResult', val !== null ? String(val) : '');
            return i;
        }

        const storageSetArg = extractCall('pl.storage.set(');
        if (storageSetArg !== null) {
            const parts = this._splitArgs(storageSetArg);
            const key = this.evaluate(parts[0], ctx);
            const value = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            this.sandbox._setStorage(ctx._pluginName || 'dsl', key, value);
            this.variables.set('_storageResult', 'ok');
            return i;
        }

        const storageDelArg = extractCall('pl.storage.del(');
        if (storageDelArg !== null) {
            const key = this.evaluate(storageDelArg, ctx);
            this.sandbox._deleteStorage(ctx._pluginName || 'dsl', key);
            this.variables.set('_storageResult', 'ok');
            return i;
        }

        const storageKeysArg = extractCall('pl.storage.keys(');
        if (storageKeysArg !== null) {
            const keys = this.sandbox._getStorageKeys(ctx._pluginName || 'dsl');
            this.variables.set('_storageResult', keys.join(', '));
            return i;
        }

        const storageClearArg = extractCall('pl.storage.clear(');
        if (storageClearArg !== null) {
            this.sandbox._clearStorage(ctx._pluginName || 'dsl');
            this.variables.set('_storageResult', 'ok');
            return i;
        }

        // ============================================================
        // 扩展 API: pl.file.read/write/delete/list
        // ============================================================
        const fileReadArg = extractCall('pl.file.read(');
        if (fileReadArg !== null) {
            const filePath = this.evaluate(fileReadArg, ctx);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                this.variables.set('_fileResult', content);
            } catch (e) {
                this.variables.set('_fileResult', '');
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        const fileWriteArg = extractCall('pl.file.write(');
        if (fileWriteArg !== null) {
            const parts = this._splitArgs(fileWriteArg);
            const filePath = this.evaluate(parts[0], ctx);
            const content = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            try {
                fs.writeFileSync(filePath, content, 'utf8');
                this.variables.set('_fileResult', 'ok');
            } catch (e) {
                this.variables.set('_fileResult', '');
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        const fileDeleteArg = extractCall('pl.file.delete(');
        if (fileDeleteArg !== null) {
            const filePath = this.evaluate(fileDeleteArg, ctx);
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                this.variables.set('_fileResult', 'ok');
            } catch (e) {
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        const fileListArg = extractCall('pl.file.list(');
        if (fileListArg !== null) {
            const dirPath = this.evaluate(fileListArg, ctx) || '.';
            try {
                const files = fs.readdirSync(dirPath);
                this.variables.set('_fileResult', files.join(', '));
            } catch (e) {
                this.variables.set('_fileResult', '');
                this.variables.set('_fileError', e.message);
            }
            return i;
        }

        // ============================================================
        // 扩展 API: pl.ui.print / pl.ui.notify / pl.ui.setStatus
        // ============================================================
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
            const text = this.evaluate(uiSetStatusArg, ctx);
            this.minep2p.emit('plugin:setStatus', { plugin: ctx._pluginName || 'dsl', text });
            return i;
        }

        // ============================================================
        // 扩展 API: pl.send("peerId", "message") / pl.getPeers()
        // ============================================================
        const plSendArg = extractCall('pl.send(');
        if (plSendArg !== null) {
            const parts = this._splitArgs(plSendArg);
            const peerId = this.evaluate(parts[0], ctx);
            const content = parts.length > 1 ? this.evaluate(parts.slice(1).join(','), ctx) : '';
            this.minep2p.sendToPeer(peerId, { type: 'chat', content });
            return i;
        }

        const plGetPeersArg = extractCall('pl.getPeers(');
        if (plGetPeersArg !== null) {
            const peers = [...this.minep2p.peers.keys()];
            this.variables.set('_peers', peers.join(', '));
            this.variables.set('_peerCount', String(peers.length));
            return i;
        }

        // ============================================================
        // 扩展 API: pl.timer.delay(ms) — 同步等待
        // ============================================================
        const timerDelayArg = extractCall('pl.timer.delay(');
        if (timerDelayArg !== null) {
            const ms = parseInt(this.evaluate(timerDelayArg, ctx));
            if (!isNaN(ms) && ms > 0 && ms <= 30000) {
                const end = Date.now() + ms;
                while (Date.now() < end) { /* spin */ }
            }
            return i;
        }

        return i;
    }

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
        const { execSync } = require('child_process');
        try {
            return execSync(`curl -sL --max-time 10 "${url}"`, { encoding: 'utf8' });
        } catch (e) {
            throw new Error(`HTTP GET failed: ${e.message}`);
        }
    }

    _syncHttpPost(url, body) {
        const { execSync } = require('child_process');
        try {
            const escapedBody = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return execSync(`curl -sL --max-time 10 -X POST -d "${escapedBody}" "${url}"`, { encoding: 'utf8' });
        } catch (e) {
            throw new Error(`HTTP POST failed: ${e.message}`);
        }
    }

    load(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const plugin = this.parse(content);

            // 检查黑名单
            if (this.sandbox.isBlacklisted(plugin.name)) {
                console.log(`[Plugin] 插件 ${plugin.name} 已被列入黑名单，跳过加载`);
                return null;
            }

            // 解析权限声明
            if (plugin.permissions) {
                const requiredPerms = plugin.permissions.split(',').map(p => p.trim());
                for (const perm of requiredPerms) {
                    this.sandbox.grantPermission(plugin.name, perm);
                }
                console.log(`[Plugin] ${plugin.name} 权限: ${requiredPerms.join(', ')}`);
            }

            this.plugins.set(plugin.name, plugin);

            // scan for command == lines to register commands
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
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            if (file.endsWith('.mp')) {
                this.load(path.join(dirPath, file));
            }
        }
    }

    handleMessage(message, context) {
        context = context || {};
        context.message = message;

        if (message && message.startsWith('/')) {
            const parts = message.slice(1).split(/\s+/);
            context.command = '/' + parts[0];
            context.args = parts.slice(1).join(' ');

            // run all plugins for this command
            let handled = false;
            for (const [, plugin] of this.plugins) {
                this.exec(plugin, { ...context });
            }
            return true;
        }

        // message event
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
