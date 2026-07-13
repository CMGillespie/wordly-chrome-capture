// popup.js — Wordly Capture v0.2.1

const PRESET_CODES = ["en", "es-MX", "fr", "fr-CA", "de", "ja"];
const ATTEND_BASE  = "https://attend.wordly.ai/join/";

let currentState = null;
let isMuted      = false;
let languages    = [];
let presetCodes  = PRESET_CODES;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Load config.json presets
  try {
    const resp = await fetch(chrome.runtime.getURL("config.json"));
    const cfg  = await resp.json();
    if (Array.isArray(cfg.presets) && cfg.presets.length) {
      presetCodes = cfg.presets.slice(0, 6);
    }
    // Pre-fill session credentials from config if set — allows IT to pre-configure per room
    if (cfg.sessionId && cfg.sessionId.trim()) {
      document.getElementById("session-id").value = cfg.sessionId.trim().toUpperCase();
    }
    if (cfg.passcode && cfg.passcode.trim()) {
      document.getElementById("passcode").value = cfg.passcode.trim();
    }
  } catch(e) {}

  // Restore saved values
  const saved = await chrome.storage.local.get([
    "lastSessionId", "lastLanguage", "lastSpeakerName", "lastAls", "lastVolume"
  ]);
  if (saved.lastSessionId)   document.getElementById("session-id").value   = saved.lastSessionId;
  // Note: passcode is intentionally NOT restored — credentials are never persisted
  if (saved.lastSpeakerName) document.getElementById("speaker-name").value = saved.lastSpeakerName;
  if (saved.lastAls === false) {
    document.getElementById("als-toggle").checked      = false;
    document.getElementById("als-toggle-live").checked = false;
  }

  // Restore volume
  const vol = saved.lastVolume !== undefined ? saved.lastVolume : 100;
  document.getElementById("vol-slider").value = vol;
  updateVolUI(vol);

  // Auto-format session ID
  document.getElementById("session-id").addEventListener("input", function() {
    let v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4, 8);
    this.value = v;
  });

  // Load languages
  await loadLanguages(saved.lastLanguage);

  // Wire buttons
  document.getElementById("btn-start").addEventListener("click", startCapture);
  document.getElementById("btn-stop").addEventListener("click", stopCapture);
  document.getElementById("btn-mute").addEventListener("click", toggleMute);
  document.getElementById("btn-end").addEventListener("click", confirmEndSession);
  document.getElementById("btn-cancel").addEventListener("click", closeConfirm);
  document.getElementById("btn-confirm-end").addEventListener("click", doEndSession);
  document.getElementById("attend-bar").addEventListener("click", openAttend);
  document.getElementById("btn-split").addEventListener("click", confirmSplit);
  document.getElementById("btn-split-cancel").addEventListener("click", closeSplitConfirm);
  document.getElementById("btn-split-confirm").addEventListener("click", doSplit);

  // ALS toggles
  document.getElementById("als-toggle").addEventListener("change", function() {
    chrome.storage.local.set({ lastAls: this.checked });
  });
  document.getElementById("als-toggle-live").addEventListener("change", function() {
    chrome.storage.local.set({ lastAls: this.checked });
    chrome.runtime.sendMessage({ type: "SET_ALS", enabled: this.checked });
  });

  // Spoken language dropdown
  document.getElementById("spoken-lang-select").addEventListener("change", function() {
    if (this.value) switchLang(this.value);
  });

  // Volume slider
  document.getElementById("vol-slider").addEventListener("input", function() {
    const vol = parseInt(this.value);
    updateVolUI(vol);
    chrome.storage.local.set({ lastVolume: vol });
    chrome.runtime.sendMessage({ type: "SET_SOURCE_VOLUME", volume: vol / 100 }).catch(() => {});
  });

  // Get current state
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    applyState(state);
  } catch(e) {
    applyState({ status: "idle" });
  }
});

// ---------------------------------------------------------------------------
// Volume UI
// ---------------------------------------------------------------------------

function updateVolUI(vol) {
  document.getElementById("vol-pct").textContent  = `${vol}%`;
  const icon = document.getElementById("vol-icon");
  if (!icon) return;
  if (vol === 0)       icon.textContent = "🔇";
  else if (vol < 40)  icon.textContent = "🔈";
  else if (vol < 70)  icon.textContent = "🔉";
  else                icon.textContent = "🔊";
}

// ---------------------------------------------------------------------------
// Attend window
// ---------------------------------------------------------------------------

function openAttend() {
  if (!currentState || !currentState.sessionId) return;
  chrome.runtime.sendMessage({ type: "OPEN_ATTEND", sessionId: currentState.sessionId });
}

// ---------------------------------------------------------------------------
// Language loading
// ---------------------------------------------------------------------------

