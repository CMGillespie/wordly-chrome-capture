// background.js — Wordly Capture v0.2
// Service worker: WSS connection, audio routing, language list caching
// connectionCode: 9011

const WORDLY_ENV  = "prod";
const WSS_HOST    = WORDLY_ENV === "prod"
  ? "endpoint.wordly.ai"
  : "dev-endpoint.wordly.ai";
const PRESENT_URL = `wss://${WSS_HOST}/present`;

const SAMPLE_RATE      = 16000;
const CHUNK_MS         = 100;
const CHUNK_FRAMES     = SAMPLE_RATE * CHUNK_MS / 1000;  // 1600
const ECHO_INTERVAL_MS = 30000;
const CONNECTION_CODE  = "9011";
const LANGUAGES_URL    = "https://assets.wordly.ai/language-config/languages.json";
const LANGUAGES_CACHE_KEY = "wc_languages";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = {
  status:           "idle",
  sessionId:        null,
  passcode:         null,
  language:         null,
  speakerName:      null,
  alsEnabled:       true,
  sessionLanguages: null,   // language list from session connect response (if available)
  connectResponse:  null,   // full raw status response — inspect for undocumented fields
  error:            null,
};

let ws        = null;
let echoTimer = null;

function setState(updates) {
  Object.assign(state, updates);
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Language list — fetch from Wordly, cache in chrome.storage.local
// ---------------------------------------------------------------------------

async function getLanguages(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(LANGUAGES_CACHE_KEY);
    if (cached[LANGUAGES_CACHE_KEY]) return cached[LANGUAGES_CACHE_KEY];
  }

  try {
    const resp = await fetch(LANGUAGES_URL);
    const data = await resp.json();
    const langs = data.languages || [];
    const sorted = langs.sort((a, b) =>
      (a.englishName || "").localeCompare(b.englishName || "")
    );
    await chrome.storage.local.set({ [LANGUAGES_CACHE_KEY]: sorted });
    return sorted;
  } catch(e) {
    console.warn("Language fetch failed, using fallback:", e.message);
    return [
      { wordlyCode:"en",    englishName:"English",               nativeName:"English" },
      { wordlyCode:"es-MX", englishName:"Spanish (LatAm)",        nativeName:"Español (Latinoamérica)" },
      { wordlyCode:"es",    englishName:"Spanish (ES)",          nativeName:"Español" },
      { wordlyCode:"fr",    englishName:"French",                nativeName:"Français" },
      { wordlyCode:"fr-CA", englishName:"French (Canadian)",     nativeName:"Français (Canadien)" },
      { wordlyCode:"de",    englishName:"German",                nativeName:"Deutsch" },
      { wordlyCode:"ja",    englishName:"Japanese",              nativeName:"日本語" },
      { wordlyCode:"ko",    englishName:"Korean",                nativeName:"한국어" },
      { wordlyCode:"zh",    englishName:"Chinese (Simplified)",  nativeName:"中文（简体）" },
      { wordlyCode:"pt-BR", englishName:"Portuguese (BR)",       nativeName:"Português (Brasil)" },
      { wordlyCode:"pt",    englishName:"Portuguese (PT)",       nativeName:"Português" },
      { wordlyCode:"ar",    englishName:"Arabic",                nativeName:"العربية" },
      { wordlyCode:"it",    englishName:"Italian",               nativeName:"Italiano" },
      { wordlyCode:"ru",    englishName:"Russian",               nativeName:"Русский" },
      { wordlyCode:"hi",    englishName:"Hindi",                 nativeName:"हिन्दी" },
      { wordlyCode:"bn",    englishName:"Bengali",               nativeName:"বাংলা" },
    ];
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case "GET_STATE":
      sendResponse(state);
      break;

    case "GET_LANGUAGES":
      getLanguages(msg.forceRefresh || false)
        .then(langs => sendResponse({ ok: true, languages: langs }))
        .catch(e  => sendResponse({ ok: false, error: e.message }));
      return true;

    case "START":
      handleStart(msg)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case "STOP":
      handleStop();
      sendResponse({ ok: true });
      break;

    case "MUTE":
      handleMute();
      sendResponse({ ok: true });
      break;

    case "UNMUTE":
      handleUnmute();
      sendResponse({ ok: true });
      break;

    case "SWITCH_LANGUAGE":
      handleSwitchLanguage(msg.language);
      sendResponse({ ok: true });
      break;

    case "SET_ALS":
      handleSetAls(msg.enabled);
      sendResponse({ ok: true });
      break;

    case "END_SESSION":
      handleEndSession()
        .then(() => sendResponse({ ok: true }))
        .catch(e  => sendResponse({ ok: false, error: e.message }));
      return true;

    case "SPLIT_TRANSCRIPT":
      if (ws && ws.readyState === WebSocket.OPEN && state.status === "connected") {
        ws.send(JSON.stringify({ type: "split" }));
      }
      sendResponse({ ok: true });
      break;

    case "AUDIO_CHUNK":
      if (ws && ws.readyState === WebSocket.OPEN && state.status === "connected") {
        const binary = atob(msg.buffer);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        ws.send(bytes.buffer);
      }
      break;

    case "CAPTURE_ERROR":
      setState({ status: "error", error: msg.error });
      break;

    case "SET_SOURCE_VOLUME":
      // Forward to offscreen document
      chrome.runtime.sendMessage({ type: "SET_SOURCE_VOLUME", volume: msg.volume }).catch(() => {});
      sendResponse({ ok: true });
      break;

    case "OPEN_ATTEND":
      openAttendWindow(msg.sessionId);
      sendResponse({ ok: true });
      break;
  }
});

