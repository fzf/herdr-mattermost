import test from "node:test";
import assert from "node:assert/strict";
import { MattermostClient, MattermostError } from "../src/mattermost.js";

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`;
    const r = routes[key] ?? routes[`${init.method ?? "GET"} ${new URL(url).pathname}`];
    if (!r) return { ok: false, status: 404, text: async () => "no route " + key, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r), arrayBuffer: async () => new TextEncoder().encode("bytes").buffer };
  };
  return { fetchImpl, calls };
}

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.instances.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test("api sends the bearer token and throws MattermostError on failure", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET /api/v4/users/me": { id: "bot1", username: "herdr" } });
  const c = new MattermostClient({ url: "https://mm.test", token: "tok", fetchImpl, WebSocketImpl: FakeWS });
  const me = await c.me();
  assert.equal(me.id, "bot1");
  assert.equal(c.userId, "bot1");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  await assert.rejects(() => c.api("GET", "/nope"), (e) => e instanceof MattermostError && e.status === 404);
});

test("createPost/editPost/reactions hit the documented endpoints with the right bodies", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST /api/v4/posts": { id: "p1" },
    "PUT /api/v4/posts/p1/patch": { id: "p1", message: "edited" },
    "POST /api/v4/reactions": {},
    "DELETE /api/v4/users/bot1/posts/p1/reactions/one": {},
    "GET /api/v4/posts/root/thread": { order: [], posts: {} },
  });
  const c = new MattermostClient({ url: "https://mm.test", token: "t", fetchImpl, WebSocketImpl: FakeWS });
  c.userId = "bot1";
  const post = await c.createPost({ channelId: "ch", rootId: "root", message: "hi" });
  assert.equal(post.id, "p1");
  assert.deepEqual(calls[0].body, { channel_id: "ch", root_id: "root", message: "hi" });
  await c.editPost("p1", "edited");
  assert.deepEqual(calls[1].body, { message: "edited" });
  await c.addReaction("p1", "one");
  assert.deepEqual(calls[2].body, { user_id: "bot1", post_id: "p1", emoji_name: "one" });
  await c.removeReaction("p1", "one");
  assert.equal(calls[3].method, "DELETE");
  await c.threadPosts("root", 5);
  assert.match(calls[4].url, /\/posts\/root\/thread\?/);
});

test("connect authenticates, parses posted/reaction events, and reconnects after close", async () => {
  const { fetchImpl } = fakeFetch({});
  FakeWS.instances = [];
  const c = new MattermostClient({ url: "https://mm.test", token: "t", fetchImpl, WebSocketImpl: FakeWS, log: { error() {}, log() {} }, backoff: { base: 1, max: 2 } });
  const seen = { posted: [], reactions: [], connected: 0 };
  const h = c.connect({
    onPosted: (post, data) => seen.posted.push([post, data.channel_name]),
    onReaction: (r) => seen.reactions.push(r),
    onConnected: () => seen.connected++,
  });
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, "wss://mm.test/api/v4/websocket");
  ws.open();
  assert.deepEqual(ws.sent[0], { seq: 1, action: "authentication_challenge", data: { token: "t" } });
  ws.emit({ event: "hello", data: {}, seq: 0 });
  assert.equal(seen.connected, 1);
  ws.emit({ event: "posted", data: { channel_name: "dev", post: JSON.stringify({ id: "p", message: "m", root_id: "" }) }, seq: 1 });
  assert.deepEqual(seen.posted, [[{ id: "p", message: "m", root_id: "" }, "dev"]]);
  ws.emit({ event: "reaction_added", data: { reaction: JSON.stringify({ post_id: "p", emoji_name: "one", user_id: "u" }) }, seq: 2 });
  assert.equal(seen.reactions[0].emoji_name, "one");
  ws.onclose({ code: 1006 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWS.instances.length, 2, "reconnected");
  h.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWS.instances.length, 2, "no reconnect after close()");
});

test("a silent websocket (no traffic after hello) is closed and reconnected", async () => {
  const { fetchImpl } = fakeFetch({});
  FakeWS.instances = [];
  const c = new MattermostClient({ url: "https://mm.test", token: "t", fetchImpl, WebSocketImpl: FakeWS, log: { error() {}, log() {} }, backoff: { base: 1, max: 2 }, liveness: { pingMs: 5, timeoutMs: 15 } });
  const h = c.connect({});
  const ws = FakeWS.instances[0];
  ws.open();
  ws.emit({ event: "hello", data: {}, seq: 0 });
  await new Promise((r) => setTimeout(r, 12));
  assert.ok(ws.sent.some((m) => m.action === "ping"), "client pings");
  assert.equal(FakeWS.instances.length, 1, "alive while under timeout");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ws.readyState, 3, "silent socket closed");
  assert.ok(FakeWS.instances.length >= 2, "reconnected");
  h.close();
});

test("threadPosts asks for posts from a timestamp downward with the parameters Mattermost implements", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET /api/v4/posts/root/thread": { order: [], posts: {} } });
  const c = new MattermostClient({ url: "https://mm.test", token: "t", fetchImpl, WebSocketImpl: FakeWS });
  await c.threadPosts("root", 5);
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get("fromCreateAt"), "5");
  assert.equal(u.searchParams.get("direction"), "down");
  assert.ok(Number(u.searchParams.get("perPage")) > 0);
  assert.equal(u.searchParams.get("since"), null);
});
