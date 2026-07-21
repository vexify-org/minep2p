// © Vexify 2026 All Rights Reserved.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.minep2p');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const STATUS_FILE = path.join(DATA_DIR, 'daemon.json');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');
const COMMAND_FILE = path.join(DATA_DIR, 'command.json');

class Daemon {
    static ensureDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    static getPid() {
        try {
            const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
            return parseInt(pid, 10);
        } catch {
            return null;
        }
    }

    static isRunning() {
        const pid = this.getPid();
        if (!pid) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    static async start(room) {
        this.ensureDir();
        
        if (this.isRunning()) {
            throw new Error('MineP2P daemon is already running');
        }

        const cliPath = path.join(__dirname, '../cli.js');
        
        const args = [cliPath, '--daemon', 'start', '--room', room];
        
        fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] Starting daemon with args: ${args.join(' ')}\n`);
        
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')],
            cwd: path.join(__dirname, '..')
        });

        child.on('error', (err) => {
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Spawn error: ${err.message}\n`);
        });
        
        child.on('exit', (code) => {
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Daemon exited with code: ${code}\n`);
        });

        child.unref();

        const status = {
            pid: child.pid,
            room: room,
            rooms: [room],
            startedAt: Date.now(),
            status: 'starting'
        };

        try {
            fs.writeFileSync(PID_FILE, child.pid.toString());
            fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
        } catch (err) {
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Failed to write PID/status: ${err.message}\n`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        
        return status;
    }

    static async stop() {
        const pid = this.getPid();
        if (!pid) {
            throw new Error('MineP2P daemon is not running');
        }

        try {
            process.kill(pid, 'SIGINT');
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            if (this.isRunning()) {
                process.kill(pid, 'SIGKILL');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            if (error.code !== 'ESRCH') {
                throw error;
            }
        }

        if (fs.existsSync(PID_FILE)) {
            fs.unlinkSync(PID_FILE);
        }
        
        const status = {
            pid: null,
            room: null,
            rooms: [],
            startedAt: null,
            status: 'stopped'
        };
        fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
        
        return status;
    }

    static getStatus() {
        try {
            const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            status.running = this.isRunning();
            return status;
        } catch {
            return {
                pid: null,
                room: null,
                rooms: [],
                startedAt: null,
                status: 'stopped',
                running: false
            };
        }
    }

    static addRoom(room) {
        this.ensureDir();
        
        if (!this.isRunning()) {
            throw new Error('MineP2P daemon is not running');
        }

        const status = this.getStatus();
        if (!status.rooms.includes(room)) {
            status.rooms.push(room);
            fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
        }

        const command = {
            action: 'add',
            room: room,
            timestamp: Date.now()
        };
        fs.writeFileSync(COMMAND_FILE, JSON.stringify(command));
        
        return room;
    }

    static sendMessage(message) {
        this.ensureDir();
        
        if (!this.isRunning()) {
            throw new Error('MineP2P daemon is not running');
        }

        const command = {
            action: 'send',
            message: message,
            timestamp: Date.now()
        };
        fs.writeFileSync(COMMAND_FILE, JSON.stringify(command));
    }

    static getCommand() {
        try {
            if (fs.existsSync(COMMAND_FILE)) {
                const command = JSON.parse(fs.readFileSync(COMMAND_FILE, 'utf8'));
                fs.unlinkSync(COMMAND_FILE);
                return command;
            }
        } catch {
            if (fs.existsSync(COMMAND_FILE)) {
                fs.unlinkSync(COMMAND_FILE);
            }
        }
        return null;
    }
}

module.exports = Daemon;
