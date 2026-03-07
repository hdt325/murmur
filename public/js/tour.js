/**
 * Guided tour / onboarding module.
 * Self-contained — only needs DOM access.
 */

const TOUR_STEPS = [
  { target: "#talkBtn", title: "Talk Button", text: "Tap to start recording, or press Right \u2318. Tap again to stop.", pos: "above" },
  { target: "#modeBtn", title: "Interaction Mode", text: "Cycle between Talk (mic + speaker), Type (keyboard + speaker), and Read (mic only, no TTS).", pos: "above" },
  { target: "#stopBtn", title: "Stop", text: "Interrupts Claude\u2019s response and stops TTS playback.", pos: "above" },
  { target: "#muteBtn", title: "Mute Mic", text: "Temporarily mutes the microphone without changing modes.", pos: "above" },
  { target: "#speedBtn", title: "Speed & Voice", text: "Adjust TTS playback speed. Use the voice button next to it to pick from 13 voices.", pos: "above" },
  { target: "#textInput", title: "Text Input", text: "Type messages directly \u2014 works in any mode. Press Enter to send.", pos: "above" },
  { target: "#cleanBtn", title: "Verbose / Clean", text: "Toggle between Clean (shows only final responses) and Verbose (shows Claude\u2019s full streaming output including tool calls and thinking).", pos: "below" },
  { target: "#flowModeBtn", title: "Flow Mode", text: "A distraction-free voice conversation view. Hides all chrome \u2014 just you, the mic, and Claude\u2019s prose.", pos: "below" },
  { target: "#terminalHeader", title: "Terminal Panel", text: "Click to expand and watch Claude Code working in real-time with ANSI colors.", pos: "above" },
  { target: "#restartBtn", title: "Restart Server", text: "Restarts the Murmur server process.", pos: "below" },
  { target: ".svc-indicators", title: "Service Status", text: "STT and TTS dots show Whisper and Kokoro status. The speaker dot shows which device has audio output.", pos: "below" },
  { target: ".svc-indicators", title: "Remote & Mobile Access", text: "Use Murmur from your phone via Tailscale.", pos: "below" },
];

let _tourOverlay, _tourSpotlight, _tourTip, _tourStep;

export function startTour() {
  endTour(true);
  _tourStep = 0;
  _tourOverlay = document.createElement("div");
  _tourOverlay.className = "tour-overlay";
  _tourSpotlight = document.createElement("div");
  _tourSpotlight.className = "tour-spotlight";
  _tourTip = document.createElement("div");
  _tourTip.className = "tour-tip";
  document.body.append(_tourOverlay, _tourSpotlight, _tourTip);
  showTourStep();
}

function showTourStep() {
  const s = TOUR_STEPS[_tourStep];
  const el = document.querySelector(s.target);
  if (!el) { advanceTour(); return; }
  const rect = el.getBoundingClientRect();
  const pad = 6;

  _tourSpotlight.style.left = (rect.left - pad) + "px";
  _tourSpotlight.style.top = (rect.top - pad) + "px";
  _tourSpotlight.style.width = (rect.width + pad * 2) + "px";
  _tourSpotlight.style.height = (rect.height + pad * 2) + "px";

  const isLast = _tourStep === TOUR_STEPS.length - 1;
  _tourTip.innerHTML =
    "<h4>" + s.title + "</h4>" +
    "<p>" + s.text + "</p>" +
    '<div class="tour-footer">' +
    '<span class="tour-step">' + (_tourStep + 1) + " / " + TOUR_STEPS.length + "</span>" +
    '<div class="tour-btns">' +
    '<button class="tour-skip">Skip</button>' +
    '<button class="tour-next">' + (isLast ? "Done" : "Next") + "</button>" +
    "</div></div>";

  _tourTip.querySelector(".tour-skip").addEventListener("click", (e) => { e.stopPropagation(); endTour(); });
  _tourTip.querySelector(".tour-next").addEventListener("click", (e) => { e.stopPropagation(); advanceTour(); });

  _tourTip.classList.remove("visible");
  requestAnimationFrame(() => {
    const tipRect = _tourTip.getBoundingClientRect();
    let top;
    if (s.pos === "above") {
      top = rect.top - tipRect.height - 12;
      if (top < 8) top = rect.bottom + 12;
    } else {
      top = rect.bottom + 12;
      if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 12;
    }
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - tipRect.width - 8));
    _tourTip.style.top = top + "px";
    _tourTip.style.left = left + "px";
    _tourTip.classList.add("visible");
  });
}

function advanceTour() {
  _tourStep++;
  if (_tourStep >= TOUR_STEPS.length) { endTour(); return; }
  showTourStep();
}

export function endTour(silent) {
  if (_tourOverlay) { _tourOverlay.remove(); _tourOverlay = null; }
  if (_tourSpotlight) { _tourSpotlight.remove(); _tourSpotlight = null; }
  if (_tourTip) { _tourTip.remove(); _tourTip = null; }
  if (!silent) localStorage.setItem("murmur-tour-done", "1");
}

export function getTourStepCount() {
  return TOUR_STEPS.length;
}

export function autoStartTour(delayMs = 1500) {
  if (!localStorage.getItem("murmur-tour-done")) {
    setTimeout(startTour, delayMs);
  }
}
