// Paper Trail — options

const $ = (id) => document.getElementById(id);

const DEFAULT_MODELS = { anthropic: "claude-sonnet-4-6", openai: "gpt-4o", custom: "" };

function syncProviderUI() {
  $("customBlock").hidden = $("provider").value !== "custom";
  if (!$("model").value || Object.values(DEFAULT_MODELS).includes($("model").value)) {
    $("model").value = DEFAULT_MODELS[$("provider").value];
  }
}

async function load() {
  const d = await chrome.storage.local.get({
    provider: "anthropic", apiKey: "", model: "", customUrl: "",
    includeScreenshots: false, captureValues: false, maxSteps: 60
  });
  $("provider").value = d.provider;
  $("apiKey").value = d.apiKey;
  $("model").value = d.model || DEFAULT_MODELS[d.provider];
  $("customUrl").value = d.customUrl;
  $("includeScreenshots").checked = d.includeScreenshots;
  $("captureValues").checked = d.captureValues;
  $("maxSteps").value = d.maxSteps;
  syncProviderUI();
}

$("provider").addEventListener("change", syncProviderUI);

$("save").addEventListener("click", async () => {
  const maxSteps = Math.max(5, Math.min(200, parseInt($("maxSteps").value, 10) || 60));
  await chrome.storage.local.set({
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    customUrl: $("customUrl").value.trim(),
    includeScreenshots: $("includeScreenshots").checked,
    captureValues: $("captureValues").checked,
    maxSteps
  });
  $("maxSteps").value = maxSteps;
  $("saved").hidden = false;
  setTimeout(() => $("saved").hidden = true, 1600);
});

load();