async function loadLanguages(selectedCode) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_LANGUAGES" });
    if (resp && resp.ok) languages = resp.languages || [];
  } catch(e) {}
  if (!languages.length) return;

  const code = selectedCode || "en";

  const sel = document.getElementById("language");
  sel.innerHTML = "";
  for (const l of languages) {
    const opt = document.createElement("option");
    opt.value = l.wordlyCode;
    opt.textContent = langLabel(l);
    if (l.wordlyCode === code) opt.selected = true;
    sel.appendChild(opt);
  }

  const liveSel = document.getElementById("spoken-lang-select");
  liveSel.innerHTML = "";
  for (const l of languages) {
    const opt = document.createElement("option");
    opt.value = l.wordlyCode;
    opt.textContent = langLabel(l);
    if (l.wordlyCode === code) opt.selected = true;
    liveSel.appendChild(opt);
  }

  buildPresetButtons(code);
}

function langLabel(l) {
  const e = l.englishName || "";
  const n = l.nativeName  || "";
  if (!n || e === n) return e;
  return `${e} (${n})`;
}

function buildPresetButtons(activeLang, sessionLanguages) {
  const grid = document.getElementById("lang-grid");
  grid.innerHTML = "";

  // Use session-configured languages if available, otherwise fall back to config.json presets
  let codes;
  if (sessionLanguages && sessionLanguages.length) {
    // sessionLanguages may be an array of strings or objects — handle both
    codes = sessionLanguages.map(l => typeof l === "string" ? l : (l.wordlyCode || l.code || l)).filter(Boolean);
  } else {
    codes = presetCodes;
  }

  for (const code of codes) {
    const l = languages.find(x => x.wordlyCode === code);
    if (!l) continue;
    const btn = document.createElement("button");
    btn.className    = "btn-lang" + (code === activeLang ? " on" : "");
    btn.dataset.code = code;
    const short = l.nativeName && l.nativeName !== l.englishName
      ? l.nativeName.split(/[\s(]/)[0]
      : code.toUpperCase();
    btn.textContent = short;
    btn.title = langLabel(l);
    btn.addEventListener("click", () => switchLang(code));
    grid.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// State updates
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") applyState(msg.state);
});

function applyState(state) {
  if (!state) return;
  currentState = state;

  const dot       = document.getElementById("status-dot");
  const hdrText   = document.getElementById("hdr-live-text");
  const statusBar = document.getElementById("status-bar");
  const configSec = document.getElementById("config-section");
  const liveSec   = document.getElementById("live-section");
  const sessInfo  = document.getElementById("session-info");
  const btnMute   = document.getElementById("btn-mute");
  const btnStart  = document.getElementById("btn-start");
  const alsLive   = document.getElementById("als-toggle-live");
  const langCur   = document.getElementById("lang-current");
  const spokenSel = document.getElementById("spoken-lang-select");
  const attendBar = document.getElementById("attend-bar");
  const attendUrl = document.getElementById("attend-url");

  dot.className = `status-dot ${state.status}`;

  const hdrMsgs = { idle:"", connecting:"Connecting...", connected:"● Live", muted:"⏸ Muted", stopping:"Stopping...", error:"Error" };
  hdrText.textContent = hdrMsgs[state.status] || "";
  hdrText.className   = `hdr-live-text ${state.status}`;
  if (state.status && state.status !== "idle") hdrText.classList.add("show");

  if (state.status === "error" && state.error) {
    statusBar.textContent = state.error;
    statusBar.className   = "status-bar show error";
  } else {
    statusBar.className = "status-bar";
  }

  const isLive = ["connected", "muted"].includes(state.status);
  const isIdle = ["idle", "error"].includes(state.status);

  configSec.classList.toggle("hidden", !isIdle);
  liveSec.classList.toggle("show", isLive);

  if (btnStart) { btnStart.disabled = false; btnStart.textContent = "▶ \u00a0Start Capture"; }

  if (isLive && state.sessionId) {
    const l = languages.find(x => x.wordlyCode === state.language);
    const langName = l ? l.englishName : (state.language || "").toUpperCase();
    sessInfo.innerHTML = `<b>SESSION</b> ${state.sessionId} &nbsp;·&nbsp; <b>LANG</b> ${langName} &nbsp;·&nbsp; <b>NAME</b> ${state.speakerName || "—"}`;
    sessInfo.classList.add("show");

    // Attend bar
    if (attendUrl) attendUrl.textContent = `${ATTEND_BASE}${state.sessionId}`;
  } else {
    sessInfo.classList.remove("show");
  }

  isMuted = state.status === "muted";
  if (btnMute) {
    btnMute.textContent = isMuted ? "🔊" : "🔇";
    btnMute.classList.toggle("on", isMuted);
    btnMute.title = isMuted ? "Unmute Capture" : "Mute Capture";
  }

  if (alsLive && state.alsEnabled !== undefined) alsLive.checked = state.alsEnabled;

  if (state.language) {
    document.querySelectorAll(".btn-lang").forEach(btn => {
      btn.classList.toggle("on", btn.dataset.code === state.language);
    });
    if (spokenSel) spokenSel.value = state.language;
    const l = languages.find(x => x.wordlyCode === state.language);
    if (langCur) {
      langCur.textContent = l ? l.englishName : state.language.toUpperCase();
      if (state.alsEnabled) langCur.textContent += " · ALS";
    }
    // Rebuild preset buttons using session languages if available
    buildPresetButtons(state.language, state.sessionLanguages || null);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function startCapture() {
  const sessionId   = document.getElementById("session-id").value.trim().toUpperCase();
  const passcode    = document.getElementById("passcode").value.trim();
  const language    = document.getElementById("language").value;
  const speakerName = document.getElementById("speaker-name").value.trim() || "Tab Capture";
  const alsEnabled  = document.getElementById("als-toggle").checked;

  if (!sessionId || sessionId.length < 9) { showError("Enter a valid Session ID (ABCD-1234)"); return; }

  const btn = document.getElementById("btn-start");
  btn.disabled = true; btn.textContent = "Connecting...";

  let streamId;
  try {
    streamId = await getTabCaptureStreamId();
  } catch(e) {
    btn.disabled = false; btn.textContent = "▶ \u00a0Start Capture";
    showError(e.message || "Tab capture denied.");
    return;
  }

  await chrome.storage.local.set({ lastSessionId: sessionId, lastLanguage: language, lastSpeakerName: speakerName, lastAls: alsEnabled });
  // Note: passcode intentionally excluded — credentials are never persisted
  buildPresetButtons(language, null); // will be rebuilt with session languages once connected

  // Apply saved volume to offscreen immediately
  const volSaved = await chrome.storage.local.get("lastVolume");
  const vol = volSaved.lastVolume !== undefined ? volSaved.lastVolume : 100;

  try {
    const result = await chrome.runtime.sendMessage({ type: "START", streamId, sessionId, passcode, language, speakerName, alsEnabled });
    if (result && !result.ok) {
      btn.disabled = false; btn.textContent = "▶ \u00a0Start Capture";
      showError(result.error || "Failed to start.");
    } else {
      // Set initial volume on offscreen
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "SET_SOURCE_VOLUME", volume: vol / 100 }).catch(() => {});
      }, 500);
    }
  } catch(e) {
    btn.disabled = false; btn.textContent = "▶ \u00a0Start Capture";
    showError(e.message || "Could not reach background.");
  }
}

