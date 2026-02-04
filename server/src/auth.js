export function verifyToken(token) {
  if (!token) return { ok: false, reason: "missing token" };
  if (token.length < 10) return { ok: false, reason: "bad token" };
  return { ok: true, userId: "demo-user" };
}