// ---------------------------------------------------------------------------
// Attend window
// ---------------------------------------------------------------------------

function openAttendWindow(sessionId) {
  const url = `https://attend.wordly.ai/join/${sessionId}`;
  chrome.windows.create({
    url,
    type: "popup",
    width: 400,
    height: 700,
    focused: true,
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function handleStart(msg) {
  if (state.status !== "idle" && state.status !== "error") {
    return { ok: false, error: `Already ${state.status}` };
  }

  const { streamId, sessionId, passcode, language, speakerName, alsEnabled } = msg;
  setState({ status: "connecting", sessionId, passcode, language, speakerName,
             alsEnabled: alsEnabled !== false, error: null });

  try {
    ws = new WebSocket(PRESENT_URL);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket timed out.")), 10000);
      ws.onopen  = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("WebSocket connection failed.")); };
    });

    const speakerId = await getStableSpeakerId(sessionId);
    ws.send(JSON.stringify({
      type:             "connect",
      presentationCode: sessionId,
      accessKey:        passcode,
      languageCode:     language,
      speakerId,
      name:             speakerName || "Wordly Capture",
      connectionCode:   CONNECTION_CODE,
    }));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Wordly did not respond.")), 8000);
      ws.onmessage = (event) => {
        try {
          const m = JSON.parse(event.data);
          if (m.type === "status") {
            clearTimeout(t);
            if (m.success) {
              // Extract session language list — field is languageCodes (confirmed)
              const sessionLangs = m.languageCodes || m.languages || m.languageList || m.supportedLanguages || m.allowedLanguages || null;
              setState({ sessionLanguages: sessionLangs, connectResponse: m });
              // Persist session languages so popup can restore them after reopening
              if (sessionLangs) chrome.storage.local.set({ lastSessionLanguages: sessionLangs });
              resolve();
            } else {
              reject(new Error(`Wordly error ${m.code}: ${m.message || "Connection refused"}`));
            }
          }
        } catch(e) {}
      };
    });

    // Send start with ALS setting
    ws.send(JSON.stringify({
      type:       "start",
      languageCode: language,
      sampleRate: SAMPLE_RATE,
      dynamicLanguageSelection: { enabled: alsEnabled !== false },
    }));

    ws.onmessage = handleWSSMessage;
    ws.onclose   = handleWSSClose;
    ws.onerror   = () => setState({ status: "error", error: "WebSocket error" });

    await ensureOffscreen();
    chrome.runtime.sendMessage({
      type:        "OFFSCREEN_START",
      streamId,
      sampleRate:  SAMPLE_RATE,
      chunkFrames: CHUNK_FRAMES,
    }).catch(() => {});

    echoTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "echo" }));
      }
    }, ECHO_INTERVAL_MS);

    setState({ status: "connected" });
    return { ok: true };

  } catch(e) {
    cleanup();
    setState({ status: "error", error: e.message });
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Offscreen
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (!existing) {
    await chrome.offscreen.createDocument({
      url:         "offscreen.html",
      reasons:     ["USER_MEDIA"],
      justification: "Capture tab audio for Wordly",
    });
  }
}

