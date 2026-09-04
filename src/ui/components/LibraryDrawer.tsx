import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  Headphones,
  Library,
  ListPlus,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { t } from "../../app/i18n-core";
import { deckActions, previewActions } from "../../engine/actions";
import { type Compatibility, camelotHue } from "../../library/compatibility";
import { getLibrary } from "../../library/library";
import {
  type CompatibilityReference,
  compatibilityOf,
  type EnergyBand,
  filterTracks,
  type LibraryFilters,
  type LibrarySort,
  libraryStore,
  useLibrary,
} from "../../library/library-store";
import { queueActions } from "../../library/queue";
import { directoryPickerAvailable } from "../../library/sources";
import type { LibraryTrack } from "../../library/types";
import type { DeckId, Section } from "../../state/session";
import { useSession } from "../../state/session-store";
import { clampDrawerHeight, DRAWER_MIN_HEIGHT, uiStore, useUi } from "../../state/ui-store";
import { formatTime } from "../engine-hooks";
import { withViewTransition } from "../view-transition";
import { SamplerPads } from "./SamplerPads";

const TRACK_MIME = "text/x-mixerx-track";
const ENERGY_BANDS: EnergyBand[] = ["all", "low", "mid", "high"];
const SORTS: LibrarySort[] = ["default", "compat", "bpm", "energy", "title"];
const SECTION_COLOURS: Record<Section["kind"], string> = {
  intro: "#4b5563",
  build: "#b98a2f",
  drop: "#c2410c",
  break: "#1d4ed8",
  body: "#374151",
  outro: "#4b5563",
};

function toneFor(confidence: number | undefined): string {
  if (confidence === undefined) return "";
  return confidence >= 0.7 ? "dot--ok" : confidence >= 0.4 ? "dot--warn" : "dot--danger";
}

function Artwork({ track }: { track: LibraryTrack }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!track.hasArtwork) {
      setUrl(null);
      return;
    }
    void getLibrary()
      .artworkUrl(track.id)
      .then((value) => {
        if (!cancelled) setUrl(value);
      });
    return () => {
      cancelled = true;
    };
  }, [track.id, track.hasArtwork]);
  return url ? (
    <img className="track-art" src={url} alt="" width={28} height={28} loading="lazy" />
  ) : (
    <span className="track-art track-art--empty" aria-hidden="true" />
  );
}

function KeyChip({ camelot, confidence }: { camelot: string | undefined; confidence: number | undefined }) {
  const hue = camelotHue(camelot);
  if (!camelot || hue === null) return <span className="num">—</span>;
  return (
    <span className="key-chip num" style={{ "--hue": hue } as CSSProperties}>
      {camelot}
      {confidence !== undefined && <span className={`dot ${toneFor(confidence)}`} />}
    </span>
  );
}

function SectionsStrip({ sections }: { sections: Section[] | undefined }) {
  if (!sections?.length) return <span className="sections sections--empty" />;
  const total = sections[sections.length - 1]?.endBar ?? 1;
  return (
    <span className="sections" role="img" aria-label={sections.map((section) => section.kind).join(", ")}>
      {sections.map((section) => (
        <i
          key={`${section.kind}-${section.startBar}`}
          style={{
            flex: Math.max(1, section.endBar - section.startBar),
            background: SECTION_COLOURS[section.kind],
          }}
        />
      ))}
      <span className="sr-only">{total}</span>
    </span>
  );
}

function CompatCell({ compat }: { compat: Compatibility | null }) {
  if (!compat) return <span className="num">—</span>;
  const parts: string[] = [];
  if (compat.key) parts.push(t(`library.compat.${compat.key}`));
  if (compat.tempoDeltaPct !== null)
    parts.push(`${compat.tempoDeltaPct > 0 ? "+" : ""}${compat.tempoDeltaPct.toFixed(1)} %`);
  const detail = [...parts];
  if (compat.energyDelta !== null) detail.push(`E${compat.energyDelta > 0 ? "+" : ""}${compat.energyDelta}`);
  const tone = compat.score >= 0.8 ? "ok" : compat.score >= 0.5 ? "warn" : "danger";
  return (
    <span className={`compat compat--${tone}`} title={detail.join(" · ")}>
      <span className="compat__bar" style={{ width: `${Math.round(compat.score * 100)}%` }} />
      <span className="compat__text num">{parts.join(" · ")}</span>
    </span>
  );
}

