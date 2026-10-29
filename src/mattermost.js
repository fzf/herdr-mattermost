import { writeFile } from "node:fs/promises";

export class MattermostError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class MattermostClient {
  constructor({ url, token, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = console, backoff = { base: 1000, max: 60000 }, liveness = { pingMs: 30000, timeoutMs: 90000 } }) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.log = log;
    this.backoff = backoff;
    this.liveness = liveness;
    this.userId = null;
  }

  async api(method, path, body) {
    const res = await this.fetch(`${this.url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MattermostError(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`, res.status, text);
    }
    return res.json();
  }

  async me() {
    const u = await this.api("GET", "/users/me");
    this.userId = u.id;
    return u;
  }
  teamByName(name) { return this.api("GET", `/teams/name/${encodeURIComponent(name)}`); }
  userByUsername(name) { return this.api("GET", `/users/username/${encodeURIComponent(name)}`); }
  user(id) { return this.api("GET", `/users/${id}`); }
  channel(id) { return this.api("GET", `/channels/${id}`); }
  channelByName(teamId, name) { return this.api("GET", `/teams/${teamId}/channels/name/${encodeURIComponent(name)}`); }
  createPost({ channelId, rootId = "", message }) {
    return this.api("POST", "/posts", { channel_id: channelId, root_id: rootId, message });
  }
  editPost(id, message) { return this.api("PUT", `/posts/${id}/patch`, { message }); }
  // The thread endpoint has no `since`; fromCreateAt + direction=down returns
  // the root plus posts at or after that time. Callers still filter by create_at.
  threadPosts(rootId, since = 0) {
    return this.api("GET", `/posts/${rootId}/thread?fromCreateAt=${since}&direction=down&perPage=200`);
  }
  addReaction(postId, emoji) {
    return this.api("POST", "/reactions", { user_id: this.userId, post_id: postId, emoji_name: emoji });
  }
  removeReaction(postId, emoji) {
    return this.api("DELETE", `/users/${this.userId}/posts/${postId}/reactions/${emoji}`);
  }
  fileInfo(fileId) { return this.api("GET", `/files/${fileId}/info`); }
  async downloadFile(fileId, destPath) {
    const res = await this.fetch(`${this.url}/api/v4/files/${fileId}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new MattermostError(`GET /files/${fileId} → ${res.status}`, res.status, "");
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return destPath;
  }

  // Websocket with authentication_challenge, event parsing and reconnect.
  connect({ onPosted, onReaction, onConnected }) {
    let closed = false;
    let delay = this.backoff.base;
    let ws = null;
    const wsUrl = this.url.replace(/^http/, "ws") + "/api/v4/websocket";

    let pinger = null;
    const stopPinger = () => { if (pinger) clearInterval(pinger); pinger = null; };
    const scheduleReconnect = () => {
      stopPinger();
      if (closed) return;
      this.log.error(`herdr-mattermost: websocket closed; reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, this.backoff.max);
    };

    const open = () => {
      if (closed) return;
      ws = new this.WebSocket(wsUrl);
      const sock = ws;
      let authed = false;
      let seq = 1;
      let lastMessageAt = Date.now();
      sock.onopen = () => {
        sock.send(JSON.stringify({ seq: seq++, action: "authentication_challenge", data: { token: this.token } }));
      };
      sock.onmessage = (m) => {
        lastMessageAt = Date.now();
        let e;
        try { e = JSON.parse(m.data); } catch { return; }
        if (e.event === "hello") {
          authed = true;
          delay = this.backoff.base;
          // A half-open socket never fires onclose: ping, and give up on silence.
          stopPinger();
          pinger = setInterval(() => {
            if (Date.now() - lastMessageAt > this.liveness.timeoutMs) {
              this.log.error("herdr-mattermost: websocket silent; reconnecting");
              sock.onclose = null;
              try { sock.close(); } catch {}
              scheduleReconnect();
              return;
            }
            try { sock.send(JSON.stringify({ seq: seq++, action: "ping" })); } catch {}
          }, this.liveness.pingMs);
          onConnected?.();
          return;
        }
        if (!authed) return;
        try {
          if (e.event === "posted") onPosted?.(JSON.parse(e.data.post), e.data);
          else if (e.event === "reaction_added") onReaction?.(JSON.parse(e.data.reaction));
        } catch (err) {
          this.log.error(`herdr-mattermost: event handler failed: ${err.message}`);
        }
      };
      sock.onerror = (err) => this.log.error(`herdr-mattermost: websocket error: ${err?.message ?? err}`);
      sock.onclose = () => scheduleReconnect();
    };
    open();
    return {
      close() {
        closed = true;
        stopPinger();
        try { ws?.close(); } catch {}
      },
    };
  }
}
