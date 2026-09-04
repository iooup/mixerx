import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { DEV_CSP_HEADER, PRODUCTION_CSP_META, SECURITY_HEADERS } from "../scripts/csp.mjs";
import {
  boardSummary,
  FACE_ROTATE_MS,
  FACES,
  mountExperience,
  nextFace,
  permitted,
  TOOLS,
  toolBoard,
} from "./experience.mjs";
import { DEMO_FRAME_POLICY, isLandingDocument, LANDING_CSP_META, landingHeaders } from "./security.mjs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./experience.mjs", import.meta.url), "utf8");

function setup(t, reduced = false, observer = true) {
  const dom = new JSDOM(html, { url: "http://localhost:4187/mixerx/", pretendToBeVisual: true });
  const { window } = dom;
  const media = new window.EventTarget();
  media.matches = reduced;
  window.matchMedia = () => media;
  let observerCallback;
  if (observer) {
    window.IntersectionObserver = class {
      constructor(next) {
        observerCallback = next;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  } else {
    delete window.IntersectionObserver;
  }
  const cleanup = mountExperience(window.document, window);
  t.after(() => {
    cleanup();
    window.close();
  });
  return {
    doc: window.document,
    window,
    cleanup,
    reveal: (node) => observerCallback([{ target: node, isIntersecting: true }]),
    reduce: (matches) => {
      const event = new window.Event("change");
      event.matches = matches;
      media.dispatchEvent(event);
    },
  };
}

/* ─────────────────────────── content ─────────────────────────── */

test("English page has one primary heading and every requested section", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  assert.equal(doc.documentElement.lang, "en");
  assert.equal(doc.querySelectorAll("h1").length, 1);
  for (const id of [
    "demo",
    "duo",
    "copilot",
    "webmcp",
    "features",
    "horizon",
    "three",
    "stack",
    "tour",
    "faq",
  ])
    assert.ok(doc.getElementById(id), id);
  assert.equal(doc.querySelectorAll("[data-tool]").length, 13);
  assert.equal(doc.querySelectorAll(".stop").length, 6);
  assert.equal(doc.querySelectorAll(".feature").length, 12);
  assert.equal(doc.querySelectorAll(".faq-list details").length, 7);
  assert.match(doc.getElementById("duo").textContent, /2-in-1/i);
  // The hero frame is the only place the two faces are shown side by side.
  const tabs = Array.from(doc.querySelectorAll('#hero-tabs [role="tab"]'));
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.face),
    FACES.map((face) => face.id),
  );
  for (const tab of tabs) {
    const panel = doc.getElementById(tab.getAttribute("aria-controls"));
    assert.equal(panel.getAttribute("role"), "tabpanel");
    assert.equal(panel.dataset.face, tab.dataset.face);
    assert.equal(panel.querySelectorAll("img").length, 1);
  }
  assert.equal(doc.getElementById("hero-tabs").getAttribute("role"), "tablist");
  assert.equal(doc.querySelectorAll(".hero-panel").length, 2);
  assert.equal(doc.querySelectorAll(".duo-window, #duo-fader").length, 0);
  assert.match(doc.getElementById("three").textContent, /3-in-1/i);
  dom.window.close();
});

