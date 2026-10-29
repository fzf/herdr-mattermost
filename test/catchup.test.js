import test from "node:test";
import assert from "node:assert/strict";
import { newUserPosts } from "../src/catchup.js";

const p = (id, create_at, user_id = "u", type = "") => ({ id, create_at, user_id, type, message: id });

test("excludes posts at or before since, bot posts, and system posts; sorts ascending", () => {
  const posts = [p("c", 30), p("a", 10), p("bot", 40, "bot"), p("sys", 50, "u", "system_join_channel"), p("b", 20)];
  const out = newUserPosts(posts, { since: 10, botUserId: "bot" });
  assert.deepEqual(out.map((x) => x.id), ["b", "c"]);
});

test("ignores the bot's own user id even with since = 0", () => {
  assert.deepEqual(newUserPosts([p("x", 5, "bot")], { since: 0, botUserId: "bot" }), []);
});

test("accepts the {order, posts} thread payload shape", () => {
  const payload = { order: ["b", "a"], posts: { a: p("a", 1), b: p("b", 2) } };
  assert.deepEqual(newUserPosts(payload, { since: 0, botUserId: "bot" }).map((x) => x.id), ["a", "b"]);
});