interface TrackRowProps {
  track: LibraryTrack;
  selected: boolean;
  previewing: boolean;
  queued: boolean;
  compat: Compatibility | null;
  onSelect(): void;
  onLoad(deck: DeckId): void;
}

function TrackRow({ track, selected, previewing, queued, compat, onSelect, onLoad }: TrackRowProps) {
  const onDragStart = (event: DragEvent<HTMLTableRowElement>) => {
    event.dataTransfer.setData(TRACK_MIME, track.id);
    event.dataTransfer.effectAllowed = "copy";
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    const key = event.key.toLowerCase();
    if (key === "a") onLoad("A");
    else if (key === "b") onLoad("B");
    else if (key === "c") void previewActions.toggle(track.id);
    else if (key === "q") queueActions.toggle(track.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <tr
      className={selected ? "track-row is-selected" : "track-row"}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onLoad("A")}
      data-testid={`track-${track.id}`}
    >
      <td className="track-row__art">
        <Artwork track={track} />
      </td>
      <td className="track-row__title">
        <strong>{track.title}</strong>
        <small>{track.artist || track.relativePath}</small>
      </td>
      <td className="num">
        {track.bpm ? track.bpm.toFixed(1) : "—"}
        {track.bpm !== undefined && track.gridConfidence !== undefined && (
          <span className={`dot ${toneFor(track.gridConfidence)}`} />
        )}
      </td>
      <td>
        <KeyChip camelot={track.camelot} confidence={track.keyConfidence} />
      </td>
      <td className="num">{track.energy ?? "—"}</td>
      <td className="track-row__sections">
        <SectionsStrip sections={track.sections} />
      </td>
      <td className="track-row__compat">
        <CompatCell compat={compat} />
      </td>
      <td className="num">{track.durationSec ? formatTime(track.durationSec) : "—"}</td>
      <td className={`track-row__state track-row__state--${track.analysisState}`}>
        {t(`library.state.${track.analysisState}`)}
        {track.analysisState === "analysing" && track.analysisStage ? ` · ${track.analysisStage}` : ""}
      </td>
      <td className="track-row__actions">
        <button
          type="button"
          className="btn-small"
          onClick={(event) => {
            event.stopPropagation();
            onLoad("A");
          }}
          data-testid={`load-A-${track.id}`}
        >
          {t("library.loadA")}
        </button>
        <button
          type="button"
          className="btn-small"
          onClick={(event) => {
            event.stopPropagation();
            onLoad("B");
          }}
          data-testid={`load-B-${track.id}`}
        >
          {t("library.loadB")}
        </button>
        <button
          type="button"
          className="btn-small btn-icon"
          aria-pressed={previewing}
          aria-label={t("library.preview")}
          title={`${t("library.preview")} (C)`}
          onClick={(event) => {
            event.stopPropagation();
            void previewActions.toggle(track.id);
          }}
          data-testid={`preview-${track.id}`}
        >
          <Headphones size={14} />
        </button>
        <button
          type="button"
          className="btn-small btn-icon"
          aria-pressed={queued}
          aria-label={queued ? t("library.inQueue") : t("library.addQueue")}
          title={`${queued ? t("library.inQueue") : t("library.addQueue")} (Q)`}
          onClick={(event) => {
            event.stopPropagation();
            queueActions.toggle(track.id);
          }}
          data-testid={`queue-${track.id}`}
        >
          <ListPlus size={14} />
        </button>
      </td>
    </tr>
  );
}