test("honesty labels: real captures are labelled, the walkthrough is scripted, the horizon is not a promise", () => {
  const text = html.replace(/\s+/g, " ");
  assert.match(text, /REAL CAPTURES · ALPHA BUILD/);
  assert.match(text, /scripted walkthrough · not a live agent/);
  assert.match(text, /not available features or launch commitments/);
  assert.match(text, /PLANNED · NOT BUILT/);
  assert.match(text, /experimental Community Group draft, not a finished W3C standard/);
  assert.match(text, /WebMCP itself is not a privacy guarantee/);
  assert.match(text, /Movement, not faces\. Consent first, no recording/);
  assert.match(text, /AGPL-3\.0-or-later/);
  // Accuracy fixes from the review.
  assert.match(text, /Below the Co-DJ level, anything the crowd would hear asks you first/);
  // The assistant is the AI DJ agent everywhere, and the app's third autonomy level is Co-DJ:
  // no "co-pilot" survives in the prose. Ids, classes and keys still use the `copilot` key.
  const prose = text.replace(/<[^>]+>/g, " ");
  assert.match(prose, /AI DJ agent/);
  assert.doesNotMatch(prose, /co-?pilot/i);
  assert.equal((prose.match(/Co-DJ/g) ?? []).length, 4);
  assert.doesNotMatch(text, /ONE BIG VIBE|GUEST LIST/);
  assert.match(text, /AI DJ AGENT ON MIXER/);
  assert.match(text, /four to start, nine slots of your own/);
  assert.match(text, /YOU \+ AI, BACK TO BACK/);
  assert.doesNotMatch(text, /Nine vibe presets/);
  assert.match(text, /Best on a desktop Chromium browser/);
  // Headlines say what the thing is: no slogans that would fit any app.
  assert.match(text, /A DJ mixer.*Live.*visuals.*AI optional/s);
  assert.doesNotMatch(text, /Drop the beat|Dream mode|unserious amount of fun|Leave with a groove/);
});

test("ids are unique, internal anchors resolve, external links are safe", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const ids = Array.from(doc.querySelectorAll("[id]"), (node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const link of doc.querySelectorAll('a[href^="#"]'))
    assert.ok(doc.getElementById(link.hash.slice(1)), link.hash);
  for (const link of doc.querySelectorAll('a[target="_blank"]')) assert.match(link.rel, /noopener/);
  for (const link of doc.querySelectorAll('a[href^="http"]')) assert.equal(link.target, "_blank");
  dom.window.close();
});

test("every control, picture and illustration has an accessible name", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  for (const button of doc.querySelectorAll("button")) {
    assert.ok(button.textContent.trim() || button.getAttribute("aria-label"), button.outerHTML);
    assert.equal(button.type, "button");
  }
  for (const range of doc.querySelectorAll("input"))
    assert.ok(range.labels.length || range.getAttribute("aria-label"));
  for (const svg of doc.querySelectorAll("svg"))
    assert.ok(
      svg.getAttribute("aria-hidden") === "true" || svg.querySelector("title"),
      svg.outerHTML.slice(0, 80),
    );
  for (const image of doc.querySelectorAll("img"))
    assert.ok(image.alt.trim().length > 20, image.outerHTML.slice(0, 80));
  for (const id of ["board-summary", "proposal-status", "prompt-copy-status", "daw-status"])
    assert.equal(doc.getElementById(id).getAttribute("aria-live"), "polite");
  dom.window.close();
});

test("every picture is a local WebP capture with dimensions, lazy below the hero", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const images = Array.from(doc.querySelectorAll("img"));
  assert.ok(images.length >= 16, `expected the captures, found ${images.length}`);
  for (const image of images) {
    const src = image.getAttribute("src");
    assert.match(src, /^\.\/shots\/[a-z0-9-]+\.webp$/, src);
    assert.ok(existsSync(new URL(src, import.meta.url)), `${src} missing on disk`);
    assert.ok(Number(image.getAttribute("width")) > 0 && Number(image.getAttribute("height")) > 0, src);
    if (image.hasAttribute("data-eager")) assert.equal(image.getAttribute("loading"), null, src);
    else assert.equal(image.getAttribute("loading"), "lazy", src);
  }
  assert.equal(doc.querySelectorAll("img[data-eager]").length, 2);
  assert.equal(doc.querySelectorAll('img[data-eager][fetchpriority="high"]').length, 1);
  dom.window.close();
});

