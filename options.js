// Paper Trail — options

const $ = (id) => document.getElementById(id);

const DEFAULT_MODELS = { anthropic: "claude-sonnet-4-6", openai: "gpt-4o", custom: "gemma4:12b-it-qat" };

function syncProviderUI() {
  $("customBlock").hidden = $("provider").value !== "custom";
  if (!$("model").value || Object.values(DEFAULT_MODELS).includes($("model").value)) {
    $("model").value = DEFAULT_MODELS[$("provider").value];
  }
}

async function load() {
  const d = await chrome.storage.local.get({
    provider: "anthropic", apiKey: "", model: "", customUrl: "",
    includeScreenshots: false, captureValues: false, captionOnCapture: false, maxSteps: 150,
    transcribeUrl: "https://api.openai.com/v1/audio/transcriptions",
    transcribeModel: "whisper-1",
    transcribeKey: ""
  });
  $("provider").value = d.provider;
  $("apiKey").value = d.apiKey;
  $("model").value = d.model || DEFAULT_MODELS[d.provider];
  $("customUrl").value = d.customUrl;
  $("includeScreenshots").checked = d.includeScreenshots;
  $("captureValues").checked = d.captureValues;
  $("captionOnCapture").checked = d.captionOnCapture;
  $("maxSteps").value = d.maxSteps;
  $("transcribeUrl").value = d.transcribeUrl;
  $("transcribeModel").value = d.transcribeModel;
  $("transcribeKey").value = d.transcribeKey;
  syncProviderUI();
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
    transcribeKey: $("transcribeKey").value.trim()
  });
  $("maxSteps").value = maxSteps;
  $("saved").hidden = false;
  setTimeout(() => $("saved").hidden = true, 1600);
});

load();
