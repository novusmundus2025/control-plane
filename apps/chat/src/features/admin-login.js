import { createHmac } from "node:crypto";

// The Google callback remains on Chat; only this short-lived, audience-bound
// assertion crosses to the control plane. Never send an operator token to a browser.
export function adminLoginAssertion(identity, nonce, origin, secret, now = Date.now()) {
  if (!identity?.email || identity.provider !== "google") throw new Error("Verified Google sign-in required");
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("Invalid login challenge");
  const audience = new URL(origin);
  if (audience.protocol !== "https:" || audience.origin !== origin || !secret || secret.length < 32) {
    throw new Error("Admin login is not configured");
  }
  const body = Buffer.from(JSON.stringify({
    kind: "mundusx-admin-login-v1", email: identity.email.trim().toLowerCase(),
    nonce, audience: origin, expires: Math.floor(now / 1000) + 60,
  })).toString("hex");
  return body + "." + createHmac("sha256", secret).update(body).digest("hex");
}

export async function handleAdminLogin({ request, response, url, authStore, origin, secret }) {
  if (request.method !== "GET" || url.pathname !== "/api/auth/control-plane") return false;
  const nonce = url.searchParams.get("state") || "";
  if (!/^[a-f0-9]{64}$/.test(nonce)) {
    response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Invalid login challenge. Start again from the control plane.");
    return true;
  }
  const identity = await authStore.googleAdminIdentity(request);
  if (!identity) {
    const returnTo = "/api/auth/control-plane?state=" + nonce;
    response.writeHead(303, { Location: "/api/auth/google/start?return_to=" + encodeURIComponent(returnTo), "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  const assertion = adminLoginAssertion(identity, nonce, origin, secret);
  response.writeHead(303, {
    Location: origin + "/auth/callback?assertion=" + assertion,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  });
  response.end();
  return true;
}