test("no inline scripts, styles, event handlers, media or external runtime assets", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll("[style], style, script:not([src]), iframe, audio, video").length, 0);
  for (const element of doc.querySelectorAll("*"))
    for (const attribute of element.attributes) assert.ok(!attribute.name.startsWith("on"), attribute.name);
  for (const element of doc.querySelectorAll("[src], link[href]"))
    assert.ok(!/^https?:/.test(element.getAttribute("src") || element.getAttribute("href")));
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|WebSocket|XMLHttpRequest|sendBeacon|AudioContext|getUserMedia|localStorage/,
  );
  assert.doesNotMatch(css, /url\(\s*["']?https?:/);
  dom.window.close();
});

test("stylesheet: breakpoints, reduced motion, focus styles, readable sizes, bundled fonts only", () => {
  assert.match(css, /max-width: 1100px/);
  assert.match(css, /max-width: 760px/);
  assert.match(css, /max-width: 390px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /font(?:-size)?:\s*(?:[1-9]|10)px\b/);
  for (const family of ["syne", "space-mono", "ibm-plex-sans"])
    assert.match(css, new RegExp(`@import "@fontsource/${family}/`));
  // Pressing "Pause motion" must stop the roadmap sketches too, not just the ticker.
  assert.match(css, /html\[data-motion="paused"\] \.sketch \*/);
  // The motion toggle stays reachable on phones: only its label collapses.
  assert.doesNotMatch(css, /#motion-toggle\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.motion-label\s*\{\s*display:\s*none/);
});

test("production output permits only the opt-in YouTube frame alongside local assets", () => {
  const built = new URL("./dist/index.html", import.meta.url);
  const dom = new JSDOM(readFileSync(built, "utf8"));
  const doc = dom.window.document;
  const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.equal(policy.content, LANDING_CSP_META);
  assert.equal(policy.content, `${PRODUCTION_CSP_META}; ${DEMO_FRAME_POLICY}`);
  assert.doesNotMatch(PRODUCTION_CSP_META, /unsafe-inline|https:/);
  assert.equal(doc.querySelectorAll("iframe, video, audio").length, 0);
  for (const node of doc.querySelectorAll("script[src], link[href], img[src]")) {
    const value = node.getAttribute("src") || node.getAttribute("href");
    assert.ok(value.startsWith("./assets/"), value);
    assert.ok(readFileSync(new URL(value, built)).length > 0, value);
  }
  assert.equal(doc.querySelectorAll("script:not([src]), [style]").length, 0);
  assert.equal(doc.title, "Mixerx — a browser DJ mixer with live visuals and an AI agent");
  dom.window.close();
});

test("the demo follows the hero, discloses YouTube and has a no-JavaScript fallback", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  assert.equal(doc.getElementById("top").nextElementSibling.id, "demo");
  const play = doc.getElementById("demo-play");
  assert.equal(play.href, "https://youtu.be/OTJsOIhV-zM");
  assert.equal(play.target, "_blank");
  assert.match(play.rel, /noopener/);
  assert.match(
    doc.getElementById(play.getAttribute("aria-describedby")).textContent,
    /only when you press play/,
  );
  assert.match(doc.getElementById("faq-privacy").textContent, /hosted on YouTube/);
  assert.doesNotMatch(html, /Nothing on this page plays audio|contains no strobes/);
  assert.match(css, /\.demo-player\s*\{[^}]*aspect-ratio: 16 \/ 9;[^}]*min-height: 200px;/);
  dom.window.close();
});

test("YouTube connects only after activation and is unloaded on cleanup", (t) => {
  const { doc, cleanup } = setup(t, true);
  const play = doc.getElementById("demo-play");
  assert.equal(doc.querySelectorAll("iframe").length, 0);
  play.click();
  const frame = doc.querySelector("#demo-player iframe");
  assert.ok(frame);
  const url = new URL(frame.src);
  assert.equal(url.origin, "https://www.youtube-nocookie.com");
  assert.equal(url.pathname, "/embed/OTJsOIhV-zM");
  assert.equal(url.searchParams.get("autoplay"), "1");
  assert.equal(url.searchParams.get("playsinline"), "1");
  assert.ok(frame.title.includes("Mixerx alpha demo"));
  assert.equal(frame.referrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(frame.allowFullscreen, true);
  assert.doesNotMatch(frame.allow, /camera|microphone/);
  assert.equal(doc.activeElement, frame);
  assert.equal(play.hidden, true);
  play.click();
  assert.equal(doc.querySelectorAll("iframe").length, 1);
  cleanup();
  assert.equal(doc.querySelectorAll("iframe").length, 0);
  assert.equal(play.hidden, false);
});

test("modified demo clicks retain the direct YouTube link", (t) => {
  const { doc, window } = setup(t);
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    const event = new window.MouseEvent("click", { [modifier]: true, bubbles: true, cancelable: true });
    doc.getElementById("demo-play").dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(doc.querySelectorAll("iframe").length, 0);
  }
});