// ---------------------------------------------------------------------------
// WSS handlers
// ---------------------------------------------------------------------------

function handleWSSMessage(event) {
  try {
    const msg = JSON.parse(event.data);
    if (msg.type === "end") handleStop();
    else if (msg.type === "error") setState({ status: "error", error: msg.message });
    else if (msg.type === "status") {
      // Track ALS language switches and capture updated language list
      if (msg.languageCodes) setState({ sessionLanguages: msg.languageCodes });
      if (msg.languageCode && msg.languageCode !== state.language) {
        setState({ language: msg.languageCode });
      }
    }
  } catch(e) {}
}

function handleWSSClose(event) {
  if (state.status !== "stopping" && state.status !== "idle") {
    setState({ status: "error", error: `Connection lost (${event.code})` });
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function handleMute() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
  setState({ status: "muted" });
}

function handleUnmute() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type:       "start",
      languageCode: state.language,
      sampleRate: SAMPLE_RATE,
      dynamicLanguageSelection: { enabled: state.alsEnabled },
    }));
  }
  setState({ status: "connected" });
}

function handleSwitchLanguage(language) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.send(JSON.stringify({
      type:       "start",
      languageCode: language,
      sampleRate: SAMPLE_RATE,
      dynamicLanguageSelection: { enabled: state.alsEnabled },
    }));
  }
  setState({ language });
}

function handleSetAls(enabled) {
  setState({ alsEnabled: enabled });
  // If connected, restart with new ALS setting
  if (ws && ws.readyState === WebSocket.OPEN && state.status === "connected") {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.send(JSON.stringify({
      type:       "start",
      languageCode: state.language,
      sampleRate: SAMPLE_RATE,
      dynamicLanguageSelection: { enabled },
    }));
  }
}

function handleStop() {
  setState({ status: "stopping" });
  chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.send(JSON.stringify({ type: "disconnect", end: false }));
    ws.close();
  }
  cleanup();
  setState({ status: "idle", sessionId: null, passcode: null,
             language: null, speakerName: null, sessionLanguages: null,
             connectResponse: null, error: null });
  chrome.storage.local.remove("lastSessionLanguages");
}

async function handleEndSession() {
  setState({ status: "stopping" });
  chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.send(JSON.stringify({ type: "disconnect", end: true }));
    ws.close();
  }
  cleanup();
  setState({ status: "idle", sessionId: null, passcode: null,
             language: null, speakerName: null, sessionLanguages: null,
             connectResponse: null, error: null });
  chrome.storage.local.remove("lastSessionLanguages");
}

function cleanup() {
  if (echoTimer) { clearInterval(echoTimer); echoTimer = null; }
  ws = null;
  chrome.offscreen.closeDocument().catch(() => {});
}

// ---------------------------------------------------------------------------
// Stable speaker ID
// ---------------------------------------------------------------------------

async function getStableSpeakerId(sessionId) {
  const key    = `speakerId_${sessionId}`;
  const result = await chrome.storage.local.get(key);
  if (result[key]) return result[key];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [key]: id });
  return id;
}
