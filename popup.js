// popup.js — Wordly Capture v0.3h
// v0.3h: ALS defaults ON for a fresh session instead of inheriting a remembered
//        "off"; list-based lock still forces it off when a language can't do ALS
// v0.3g: FIX — session languages now REPLACE the config.json preset placeholder
//        instead of merging with it (presets were leaking in, e.g. fr-CA/es-MX
//        showing on an 8-language session). Quick Switch order is derived fresh
//        from manualAdds + session languages − removed; nothing stale persists.
// v0.3f: Quick Switch hard cap of 10 buttons. Session connect languages (portal
//        max 8) populate on start; switching to outside languages adds them at A1
//        up to the ceiling of 10, then the oldest non-active button drops off.
// v0.3e: manually-added Quick Switch language now lands at A1 (front) and holds
// v0.3d: fix Quick Switch grid overflow (minmax(0,1fr) + smaller font); ALS star
//        moved inline before the name instead of a corner badge
// v0.3c: blue ★ after name in dropdowns; Quick Switch buttons show English names
//        (truncated); stable button order (added langs hold position); banner shows
//        lang CODE only (no width jitter); ALS lock is list-based — any non-ALS
//        language present in Quick Switch disables ALS until it is removed

const PRESET_CODES     = ["en", "es-MX", "fr", "fr-CA", "de", "ja"];
const ATTEND_BASE      = "https://attend.wordly.ai/join/";
const ALS_STAR         = "★";
const QUICK_SWITCH_MAX = 10;   // hard ceiling on total Quick Switch buttons

let currentState = null;
let isMuted      = false;
let languages    = [];
let presetCodes  = PRESET_CODES;

// Quick Switch list state. The displayed button order is DERIVED fresh on every
// rebuild from three persisted inputs, so a stale list can never accumulate and
// presets can never leak into a live session:
//   manualAdds        — languages you switched to that aren't in the session (front/A1)
//   removedBaseCodes  — session languages you X'd off (offered in the restore row)
//   the session's own language list (from the connect message) is authoritative
let quickSwitchOrder      = [];   // derived display order (NOT persisted)
let manualAdds            = [];   // persisted per-session, cleared on start/stop/end
let removedBaseCodes      = [];   // persisted per-session, cleared on start/stop/end
let lastKnownSessionLangs = null;
let lastActiveLang        = null;

// ALS lock state — recalculated from list composition, never persisted
let alsLocked = false;

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
    "lastSessionId", "lastLanguage", "lastSpeakerName", "lastAls", "lastVolume",
    "lastSessionLanguages", "manualAdds", "removedBaseCodes"
  ]);
  if (saved.lastSessionId)   document.getElementById("session-id").value   = saved.lastSessionId;
  // Note: passcode is intentionally NOT restored — credentials are never persisted
  if (saved.lastSpeakerName) document.getElementById("speaker-name").value = saved.lastSpeakerName;
  // ALS defaults ON for a fresh session (matches native + the session's own
  // connect state). We intentionally do NOT carry over a remembered "off" — the
  // list-based lock still forces it off (with a warning) if a session language
  // can't do ALS. The HTML default is checked/on.
  if (Array.isArray(saved.manualAdds))       manualAdds       = saved.manualAdds;
  if (Array.isArray(saved.removedBaseCodes)) removedBaseCodes = saved.removedBaseCodes;

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

  // ALS availability check for the initially selected speaker language
  refreshAlsAvailability();

  // Re-check ALS availability when the config-view language changes
  document.getElementById("language").addEventListener("change", function() {
    refreshAlsAvailability();
  });

  // Wire buttons
  document.getElementById("btn-start").addEventListener("click", startCapture);
  document.getElementById("btn-stop").addEventListener("click", stopCapture);
  document.getElementById("hdr-btn-mute").addEventListener("click", toggleMute);
  document.getElementById("btn-end").addEventListener("click", confirmEndSession);
  document.getElementById("btn-cancel").addEventListener("click", closeConfirm);
  document.getElementById("btn-confirm-end").addEventListener("click", doEndSession);
  document.getElementById("attend-bar").addEventListener("click", openAttend);
  document.getElementById("hdr-btn-split").addEventListener("click", confirmSplit);
  document.getElementById("btn-split-cancel").addEventListener("click", closeSplitConfirm);
  document.getElementById("btn-split-confirm").addEventListener("click", doSplit);

  // ALS toggles — change events only fire from user interaction (toggle is
  // disabled while ALS-locked), so these always reflect a real user preference
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
    if (!state.sessionLanguages && saved.lastSessionLanguages) {
      state.sessionLanguages = saved.lastSessionLanguages;
    }
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

  fillLangDropdown(document.getElementById("language"), code);
  fillLangDropdown(document.getElementById("spoken-lang-select"), code);

  buildPresetButtons(code);
}

