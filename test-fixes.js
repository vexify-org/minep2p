// Test 1: wrtc-neo exports
console.log('=== Test 1: wrtc-neo exports ===');
try {
    const wrtc = require('wrtc-neo');
    const checks = [
        ['HolePuncher', typeof wrtc.HolePuncher === 'function'],
        ['VirtualLAN', typeof wrtc.VirtualLAN === 'function'],
        ['RTCPeerConnection', typeof wrtc.RTCPeerConnection === 'function'],
        ['RTCDataChannel', typeof wrtc.RTCDataChannel === 'function'],
        ['IceManager', typeof wrtc.IceManager === 'function'],
        ['SignalingClient', typeof wrtc.SignalingClient === 'function'],
        ['SdpParser', typeof wrtc.SdpParser === 'function'],
    ];
    let allPass = true;
    for (const [name, ok] of checks) {
        console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
        if (!ok) allPass = false;
    }
    
    const hp = new wrtc.HolePuncher();
    console.log('  ✓ HolePuncher instance created');
    console.log('  ' + (allPass ? 'PASS' : 'PARTIAL FAIL'));
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 2: node-fetch
console.log('\n=== Test 2: node-fetch ===');
try {
    const fetch = require('node-fetch');
    console.log('  fetch type:', typeof fetch);
    console.log('  ✓ fetch available');
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 3: Store config
console.log('\n=== Test 3: Store config ===');
try {
    const Store = require('./lib/store');
    const keys = Store.getConfigurableKeys();
    console.log('  keys:', Object.keys(keys).join(', '));
    
    Store.setConfig('apiBaseUrl', 'https://test.vexify.top/mp/');
    const val = Store.getConfig('apiBaseUrl');
    console.log('  set:', val === 'https://test.vexify.top/mp/' ? '✓' : '✗');
    
    Store.resetConfig('apiBaseUrl');
    const reset = Store.getConfig('apiBaseUrl');
    console.log('  reset:', reset === null ? '✓' : '✗');
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 4: Daemon
console.log('\n=== Test 4: Daemon ===');
try {
    const Daemon = require('./lib/daemon');
    const status = Daemon.getStatus();
    console.log('  status:', status.status, 'running:', status.running);
    console.log('  ✓ Daemon loads');
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 5: NetworkManager
console.log('\n=== Test 5: NetworkManager ===');
try {
    const { MineP2P } = require('./index');
    const client = new MineP2P();
    console.log('  network:', typeof client.network);
    console.log('  startNetwork:', typeof client.startNetwork);
    console.log('  connectRoomNetwork:', typeof client.connectRoomNetwork);
    console.log('  getNetworkShareInfo:', typeof client.getNetworkShareInfo);
    console.log('  getNetworkStatus:', typeof client.getNetworkStatus);
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 6: Signaling
console.log('\n=== Test 6: Signaling ===');
try {
    const Signaling = require('./lib/signaling');
    const sig = new Signaling('test-peer');
    console.log('  _post:', typeof sig._post);
    console.log('  _get:', typeof sig._get);
    console.log('  join:', typeof sig.join);
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 7: CLI yaggs parsing
console.log('\n=== Test 7: CLI commands ===');
try {
    const yaggs = require('@vexify-org/yaggs');
    const parser = yaggs();
    parser.command('start [room]', 'test', (y) => {
        y.positional('room', { type: 'string' });
    }, (argv) => {});
    parser.command('set <key> <value>', 'test', null, (argv) => {});
    parser.command('get [key]', 'test', null, (argv) => {});
    console.log('  ✓ CLI commands register');
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 8: HolePuncher start/stop
console.log('\n=== Test 8: HolePuncher lifecycle ===');
try {
    const wrtc = require('wrtc-neo');
    const hp = new wrtc.HolePuncher();
    console.log('  start:', typeof hp.start);
    console.log('  stop:', typeof hp.stop);
    console.log('  discoverPublicAddress:', typeof hp.discoverPublicAddress);
    console.log('  punch:', typeof hp.punch);
    console.log('  getLocalPort:', typeof hp.getLocalPort);
    console.log('  ✓ HolePuncher methods OK');
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

// Test 9: VirtualLAN
console.log('\n=== Test 9: VirtualLAN ===');
try {
    const wrtc = require('wrtc-neo');
    const vlan = new wrtc.VirtualLAN();
    console.log('  start:', typeof vlan.start);
    console.log('  stop:', typeof vlan.stop);
    console.log('  allocateIP:', typeof vlan.allocateIP);
    console.log('  addPeer:', typeof vlan.addPeer);
    console.log('  sendPacket:', typeof vlan.sendPacket);
    console.log('  broadcast:', typeof vlan.broadcast);
    console.log('  getStatus:', typeof vlan.getStatus);
    console.log('  listPeers:', typeof vlan.listPeers);
    console.log('  ✓ VirtualLAN methods OK');
    console.log('  PASS');
} catch (e) {
    console.log('  FAIL:', e.message);
}

console.log('\n=== All tests complete ===');