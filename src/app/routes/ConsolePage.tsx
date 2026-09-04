import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { startAgentLayer } from "../../agent";
import { guide } from "../../coach/engine";
import { useGuide } from "../../coach/guide-store";
import { lesson1 } from "../../coach/lessons/lesson1";
import { getLibrary } from "../../library/library";
import { sessionStore, useSession } from "../../state/session-store";
import { uiStore, useUi } from "../../state/ui-store";
import { AudioSetup } from "../../ui/components/AudioSetup";
import { CopilotRail } from "../../ui/components/CopilotRail";
import { DeckPanel } from "../../ui/components/DeckPanel";
import { DevHarness } from "../../ui/components/DevHarness";
import { GuideOverlay } from "../../ui/components/GuideOverlay";
import { KeyboardMap } from "../../ui/components/KeyboardMap";
import { LibraryDrawer } from "../../ui/components/LibraryDrawer";
import { MixerPanel } from "../../ui/components/MixerPanel";
import { OnAirStrip } from "../../ui/components/OnAirStrip";
import { StagePreview } from "../../ui/components/StagePreview";
import { useRail } from "../../ui/hooks";
import { handleConsoleKey } from "../../ui/keyboard";
import type { ConsoleActions } from "../../ui/palette/sources";
import { withViewTransition } from "../../ui/view-transition";
import { t } from "../i18n-core";

interface PaletteProps {
  open: boolean;
  onClose(): void;
  context: { mode: ReturnType<typeof useSession>["mode"]; autonomy: string; actions: ConsoleActions };
}

interface RecapProps {
  open: boolean;
  onClose(): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, select, textarea, [contenteditable='true'], dialog[open]"))
  );
}

