# Wordly Capture — Chrome Extension

Stream browser tab audio directly to a Wordly translation session. No VB-Cable, no Python, no server required.

## What it does

- Captures audio from the active Chrome/Edge browser tab
- Streams 16kHz/16-bit mono PCM to Wordly via WSS `/present` endpoint
- Supports mute/unmute, language switching, and Auto Language Selection toggle
- Works with any tab-based platform: Zoom web, Google Meet, Adobe Connect, ON24, Cvent, etc.

## Installation (Developer Mode)

1. Clone or unzip this folder to a permanent location on your computer
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `wordly-chrome-capture` folder
6. Pin the extension via the 🧩 puzzle icon in the Chrome toolbar

## Usage

1. Navigate to the tab you want to capture
2. Click the **Wordly Capture** icon in your toolbar
3. Enter your Session ID and Passcode
4. Select the speaker language
5. Toggle **Auto Language Detection** on or off as needed
6. Click **Start Capture**

## Customizing Language Preset Buttons

The quick-switch language buttons shown during a live session are configured in **`config.json`** in this folder.

Edit the `presets` array with up to 6 Wordly language codes:

```json
{
  "presets": ["en", "es", "fr", "de", "ja", "ko"]
}
```

**To find language codes:** visit https://help.wordly.ai/about-languages-supported

Common codes:

| Code    | Language                  |
|---------|---------------------------|
| `en`    | English (US)              |
| `es`    | Spanish (Latin America)   |
| `fr`    | French                    |
| `fr-CA` | French (Canadian)         |
| `de`    | German                    |
| `ja`    | Japanese                  |
| `ko`    | Korean                    |
| `zh`    | Chinese (Simplified)      |
| `pt`    | Portuguese (Brazil)       |
| `ar`    | Arabic                    |
| `it`    | Italian                   |
| `ru`    | Russian                   |
| `hi`    | Hindi                     |
| `bn`    | Bengali                   |

After editing `config.json`, go to `chrome://extensions` and click the **refresh** icon on Wordly Capture to reload the configuration.

## Auto Language Detection (ALS)

When enabled, Wordly automatically detects if the speaker switches languages and adjusts accordingly. When disabled, the session is locked to the selected spoken language — useful when multiple similar languages are in use and auto-detection causes unwanted switching.

Can be toggled live without disconnecting.

## Notes

- Chrome and Edge only — Firefox does not support the tab audio capture API
- The extension must remain installed (not removed) to function
- Currently targets the **DEV** Wordly endpoint. Change `WORDLY_ENV` in `background.js` to `"prod"` for production use
- connectionCode: `9011`

## Architecture

| File | Purpose |
|------|---------|
| `manifest.json`  | Extension config (Manifest V3) |
| `config.json`    | Language preset button configuration |
| `background.js`  | Service worker — WebSocket, audio routing |
| `offscreen.js`   | Offscreen document — getUserMedia, PCM encoding |
| `offscreen.html` | Required HTML wrapper for offscreen document |
| `popup.html`     | Extension popup UI |
| `popup.js`       | Popup logic |
