// After a websocket (re)connect, posts that arrived while disconnected are
// fetched per thread; this picks the ones the bot still has to act on.
export function newUserPosts(payload, { since = 0, botUserId }) {
  const posts = Array.isArray(payload) ? payload : Object.values(payload?.posts ?? {});
  return posts
    .filter((p) => p.create_at > since && p.user_id !== botUserId && (p.type ?? "") === "")
    .sort((a, b) => a.create_at - b.create_at);
}
