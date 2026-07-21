// © Vexify 2026 All Rights Reserved.
const fetch = require('node-fetch');
const { networkInterfaces } = require('os');
const config = require('./config');

class IPv6 {
    static async getPublicIPv6() {
        for (let i = 0; i < config.ipv6Endpoints.length; i++) {
            try {
                const response = await fetch(config.ipv6Endpoints[i], {
                    timeout: 10000
                });
                if (response.ok) {
                    const ip = await response.text();
                    if (this.isValidIPv6(ip.trim())) {
                        return ip.trim();
                    }
                }
            } catch (error) {
                console.log(`IPv6 attempt ${i + 1} failed:`, error.message);
            }
        }
        return null;
    }

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
