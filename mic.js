// Paper Trail — one-shot microphone permission grant for the extension origin.
// The side panel cannot always render Chrome's mic prompt; this page can.
navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
  stream.getTracks().forEach(t => t.stop()); // permission is what we came for
  document.getElementById("state").textContent =
    "Microphone allowed ✓ — close this tab and press 🎤 Narrate again.";
}).catch((e) => {
  document.getElementById("state").textContent =
    `Permission not granted (${e.name}). Allow the microphone for this extension ` +
    `in Chrome's site settings (padlock icon), then close this tab and retry.`;
});