test("the landing security exception never changes the instrument policy", () => {
  for (const path of ["/mixerx/", "/mixerx/index.html", "/mixerx/?demo=1"])
    assert.equal(isLandingDocument(path), true, path);
  for (const path of ["/", "/stage", "/stage?next=/mixerx/", "/mixerx/experience.mjs", "/mixerx-other/"])
    assert.equal(isLandingDocument(path), false, path);
  const headers = landingHeaders(DEV_CSP_HEADER);
  assert.equal(headers["Content-Security-Policy"], `${DEV_CSP_HEADER}; ${DEMO_FRAME_POLICY}`);
  assert.equal(headers["Cross-Origin-Embedder-Policy"], "unsafe-none");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(SECURITY_HEADERS["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(SECURITY_HEADERS["Referrer-Policy"], "no-referrer");
  assert.doesNotMatch(PRODUCTION_CSP_META, /youtube/);
});

/* ─────────────────────────── pure functions ─────────────────────────── */

test("the two faces rotate in order, every two seconds", () => {
  assert.deepEqual(
    FACES.map((face) => face.id),
    ["mixer", "visuals"],
  );
  assert.equal(FACE_ROTATE_MS, 2000);
  assert.equal(nextFace("mixer"), "visuals");
  assert.equal(nextFace("visuals"), "mixer");
  assert.throws(() => nextFace("stage"), RangeError);
  for (const face of FACES) assert.match(face.caption, /^[A-Z0-9 ·,]+$/);
});

test("the tool board mirrors the registry policy: 3 tools in Learn, 13 in Mix and Perform", () => {
  assert.equal(TOOLS.length, 13);
  assert.equal(permitted("read", "observe"), true);
  assert.equal(permitted("prepare", "observe"), false);
  assert.equal(permitted("prepare", "prepare"), true);
  assert.equal(permitted("act", "prepare"), false);
  assert.equal(permitted("act", "copilot"), true);
  assert.throws(() => permitted("read", "boss"), RangeError);
  const learn = toolBoard("learn", "copilot");
  assert.deepEqual([learn.registered, learn.runs, learn.asks], [3, 3, 0]);
  const observe = toolBoard("mix", "observe");
  assert.deepEqual([observe.registered, observe.runs, observe.asks], [13, 6, 7]);
  const prepare = toolBoard("perform", "prepare");
  assert.deepEqual([prepare.registered, prepare.runs, prepare.asks], [13, 9, 4]);
  const copilot = toolBoard("mix", "copilot");
  assert.deepEqual([copilot.registered, copilot.runs, copilot.asks], [13, 13, 0]);
  assert.equal(boardSummary(prepare), "13 tools registered · 9 run on their own · 4 ask you first");
  assert.throws(() => toolBoard("party", "observe"), RangeError);
});

test("the roadmap shows every direction at once, labelled and undated", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const lanes = Array.from(doc.querySelectorAll("#horizon .lane"), (lane) => lane.dataset.when);
  assert.deepEqual(lanes, ["now", "next", "far"]);
  const stops = Array.from(doc.querySelectorAll("#horizon .stop"));
  assert.equal(stops.length, 6);
  for (const stop of stops) {
    assert.ok(stop.querySelector("h3").textContent.trim().length > 3);
    assert.ok(stop.querySelector("p").textContent.trim().length > 20);
  }
  assert.equal(doc.querySelectorAll('#horizon .lane[data-when="now"] .stop').length, 1);
  // One sketch and one line per idea: no chips, no caveats, no dates.
  assert.equal(doc.querySelectorAll("#horizon .stop-tag").length, 0);
  assert.match(doc.getElementById("horizon").textContent, /Movement, not faces/);
  for (const stop of stops) {
    assert.equal(stop.querySelectorAll("p").length, 1);
    assert.ok(stop.querySelector("p").textContent.trim().length <= 90, stop.querySelector("p").textContent);
    const art = stop.querySelector("button.stop-art");
    assert.equal(art.getAttribute("aria-pressed"), "false");
    assert.match(art.getAttribute("aria-label"), /sketch/i);
    assert.equal(art.querySelectorAll("svg.sketch").length, 1);
  }
  assert.equal(doc.querySelectorAll("#horizon [hidden]").length, 0);
  assert.doesNotMatch(doc.getElementById("horizon").textContent, /\b20\d\d\b|Q[1-4]/);
  dom.window.close();
});

test("the WebMCP prompt starters map three useful requests to their real tool paths", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const cards = Array.from(doc.querySelectorAll("[data-prompt-example]"));
  const expected = [
    {
      level: "observe",
      prompt: "Analyze the live session and show the three tracks most compatible with the on-air track.",
      tools: ["get-session", "search-library"],
    },
    {
      level: "prepare",
      prompt: "Build a five-track rising-energy queue using BPM, key, and energy compatibility.",
      tools: ["get-session", "search-library", "plan-set", "set-queue"],
    },
    {
      level: "copilot",
      prompt:
        "Choose the best next track, prepare a phrase-aligned transition, and apply a Stage scene for the upcoming drop.",
      tools: [
        "get-session",
        "search-library",
        "load-deck",
        "propose-transition",
        "arm-transition",
        "propose-scene",
        "apply-scene",
      ],
    },
  ];
  assert.equal(cards.length, expected.length);
  for (const [index, card] of cards.entries()) {
    assert.equal(card.dataset.level, expected[index].level);
    assert.equal(card.querySelector(".prompt-text").textContent.trim(), expected[index].prompt);
    assert.deepEqual(
      Array.from(card.querySelectorAll(".prompt-tools code"), (tool) => tool.textContent),
      expected[index].tools,
    );
    assert.equal(card.querySelectorAll("[data-copy-prompt]").length, 1);
  }
  assert.match(
    doc.querySelector("#tour .steps li:nth-child(3)").textContent,
    /Prepare a phrase-aligned transition from Deck A to Deck B/,
  );
  dom.window.close();
});

