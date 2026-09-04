/**
 * Mixerx introduction page — the page's interactions.
 *
 * The pictures are real captures of the alpha; this module only wires the controls around them:
 * the hero's two faces (mixer / visuals, on a two-second rotation until you take over), the
 * tool board (a mirror of the registry policy), the scripted
 * proposal loop, the roadmap sketches, the 3-in-1 concept, the motion toggle and the reveals. Every pure function is exported so
 * it can be tested without a browser. Nothing here opens audio, a microphone, a socket or a
 * network request.
 */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const f1 = (value) => value.toFixed(1);

/* ─────────────────────────── the hero's two faces ─────────────────────────── */

/** The two real screens the hero frame flips between, in rotation order. */
export const FACES = Object.freeze([
  { id: "mixer", caption: "CONSOLE · MIX MODE · DEMO TRACKS WRITTEN BY THE PAGE" },
  { id: "visuals", caption: "VISUALS STUDIO · NIGHT PHOENIX · SAME SESSION, SAME BEAT" },
]);

/** How long each face is held while the frame rotates on its own. */
export const FACE_ROTATE_MS = 2000;

export function nextFace(id) {
  const index = FACES.findIndex((face) => face.id === id);
  if (index < 0) throw new RangeError(`Unknown face "${id}"`);
  return FACES[(index + 1) % FACES.length].id;
}

/* ─────────────────────────── the tool board ─────────────────────────── */

const EVERYWHERE = ["learn", "mix", "perform"];
const MIXING = ["mix", "perform"];

/** The v2 tool set as the registry knows it: name, access level and the modes it registers in. */
export const TOOLS = Object.freeze([
  { name: "get-session", access: "read", contexts: EVERYWHERE },
  { name: "search-library", access: "read", contexts: EVERYWHERE },
  { name: "get-track", access: "read", contexts: EVERYWHERE },
  { name: "propose-transition", access: "read", contexts: MIXING },
  { name: "plan-set", access: "read", contexts: MIXING },
  { name: "propose-scene", access: "read", contexts: MIXING },
  { name: "load-deck", access: "prepare", contexts: MIXING },
  { name: "set-queue", access: "prepare", contexts: MIXING },
  { name: "preview-cue", access: "prepare", contexts: MIXING },
  { name: "arm-transition", access: "act", contexts: MIXING },
  { name: "enter-deck", access: "act", contexts: MIXING },
  { name: "apply-scene", access: "act", contexts: MIXING },
  { name: "apply-preset", access: "act", contexts: MIXING },
]);

const AUTONOMY_ORDER = { observe: 0, prepare: 1, copilot: 2 };

/** Which access levels may run without asking at each autonomy level. */
export function permitted(access, autonomy) {
  if (!Object.hasOwn(AUTONOMY_ORDER, autonomy)) throw new RangeError(`Unknown autonomy "${autonomy}"`);
  if (access === "read") return true;
  if (access === "prepare") return AUTONOMY_ORDER[autonomy] >= AUTONOMY_ORDER.prepare;
  return autonomy === "copilot";
}

/** What the agent sees in one mode at one autonomy level: registered, runs on its own, asks first. */
export function toolBoard(mode, autonomy) {
  if (!EVERYWHERE.includes(mode)) throw new RangeError(`Unknown mode "${mode}"`);
  const tools = TOOLS.map((tool) => {
    if (!tool.contexts.includes(mode)) return { ...tool, state: "hidden" };
    return { ...tool, state: permitted(tool.access, autonomy) ? "runs" : "asks" };
  });
  const registered = tools.filter((tool) => tool.state !== "hidden").length;
  const runs = tools.filter((tool) => tool.state === "runs").length;
  return { tools, registered, runs, asks: registered - runs };
}

export function boardSummary({ registered, runs, asks }) {
  return `${registered} tools registered · ${runs} run on their own · ${asks} ask you first`;
}

/* ─────────────────────────── mounting ─────────────────────────── */

