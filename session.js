async function dialTelegramSocket(options) {
  try {
    const sockets = await import("cloudflare:sockets");
    return sockets.connect(options);
  } catch {
    throw new Error("cloudflare:sockets is only available in Cloudflare Workers runtime");
  }
}
import {
  FRAME_TYPES,
  encodeFrame,
  decodeFrames,
  MAX_DATA_CHUNK,
  INITIAL_STREAM_WINDOW,
  MAX_STREAMS_PER_SESSION,
  constantTimeCompare,
  ProtocolError
} from "./protocol.ts";
const TELEGRAM_DCS = Object.freeze({
  1: { ip: "149.154.175.50", port: 443 },
  2: { ip: "149.154.167.51", port: 443 },
  3: { ip: "149.154.175.100", port: 443 },
  4: { ip: "149.154.167.91", port: 443 },
  5: { ip: "91.108.56.130", port: 443 }
});
const DEFAULT_DC = TELEGRAM_DCS[2];
const IDLE_TIMEOUT_MS = 3e5;
class StreamContext {
  constructor(streamId, dcId, abortController) {
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
    this.streamId = streamId;
    this.dcId = dcId;
    this.abortController = abortController;
    this.inboundWindow = INITIAL_STREAM_WINDOW;
    this.outboundWindow = INITIAL_STREAM_WINDOW;
  }
}
class ProxySessionDO {
  constructor(state, env) {
    this.ws = null;
    this.streams = /* @__PURE__ */ new Map();
    this.tombstones = /* @__PURE__ */ new Set();
    this.rxBuffer = new Uint8Array(0);
    this.idleTimer = null;
    this.state = state;
    this.env = env;
  }
  touchIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.closeCarrierProtocolViolation("Session idle timeout", 1e3);
    }, IDLE_TIMEOUT_MS);
  }
  async fetch(request) {
    const internalAuth = request.headers.get("X-Internal-Auth");
    if (!internalAuth || !constantTimeCompare(internalAuth, "trusted-worker")) {
      return new Response("Unauthorized internal call", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();
    this.ws = serverSocket;
    this.touchIdleTimer();
    this.bindCarrierSocket(serverSocket);
    const headers = new Headers();
    const requestedProtocol = request.headers.get("Sec-WebSocket-Protocol");
    if (requestedProtocol) {
      const parts = requestedProtocol.split(",").map((p) => p.trim());
      const matched = parts.find((p) => p.startsWith("tproxy-v1"));
      if (matched) {
        headers.set("Sec-WebSocket-Protocol", matched);
      }
    }
    return new Response(null, {
      status: 101,
      // @ts-ignore webSocket response in Cloudflare Workers
      webSocket: clientSocket,
      headers
    });
  }
  bindCarrierSocket(ws) {
    ws.addEventListener("message", async (event) => {
      this.touchIdleTimer();
      try {
        let chunk;
        if (typeof event.data === "string") {
          chunk = new TextEncoder().encode(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          chunk = new Uint8Array(event.data);
        } else {
          chunk = new Uint8Array(await event.data.arrayBuffer());
        }
        const next = new Uint8Array(this.rxBuffer.byteLength + chunk.byteLength);
        next.set(this.rxBuffer, 0);
        next.set(chunk, this.rxBuffer.byteLength);
        this.rxBuffer = next;
        const { frames, remainder } = decodeFrames(this.rxBuffer);
        this.rxBuffer = remainder;
        for (const frame of frames) {
          await this.handleFrame(frame);
        }
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.closeCarrierProtocolViolation(err.message, err.code || 1002);
        } else {
          this.closeCarrierProtocolViolation("Frame decode violation", 1002);
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closeAllStreams(0);
      this.ws = null;
    });
    ws.addEventListener("error", () => {
      this.closeAllStreams(1);
      this.ws = null;
    });
  }
  async handleFrame(frame) {
    const { type, streamId, payload } = frame;
    switch (type) {
      case FRAME_TYPES.HELLO: {
        const welcome = new Uint8Array(8);
        const view = new DataView(welcome.buffer);
        view.setUint32(0, INITIAL_STREAM_WINDOW, false);
        view.setUint32(4, MAX_STREAMS_PER_SESSION, false);
        this.sendFrame(FRAME_TYPES.WELCOME, 0, welcome);
        break;
      }
      case FRAME_TYPES.OPEN: {
        if (streamId === 0) {
          this.sendStreamClose(0, 1);
          return;
        }
        let targetDcId = 2;
        let explicitTarget = null;
        if (payload.byteLength === 1) {
          targetDcId = payload[0];
        } else if (payload.byteLength === 2) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          targetDcId = Math.abs(view.getInt16(0, false));
        } else if (payload.byteLength >= 6) {
          const ip = `${payload[0]}.${payload[1]}.${payload[2]}.${payload[3]}`;
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          const port = view.getUint16(4, false);
          explicitTarget = { ip, port: port || 443 };
        }
        if (this.tombstones.has(streamId) || this.streams.has(streamId)) {
          return;
        }
        if (this.streams.size >= MAX_STREAMS_PER_SESSION) {
          this.sendStreamClose(streamId, 3);
          return;
        }
        await this.openDcStream(streamId, targetDcId, explicitTarget);
        break;
      }
      case FRAME_TYPES.DATA: {
        const stream = this.streams.get(streamId);
        if (!stream || stream.closed) {
          return;
        }
        await this.forwardDataUpstream(stream, payload);
        break;
      }
      case FRAME_TYPES.WINDOW: {
        const stream = this.streams.get(streamId);
        if (stream && !stream.closed && payload.byteLength >= 4) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          const credit = view.getUint32(0, false);
          stream.outboundWindow = Math.min(
            stream.outboundWindow + credit,
            INITIAL_STREAM_WINDOW * 2
          );
        }
        break;
      }
      case FRAME_TYPES.PING: {
        this.sendFrame(FRAME_TYPES.PONG, streamId, payload);
        break;
      }
      case FRAME_TYPES.CLOSE: {
        const code = payload.byteLength >= 1 ? payload[0] : 0;
        this.closeStream(streamId, code);
        break;
      }
      case FRAME_TYPES.BYE: {
        this.closeAllStreams(0);
        if (this.ws) {
          try {
            this.ws.close(1e3, "Client requested bye");
          } catch {
          }
          this.ws = null;
        }
        break;
      }
    }
  }
  async openDcStream(streamId, dcId, explicitTarget = null) {
    const abortController = new AbortController();
    const stream = new StreamContext(streamId, dcId, abortController);
    this.streams.set(streamId, stream);
    const targetDc = explicitTarget || TELEGRAM_DCS[dcId] || DEFAULT_DC;
    try {
      const dialTimeout = setTimeout(() => {
        abortController.abort();
      }, 1e4);
      const socket = await dialTelegramSocket({
        hostname: targetDc.ip,
        port: targetDc.port
      });
      clearTimeout(dialTimeout);
      if (stream.closed || abortController.signal.aborted) {
        try {
          socket.close();
        } catch {
        }
        return;
      }
      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      stream.reader = socket.readable.getReader();
      this.pumpUpstreamToCarrier(stream);
    } catch {
      this.closeStream(streamId, 1);
    }
  }
  async forwardDataUpstream(stream, data) {
    if (stream.closed || !stream.writer || data.byteLength === 0) return;
    try {
      await stream.writer.write(data);
      stream.inboundWindow -= data.byteLength;
      if (stream.inboundWindow <= INITIAL_STREAM_WINDOW / 2) {
        const credit = INITIAL_STREAM_WINDOW - stream.inboundWindow;
        stream.inboundWindow += credit;
        this.sendStreamWindow(stream.streamId, credit);
      }
    } catch {
      this.closeStream(stream.streamId, 2);
    }
  }
  async pumpUpstreamToCarrier(stream) {
    try {
      while (!stream.closed && stream.reader) {
        const { value, done } = await stream.reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          let offset = 0;
          while (offset < value.byteLength && !stream.closed) {
            const chunkSize = Math.min(MAX_DATA_CHUNK, value.byteLength - offset);
            const chunk = value.subarray(offset, offset + chunkSize);
            this.sendFrame(FRAME_TYPES.DATA, stream.streamId, chunk);
            offset += chunkSize;
            stream.outboundWindow -= chunkSize;
            if (stream.outboundWindow <= 0) {
              await this.waitForStreamCredit(stream);
            }
          }
        }
      }
    } catch {
    } finally {
      this.closeStream(stream.streamId, 0);
    }
  }
  async waitForStreamCredit(stream) {
    let waited = 0;
    while (stream.outboundWindow <= 0 && !stream.closed && waited < 100) {
      await new Promise((r) => setTimeout(r, 20));
      waited++;
    }
  }
  sendStreamWindow(streamId, credit) {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, credit, false);
    this.sendFrame(FRAME_TYPES.WINDOW, streamId, payload);
  }
  sendStreamClose(streamId, code = 0) {
    const payload = new Uint8Array([code & 255]);
    this.sendFrame(FRAME_TYPES.CLOSE, streamId, payload);
  }
  sendFrame(type, streamId = 0, payload = new Uint8Array(0)) {
    if (!this.ws) return;
    try {
      const buffer = encodeFrame(type, streamId, payload);
      this.ws.send(buffer);
    } catch {
      this.closeCarrierProtocolViolation("Carrier write failure", 1002);
    }
  }
  closeStream(streamId, code = 0) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.closed = true;
    stream.abortController.abort();
    this.streams.delete(streamId);
    this.tombstones.add(streamId);
    try {
      if (stream.writer) stream.writer.close();
      if (stream.reader) stream.reader.cancel();
      if (stream.socket) stream.socket.close();
    } catch {
    }
    this.sendStreamClose(streamId, code);
  }
  closeAllStreams(code = 0) {
    for (const streamId of Array.from(this.streams.keys())) {
      this.closeStream(streamId, code);
    }
  }
  closeCarrierProtocolViolation(reason, code = 1002) {
    this.closeAllStreams(1);
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
      }
      this.ws = null;
    }
  }
}
export {
  DEFAULT_DC,
  ProxySessionDO,
  TELEGRAM_DCS
};