/* ─────────────────────────── mounted behaviour ─────────────────────────── */

test("mount marks the document as scripted and draws the first state", (t) => {
  const { doc } = setup(t);
  assert.equal(doc.documentElement.dataset.js, "1");
  assert.equal(
    doc.getElementById("board-summary").textContent,
    "13 tools registered · 9 run on their own · 4 ask you first",
  );
  assert.equal(doc.querySelector(".hero-panel[data-on]").dataset.face, "mixer");
});

test("the hero rotates to the other face on its own, and the visitor can take over", async (t) => {
  const { doc } = setup(t);
  const tabs = doc.querySelectorAll('#hero-tabs [role="tab"]');
  const shown = () => doc.querySelector(".hero-panel[data-on]").dataset.face;
  assert.equal(doc.getElementById("hero-tabs").dataset.auto, "on");
  assert.equal(shown(), "mixer");
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].tabIndex, -1);
  await new Promise((resolve) => setTimeout(resolve, FACE_ROTATE_MS + 250));
  assert.equal(shown(), "visuals");
  assert.equal(doc.getElementById("hero-caption").textContent, FACES[1].caption);
  assert.equal(doc.querySelectorAll('#hero-tabs [aria-selected="true"]').length, 1);
  // One press hands the frame over: it stops rotating and stays where the visitor left it.
  tabs[0].click();
  assert.equal(doc.getElementById("hero-tabs").dataset.auto, "off");
  assert.equal(shown(), "mixer");
  assert.equal(tabs[0].tabIndex, 0);
  await new Promise((resolve) => setTimeout(resolve, FACE_ROTATE_MS + 250));
  assert.equal(shown(), "mixer");
});

