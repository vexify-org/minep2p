// © Vexify 2026 All Rights Reserved.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * 文件传输升级 — v2
 *
 * 新特性：
 * - 断点续传（进度持久化 + 偏移量恢复）
 * - 多线程并发传输（并发分片，可配置并发数）
 * - Merkle Tree 文件校验（全文件完整性验证）
 * - 文件夹自动打包传输
 * - 传输限速（Token Bucket）
 * - 文件搜索（P2P 资源发现）
 */

const CHUNK_SIZE = 65536; // 64KB per chunk
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_SPEED_LIMIT = 0; // 0 = 无限制，单位 bytes/s
const RESUME_DIR = '.minep2p_transfers';

// ============================================================
// Token Bucket 限速器
// ============================================================
class RateLimiter {
    constructor(bytesPerSecond = 0) {
        this._rate = bytesPerSecond;
        this._tokens = bytesPerSecond;
        this._lastRefill = Date.now();
        this._maxTokens = bytesPerSecond;
    }

    setRate(bytesPerSecond) {
        this._rate = bytesPerSecond;
        this._maxTokens = bytesPerSecond;
        this._tokens = Math.min(this._tokens, bytesPerSecond);
    }

    async consume(bytes) {
        if (this._rate <= 0) return; // 无限制
        this._refill();
        while (this._tokens < bytes) {
            await new Promise(r => setTimeout(r, 50));
            this._refill();
        }
        this._tokens -= bytes;
    }

    _refill() {
        const now = Date.now();
        const elapsed = (now - this._lastRefill) / 1000;
        this._tokens = Math.min(this._maxTokens, this._tokens + elapsed * this._rate);
        this._lastRefill = now;
    }
}

// ============================================================
// Merkle Tree 校验
// ============================================================
class MerkleTree {
    /**
     * 从 chunks 构建 Merkle Tree
     * @param {Buffer[]} chunks - 文件分片
     * @returns {{ root: string, tree: string[][], leaves: string[] }}
     */
    static build(chunks) {
        const leaves = chunks.map(c => crypto.createHash('sha256').update(c).digest('hex'));
        const tree = [leaves];
        let current = leaves;

        while (current.length > 1) {
            const next = [];
            for (let i = 0; i < current.length; i += 2) {
                const left = current[i];
                const right = i + 1 < current.length ? current[i + 1] : left;
                next.push(crypto.createHash('sha256').update(left + right).digest('hex'));
            }
            tree.push(next);
            current = next;
        }

        return { root: current[0], tree, leaves };
    }

    /**
     * 验证单个 chunk
     * @param {string} leafHash - chunk 的 hash
     * @param {number} index - chunk 索引
     * @param {string[]} proof - Merkle proof 路径
     * @param {string} root - 期望的根 hash
     * @returns {boolean}
     */
    static verify(leafHash, index, proof, root) {
        let hash = leafHash;
        let idx = index;
        for (const sibling of proof) {
            if (idx % 2 === 0) {
                hash = crypto.createHash('sha256').update(hash + sibling).digest('hex');
            } else {
                hash = crypto.createHash('sha256').update(sibling + hash).digest('hex');
            }
            idx = Math.floor(idx / 2);
        }
        return hash === root;
    }

    /**
     * 生成 Merkle proof
     * @param {string[][]} tree
     * @param {number} leafIndex
     * @returns {string[]}
     */
    static getProof(tree, leafIndex) {
        const proof = [];
        let idx = leafIndex;
        for (let level = 0; level < tree.length - 1; level++) {
            const isLeft = idx % 2 === 0;
            const siblingIdx = isLeft ? idx + 1 : idx - 1;
            if (siblingIdx < tree[level].length) {
                proof.push(tree[level][siblingIdx]);
            } else {
                proof.push(tree[level][idx]); // 用自己当 sibling（奇数个节点）
            }
            idx = Math.floor(idx / 2);
        }
        return proof;
    }
}

