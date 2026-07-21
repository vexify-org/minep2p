// © Vexify 2026 All Rights Reserved.
module.exports = {
    // 多端点负载均衡配置（50/50 均分）
    apiEndpoints: [
        { url: 'https://vex-api-2.vexify.qzz.io/', weight: 50 },
        { url: 'https://api.vexify.top/', weight: 50 }
    ],
    // http fallback（SSL 有问题时使用）
    apiEndpointsHttp: [
        { url: 'http://vex-api-2.vexify.qzz.io/', weight: 50 },
        { url: 'http://api.vexify.top/', weight: 50 }
    ],
    apiBaseUrl: 'https://vex-api-2.vexify.qzz.io/',
    iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun1.cloudflare.com:3478' },
        { urls: 'stun:stun2.cloudflare.com:3478' },
        { urls: 'stun:stun3.cloudflare.com:3478' },
        { urls: 'stun:stun4.cloudflare.com:3478' }
    ],
    ipv6Endpoints: [
        'https://api6.ipify.org',
        'https://ipv6.icanhazip.com',
        'https://v6.ident.me'
    ],
    defaultRoom: 'minep2p-default',
    pollTimeout: 30,
    reconnectDelay: 5000,
    maxRetries: 3
};