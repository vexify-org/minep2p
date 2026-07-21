// © Vexify 2026 All Rights Reserved.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(os.homedir(), '.minep2p');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 可配置项定义
const CONFIGURABLE_KEYS = {
    apiBaseUrl: { type: 'string', desc: 'API 基础 URL' },
    defaultRoom: { type: 'string', desc: '默认房间名' },
    pollTimeout: { type: 'number', desc: '轮询超时时间(秒)' },
    reconnectDelay: { type: 'number', desc: '重连延迟(毫秒)' },
    maxRetries: { type: 'number', desc: '最大重试次数' }
};

class Store {
    static ensureDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    static getMessageFile(room) {
        const roomDir = path.join(DATA_DIR, 'rooms', room);
        if (!fs.existsSync(roomDir)) {
            fs.mkdirSync(roomDir, { recursive: true });
        }
        return path.join(roomDir, 'messages.json');
    }

    static saveMessage(room, message) {
        this.ensureDir();
        
        const messageFile = this.getMessageFile(room);
        let messages = [];
        
        try {
            if (fs.existsSync(messageFile)) {
                messages = JSON.parse(fs.readFileSync(messageFile, 'utf8'));
            }
        } catch {
            messages = [];
        }
        
        const storedMessage = {
            id: uuidv4(),
            from: message.from || 'unknown',
            to: message.to || 'all',
            content: message.content,
            type: message.type || 'chat',
            timestamp: message.timestamp || Date.now()
        };
        
        messages.push(storedMessage);
        
        if (messages.length > 1000) {
            messages = messages.slice(-1000);
        }
        
        fs.writeFileSync(messageFile, JSON.stringify(messages, null, 2));
        
        return storedMessage;
    }

    static getMessages(room, limit = 100) {
        this.ensureDir();
        
        const messageFile = this.getMessageFile(room);
        
        try {
            if (fs.existsSync(messageFile)) {
                const messages = JSON.parse(fs.readFileSync(messageFile, 'utf8'));
                return messages.slice(-limit).reverse();
            }
        } catch {
            // ignore
        }
        
        return [];
    }

    static getAllRooms() {
        this.ensureDir();
        
        const roomsDir = path.join(DATA_DIR, 'rooms');
        
        try {
            if (fs.existsSync(roomsDir)) {
                return fs.readdirSync(roomsDir).filter(f => fs.statSync(path.join(roomsDir, f)).isDirectory());
            }
        } catch {
            // ignore
        }
        
        return [];
    }

    static getRoomStats(room) {
        const messages = this.getMessages(room, 9999);
        
        return {
            room: room,
            messageCount: messages.length,
            firstMessage: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
            lastMessage: messages.length > 0 ? messages[0].timestamp : null
        };
    }

    static clearMessages(room) {
        this.ensureDir();
        
        const messageFile = this.getMessageFile(room);
        
        try {
            if (fs.existsSync(messageFile)) {
                fs.writeFileSync(messageFile, '[]');
            }
        } catch {
            // ignore
        }
    }

    static deleteRoom(room) {
        const roomDir = path.join(DATA_DIR, 'rooms', room);

        try {
            if (fs.existsSync(roomDir)) {
                fs.rmSync(roomDir, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }
    }

    // ========== 配置管理 ==========

    static getConfigurableKeys() {
        return CONFIGURABLE_KEYS;
    }

    static loadConfig() {
        this.ensureDir();

        try {
            if (fs.existsSync(CONFIG_FILE)) {
                return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            }
        } catch {
            // ignore
        }

        return {};
    }

    static saveConfig(config) {
        this.ensureDir();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }

    static setConfig(key, value) {
        if (!CONFIGURABLE_KEYS[key]) {
            throw new Error(`Unknown config key: ${key}`);
        }

        const config = this.loadConfig();
        const keyDef = CONFIGURABLE_KEYS[key];

        // 类型转换
        if (keyDef.type === 'number') {
            value = Number(value);
            if (isNaN(value)) {
                throw new Error(`Invalid number value for ${key}`);
            }
        }

        config[key] = value;
        this.saveConfig(config);

        return value;
    }

    static getConfig(key) {
        const config = this.loadConfig();
        return config[key] !== undefined ? config[key] : null;
    }

    static getAllConfig() {
        return this.loadConfig();
    }

    static resetConfig(key) {
        if (key) {
            if (!CONFIGURABLE_KEYS[key]) {
                throw new Error(`Unknown config key: ${key}`);
            }
            const config = this.loadConfig();
            delete config[key];
            this.saveConfig(config);
        } else {
            this.saveConfig({});
        }
    }
}

module.exports = Store;
