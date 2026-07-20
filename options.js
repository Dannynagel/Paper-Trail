// Paper Trail — options

const $ = (id) => document.getElementById(id);

// Defaults live once in PTCommon.SETTINGS_DEFAULTS / defaultModel — the same
// table the service worker and side panel read.
const PROVIDERS = ["anthropic", "claude", "openai", "custom"];

function syncProviderUI() {
  const p = $("provider").value;
  $("customBlock").hidden = p !== "custom";
  $("claudeBlock").hidden = p !== "claude";
  $("apiKeyBlock").hidden = p === "claude"; // the Claude account needs no API key
  if (!$("model").value || PROVIDERS.some(x => PTCommon.defaultModel(x) === $("model").value)) {
    $("model").value = PTCommon.defaultModel(p);
  }
}

// ── Sign in with Claude (OAuth + PKCE; tokens stay in chrome.storage.local) ─
async function refreshClaudeStatus() {
  const { claudeAuth } = await chrome.storage.local.get({ claudeAuth: null });
  const connected = !!(claudeAuth && (claudeAuth.accessToken || claudeAuth.refreshToken));
  $("claudeStatus").textContent = connected
    ? `Connected ✓${claudeAuth.expiresAt ? " — token refreshes automatically" : ""}`
    : "Not connected.";
  $("claudeDisconnect").hidden = !connected;
}

function claudeMsg(text, isErr) {
  const el = $("claudeMsg");
  el.textContent = text;
  el.className = isErr ? "warn" : "hint";
}

$("claudeSignIn").addEventListener("click", async () => {
  const d = await chrome.storage.local.get(PTCommon.SETTINGS_DEFAULTS);
  const clientId = $("claudeClientId").value.trim() || d.claudeClientId;
  if (!clientId) { claudeMsg("Enter your OAuth client ID first (Sign in with Claude program).", true); return; }
  const verifier = PTCommon.randomVerifier();
  const state = PTCommon.randomVerifier();
  await chrome.storage.local.set({ claudeOauthPending: { verifier, state }, claudeClientId: clientId });
  const u = new URL(d.claudeAuthUrl);
  u.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: d.claudeRedirectUri,
    scope: d.claudeScopes,
    code_challenge: await PTCommon.pkceChallenge(verifier),
    code_challenge_method: "S256",
    state
  }).toString();
  chrome.tabs.create({ url: u.href });
  claudeMsg("Approve in the opened tab, then paste the code it shows here and press Connect.");
});

$("claudeConnect").addEventListener("click", async () => {
  const raw = $("claudeCode").value.trim();
  if (!raw) { claudeMsg("Paste the authorization code first.", true); return; }
  const d = await chrome.storage.local.get(PTCommon.SETTINGS_DEFAULTS);
  const { claudeOauthPending } = await chrome.storage.local.get({ claudeOauthPending: null });
  if (!claudeOauthPending) { claudeMsg("Press “Sign in with Claude” first.", true); return; }
  const [code, state] = raw.split("#");
  try {
    const resp = await fetch(d.claudeTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        state: state || claudeOauthPending.state,
        client_id: $("claudeClientId").value.trim() || d.claudeClientId,
        redirect_uri: d.claudeRedirectUri,
        code_verifier: claudeOauthPending.verifier
      })
    });
    if (!resp.ok) throw new Error(`token endpoint ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const t = await resp.json();
    await chrome.storage.local.set({
      claudeAuth: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token || "",
        expiresAt: Date.now() + (t.expires_in || 3600) * 1000
      }
    });
    await chrome.storage.local.remove("claudeOauthPending");
    $("claudeCode").value = "";
    claudeMsg("Connected ✓ — generation will use your Claude account.");
  } catch (e) {
    claudeMsg("Sign-in failed: " + String(e.message || e), true);
  }
  refreshClaudeStatus();
});

$("claudeDisconnect").addEventListener("click", async () => {
  await chrome.storage.local.remove("claudeOauthPending");
  await chrome.storage.local.set({ claudeAuth: null });
  claudeMsg("Disconnected — tokens removed from this machine.");
  refreshClaudeStatus();
});

async function load() {
  const d = await chrome.storage.local.get(PTCommon.SETTINGS_DEFAULTS);
  $("provider").value = d.provider;
  $("apiKey").value = d.apiKey;
  $("model").value = d.model || PTCommon.defaultModel(d.provider);
  $("customUrl").value = d.customUrl;
  $("includeScreenshots").checked = d.includeScreenshots;
  $("captureValues").checked = d.captureValues;
  $("captionOnCapture").checked = d.captionOnCapture;
  $("maxSteps").value = d.maxSteps;
  $("transcribeUrl").value = d.transcribeUrl;
  $("transcribeModel").value = d.transcribeModel;
  $("transcribeKey").value = d.transcribeKey;
  $("claudeClientId").value = d.claudeClientId;
  syncProviderUI();
  refreshClaudeStatus();
}

$("provider").addEventListener("change", syncProviderUI);

$("save").addEventListener("click", async () => {
  const maxSteps = Math.max(5, Math.min(500, parseInt($("maxSteps").value, 10) || 150));
  await chrome.storage.local.set({
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    customUrl: $("customUrl").value.trim(),
    includeScreenshots: $("includeScreenshots").checked,
    captureValues: $("captureValues").checked,
    captionOnCapture: $("captionOnCapture").checked,
    maxSteps,
    transcribeUrl: $("transcribeUrl").value.trim(),
    transcribeModel: $("transcribeModel").value.trim() || "whisper-1",
    transcribeKey: $("transcribeKey").value.trim(),
    claudeClientId: $("claudeClientId").value.trim()
  });
  $("maxSteps").value = maxSteps;
  $("saved").hidden = false;
  setTimeout(() => $("saved").hidden = true, 1600);
});

load();