function getTabCaptureStreamId() {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({}, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!id) reject(new Error("No stream ID returned."));
      else resolve(id);
    });
  });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function stopCapture() {
  try { await chrome.runtime.sendMessage({ type: "STOP" }); } catch(e) {}
  const btn = document.getElementById("btn-start");
  btn.disabled = false; btn.textContent = "▶ \u00a0Start Capture";
}

async function toggleMute() {
  try { await chrome.runtime.sendMessage({ type: isMuted ? "UNMUTE" : "MUTE" }); } catch(e) {}
}

async function switchLang(code) {
  try { await chrome.runtime.sendMessage({ type: "SWITCH_LANGUAGE", language: code }); } catch(e) {}
  document.querySelectorAll(".btn-lang").forEach(btn => btn.classList.toggle("on", btn.dataset.code === code));
  const spokenSel = document.getElementById("spoken-lang-select");
  if (spokenSel) spokenSel.value = code;
  const l = languages.find(x => x.wordlyCode === code);
  const langCur = document.getElementById("lang-current");
  if (langCur && l) langCur.textContent = l.englishName;
}

function confirmEndSession() { document.getElementById("confirm-overlay").classList.add("show"); }
function closeConfirm()       { document.getElementById("confirm-overlay").classList.remove("show"); }

function confirmSplit()      { document.getElementById("split-overlay").classList.add("show"); }
function closeSplitConfirm() { document.getElementById("split-overlay").classList.remove("show"); }

async function doSplit() {
  closeSplitConfirm();
  try { await chrome.runtime.sendMessage({ type: "SPLIT_TRANSCRIPT" }); } catch(e) {}
}

async function doEndSession() {
  closeConfirm();
  try { await chrome.runtime.sendMessage({ type: "END_SESSION" }); } catch(e) {}
  const btn = document.getElementById("btn-start");
  btn.disabled = false; btn.textContent = "▶ \u00a0Start Capture";
}

function showError(msg) {
  document.getElementById("status-bar").textContent = msg;
  document.getElementById("status-bar").className   = "status-bar show error";
  document.getElementById("status-dot").className   = "status-dot error";
  document.getElementById("hdr-live-text").textContent = "Error";
  document.getElementById("hdr-live-text").className   = "hdr-live-text show error";
}
