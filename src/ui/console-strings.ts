/**
 * Strings for the console's lazy features (command palette, session recap, badges, MIDI). They
 * live outside `en.json` so the console entry does not carry them: each chunk merges them the
 * moment it is imported, the way the Stage merges its own.
 */

import { extendDictionaries } from "../app/i18n-core";
import extraEn from "../locales/console-extra.en.json";

extendDictionaries(extraEn);
