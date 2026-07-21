// © Vexify 2026 All Rights Reserved.
const MineP2P = require('./lib/client');
const config = require('./lib/config');
const {
    RTCPeerConnection,
    RTCDataChannel,
    RTCSessionDescription,
    RTCIceCandidate
} = require('wrtc-neo');

module.exports = {
    MineP2P,
    config,
    createClient: () => new MineP2P(),
    RTCPeerConnection,
    RTCDataChannel,
    RTCSessionDescription,
    RTCIceCandidate
};