export function ConsolePage() {
  const { mode, autonomy } = useSession();
  const [presetNames, setPresetNames] = useState<string[]>([]);
  const { collapsed } = useRail();
  const [audioSetupOpen, setAudioSetupOpen] = useState(false);
  const [keyboardMapOpen, setKeyboardMapOpen] = useState(false);
  const [harnessOpen, setHarnessOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recapOpen, setRecapOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);

  const guideState = useGuide();

  const { stagePreviewOpen } = useUi();

  useEffect(() => {
    void getLibrary().open();
    startAgentLayer();
    // The Stage bridge lives in its own chunk; it starts listening for Stage windows at once.
    void import("../../visuals/console-bridge").then((bridge) => bridge.startStageBridge());
    void import("../../visuals/settings-store").then(({ stageSettingsStore }) => {
      const read = () => setPresetNames(stageSettingsStore.getState().presets.map((preset) => preset.name));
      read();
      stageSettingsStore.subscribe(read);
    });
  }, []);

  // LEARN runs Lesson 1; leaving the mode ends the lesson cleanly.
  useEffect(() => {
    if (mode === "learn") guide.start(lesson1);
    else guide.stop();
    return () => guide.stop();
  }, [mode]);

  // The palette and the recap live in their own chunks: the console entry carries only the key
  // that opens them, so a DJ who never presses ⌘K never downloads them.
  const [Palette, setPalette] = useState<ComponentType<PaletteProps> | null>(null);
  const [Recap, setRecap] = useState<ComponentType<RecapProps> | null>(null);
  useEffect(() => {
    if (!paletteOpen || Palette) return;
    void import("../../ui/components/CommandPalette").then((module) => {
      setPalette(() => module.CommandPalette as ComponentType<PaletteProps>);
    });
  }, [paletteOpen, Palette]);
  useEffect(() => {
    if (!recapOpen || Recap) return;
    void import("../../ui/components/SessionRecap").then((module) => {
      setRecap(() => module.SessionRecap as ComponentType<RecapProps>);
    });
  }, [recapOpen, Recap]);
  // The MIDI layer is its own chunk too: nothing touches `requestMIDIAccess` until it is opened.
  const [Midi, setMidi] = useState<ComponentType<RecapProps> | null>(null);
  useEffect(() => {
    if (!midiOpen || Midi) return;
    void import("../../ui/components/MidiSetup").then((module) => {
      setMidi(() => module.MidiSetup as ComponentType<RecapProps>);
    });
  }, [midiOpen, Midi]);
  // The development harness's virtual controller (tests and demos without hardware).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    void import("../../midi/router").then((module) => {
      module.installVirtualMidi();
    });
  }, []);

  const stageAction = useCallback(
    (run: (bridge: typeof import("../../visuals/console-bridge")) => Promise<unknown> | undefined) => {
      void import("../../visuals/console-bridge").then(run);
    },
    [],
  );

  const actions = useMemo<ConsoleActions>(
    () => ({
      toggleLibrary: () =>
        withViewTransition(() =>
          uiStore.dispatch({ type: "ui/drawer", open: !uiStore.getState().drawerOpen }),
        ),
      openAudioSetup: () => setAudioSetupOpen(true),
      openKeyboardMap: () => setKeyboardMapOpen(true),
      openRecap: () => setRecapOpen(true),
      openStudio: () =>
        stageAction((bridge) => {
          bridge.openStudio(bridge.startStageBridge().sessionId);
          return undefined;
        }),
      openDisplay: () =>
        stageAction(async (bridge) => {
          await bridge.openDisplay(bridge.startStageBridge().sessionId);
        }),
      openPreview: () =>
        stageAction(async (bridge) => {
          const sessionId = bridge.startStageBridge().sessionId;
          const pip = bridge.pictureInPictureAvailable()
            ? await bridge.openPictureInPicture(sessionId)
            : null;
          if (!pip) withViewTransition(() => uiStore.dispatch({ type: "ui/stagePreview", open: true }));
        }),
      toggleBlackout: () =>
        stageAction((bridge) => {
          bridge.startStageBridge().patch({ blackout: !sessionStore.getState().visuals.blackout });
          return undefined;
        }),
      setMode: (nextMode) =>
        withViewTransition(() => sessionStore.dispatch({ type: "mode/set", mode: nextMode })),
      applyPreset: (index) =>
        stageAction(async (bridge) => {
          const [store, protocol] = await Promise.all([
            import("../../visuals/settings-store"),
            import("../../visuals/protocol"),
          ]);
          const settings = store.stageSettingsStore.getState();
          const preset = settings.presets[index];
          if (preset) bridge.startStageBridge().patch(protocol.presetPatch(preset, settings));
        }),
      presetNames: () => presetNames,
    }),
    [stageAction, presetNames],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      // ⌘K / Ctrl+K reaches everything, so it works even while a field has focus.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        withViewTransition(() => setPaletteOpen((open) => !open));
        return;
      }
      const typing = isTypingTarget(event.target);
      if (typing && event.key !== "Escape") return;
      const handled = handleConsoleKey(event, {
        toggleDrawer: () =>
          withViewTransition(() =>
            uiStore.dispatch({ type: "ui/drawer", open: !uiStore.getState().drawerOpen }),
          ),
        toggleHelp: () => setKeyboardMapOpen((open) => !open),
        toggleHarness: () => setHarnessOpen((open) => !open),
        closeOverlays: () => {
          setKeyboardMapOpen(false);
          setAudioSetupOpen(false);
          setHarnessOpen(false);
          setPaletteOpen(false);
          setRecapOpen(false);
          setMidiOpen(false);
          uiStore.dispatch({ type: "ui/railOverlay", open: false });
          withViewTransition(() => uiStore.dispatch({ type: "ui/stagePreview", open: false }));
        },
      });
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <a className="skip-link" href="#console-main">
        {t("app.skipToConsole")}
      </a>
      <div className="app-console" data-mode={mode} data-testid="console">
        <OnAirStrip
          onOpenAudioSetup={() => setAudioSetupOpen(true)}
          onOpenRecap={() => setRecapOpen(true)}
          onOpenMidi={() => setMidiOpen(true)}
        />
        <main
          id="console-main"
          className={collapsed ? "console__main console__main--rail-collapsed" : "console__main"}
        >
          <DeckPanel id="A" />
          <MixerPanel
            crossfaderLocked={guideState.locks.includes("crossfader")}
            stripsLocked={guideState.locks.includes("strips")}
            phaseMeterHidden={mode === "learn" && !guideState.phaseMeterRevealed}
          />
          <DeckPanel id="B" />
          <CopilotRail />
        </main>
        <LibraryDrawer />
      </div>
      <GuideOverlay />
      {Palette && (
        <Palette
          open={paletteOpen}
          onClose={() => withViewTransition(() => setPaletteOpen(false))}
          context={{ mode, autonomy, actions }}
        />
      )}
      {Recap && <Recap open={recapOpen} onClose={() => setRecapOpen(false)} />}
      {Midi && <Midi open={midiOpen} onClose={() => setMidiOpen(false)} />}
      <AudioSetup open={audioSetupOpen} onClose={() => setAudioSetupOpen(false)} />
      <KeyboardMap open={keyboardMapOpen} onClose={() => setKeyboardMapOpen(false)} />
      <DevHarness open={harnessOpen} onClose={() => setHarnessOpen(false)} />
      {stagePreviewOpen && <StagePreview />}
      <div className="narrow-notice">
        <div>
          <h1>{t("narrow.title")}</h1>
          <p>{t("narrow.body")}</p>
        </div>
      </div>
    </>
  );
}