export function mountExperience(doc, win) {
  const root = doc.documentElement;
  root.dataset.js = "1";
  const listeners = new win.AbortController();
  const listen = (node, event, callback) =>
    node.addEventListener(event, callback, { signal: listeners.signal });
  const byId = (id) => doc.getElementById(id);
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
  let paused = reduced.matches;

  /* ── opt-in YouTube demo: no remote player or thumbnail before a click ── */
  const demoPlay = byId("demo-play");
  const demoPlayer = byId("demo-player");
  let demoFrame = null;
  listen(demoPlay, "click", (event) => {
    // Keep the link's normal new-tab behaviour for modifier clicks and without JavaScript.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (demoFrame) return;
    demoFrame = doc.createElement("iframe");
    demoFrame.title = "Mixerx alpha demo — DJ agent, music mixer and music visualization";
    demoFrame.referrerPolicy = "strict-origin-when-cross-origin";
    demoFrame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    demoFrame.allowFullscreen = true;
    demoFrame.src = "https://www.youtube-nocookie.com/embed/OTJsOIhV-zM?autoplay=1&playsinline=1&rel=0";
    demoPlayer.append(demoFrame);
    demoPlay.hidden = true;
    demoFrame.focus();
  });

  /* ── hero parallax over the real captures ── */
  const heroArt = byId("hero-art");
  listen(heroArt, "pointermove", (event) => {
    if (reduced.matches || paused) return;
    const rect = heroArt.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const py = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    heroArt.style.setProperty("--px", f1(clamp(px, -1, 1)));
    heroArt.style.setProperty("--py", f1(clamp(py, -1, 1)));
  });
  listen(heroArt, "pointerleave", () => {
    heroArt.style.setProperty("--px", "0");
    heroArt.style.setProperty("--py", "0");
  });

  /* ── the hero's two faces: a rotation that stops the moment you touch it ── */
  const heroTabs = byId("hero-tabs");
  const faceTabs = Array.from(heroTabs.querySelectorAll('[role="tab"]'));
  const heroCaption = byId("hero-caption");
  const facePanels = Array.from(doc.querySelectorAll(".hero-panel"));
  let face = FACES[0].id;
  let rotation = null;
  // Once the visitor picks a face, the frame stops rotating for the rest of the visit.
  let handedOver = false;

  function showFace(id) {
    face = id;
    for (const tab of faceTabs) {
      const on = tab.dataset.face === id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of facePanels) panel.toggleAttribute("data-on", panel.dataset.face === id);
    heroCaption.textContent = FACES.find((entry) => entry.id === id).caption;
  }
  function stopRotating() {
    if (rotation !== null) win.clearInterval(rotation);
    rotation = null;
    heroTabs.dataset.auto = "off";
  }
  function startRotating() {
    if (rotation !== null || handedOver || paused) return;
    heroTabs.dataset.auto = "on";
    rotation = win.setInterval(() => showFace(nextFace(face)), FACE_ROTATE_MS);
  }
  function pickFace(id) {
    handedOver = true;
    stopRotating();
    showFace(id);
  }
  for (const tab of faceTabs) {
    listen(tab, "click", () => pickFace(tab.dataset.face));
    listen(tab, "keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? faceTabs.length - 1
            : step === undefined
              ? -1
              : (faceTabs.indexOf(tab) + step + faceTabs.length) % faceTabs.length;
      if (target < 0) return;
      event.preventDefault();
      pickFace(faceTabs[target].dataset.face);
      faceTabs[target].focus();
    });
  }
  // Hovering or tabbing into the frame holds the current face; leaving hands it back.
  listen(heroArt, "pointerenter", stopRotating);
  listen(heroArt, "pointerleave", startRotating);
  listen(heroTabs, "focusin", stopRotating);

  /* ── the tool board ── */
  let mode = "mix";
  let autonomy = "prepare";
  const summary = byId("board-summary");
  function drawBoard() {
    const board = toolBoard(mode, autonomy);
    for (const tool of board.tools) {
      const chip = doc.querySelector(`[data-tool="${tool.name}"]`);
      if (chip) chip.dataset.state = tool.state;
    }
    summary.textContent = boardSummary(board);
    for (const button of doc.querySelectorAll("[data-mode]"))
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    for (const button of doc.querySelectorAll("[data-autonomy]"))
      button.setAttribute("aria-pressed", String(button.dataset.autonomy === autonomy));
  }
  for (const button of doc.querySelectorAll("[data-mode]"))
    listen(button, "click", () => {
      mode = button.dataset.mode;
      drawBoard();
    });
  for (const button of doc.querySelectorAll("[data-autonomy]"))
    listen(button, "click", () => {
      autonomy = button.dataset.autonomy;
      drawBoard();
    });

  /* ── the proposal loop ── */
  const steps = Array.from(doc.querySelectorAll("[data-step]"));
  const card = byId("proposal-card");
  const run = byId("chat-run");
  const accept = byId("proposal-accept");
  const dismiss = byId("proposal-dismiss");
  const undo = byId("proposal-undo");
  const reset = byId("proposal-reset");
  const status = byId("proposal-status");
  function resetLoop() {
    for (const step of steps) delete step.dataset.on;
    card.hidden = true;
    undo.hidden = true;
    reset.hidden = true;
    accept.disabled = false;
    dismiss.disabled = false;
    run.disabled = false;
    status.textContent = "Press “Ask the AI DJ agent” to run the example. Nothing real changes.";
  }
  listen(run, "click", () => {
    for (const step of steps) step.dataset.on = "";
    card.hidden = false;
    run.disabled = true;
    status.textContent = "Proposed. The card waits for you; nothing is audible yet.";
  });
  listen(accept, "click", () => {
    accept.disabled = true;
    dismiss.disabled = true;
    undo.hidden = false;
    reset.hidden = false;
    status.textContent =
      "Armed. B enters at bar 17, sample-accurate. Activity log: arm-transition · agent · confirmedBy: user.";
  });
  listen(dismiss, "click", () => {
    accept.disabled = true;
    dismiss.disabled = true;
    reset.hidden = false;
    status.textContent = "Dismissed. Nothing changed, and the agent gets a polite no.";
  });
  listen(undo, "click", () => {
    undo.hidden = true;
    status.textContent = "Undone: B's entry is cancelled. One tap, like every agent action.";
  });
  listen(reset, "click", () => {
    resetLoop();
    run.focus();
  });

  /* ── WebMCP prompt starters ── */
  const copyStatus = byId("prompt-copy-status");
  for (const button of doc.querySelectorAll("[data-copy-prompt]"))
    listen(button, "click", async () => {
      const prompt = byId(button.dataset.copyPrompt)?.textContent.trim();
      if (!prompt) return;
      try {
        if (!win.navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await win.navigator.clipboard.writeText(prompt);
        copyStatus.textContent = `${button.dataset.promptName} copied. Paste it into your browser agent.`;
      } catch {
        copyStatus.textContent = "Copy is unavailable here. Select the prompt text and copy it manually.";
      }
    });

  /* ── the roadmap sketches: press one and it speeds up ── */
  for (const art of doc.querySelectorAll(".stop-art"))
    listen(art, "click", () =>
      art.setAttribute("aria-pressed", String(art.getAttribute("aria-pressed") !== "true")),
    );

  /* ── the 3-in-1 concept ── */
  const ghosts = Array.from(doc.querySelectorAll("[data-ghost]"));
  const ask = byId("daw-ask");
  const keep = byId("daw-accept");
  const dawReset = byId("daw-reset");
  const dawStatus = byId("daw-status");
  listen(ask, "click", () => {
    for (const ghost of ghosts) ghost.removeAttribute("hidden");
    ask.disabled = true;
    keep.disabled = false;
    dawReset.disabled = false;
    dawStatus.textContent = "Four ideas, each with a reason. Ghost clips touch nothing until you keep them.";
  });
  listen(keep, "click", () => {
    for (const ghost of ghosts) ghost.dataset.solid = "";
    keep.disabled = true;
    dawStatus.textContent = "Kept. They're clips now. Undo would be one tap here too.";
  });
  listen(dawReset, "click", () => {
    for (const ghost of ghosts) {
      ghost.setAttribute("hidden", "");
      delete ghost.dataset.solid;
    }
    ask.disabled = false;
    keep.disabled = true;
    dawReset.disabled = true;
    dawStatus.textContent = "Your project. No suggestions yet.";
    ask.focus();
  });

  /* ── the privacy deep link ── */
  const privacyLink = doc.querySelector('a[href="#faq-privacy"]');
  if (privacyLink)
    listen(privacyLink, "click", () => {
      byId("faq-privacy").open = true;
    });

  /* ── motion ── */
  const motion = byId("motion-toggle");
  const motionLabel = motion.querySelector(".motion-label");
  const motionIcon = motion.querySelector(".motion-icon");
  function updateMotion() {
    motion.setAttribute("aria-pressed", String(paused));
    motionLabel.textContent = paused ? "Play motion" : "Pause motion";
    motionIcon.textContent = paused ? "▶" : "⏸";
    root.dataset.motion = paused ? "paused" : "playing";
    if (paused) {
      heroArt.style.setProperty("--px", "0");
      heroArt.style.setProperty("--py", "0");
      stopRotating();
    } else startRotating();
  }
  listen(motion, "click", () => {
    paused = !paused;
    updateMotion();
  });
  const onReduced = (event) => {
    paused = event.matches;
    updateMotion();
  };
  reduced.addEventListener("change", onReduced);

  /* ── scroll reveals ── */
  const observer = win.IntersectionObserver
    ? new win.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.dataset.shown = "";
            observer.unobserve(entry.target);
          }
        }
      })
    : null;
  const viewportHeight = win.innerHeight || 0;
  for (const node of doc.querySelectorAll("[data-reveal]")) {
    const rect = node.getBoundingClientRect();
    // Above the fold: show at once instead of waiting for the observer's first callback.
    if (rect.bottom > 0 && rect.top < viewportHeight) node.dataset.shown = "";
    else if (observer) observer.observe(node);
    else node.dataset.shown = "";
  }

  /* ── first paint ── */
  showFace(face);
  updateMotion();
  drawBoard();
  resetLoop();

  return () => {
    demoFrame?.remove();
    demoFrame = null;
    demoPlay.hidden = false;
    stopRotating();
    listeners.abort();
    observer?.disconnect();
    reduced.removeEventListener("change", onReduced);
  };
}
