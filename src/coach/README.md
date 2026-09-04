# Guided learning

The Guide runs declarative lessons against real session and audio-engine state.

- `types.ts` defines lessons, steps, completion conditions, locks, and scores.
- `engine.ts` advances the lesson, coordinates calibration, and runs demonstrations.
- `guide-store.ts` exposes the current step and highlighted control to the UI.
- `lessons/lesson1.ts` defines the phrase-entry blend lesson.

The overlay presents one next action at a time. Completion and feedback must come
from actual deck and mixer state, not elapsed animation time. Transport still
uses the shared engine actions.

Keep cleanup on lesson exit, keyboard accessibility, control locks, and
reduced-motion behavior intact when extending a lesson.