test("arrow keys move between the hero's faces", (t) => {
  const { doc, window } = setup(t);
  const tabs = doc.querySelectorAll('#hero-tabs [role="tab"]');
  const press = (tab, key) =>
    tab.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  press(tabs[0], "ArrowRight");
  assert.equal(doc.querySelector(".hero-panel[data-on]").dataset.face, "visuals");
  assert.equal(doc.activeElement, tabs[1]);
  press(tabs[1], "ArrowRight");
  assert.equal(doc.querySelector(".hero-panel[data-on]").dataset.face, "mixer");
  press(tabs[0], "End");
  assert.equal(doc.querySelector(".hero-panel[data-on]").dataset.face, "visuals");
  press(tabs[1], "Home");
  assert.equal(doc.querySelector(".hero-panel[data-on]").dataset.face, "mixer");
  press(tabs[0], "Enter");
  assert.equal(doc.querySelector(".hero-panel[data-on]").dataset.face, "mixer");
});

test("mode and autonomy buttons relabel the tool board", (t) => {
  const { doc } = setup(t);
  doc.querySelector('[data-mode="learn"]').click();
  assert.equal(doc.querySelectorAll('[data-tool][data-state="hidden"]').length, 10);
  assert.equal(
    doc.getElementById("board-summary").textContent,
    "3 tools registered · 3 run on their own · 0 ask you first",
  );
  doc.querySelector('[data-mode="mix"]').click();
  doc.querySelector('[data-autonomy="observe"]').click();
  assert.equal(doc.querySelectorAll('[data-tool][data-state="asks"]').length, 7);
  assert.equal(doc.querySelector('[data-tool="arm-transition"]').dataset.state, "asks");
  doc.querySelector('[data-autonomy="copilot"]').click();
  assert.equal(doc.querySelectorAll('[data-tool][data-state="runs"]').length, 13);
  assert.equal(doc.querySelectorAll('[data-autonomy][aria-pressed="true"]').length, 1);
  assert.equal(doc.querySelectorAll('[data-mode][aria-pressed="true"]').length, 1);
});

test("the proposal loop: ask, card, accept, undo, reset — and dismiss", (t) => {
  const { doc } = setup(t);
  const card = doc.getElementById("proposal-card");
  assert.equal(card.hidden, true);
  doc.getElementById("chat-run").click();
  assert.equal(card.hidden, false);
  assert.equal(doc.querySelectorAll("[data-step][data-on]").length, 4);
  assert.equal(doc.getElementById("chat-run").disabled, true);
  doc.getElementById("proposal-accept").click();
  assert.match(doc.getElementById("proposal-status").textContent, /confirmedBy: user/);
  assert.equal(doc.getElementById("proposal-undo").hidden, false);
  doc.getElementById("proposal-undo").click();
  assert.match(doc.getElementById("proposal-status").textContent, /Undone/);
  doc.getElementById("proposal-reset").click();
  assert.equal(card.hidden, true);
  assert.equal(doc.querySelectorAll("[data-step][data-on]").length, 0);
  assert.equal(doc.activeElement, doc.getElementById("chat-run"));
  doc.getElementById("chat-run").click();
  doc.getElementById("proposal-dismiss").click();
  assert.match(doc.getElementById("proposal-status").textContent, /Dismissed/);
  assert.equal(doc.getElementById("proposal-accept").disabled, true);
});