// Populate a language <select>. ALS-capable languages get a ★ marker AFTER the
// name so the user can see which support auto language switching.
// NOTE: on macOS, Chrome renders the native OS dropdown, which ignores per-option
// CSS color — so the ★ shows in the menu's default text color, not Wordly blue.
// True-blue-after-name would require replacing this with a custom dropdown.
function fillLangDropdown(sel, code) {
  if (!sel) return;
  sel.innerHTML = "";
  for (const l of languages) {
    const opt = document.createElement("option");
    opt.value = l.wordlyCode;
    opt.textContent = langLabel(l) + (isAlsCapable(l.wordlyCode) ? `  ${ALS_STAR}` : "");
    if (l.wordlyCode === code) opt.selected = true;
    sel.appendChild(opt);
  }
}

function langLabel(l) {
  const e = l.englishName || "";
  const n = l.nativeName  || "";
  if (!n || e === n) return e;
  return `${e} (${n})`;
}

// Return the base language codes for the current session (session-configured
// list if known, otherwise the config.json presets).
function baseCodesForSession(sessionLanguages) {
  const source = (sessionLanguages && sessionLanguages.length) ? sessionLanguages : lastKnownSessionLangs;
  if (source && source.length) {
    // sessionLanguages may be an array of strings or objects — handle both
    return source.map(l => typeof l === "string" ? l : (l.wordlyCode || l.code || l)).filter(Boolean);
  }
  return presetCodes.slice();
}

// The session's own language list (from the connect message), normalized, or
// null if we don't have it yet (pre-connect). Presets are only a placeholder.
function realSessionBase() {
  if (!lastKnownSessionLangs || !lastKnownSessionLangs.length) return null;
  return baseCodesForSession(lastKnownSessionLangs);
}

// Rebuild the displayed Quick Switch order from clean inputs. Session languages
// are authoritative and REPLACE any preset placeholder — presets never linger.
function syncQuickSwitchOrder(activeLang, sessionLanguages) {
  const base = realSessionBase();

  // Pre-connect: show config.json presets as a placeholder only. Never persisted,
  // so it cannot leak into the live session's list.
  if (!base) {
    quickSwitchOrder = presetCodes.slice();
    return;
  }

  // A language you switched to that isn't part of the session becomes a persistent
  // manual add at the FRONT (A1). It holds that spot for the session.
  if (activeLang && !base.includes(activeLang) && !manualAdds.includes(activeLang)) {
    manualAdds.unshift(activeLang);
  }
  // Housekeeping: a "manual add" that's actually in the session base isn't one;
  // a "removed" code only matters if it's genuinely a session/base language.
  manualAdds       = manualAdds.filter(c => !base.includes(c));
  removedBaseCodes = removedBaseCodes.filter(c => base.includes(c));

  // Derive order: manual adds (newest first) + session languages minus removed
  let order = manualAdds.concat(base.filter(c => !removedBaseCodes.includes(c)));
  order = order.filter((c, i) => order.indexOf(c) === i);   // dedupe, keep order

  // Hard ceiling of 10: drop from the end (never the currently-live language)
  while (order.length > QUICK_SWITCH_MAX) {
    let idx = order.length - 1;
    while (idx >= 0 && order[idx] === activeLang) idx--;
    if (idx < 0) break;
    const dropped = order.splice(idx, 1)[0];
    if (base.includes(dropped)) { if (!removedBaseCodes.includes(dropped)) removedBaseCodes.push(dropped); }
    else manualAdds = manualAdds.filter(c => c !== dropped);
  }

  quickSwitchOrder = order;
  persistQuickSwitch();
}

function persistQuickSwitch() {
  chrome.storage.local.set({ manualAdds, removedBaseCodes });
}

