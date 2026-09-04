# Mixerx introduction website

The introduction website explains Mixerx through product features, real interface
captures, agent examples, and a recorded demo. In local development it lives at
`/mixerx/`; the instrument keeps `/`.

This is a separate presentation surface, not another Console or audio engine.

## Content and assets

- `index.html`: product overview, features, agent examples, roadmap, and FAQ.
- `main.js` and `experience.mjs`: interactive examples, prompt copying, motion
  controls, and the opt-in video player.
- `style.css`: layout, color, typography, and responsive behavior.
- `shots/`: interface captures used by the page; retain them in Git.
- `mark.svg`: the page's brand mark.
- `security.mjs`: the introduction page's media policy and response headers.

The page uses bundled Syne, IBM Plex Sans, and Space Mono fonts. Captures show
the application in a test environment; Stage images may use the labeled test
signal. Interactive explanatory examples are scripted illustrations, not
connections to a live deck or agent.

Keep current features distinct from future ideas. Product copy should describe
what a visitor can do without implementation phases, task history, or promises
of unverified performance.

## Run and build

From the repository root:

```bash
npm run dev -- --host 127.0.0.1
```

Open [the introduction page](http://localhost:4187/mixerx/).

Build and test it separately:

```bash
npx vite build --config mixerx/vite.config.mjs
node --test mixerx/landing.test.mjs
```

Output goes to `mixerx/dist/`, which is ignored. The root `npm run build`
does not include this website. Use `npm run build:site` to package both surfaces
under `dist/` for Sites, with this page at `/mixerx/`. No build command publishes it.

## Media and security

The YouTube demo uses a local screenshot as its poster. The player is created
only after activation and uses `https://www.youtube-nocookie.com`. A direct link
remains available if embedding fails. Provider and browser restrictions can still
prevent playback.

Only this document permits that external frame. Its headers disable COEP and
send an origin-only cross-origin referrer to support playback. Parent-page
connections remain same-origin.

Any host serving this page must apply the headers from `security.mjs` separately.
Do not weaken the Console or Stage policy to accommodate the video.
The combined Sites package configures the worker to apply those headers only to
`/mixerx/` and `/mixerx/index.html`; missing introduction files return a real 404.

The page's motion toggle and reduced-motion support control its decorative
animation, not the third-party video player's playback.
