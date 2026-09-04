import { mountExperience } from "./experience.mjs";

const cleanup = mountExperience(document, window);
if (import.meta.hot) import.meta.hot.dispose(cleanup);
