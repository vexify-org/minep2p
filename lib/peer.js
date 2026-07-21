// © Vexify 2026 All Rights Reserved.
const wrtc = require('wrtc-neo');
const config = require('./config');

class Peer {
    constructor(peerId, signaling) {
        this.peerId = peerId;
        this.signaling = signaling;
        this.peerConnection = null;
        this.dataChannel = null;
        this.isInitiator = false;
        this.callbacks = {
            connect: [],
            disconnect: [],
            message: [],
            error: []
        };
    }

    async connect(isInitiator = false) {
        this.isInitiator = isInitiator;
        this.peerConnection = new wrtc.RTCPeerConnection({
            iceServers: config.iceServers
        });

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.sendMessage({
                    type: 'ice',
                    targetPeerId: this.peerId,
                    candidate: event.candidate.toJSON()
                });
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this._setupDataChannel();
        };

        this.peerConnection.onconnectionstatechange = () => {
            if (this.peerConnection.connectionState === 'connected') {
                this.callbacks.connect.forEach(cb => cb());
            } else if (this.peerConnection.connectionState === 'disconnected') {
                this.callbacks.disconnect.forEach(cb => cb());
            }
        };

        if (this.isInitiator) {
            this.dataChannel = this.peerConnection.createDataChannel('minep2p');
            this._setupDataChannel();
            
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            
            this.signaling.sendMessage({
                type: 'offer',
                targetPeerId: this.peerId,
                sdp: offer.toJSON()
            });
        }
    }

    async handleOffer(sdp) {
        await this.peerConnection.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
        
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        
        this.signaling.sendMessage({
            type: 'answer',
            targetPeerId: this.peerId,
            sdp: answer.toJSON()
        });
    }

    async handleAnswer(sdp) {
        await this.peerConnection.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
    }

    async handleIceCandidate(candidate) {
        try {
            await this.peerConnection.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
        } catch (error) {
            this.callbacks.error.forEach(cb => cb(error));
        }
    }

    send(data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify(data));
        }
    }

    close() {
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.peerConnection) {
            this.peerConnection.close();
        }
    }

    on(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event].push(callback);
        }
    }

    off(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
        }
    }

    _setupDataChannel() {
        this.dataChannel.onopen = () => {
            this.callbacks.connect.forEach(cb => cb());
        };

        this.dataChannel.onclose = () => {
            this.callbacks.disconnect.forEach(cb => cb());
        };

        this.dataChannel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.callbacks.message.forEach(cb => cb(data));
            } catch (error) {
                this.callbacks.message.forEach(cb => cb(event.data));
            }
        };

        this.dataChannel.onerror = (error) => {
            this.callbacks.error.forEach(cb => cb(error));
        };
    }
}

module.exports = Peer;
