# Paper Trail — Installation

Three parts, only the first is required: the extension, a model provider, and (optionally) the Windows UIA companion for semantic desktop capture.

---

## 1. Install the extension

Paper Trail loads as an unpacked extension (Chrome or Edge, v116+):

1. Clone this repo or download and extract it
2. Open `chrome://extensions` (Edge: `edge://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository root (the folder containing `manifest.json`)
5. Pin the Paper Trail icon; clicking it opens the side panel

**Note your extension ID** (32 lowercase letters shown on the extension card) — you'll need it if you install the UIA companion. The ID is derived from the folder path, so loading from a different path later produces a different ID.

### Permissions it asks for, and why

| Permission | Used for |
|---|---|
| `<all_urls>` + content script | Capturing clicks/fields on whatever site your procedure touches |
| `tabs`, `activeTab` | Screenshots of the active tab (`captureVisibleTab`), navigation steps |
| `storage`, `unlimitedStorage` | Session ledger and settings, kept on-device |
| `sidePanel`, `commands` | The recorder UI and keyboard shortcuts |
| `nativeMessaging` | Talking to the optional UIA companion |

Nothing is sent anywhere except your configured model endpoint, and only when you click **Generate** (see [DESIGN.md §6](DESIGN.md#6-privacy--security-model)).

---

## 2. Configure a model provider

Open the side panel → **⚙** (or right-click the icon → Options):

| Provider | Model examples | Auth |
|---|---|---|
| **Anthropic** | `claude-sonnet-4-6` (default) | API key from console.anthropic.com |
| **OpenAI** | `gpt-4o` (default) | API key from platform.openai.com |
| **Custom** (OpenAI-compatible) | Your deployment/model name | Bearer key, sent to *your* URL only |

**Custom endpoint examples:**

- Open WebUI: `https://openwebui.corp.example.com/api/chat/completions`
- Azure OpenAI via Open WebUI: same URL — Open WebUI proxies the Azure deployment you configured in it
- vLLM / LiteLLM: `https://host:port/v1/chat/completions`

The API key is stored in `chrome.storage.local` on this machine and attached only to requests to the endpoint you configured.

**Privacy defaults** (both off; read before enabling):

- *Send screenshots to the model* — off means only the semantic action log leaves the machine
- *Record typed values* — off means field entries are logged without content; secret-like fields are always masked regardless

---

## 3. Install the UIA companion (optional, Windows)

Adds semantic capture for native desktop apps. Requires Windows PowerShell 5.1+ (built into Windows 10/11). Per-user install, **no admin rights needed**.

```powershell
cd native-host
.\Install-PaperTrailHost.ps1 -ExtensionId <your-32-char-extension-id>
```

The installer:

1. Writes `com.papertrail.uia.json` (the native messaging host manifest) next to the script
2. Registers it under `HKCU:\Software\Google\Chrome\NativeMessagingHosts` **and** the Edge equivalent
3. Pins your extension ID in `allowed_origins` — no other extension can launch the host

Then in the side panel, click **⚡ UIA companion**. Recording starts and desktop clicks stream in as semantic steps.

### Verifying / troubleshooting

- **"Companion not installed" or instant disconnect** — the extension ID changed (reloaded from a new path?). Rerun the installer with the current ID.
- **Test the registration:** `Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.papertrail.uia"` should point at the JSON manifest, whose `path` must point at `PaperTrailHost.bat`.
- **Execution policy:** the launcher uses `-ExecutionPolicy Bypass` for its own process; no machine policy change is made. If AppLocker/WDAC blocks `powershell.exe -File`, ask your endpoint team to allow the script by hash/path.
- **Elevated windows:** apps running as admin may deny UIA reads to a non-elevated host; those clicks fall back to window title + screenshot.

### Uninstall

```powershell
.\Install-PaperTrailHost.ps1 -Uninstall
```

Removes both registry keys and the manifest. The extension itself is removed from `chrome://extensions`.

---

## 4. Updating

Pull the repo, then `chrome://extensions` → **Reload** on the Paper Trail card. Reloading in place keeps the extension ID (and thus the companion registration) stable; loading from a *new folder* does not.
