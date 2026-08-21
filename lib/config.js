// © Vexify 2026 All Rights Reserved.

/**
 * MineP2P 默认配置
 *
 * 说明:
 *  - apiEndpoints: 信令服务器多端点负载均衡(按 weight 均分)
 *  - apiEndpointsHttp: SSL 异常时的 http 降级端点
 *  - iceServers: WebRTC 的 STUN 打洞服务器
 *  - ipv6Endpoints: 公网 IPv6 探测端点(用于 NAT 穿透的 IPv6 通道)
 */

module.exports = {
    // 多端点负载均衡配置(50/50 均分)
    apiEndpoints: [
        { url: 'https://vex-api-2.vexify.qzz.io/', weight: 50 },
        { url: 'https://api.vexify.top/', weight: 50 }
    ],

    // http 降级(SSL 异常时使用)
    apiEndpointsHttp: [
        { url: 'http://vex-api-2.vexify.qzz.io/', weight: 50 },
        { url: 'http://api.vexify.top/', weight: 50 }
    ],

    // 首选信令端点
    apiBaseUrl: 'https://vex-api-2.vexify.qzz.io/',

    // STUN 打洞服务器(WebRTC ICE)
    iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun1.cloudflare.com:3478' },
        { urls: 'stun:stun2.cloudflare.com:3478' },
        { urls: 'stun:stun3.cloudflare.com:3478' },
        { urls: 'stun:stun4.cloudflare.com:3478' }
    ],

    // 公网 IPv6 探测端点
    ipv6Endpoints: [
        'https://api6.ipify.org',
        'https://ipv6.icanhazip.com',
        'https://v6.ident.me'
    ],

    // 默认房间
    defaultRoom: 'minep2p-default',

    // 信令长轮询超时(秒)
    pollTimeout: 30,

    // 重连延迟(毫秒)
    reconnectDelay: 5000,

    // 最大重试次数
    maxRetries: 3
};