// ============================================================
// 文件传输管理器
// ============================================================
class FileTransfer extends EventEmitter {
    constructor(minep2p) {
        super();
        this.minep2p = minep2p;
        this.transfers = new Map();    // fileId -> send transfer
        this.receivers = new Map();    // fileId -> receive transfer
        this._sharedFiles = new Map(); // fileName -> { path, size, hash, merkleRoot }
        this._speedLimiters = new Map();
        this._resumeDir = path.join(
            minep2p.pluginDir || path.join(require('os').homedir(), '.minep2p'),
            RESUME_DIR
        );
        if (!fs.existsSync(this._resumeDir)) {
            fs.mkdirSync(this._resumeDir, { recursive: true });
        }
    }

    // ============================================================
    // 发送文件（支持断点续传）
    // ============================================================
    async sendFile(peerId, filePath, options = {}) {
        const {
            onProgress,
            concurrency = DEFAULT_CONCURRENCY,
            speedLimit = DEFAULT_SPEED_LIMIT,
            resume = true,
            fileId: customFileId
        } = options;

        const stat = fs.statSync(filePath);
        const fileName = path.basename(filePath);
        const fileSize = stat.size;
        const fileId = customFileId || crypto.randomBytes(16).toString('hex');
        const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

        // 建立 Merkle Tree（后台进行）
        const chunks = [];
        const fd = fs.openSync(filePath, 'r');
        for (let i = 0; i < totalChunks; i++) {
            const buf = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize - i * CHUNK_SIZE));
            fs.readSync(fd, buf, 0, buf.length, i * CHUNK_SIZE);
            chunks.push(buf);
        }
        fs.closeSync(fd);
        const merkle = MerkleTree.build(chunks);

        // 检查断点续传
        let startChunk = 0;
        let resumeState = null;
        if (resume) {
            resumeState = this._loadResumeState(fileId, 'send');
            if (resumeState && resumeState.fileName === fileName && resumeState.fileSize === fileSize) {
                startChunk = resumeState.sentChunks || 0;
                this.emit('resume', { fileId, fileName, startChunk, totalChunks });
            }
        }

        const transfer = {
            id: fileId,
            fileName,
            fileSize,
            totalChunks,
            sentChunks: startChunk,
            sentBytes: startChunk * CHUNK_SIZE,
            merkleRoot: merkle.root,
            merkleTree: merkle.tree,
            onProgress,
            paused: false,
            cancelled: false,
            startTime: Date.now()
        };
        this.transfers.set(fileId, transfer);

        // 发送文件头
        this.minep2p.sendToPeer(peerId, {
            type: 'file-header-v2',
            fileId,
            fileName,
            fileSize,
            totalChunks,
            chunkSize: CHUNK_SIZE,
            merkleRoot: merkle.root,
            resumeOffset: startChunk * CHUNK_SIZE
        });

        // 限速器
        const limiter = new RateLimiter(speedLimit);
        this._speedLimiters.set(fileId, limiter);

        // 并发发送分片
        const pending = [];
        for (let i = startChunk; i < totalChunks; i++) {
            pending.push(i);
        }

        const worker = async () => {
            while (pending.length > 0 && !transfer.cancelled) {
                if (transfer.paused) {
                    await new Promise(r => setTimeout(r, 100));
                    continue;
                }
                const idx = pending.shift();
                if (idx === undefined) break;

                const buf = chunks[idx];
                const hash = crypto.createHash('sha256').update(buf).digest('hex');
                const proof = MerkleTree.getProof(merkle.tree, idx);

                await limiter.consume(buf.length);

                this.minep2p.sendToPeer(peerId, {
                    type: 'file-chunk-v2',
                    fileId,
                    index: idx,
                    data: buf.toString('base64'),
                    hash,
                    proof
                });

                transfer.sentChunks++;
                transfer.sentBytes += buf.length;
                this._saveResumeState(fileId, 'send', transfer);

                if (onProgress || this.listenerCount('progress')) {
                    const progress = {
                        fileId, fileName,
                        sent: transfer.sentBytes,
                        total: fileSize,
                        percent: Math.round((transfer.sentBytes / fileSize) * 100),
                        speed: this._calculateSpeed(transfer)
                    };
                    if (onProgress) onProgress(progress);
                    this.emit('progress', progress);
                }
            }
        };

        await Promise.all(Array.from({ length: concurrency }, () => worker()));

        if (transfer.cancelled) {
            this.transfers.delete(fileId);
            this._speedLimiters.delete(fileId);
            return { fileId, cancelled: true };
        }

        // 发送 Merkle 根 hash（完成确认）
        this.minep2p.sendToPeer(peerId, {
            type: 'file-done-v2',
            fileId,
            merkleRoot: merkle.root,
            totalChunks,
            fileSize
        });

        this.transfers.delete(fileId);
        this._speedLimiters.delete(fileId);
        this._clearResumeState(fileId, 'send');

        const elapsed = (Date.now() - transfer.startTime) / 1000;
        this.emit('complete', { fileId, fileName, fileSize, elapsed, speed: fileSize / elapsed });

        return { fileId, fileName, fileSize, elapsed, speed: fileSize / elapsed };
    }

    // ============================================================
    // 发送文件夹（自动打包）
    // ============================================================
    async sendFolder(peerId, folderPath, options = {}) {
        const folderName = path.basename(folderPath);
        const tarPath = path.join(this._resumeDir, `${folderName}_${Date.now()}.tar`);

        // 打包文件夹
        const { execSync } = require('child_process');
        try {
            execSync(`tar -cf "${tarPath}" -C "${path.dirname(folderPath)}" "${folderName}"`, { encoding: 'utf8' });
        } catch (e) {
            // 回退到目录遍历
            this._packFolder(folderPath, tarPath);
        }

        const result = await this.sendFile(peerId, tarPath, {
            ...options,
            onProgress: options.onProgress ? (p) => {
                options.onProgress({ ...p, isFolder: true, folderName });
            } : undefined
        });

        // 清理临时文件
        try { fs.unlinkSync(tarPath); } catch (e) { /* ignore */ }

        return { ...result, isFolder: true, folderName };
    }

    _packFolder(folderPath, outputPath) {
        const files = [];
        const walkDir = (dir, base) => {
            for (const entry of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, entry);
                const relPath = path.join(base, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    walkDir(fullPath, relPath);
                } else {
                    files.push({ path: fullPath, relative: relPath, size: fs.statSync(fullPath).size });
                }
            }
        };
        walkDir(folderPath, '');

        // 简单打包格式：JSON 头 + 文件内容
        const header = { folder: path.basename(folderPath), files };
        const headerStr = JSON.stringify(header) + '\n---FILES---\n';
        const fd = fs.openSync(outputPath, 'w');
        fs.writeSync(fd, headerStr);
        for (const f of files) {
            fs.writeSync(fd, f.relative + '\n');
            fs.writeSync(fd, String(f.size) + '\n');
            fs.writeSync(fd, fs.readFileSync(f.path));
        }
        fs.closeSync(fd);
    }

    // ============================================================
    // 接收文件
    // ============================================================
    handleMessage(peerId, message) {
        const { type } = message;

        if (type === 'file-header-v2') {
            this._handleHeader(peerId, message);
        } else if (type === 'file-chunk-v2') {
            this._handleChunk(peerId, message);
        } else if (type === 'file-done-v2') {
            this._handleDone(peerId, message);
        } else if (type === 'file-resume-request') {
            this._handleResumeRequest(peerId, message);
        } else if (type === 'file-search') {
            this._handleSearch(peerId, message);
        } else if (type === 'file-search-result') {
            this._handleSearchResult(peerId, message);
        }
    }

    _handleHeader(peerId, message) {
        const { fileId, fileName, fileSize, totalChunks, chunkSize, merkleRoot, resumeOffset } = message;

        // 检查是否有断点续传状态
        let resumeState = this._loadResumeState(fileId, 'receive');
        let receivedChunks = new Set();
        let receivedBytes = 0;

        if (resumeState && resumeState.fileName === fileName && resumeState.fileSize === fileSize) {
            receivedChunks = new Set(resumeState.receivedChunks || []);
            receivedBytes = resumeState.receivedBytes || 0;
            this.emit('resume', { fileId, fileName, receivedBytes, totalSize: fileSize });
        }

        const receiver = {
            fileName,
            fileSize,
            totalChunks,
            chunkSize: chunkSize || CHUNK_SIZE,
            merkleRoot,
            receivedChunks,
            receivedBytes,
            buffer: Buffer.alloc(fileSize),
            startTime: Date.now(),
            peerId
        };
        this.receivers.set(fileId, receiver);

        // 如果对方有偏移，发送断点续传请求
        if (resumeOffset > 0 && receivedChunks.size === 0) {
            this.minep2p.sendToPeer(peerId, {
                type: 'file-resume-request',
                fileId,
                resumeFrom: resumeOffset
            });
        }

        this.emit('receive-start', { fileId, fileName, fileSize, peerId });
    }

    _handleChunk(peerId, message) {
        const { fileId, index, data, hash, proof } = message;
        const receiver = this.receivers.get(fileId);
        if (!receiver) return;

        if (receiver.receivedChunks.has(index)) return; // 已接收

        const chunk = Buffer.from(data, 'base64');

        // 校验 chunk
        const localHash = crypto.createHash('sha256').update(chunk).digest('hex');
        if (localHash !== hash) {
            this.emit('chunk-error', { fileId, index, error: 'Hash mismatch' });
            return;
        }

        // Merkle 验证（如果有 proof）
        if (proof && receiver.merkleRoot) {
            if (!MerkleTree.verify(hash, index, proof, receiver.merkleRoot)) {
                this.emit('chunk-error', { fileId, index, error: 'Merkle proof failed' });
                return;
            }
        }

        // 写入缓冲区
        chunk.copy(receiver.buffer, index * receiver.chunkSize);
        receiver.receivedChunks.add(index);
        receiver.receivedBytes = receiver.receivedChunks.size * receiver.chunkSize;

        // 保存断点
        this._saveResumeState(fileId, 'receive', {
            fileName: receiver.fileName,
            fileSize: receiver.fileSize,
            receivedChunks: [...receiver.receivedChunks],
            receivedBytes: receiver.receivedBytes
        });

        const percent = Math.min(100, Math.round((receiver.receivedChunks.size / receiver.totalChunks) * 100));
        this.emit('progress', {
            fileId, fileName: receiver.fileName,
            received: receiver.receivedBytes,
            total: receiver.fileSize,
            percent,
            speed: this._calculateSpeed(receiver)
        });
    }

    _handleDone(peerId, message) {
        const { fileId, merkleRoot, totalChunks, fileSize } = message;
        const receiver = this.receivers.get(fileId);
        if (!receiver) return;

        // 验证完整性
        const complete = receiver.receivedChunks.size >= totalChunks;

        if (complete) {
            // 保存文件
            const savePath = path.join(process.cwd(), receiver.fileName);
            const finalBuffer = receiver.buffer.slice(0, receiver.fileSize);

            // 最终 Merkle 验证
            if (merkleRoot) {
                const chunkCount = Math.ceil(receiver.fileSize / receiver.chunkSize);
                const chunks = [];
                for (let i = 0; i < chunkCount; i++) {
                    const start = i * receiver.chunkSize;
                    const end = Math.min(start + receiver.chunkSize, receiver.fileSize);
                    chunks.push(finalBuffer.slice(start, end));
                }
                const finalMerkle = MerkleTree.build(chunks);
                if (finalMerkle.root !== merkleRoot) {
                    this.emit('error', { fileId, fileName: receiver.fileName, error: 'Final Merkle verification failed' });
                    return;
                }
            }

            fs.writeFileSync(savePath, finalBuffer);
            this._clearResumeState(fileId, 'receive');

            const elapsed = (Date.now() - receiver.startTime) / 1000;
            this.emit('receive-complete', {
                fileId, fileName: receiver.fileName,
                fileSize: receiver.fileSize, savePath,
                elapsed, speed: receiver.fileSize / elapsed
            });
        } else {
            this.emit('receive-incomplete', {
                fileId, fileName: receiver.fileName,
                received: receiver.receivedChunks.size,
                total: totalChunks
            });
        }

        this.receivers.delete(fileId);
    }

    _handleResumeRequest(peerId, message) {
        const { fileId, resumeFrom } = message;
        // 对端请求从某个偏移量继续，我们重新发送
        const transfer = this.transfers.get(fileId);
        if (transfer) {
            transfer.sentChunks = Math.floor(resumeFrom / CHUNK_SIZE);
            transfer.sentBytes = resumeFrom;
        }
    }

    // ============================================================
    // 文件搜索
    // ============================================================
    shareFile(filePath, fileName = null) {
        try {
            const stat = fs.statSync(filePath);
            const name = fileName || path.basename(filePath);
            const hash = this._hashFile(filePath);
            this._sharedFiles.set(name, {
                path: filePath,
                size: stat.size,
                hash,
                mtime: stat.mtime,
                sharedAt: Date.now()
            });
            this.emit('file-shared', { fileName: name, size: stat.size });
            return name;
        } catch (e) {
            this.emit('error', { error: `Share failed: ${e.message}` });
            return null;
        }
    }

    unshareFile(fileName) {
        this._sharedFiles.delete(fileName);
        this.emit('file-unshared', { fileName });
    }

    getSharedFiles() {
        const result = {};
        for (const [name, info] of this._sharedFiles) {
            result[name] = { size: info.size, hash: info.hash, sharedAt: info.sharedAt };
        }
        return result;
    }

    /**
     * 搜索文件（向所有 peers 广播查询）
     */
    searchFile(query, options = {}) {
        const { timeout = 5000 } = options;
        this.minep2p.broadcast({
            type: 'file-search',
            query,
            requestId: crypto.randomBytes(8).toString('hex')
        });
        this.emit('search-started', { query });

        return new Promise((resolve) => {
            const results = [];
            const handler = (result) => {
                results.push(result);
            };
            this.on('search-result', handler);
            setTimeout(() => {
                this.off('search-result', handler);
                resolve(results);
            }, timeout);
        });
    }

    _handleSearch(peerId, message) {
        const { query, requestId } = message;
        const matches = [];
        for (const [name, info] of this._sharedFiles) {
            if (name.toLowerCase().includes(query.toLowerCase())) {
                matches.push({
                    fileName: name,
                    size: info.size,
                    hash: info.hash,
                    sharedAt: info.sharedAt
                });
            }
        }
        if (matches.length > 0) {
            this.minep2p.sendToPeer(peerId, {
                type: 'file-search-result',
                requestId,
                query,
                results: matches
            });
        }
    }

    _handleSearchResult(peerId, message) {
        const { query, results } = message;
        for (const r of results) {
            this.emit('search-result', { ...r, peerId, query });
        }
    }

    // ============================================================
    // 传输控制
    // ============================================================
    pauseTransfer(fileId) {
        const transfer = this.transfers.get(fileId);
        if (transfer) {
            transfer.paused = true;
            this.emit('paused', { fileId });
        }
    }

    resumeTransfer(fileId) {
        const transfer = this.transfers.get(fileId);
        if (transfer) {
            transfer.paused = false;
            this.emit('resumed', { fileId });
        }
    }

    cancelTransfer(fileId) {
        const transfer = this.transfers.get(fileId);
        if (transfer) {
            transfer.cancelled = true;
            this.emit('cancelled', { fileId });
        }
        const receiver = this.receivers.get(fileId);
        if (receiver) {
            this.receivers.delete(fileId);
            this._clearResumeState(fileId, 'receive');
            this.emit('cancelled', { fileId });
        }
    }

    setSpeedLimit(fileId, bytesPerSecond) {
        const limiter = this._speedLimiters.get(fileId);
        if (limiter) {
            limiter.setRate(bytesPerSecond);
        }
    }

    getTransferStatus(fileId) {
        const transfer = this.transfers.get(fileId);
        if (transfer) {
            return {
                fileId,
                fileName: transfer.fileName,
                fileSize: transfer.fileSize,
                sentBytes: transfer.sentBytes,
                percent: Math.round((transfer.sentBytes / transfer.fileSize) * 100),
                speed: this._calculateSpeed(transfer),
                paused: transfer.paused,
                elapsed: (Date.now() - transfer.startTime) / 1000
            };
        }
        const receiver = this.receivers.get(fileId);
        if (receiver) {
            return {
                fileId,
                fileName: receiver.fileName,
                fileSize: receiver.fileSize,
                receivedBytes: receiver.receivedBytes,
                percent: Math.round((receiver.receivedChunks.size / receiver.totalChunks) * 100),
                speed: this._calculateSpeed(receiver),
                elapsed: (Date.now() - receiver.startTime) / 1000
            };
        }
        return null;
    }

    getAllTransfers() {
        const result = [];
        for (const [id, t] of this.transfers) {
            result.push({
                id, direction: 'send',
                fileName: t.fileName, fileSize: t.fileSize,
                percent: Math.round((t.sentBytes / t.fileSize) * 100),
                speed: this._calculateSpeed(t), paused: t.paused
            });
        }
        for (const [id, r] of this.receivers) {
            result.push({
                id, direction: 'receive',
                fileName: r.fileName, fileSize: r.fileSize,
                percent: Math.round((r.receivedChunks.size / r.totalChunks) * 100),
                speed: this._calculateSpeed(r)
            });
        }
        return result;
    }

    // ============================================================
    // 辅助方法
    // ============================================================
    _hashFile(filePath) {
        const hash = crypto.createHash('sha256');
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(65536);
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            hash.update(buf.slice(0, bytesRead));
        }
        fs.closeSync(fd);
        return hash.digest('hex');
    }

    _calculateSpeed(transfer) {
        const elapsed = (Date.now() - transfer.startTime) / 1000;
        if (elapsed <= 0) return 0;
        const bytes = transfer.sentBytes || transfer.receivedBytes || 0;
        return bytes / elapsed;
    }

    _loadResumeState(fileId, direction) {
        const statePath = path.join(this._resumeDir, `${direction}_${fileId}.json`);
        try {
            if (fs.existsSync(statePath)) {
                return JSON.parse(fs.readFileSync(statePath, 'utf8'));
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    _saveResumeState(fileId, direction, state) {
        const statePath = path.join(this._resumeDir, `${direction}_${fileId}.json`);
        try {
            fs.writeFileSync(statePath, JSON.stringify({
                ...state,
                savedAt: Date.now()
            }, null, 2), 'utf8');
        } catch (e) { /* ignore */ }
    }

    _clearResumeState(fileId, direction) {
        const statePath = path.join(this._resumeDir, `${direction}_${fileId}.json`);
        try {
            if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
        } catch (e) { /* ignore */ }
    }

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
}

FileTransfer.MerkleTree = MerkleTree;
FileTransfer.RateLimiter = RateLimiter;
FileTransfer.CHUNK_SIZE = CHUNK_SIZE;

module.exports = FileTransfer;