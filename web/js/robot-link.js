// BLE link to firmware/robot_drive_ble (UUIDs and packet must match that sketch).
//
// Command (write without response, ~20 Hz), 4 bytes: [seq lo, seq hi, left, right]
//   left/right = int8 wheel speed in percent, -100..100, + = forward.
// ACK (notify), 2 bytes: seq echoed back, used for round-trip time and stall detection.
// Board watchdog: no command for 400 ms, or a disconnect -> both motors stop.
// Screen height (write, 1 byte): 0..100 = lowest..highest position of the phone lift servo.
//   Sketches from before the lift do not have this characteristic; driving still works with them.
//
// Connection handling follows haptic-lane-guide's BeltLink: one tap to choose the board, then
// automatic reconnects with backoff, a stall check (writing but no ACK for 1 s -> reconnect) and
// reconnect after reload through getDevices() where the browser supports it.

export const ROBOT_NAME = 'MockingbirdBot';
export const SERVICE_UUID = 'c5831c08-81a7-4b41-bc27-ce21e6c8a9d0';
export const COMMAND_UUID = 'ae8acab1-0450-4513-b4e1-0cec81b012a7';
export const ACK_UUID = 'd55045a0-f292-446c-99f6-c6b81a18cba1';
export const HEIGHT_UUID = '535aa1fd-354f-456e-a5d3-7529c36fed04';

const clampPct = (v) => Math.max(-100, Math.min(100, Math.round(v) || 0));

export function encodeDrive(seq, left, right) {
  const b = new Uint8Array(4);
  b[0] = seq & 0xff;
  b[1] = (seq >> 8) & 0xff;
  b[2] = clampPct(left) & 0xff; // int8 two's complement
  b[3] = clampPct(right) & 0xff;
  return b;
}

export function encodeHeight(pct) {
  return new Uint8Array([Math.max(0, Math.min(100, Math.round(pct) || 0))]);
}

export class RobotLink {
  constructor({ onLog = () => {}, onStatus = () => {} } = {}) {
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.device = null;
    this.cmdChar = null;
    this.heightChar = null;
    this.heightWant = null; // 0..100, sent by the next send() when dirty
    this.heightDirty = false;
    this.noResponse = false;
    this.connecting = false;
    this.writing = false;
    this.attempts = 0;
    this.retryTimer = null;
    this.restored = false;
    this.seq = 0;
    this.pending = new Map();
    this.lastAckT = 0;
    this.lastWriteT = 0;
    this.rttMs = null;
    this.onDisconnected = this.onDisconnected.bind(this);
    this.onAck = this.onAck.bind(this);
    this.stallTimer = setInterval(() => this.checkStall(), 250);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected() {
    return !!this.cmdChar;
  }

  // False when connected to a sketch without the screen lift.
  get hasHeight() {
    return !!this.heightChar;
  }

  // Latest wins. The value goes out with the next drive command, so the two writes never overlap
  // (Web Bluetooth allows one GATT operation at a time). It is sent again after every reconnect:
  // the board only powers the servo once it knows where the screen should be.
  setHeight(pct) {
    this.heightWant = pct;
    this.heightDirty = true;
  }

  // Must run inside a tap: opens the device chooser.
  async choose() {
    if (this.cmdChar) return;
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
    this.use(dev, false);
  }

  async restore() {
    if (!navigator.bluetooth?.getDevices) return false;
    const dev = (await navigator.bluetooth.getDevices()).find((d) => d.name === ROBOT_NAME);
    if (dev && !this.device) this.use(dev, true);
    return !!dev;
  }

  use(device, restored) {
    this.drop();
    this.device = device;
    this.restored = restored;
    this.attempts = 0;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.connectGatt();
  }

  drop() {
    if (!this.device) return;
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      this.device.gatt.disconnect();
    } catch {}
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.device = null;
    this.cmdChar = null;
    this.heightChar = null;
  }

  disconnect() {
    this.drop();
    this.onStatus('not connected', false);
  }

  async connectGatt() {
    if (this.connecting || !this.device) return;
    this.connecting = true;
    this.attempts++;
    this.onStatus(`connecting (try ${this.attempts})`, false);
    try {
      const server = await withTimeout(this.device.gatt.connect(), 5000);
      const service = await server.getPrimaryService(SERVICE_UUID);
      const cmd = await service.getCharacteristic(COMMAND_UUID);
      const ack = await service.getCharacteristic(ACK_UUID);
      ack.addEventListener('characteristicvaluechanged', this.onAck);
      await ack.startNotifications();
      this.noResponse = typeof cmd.writeValueWithoutResponse === 'function';
      try {
        this.heightChar = await service.getCharacteristic(HEIGHT_UUID);
        this.heightDirty = this.heightWant !== null;
      } catch {
        this.heightChar = null;
        this.onLog('this sketch has no screen-height control: upload the current firmware to use it');
      }
      this.cmdChar = cmd;
      this.lastAckT = performance.now();
      this.attempts = 0;
      this.restored = false;
      this.onStatus('connected', true);
      this.onLog('robot connected');
    } catch (err) {
      this.onLog(`connect failed: ${err.name || ''} ${err.message || err}`);
      try {
        this.device.gatt.disconnect();
      } catch {}
      if (this.restored && this.attempts >= 3) {
        this.drop();
        this.onStatus('tap Connect robot', false);
      } else {
        this.scheduleRetry([500, 1000, 2000][Math.min(this.attempts - 1, 2)]);
      }
    } finally {
      this.connecting = false;
    }
  }

  scheduleRetry(ms) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connectGatt();
    }, ms);
  }

  onDisconnected() {
    this.cmdChar = null;
    this.heightChar = null;
    this.pending.clear();
    this.onStatus('disconnected, reconnecting', false);
    if (!this.connecting) this.scheduleRetry(500);
  }

  checkStall() {
    const t = performance.now();
    if (this.cmdChar && t - this.lastWriteT < 200 && t - this.lastAckT > 1000) {
      this.onLog(`no ACK for ${Math.round(t - this.lastAckT)} ms, reconnecting`);
      try {
        this.device.gatt.disconnect();
      } catch {}
    }
  }

  onAck(e) {
    const seq = e.target.value.getUint16(0, true);
    const sentT = this.pending.get(seq);
    if (sentT === undefined) return;
    this.pending.delete(seq);
    this.lastAckT = performance.now();
    this.rttMs = this.lastAckT - sentT;
  }

  // Latest wins: a command is dropped while the previous write is still in flight.
  async send(left, right) {
    if (!this.cmdChar || this.writing) return;
    this.writing = true;
    this.seq = (this.seq + 1) & 0xffff;
    const packet = encodeDrive(this.seq, left, right);
    try {
      if (this.heightDirty && this.heightChar) {
        this.heightDirty = false;
        const h = encodeHeight(this.heightWant);
        if (this.noResponse) await this.heightChar.writeValueWithoutResponse(h);
        else await this.heightChar.writeValue(h);
      }
      this.lastWriteT = performance.now();
      this.pending.set(this.seq, this.lastWriteT);
      if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value);
      if (this.noResponse) await this.cmdChar.writeValueWithoutResponse(packet);
      else await this.cmdChar.writeValue(packet);
    } catch (err) {
      this.onLog(`write failed: ${err.message || err}`);
    } finally {
      this.writing = false;
    }
  }
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