function EnergyArc({ energies }: { energies: number[] }) {
  if (energies.length < 2) return null;
  const width = 160;
  const height = 32;
  const points = energies
    .map((energy, index) => {
      const x = (index / (energies.length - 1)) * (width - 8) + 4;
      const y = height - 4 - ((Math.max(1, Math.min(10, energy)) - 1) / 9) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="energy-arc"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={t("library.queueEnergy", { list: energies.join(" → ") })}
      data-testid="energy-arc"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
      {energies.map((energy, index) => {
        const x = (index / (energies.length - 1)) * (width - 8) + 4;
        const y = height - 4 - ((Math.max(1, Math.min(10, energy)) - 1) / 9) * (height - 8);
        return <circle key={x.toFixed(1)} cx={x} cy={y} r="2.5" fill="currentColor" />;
      })}
    </svg>
  );
}

function QueuePanel({ tracks, load }: { tracks: LibraryTrack[]; load(deck: DeckId, trackId: string): void }) {
  const energies = tracks.map((track) => track.energy ?? 5);
  return (
    <div className="drawer__queue" data-testid="queue">
      <h3 className="label">
        {t("library.queue")} <span className="num">{tracks.length ? tracks.length : ""}</span>
      </h3>
      {tracks.length === 0 ? (
        <div className="drawer__empty">{t("library.queueEmpty")}</div>
      ) : (
        <>
          <EnergyArc energies={energies} />
          <ol className="queue-list" data-testid="queue-list">
            {tracks.map((track, index) => (
              <li key={track.id} className="queue-item">
                <span className="queue-item__index num">{index + 1}</span>
                <span className="queue-item__title">
                  <strong>{track.title}</strong>
                  <small className="num">
                    {track.bpm ? track.bpm.toFixed(1) : "—"} · {track.camelot ?? "—"} · E{track.energy ?? "—"}
                  </small>
                </span>
                <span className="queue-item__actions">
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => load("A", track.id)}
                    title={t("library.loadA")}
                  >
                    A
                  </button>
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => load("B", track.id)}
                    title={t("library.loadB")}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-icon"
                    aria-label={t("library.moveUp")}
                    disabled={index === 0}
                    onClick={() => queueActions.move(track.id, -1)}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-icon"
                    aria-label={t("library.moveDown")}
                    disabled={index === tracks.length - 1}
                    onClick={() => queueActions.move(track.id, 1)}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-icon"
                    aria-label={t("library.remove")}
                    onClick={() => queueActions.remove(track.id)}
                    data-testid={`queue-remove-${track.id}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function LibraryDrawer() {
  const { drawerOpen, drawerHeight } = useUi();
  const library = useLibrary();
  const session = useSession();
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [demoBusy, setDemoBusy] = useState(false);

  /**
   * Renders the bundled-in-code demo pair and adds it the way a dropped file is added, so the first
   * visitor has something to mix without a download. Rendering blocks for about half a second per
   * track, so the busy state is painted first and the two renders are separated by a frame.
   */
  async function loadDemoTracks() {
    if (demoBusy) return;
    setDemoBusy(true);
    try {
      const { demoTrackFiles } = await import("../../library/demo-tracks");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await getLibrary().addFiles(demoTrackFiles(), "Demo tracks");
    } finally {
      setDemoBusy(false);
    }
  }

  const referenceDeck: DeckId | null = session.decks.A.onAir
    ? "A"
    : session.decks.B.onAir
      ? "B"
      : session.decks.A.track
        ? "A"
        : session.decks.B.track
          ? "B"
          : null;
  const referenceTrack = referenceDeck
    ? library.tracks.find((track) => track.id === session.decks[referenceDeck].track?.id)
    : undefined;
  const reference: CompatibilityReference | null = referenceTrack
    ? { camelot: referenceTrack.camelot, bpm: referenceTrack.bpm, energy: referenceTrack.energy }
    : null;
  const tracks = filterTracks(library.tracks, library.query, library.filters, reference, library.sort);
  const queueTracks = session.queue
    .map((id) => library.tracks.find((track) => track.id === id))
    .filter((track): track is LibraryTrack => Boolean(track));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startY: event.clientY, startHeight: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    uiStore.dispatch({
      type: "ui/drawerHeight",
      height: clampDrawerHeight(
        drag.current.startHeight + (drag.current.startY - event.clientY),
        window.innerHeight,
      ),
    });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onHandleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
    if (!delta) return;
    event.preventDefault();
    uiStore.dispatch({
      type: "ui/drawerHeight",
      height: clampDrawerHeight(drawerHeight + delta, window.innerHeight),
    });
  };

  const load = (deck: DeckId, trackId: string) => {
    libraryStore.dispatch({ type: "library/select", id: trackId });
    void deckActions.load(deck, trackId);
  };

  const onListKey = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = tracks.findIndex((track) => track.id === library.selectedId);
    const next =
      tracks[Math.max(0, Math.min(tracks.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      libraryStore.dispatch({ type: "library/select", id: next.id });
      event.currentTarget.querySelector<HTMLElement>(`[data-testid="track-${next.id}"]`)?.focus();
    }
  };

  const onDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length)
      await getLibrary().addFiles(
        files,
        files.length === 1 ? (files[0]?.name ?? "Files") : `${files.length} files`,
      );
  };

  const setFilter = (patch: Partial<LibraryFilters>) =>
    libraryStore.dispatch({ type: "library/filters", filters: patch });

  return (
    <section
      className={drawerOpen ? "drawer" : "drawer drawer--closed"}
      style={{ "--drawer-h": `${drawerHeight}px` } as CSSProperties}
      aria-labelledby="library-title"
      data-testid="library-drawer"
      data-open={drawerOpen}
      data-guide-target="library"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => void onDrop(event)}
    >
      <div
        className="drawer__handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("library.resize")}
        aria-valuemin={DRAWER_MIN_HEIGHT}
        aria-valuenow={drawerHeight}
        tabIndex={drawerOpen ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onHandleKey}
      />
      <header className="drawer__head">
        <button
          type="button"
          className="icon-btn"
          aria-label={drawerOpen ? t("library.close") : t("library.open")}
          aria-expanded={drawerOpen}
          aria-controls="library-body"
          onClick={() => withViewTransition(() => uiStore.dispatch({ type: "ui/drawer", open: !drawerOpen }))}
          data-testid="drawer-toggle"
        >
          {drawerOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <Library size={16} aria-hidden="true" />
        <h2 id="library-title" className="drawer__title">
          {t("library.title")}
        </h2>
        <span className="muted">{t("library.tracks", { count: library.tracks.length })}</span>
        {library.scanning && <span className="muted">{t("library.scanning")}</span>}
        {library.analysing > 0 && (
          <span className="muted" data-testid="library-analysing">
            {t("library.analysing", { count: library.analysing })}
          </span>
        )}
        <span className="drawer__spacer" />
        {library.sources
          .filter((source) => source.kind === "directory" && source.permission !== "granted")
          .map((source) => (
            <button
              key={source.id}
              type="button"
              className="btn-small"
              onClick={() => void getLibrary().regrantDirectory(source.id)}
            >
              {source.name}: {t("library.regrant")}
            </button>
          ))}
        {directoryPickerAvailable() && (
          <button
            type="button"
            className="btn-small"
            onClick={() => void getLibrary().addDirectory()}
            data-testid="add-folder"
          >
            <FolderPlus size={14} /> {t("library.addFolder")}
          </button>
        )}
        <button
          type="button"
          className="btn-small"
          onClick={() => fileInput.current?.click()}
          data-testid="add-files"
        >
          <Upload size={14} /> {t("library.addFiles")}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.aiff"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) void getLibrary().addFiles(files, `${files.length} files`);
            event.target.value = "";
          }}
        />
      </header>
      <div className="drawer__body" id="library-body">
        <div className="drawer__list">
          <div className="drawer__toolbar">
            <form className="drawer__search" onSubmit={(event) => event.preventDefault()}>
              <input
                type="search"
                aria-label={t("library.search")}
                placeholder={t("library.search")}
                value={library.query}
                onChange={(event) =>
                  libraryStore.dispatch({ type: "library/query", query: event.target.value })
                }
                data-testid="library-search"
              />
            </form>
            <select
              aria-label={t("library.filter.source")}
              value={library.filters.sourceId ?? ""}
              onChange={(event) => setFilter({ sourceId: event.target.value || null })}
              data-testid="filter-source"
            >
              <option value="">{t("library.filter.allSources")}</option>
              {library.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.kind === "manifest" ? t("library.devSource") : source.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-small"
              aria-pressed={library.filters.keyCompatible}
              disabled={!reference?.camelot}
              onClick={() => setFilter({ keyCompatible: !library.filters.keyCompatible })}
              title={
                reference
                  ? t("library.filter.keyHint", { deck: referenceDeck ?? "" })
                  : t("library.filter.noReference")
              }
              data-testid="filter-key"
            >
              {t("library.filter.key")}
            </button>
            <button
              type="button"
              className="btn-small"
              aria-pressed={library.filters.tempoWindow}
              disabled={!reference?.bpm}
              onClick={() => setFilter({ tempoWindow: !library.filters.tempoWindow })}
              title={
                reference
                  ? t("library.filter.tempoHint", { deck: referenceDeck ?? "" })
                  : t("library.filter.noReference")
              }
              data-testid="filter-tempo"
            >
              {t("library.filter.tempo")}
            </button>
            <select
              aria-label={t("library.filter.energy")}
              value={library.filters.energyBand}
              onChange={(event) => setFilter({ energyBand: event.target.value as EnergyBand })}
              data-testid="filter-energy"
            >
              {ENERGY_BANDS.map((band) => (
                <option key={band} value={band}>
                  {t(`library.energy.${band}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("library.sort")}
              value={library.sort}
              onChange={(event) =>
                libraryStore.dispatch({ type: "library/sort", sort: event.target.value as LibrarySort })
              }
              data-testid="library-sort"
            >
              {SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {t(`library.sortBy.${sort}`)}
                </option>
              ))}
            </select>
            <span className="muted num" data-testid="library-count">
              {tracks.length}/{library.tracks.length}
            </span>
          </div>
          {tracks.length === 0 ? (
            <div className="drawer__empty">
              {!library.ready ? (
                "…"
              ) : library.tracks.length === 0 ? (
                <div className="drawer__onboard">
                  <p>{t("library.empty")}</p>
                  <button
                    type="button"
                    className="btn-small btn-primary"
                    onClick={() => void loadDemoTracks()}
                    disabled={demoBusy}
                    data-testid="load-demo"
                  >
                    <Sparkles size={14} /> {demoBusy ? t("library.demoLoading") : t("library.demoLoad")}
                  </button>
                  <p className="muted">{t("library.demoNote")}</p>
                </div>
              ) : (
                t("library.empty")
              )}
            </div>
          ) : (
            <table
              className="track-list"
              aria-label={t("library.title")}
              onKeyDown={onListKey}
              data-testid="track-list"
            >
              <thead>
                <tr className="track-list__head">
                  <th scope="col">
                    <span className="sr-only">{t("library.col.art")}</span>
                  </th>
                  <th scope="col">{t("library.col.title")}</th>
                  <th scope="col">{t("library.col.bpm")}</th>
                  <th scope="col">{t("library.col.key")}</th>
                  <th scope="col">{t("library.col.energy")}</th>
                  <th scope="col">{t("library.col.sections")}</th>
                  <th scope="col">
                    {referenceDeck
                      ? t("library.col.compat", { deck: referenceDeck })
                      : t("library.col.compatNone")}
                  </th>
                  <th scope="col">{t("library.col.time")}</th>
                  <th scope="col">{t("library.col.state")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("deck.load")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    selected={library.selectedId === track.id}
                    previewing={library.previewId === track.id}
                    queued={session.queue.includes(track.id)}
                    compat={compatibilityOf(track, reference)}
                    onSelect={() => libraryStore.dispatch({ type: "library/select", id: track.id })}
                    onLoad={(deck) => load(deck, track.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
        <QueuePanel tracks={queueTracks} load={load} />
        {session.mode === "perform" && (
          <div className="drawer__sampler">
            <h3 className="label">{t("sampler.title")}</h3>
            <SamplerPads />
          </div>
        )}
      </div>
    </section>
  );
}