function buildPresetButtons(activeLang, sessionLanguages) {
  const grid = document.getElementById("lang-grid");
  grid.innerHTML = "";
  lastActiveLang = activeLang;

  // Remember the session language list so rebuilds work without it being re-passed
  if (sessionLanguages && sessionLanguages.length) lastKnownSessionLangs = sessionLanguages;

  syncQuickSwitchOrder(activeLang, sessionLanguages);

  const canRemove = quickSwitchOrder.length > 1;

  for (const code of quickSwitchOrder) {
    const l = languages.find(x => x.wordlyCode === code);
    if (!l) continue;
    const btn = document.createElement("button");
    btn.className    = "btn-lang" + (code === activeLang ? " on" : "");
    btn.dataset.code = code;
    btn.title        = langLabel(l);

    // Button labels are English only (matches the native Wordly app). The ALS
    // star sits inline just before the name; long names truncate with an
    // ellipsis in the fixed grid and show the full name on hover.
    const label = document.createElement("span");
    label.className = "lang-label";
    if (isAlsCapable(code)) {
      const star = document.createElement("span");
      star.className   = "lang-star";
      star.textContent = ALS_STAR + " ";
      star.title       = "Supports auto language switching";
      label.appendChild(star);
    }
    label.appendChild(document.createTextNode(l.englishName || code.toUpperCase()));
    btn.appendChild(label);

    // Remove-X — on any button except the currently-live one, and never when
    // only one language remains
    if (canRemove && code !== activeLang) {
      const x = document.createElement("span");
      x.className   = "lang-x";
      x.textContent = "✕";
      x.title       = "Remove from Quick Switch";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeQuickSwitchCode(code);
      });
      btn.appendChild(x);
    }

    btn.addEventListener("click", () => switchLang(code));
    grid.appendChild(btn);
  }

  renderReAddRow();
  refreshAlsAvailability();
}

function removeQuickSwitchCode(code) {
  // A session/base language goes to the restore row; a manual add just disappears.
  const base = realSessionBase() || [];
  if (base.includes(code)) {
    if (!removedBaseCodes.includes(code)) removedBaseCodes.push(code);
  } else {
    manualAdds = manualAdds.filter(c => c !== code);
  }
  persistQuickSwitch();
  buildPresetButtons(lastActiveLang, null);
}

function reAddQuickSwitchCode(code) {
  removedBaseCodes = removedBaseCodes.filter(c => c !== code);
  persistQuickSwitch();
  buildPresetButtons(lastActiveLang, null);
}

// Dashed ghost buttons for removed BASE languages — tap to restore
function renderReAddRow() {
  const row = document.getElementById("readd-row");
  if (!row) return;
  row.innerHTML = "";
  if (!removedBaseCodes.length) { row.classList.remove("show"); return; }
  for (const code of removedBaseCodes) {
    const l   = languages.find(x => x.wordlyCode === code);
    const btn = document.createElement("button");
    btn.className   = "btn-readd";
    btn.textContent = `+ ${l ? l.englishName : code.toUpperCase()}`;
    btn.title = l ? `Restore ${langLabel(l)}` : `Restore ${code}`;
    btn.addEventListener("click", () => reAddQuickSwitchCode(code));
    row.appendChild(btn);
  }
  row.classList.add("show");
}

// ---------------------------------------------------------------------------
// ALS availability — driven by detectability field in languages.json
// ---------------------------------------------------------------------------

function isAlsCapable(code) {
  if (!code) return true;
  const l = languages.find(x => x.wordlyCode === code);
  // Fail open: missing language or missing detectability field = assume capable
  // (covers the hardcoded fallback list, which has no detectability data)
  if (!l || l.detectability === undefined || l.detectability === null) return true;
  return l.detectability !== "none";
}

