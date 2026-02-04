export class WSClient {
  constructor(url, { token, onMessage, onOpen, onClose, log } = {}) {
    this.url = url;
    this.token = token;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.log = log || (() => {});
    this.ws = null;

    this.backoffMs = 500;
    this.maxBackoffMs = 5000;
    this.shouldReconnect = true;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      if (this.token) u.searchParams.set("token", this.token);
      this.ws = new WebSocket(u.toString());
      this.ws.onopen = () => {
        this.backoffMs = 500;
        this.onOpen?.();
        resolve();
      };
      this.ws.onclose = () => {
        this.onClose?.();
        if (this.shouldReconnect) this._reconnect();
      };
      this.ws.onerror = (e) => {
        this.log("ws error", e);
      };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this.onMessage?.(msg);
        } catch {
          this.log("bad msg", ev.data);
        }
      };
    });
  }

  _reconnect() {
    setTimeout(() => {
      if (!this.shouldReconnect) return;
      this.connect().catch(() => {});
      this.backoffMs = Math.min(this.maxBackoffMs, Math.floor(this.backoffMs * 1.5));
    }, this.backoffMs);
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close() {
    this.shouldReconnect = false;
    this.ws?.close();
  }
}