test("a prompt starter copies its exact text for the browser agent", async (t) => {
  const { doc, window } = setup(t);
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  doc.querySelector('[data-copy-prompt="prompt-prepare"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, [doc.getElementById("prompt-prepare").textContent.trim()]);
  assert.match(doc.getElementById("prompt-copy-status").textContent, /Prepare prompt copied/);
});

test("a roadmap sketch plays and stops when its button is pressed", (t) => {
  const { doc } = setup(t);
  const art = doc.querySelector('.stop[data-idea="game"] .stop-art');
  assert.equal(art.getAttribute("aria-pressed"), "false");
  art.click();
  assert.equal(art.getAttribute("aria-pressed"), "true");
  assert.equal(doc.querySelectorAll('.stop-art[aria-pressed="true"]').length, 1);
  art.click();
  assert.equal(art.getAttribute("aria-pressed"), "false");
});

test("the 3-in-1 concept: ask, keep, reset", (t) => {
  const { doc } = setup(t);
  const ghosts = doc.querySelectorAll("[data-ghost]");
  assert.equal(ghosts.length, 4);
  assert.ok(Array.from(ghosts).every((ghost) => ghost.hasAttribute("hidden")));
  doc.getElementById("daw-ask").click();
  assert.ok(Array.from(ghosts).every((ghost) => !ghost.hasAttribute("hidden")));
  assert.equal(doc.getElementById("daw-accept").disabled, false);
  doc.getElementById("daw-accept").click();
  assert.equal(doc.querySelectorAll("[data-ghost][data-solid]").length, 4);
  assert.match(doc.getElementById("daw-status").textContent, /Kept/);
  doc.getElementById("daw-reset").click();
  assert.ok(
    Array.from(ghosts).every((ghost) => ghost.hasAttribute("hidden") && !ghost.hasAttribute("data-solid")),
  );
  assert.equal(doc.getElementById("daw-ask").disabled, false);
  assert.equal(doc.activeElement, doc.getElementById("daw-ask"));
});

test("the motion toggle pauses the page's motion and relabels itself", (t) => {
  const { doc } = setup(t);
  const toggle = doc.getElementById("motion-toggle");
  assert.equal(doc.documentElement.dataset.motion, "playing");
  assert.equal(toggle.querySelector(".motion-label").textContent, "Pause motion");
  toggle.click();
  assert.equal(doc.documentElement.dataset.motion, "paused");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.querySelector(".motion-label").textContent, "Play motion");
  assert.equal(toggle.querySelector(".motion-icon").textContent, "▶");
  assert.equal(doc.getElementById("hero-art").style.getPropertyValue("--px"), "0");
  assert.equal(doc.getElementById("hero-tabs").dataset.auto, "off");
  toggle.click();
  assert.equal(doc.documentElement.dataset.motion, "playing");
  assert.equal(doc.getElementById("hero-tabs").dataset.auto, "on");
});

test("reduced motion is respected initially and on system changes", (t) => {
  const { doc, reduce } = setup(t, true);
  assert.equal(doc.documentElement.dataset.motion, "paused");
  // No self-rotating frame for a visitor who asked for less motion.
  assert.equal(doc.getElementById("hero-tabs").dataset.auto, "off");
  reduce(false);
  assert.equal(doc.documentElement.dataset.motion, "playing");
  reduce(true);
  assert.equal(doc.documentElement.dataset.motion, "paused");
});

test("scroll reveals mark blocks shown, and show everything when there is no observer", (t) => {
  const { doc, reveal } = setup(t);
  const block = doc.querySelector("[data-reveal]");
  assert.equal(block.hasAttribute("data-shown"), false);
  reveal(block);
  assert.equal(block.hasAttribute("data-shown"), true);
  const plain = setup(t, false, false);
  assert.equal(
    plain.doc.querySelectorAll("[data-reveal]").length,
    plain.doc.querySelectorAll("[data-reveal][data-shown]").length,
  );
});

test("privacy deep link opens the actual FAQ answer", (t) => {
  const { doc } = setup(t);
  doc.querySelector('a[href="#faq-privacy"]').click();
  assert.equal(doc.getElementById("faq-privacy").open, true);
});

test("cleanup removes interaction handlers", (t) => {
  const { doc, cleanup } = setup(t);
  cleanup();
  doc.getElementById("motion-toggle").click();
  assert.equal(doc.documentElement.dataset.motion, "playing");
  doc.getElementById("daw-ask").click();
  assert.equal(doc.getElementById("daw-status").textContent, "Your project. No suggestions yet.");
});