// List-based ALS availability (matches the native Wordly app):
//  - Live: ALS is disabled while ANY language in the Quick Switch list is non-ALS.
//    Remove the offending language(s) to re-enable ALS.
//  - Pre-start: keys off the selected Speaker Language.
// Never persisted; recomputed on every list/selection change. Unlocking only
// re-enables the toggle — it never silently turns ALS back on.
function refreshAlsAvailability() {
  const t1      = document.getElementById("als-toggle");
  const t2      = document.getElementById("als-toggle-live");
  const msgCfg  = document.getElementById("als-config-msg");
  const msgLive = document.getElementById("als-disabled-msg");
  if (!t1 || !t2) return;

  const isLive = currentState && ["connected", "muted"].includes(currentState.status);

  // Which languages gate ALS availability
  const checkCodes = isLive
    ? quickSwitchOrder.slice()
    : [document.getElementById("language").value].filter(Boolean);

  const offenders = checkCodes.filter(c => !isAlsCapable(c));
  const names = offenders.map(c => {
    const l = languages.find(x => x.wordlyCode === c);
    return l ? l.englishName : c.toUpperCase();
  });

  if (offenders.length) {
    if (!alsLocked) {
      alsLocked = true;
      // Kill ALS on the live stream if it was running
      if (isLive && currentState.alsEnabled) {
        chrome.runtime.sendMessage({ type: "SET_ALS", enabled: false }).catch(() => {});
      }
    }
    t1.checked = false; t1.disabled = true;
    t2.checked = false; t2.disabled = true;
    const list = names.join(", ");
    const msgCfgText  = `${list} ${offenders.length > 1 ? "do" : "does"} not support automatic language switching. ALS is off.`;
    const msgLiveText = `${list} ${offenders.length > 1 ? "do" : "does"} not support automatic language switching. Remove ${offenders.length > 1 ? "them" : "it"} from Quick Switch to turn ALS back on.`;
    if (msgCfg)  { msgCfg.textContent  = msgCfgText;  msgCfg.style.display  = "block"; }
    if (msgLive) { msgLive.textContent = msgLiveText; msgLive.style.display = "block"; }
  } else {
    // Unlock only — re-enable the toggle but leave ALS OFF.
    if (alsLocked) {
      alsLocked = false;
      t1.disabled = false; t2.disabled = false;
    }
    if (msgCfg)  msgCfg.style.display  = "none";
    if (msgLive) msgLive.style.display = "none";
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

  // hdr-live-text was removed in the light-mode redesign — guard so applyState
  // doesn't throw and silently kill the config/live view switch
  const hdrMsgs = { idle:"", connecting:"Connecting...", connected:"● Live", muted:"⏸ Muted", stopping:"Stopping...", error:"Error" };
  if (hdrText) {
    hdrText.textContent = hdrMsgs[state.status] || "";
    hdrText.className   = `hdr-live-text ${state.status}`;
    if (state.status && state.status !== "idle") hdrText.classList.add("show");
  }

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
    // Banner shows the language CODE only (e.g. EN, ZH, ES-MX) so its width stays
    // stable as you flip languages — full names caused the banner to jitter.
    const langCode = (state.language || "").toUpperCase();
    sessInfo.innerHTML = `<b>SESSION</b> ${state.sessionId} &nbsp;·&nbsp; <b>LANG</b> ${langCode} &nbsp;·&nbsp; <b>NAME</b> ${state.speakerName || "—"}`;
    sessInfo.classList.add("show");

    // Attend bar
    if (attendUrl) attendUrl.textContent = `${ATTEND_BASE}${state.sessionId}`;
  } else {
    sessInfo.classList.remove("show");
  }

  isMuted = state.status === "muted";
  const iconPause = document.getElementById("icon-pause");
  const iconPlay  = document.getElementById("icon-play");
  const muteTip   = document.getElementById("mute-tip");
  if (iconPause) iconPause.style.display = isMuted ? "none" : "block";
  if (iconPlay)  iconPlay.style.display  = isMuted ? "block" : "none";
  if (muteTip)   muteTip.textContent     = isMuted ? "Resume capture" : "Pause capture";

  // Show/hide header action buttons in live view
  const hdrBtnMute  = document.getElementById("hdr-btn-mute");
  const hdrBtnSplit = document.getElementById("hdr-btn-split");
  const isLiveNow   = ["connected", "muted"].includes(state.status);
  if (hdrBtnMute)  hdrBtnMute.style.display  = isLiveNow ? "flex" : "none";
  if (hdrBtnSplit) hdrBtnSplit.style.display = isLiveNow ? "flex" : "none";

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
    // Rebuild preset buttons using session languages if available.
    // buildPresetButtons re-runs the list-based ALS availability check itself.
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

  // Fresh session — clear all Quick Switch state (and any stale session language
  // list) so a previous session's languages can never bleed into this one
  quickSwitchOrder      = [];
  manualAdds            = [];
  removedBaseCodes      = [];
  lastKnownSessionLangs = null;
  chrome.storage.local.remove(["manualAdds", "removedBaseCodes", "lastSessionLanguages"]);

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
  // ALS availability is list-based now; if this switch adds a new language to the
  // list, the rebuild via applyState re-checks it. Refresh here for immediate feedback.
  refreshAlsAvailability();
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
  // hdr-live-text removed in redesign — guard to avoid throwing mid-error-display
  const hdrText = document.getElementById("hdr-live-text");
  if (hdrText) {
    hdrText.textContent = "Error";
    hdrText.className   = "hdr-live-text show error";
  }
}
