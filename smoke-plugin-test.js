// 重构后功能冒烟测试: DSL 解释器 / 内置信令 / Store
const assert = require('assert');

console.log('=== DSL 插件解释器 ===');
const PluginLoader = require('./lib/plugin-loader');
const fakeSent = [];
const fakeClient = {
    peers: new Map(),
    sent: fakeSent,
    sendToPeer(pid, m) { this.sent.push({ pid, m }); },
    broadcast(m) { this.sent.push({ pid: '*', m }); },
    emit() {}
};
const L = new PluginLoader(fakeClient);
const p = L.load('./plugins/welcome.mp');
assert(p && p.name === 'welcome', 'welcome plugin should load');
assert(L.commands.has('hello') && L.commands.has('dice'), 'commands should register');

// 命令触发
L.handleMessage('/dice', { room: 'r1', peerId: '12345678a' });
L.handleMessage('/info', { room: 'r1', peerId: '12345678a' });
// 消息触发
L.handleMessage('ping', { room: 'r1', peerId: '12345678a' });
// 事件触发
L.handleEvent('join', { room: 'r1', peerId: '12345678a' });

console.log('  plugin outputs:');
fakeSent.forEach(s => console.log('   →', s.m.type, JSON.stringify(s.m.content)));
assert(fakeSent.some(s => String(s.m.content).includes('pong')), 'ping should reply pong');
assert(fakeSent.some(s => /🎲/.test(String(s.m.content))), '/dice should reply dice');
assert(fakeSent.some(s => String(s.m.content).includes('加入了房间')), 'join event should broadcast welcome');
console.log('  ✓ DSL interpreter OK');

console.log('\n=== 内置信令服务器 ===');
const BuiltinSignaling = require('./lib/builtin-signaling');
const sig = new BuiltinSignaling();
const a = sig.join('room1', 'peerA');
const b = sig.join('room1', 'peerB');
assert(a.peers.length === 0 && b.peers.length === 1, 'join should return existing peers');
assert(b.peers[0] === 'peerA', 'B should see A');
sig.broadcastMessage('room1', 'peerB', { type: 'chat', content: 'hi' });
const polled = sig.poll('room1', 'peerA', 2000);
polled.then(r => {
    assert(r.messages.some(m => m.content === 'hi'), 'broadcast should reach A via poll');
    console.log('  ✓ BuiltinSignaling OK');
    sig.leave('room1', 'peerA');
    sig.destroy();

    console.log('\n=== Store 消息存储 ===');
    const Store = require('./lib/store');
    const room = 'smoke-test-room';
    Store.saveMessage(room, { from: 'me', content: 'hello', type: 'chat' });
    Store.saveMessage(room, { from: 'x', content: 'world', type: 'chat' });
    const msgs = Store.getMessages(room, 10);
    assert(msgs.length === 2, 'should store 2 messages');
    assert(msgs[0].content === 'world', 'newest first');
    assert(Store.getRoomStats(room).messageCount === 2, 'stats count');
    Store.deleteRoom(room);
    console.log('  ✓ Store OK');

    console.log('\n=== SigningRoom 解析 ===');
    const Signaling = require('./lib/signaling');
    const custom = Signaling.parseRoomEndpoint('mp-custom.example.com-abc', {});
    assert(custom === 'https://custom.example.com/', 'custom node URL');
    const n1 = Signaling.parseRoomEndpoint('mp-n1-xyz', {});
    assert(n1.includes('vex-api-2'), 'n1 node endpoint');
    const plain = Signaling.parseRoomEndpoint('my-room', {});
    assert(plain.includes('vex-api-2') || plain.includes('api.vexify'), 'plain room → default');
    console.log('  ✓ Room endpoint parsing OK');

    console.log('\n=== ALL SMOKE TESTS PASSED ===');
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });