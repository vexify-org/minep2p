// © Vexify 2026 All Rights Reserved.
const { networkInterfaces } = require('os');
const config = require('./config');

/**
 * IPv6 检测工具
 *
 * 用途:在 UDP 打洞/NAT 穿透时优先使用公网 IPv6(若可用),避免 IPv4 对称 NAT 的穿透失败。
 * 尝试顺序:公网 IPv6 探测端点 → 重试 → 本地接口 IPv6。
 */

class IPv6 {
    /** 遍历多个探测端点获取公网 IPv6 */
    static async getPublicIPv6() {
        for (let i = 0; i < config.ipv6Endpoints.length; i++) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10000);
                const response = await fetch(config.ipv6Endpoints[i], { signal: controller.signal });
                clearTimeout(timer);
                if (response.ok) {
                    const ip = (await response.text()).trim();
                    if (this.isValidIPv6(ip)) return ip;
                }
            } catch (error) {
                console.log(`IPv6 attempt ${i + 1} failed:`, error.message);
            }
        }
        return null;
    }

    /** 带重试的获取,最终回退到本地 IPv6 */
    static async getIPv6WithRetry(retries = config.maxRetries) {
        let result = await this.getPublicIPv6();
        if (result) return result;

        for (let i = 0; i < retries; i++) {
            console.log(`IPv6 retry attempt ${i + 1}/${retries}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            result = await this.getPublicIPv6();
            if (result) return result;
        }

        return this.getLocalIPv6();
    }

    /** 获取本机第一个非内部 IPv6 地址 */
    static getLocalIPv6() {
        const interfaces = networkInterfaces();
        for (const interfaceName of Object.keys(interfaces)) {
            for (const iface of interfaces[interfaceName]) {
                if (iface.family === 'IPv6' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return null;
    }

    /** 校验 IPv6 地址格式 */
    static isValidIPv6(ip) {
        try {
            const parts = ip.split(':');
            if (parts.length > 8) return false;

            const hasDoubleColon = ip.includes('::');
            if (hasDoubleColon && parts.filter(p => p === '').length > 1) {
                return false;
            }

            for (const part of parts) {
                if (part === '') continue;
                if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
                    return false;
                }
            }
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = IPv6;