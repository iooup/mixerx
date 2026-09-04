/**
 * Local agent: deterministic rules that call the same tools an external agent would. The
 * registry's policy decides whether a call executes or becomes a proposal.
 */
import { compatibilityOf, libraryStore } from "../library/library-store";
import type { DeckId } from "../state/session";
import { sessionStore } from "../state/session-store";
import type { ToolRegistry } from "./registry";

const otherDeck = (deck: DeckId): DeckId => (deck === "A" ? "B" : "A");
const MIN_FIT = 0.65;

export class LocalCopilot {
  private readonly seen = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private readonly registry: ToolRegistry) {}

  start(): void {
    this.stop();
    const schedule = () => {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.evaluate();
      }, 1000);
    };
    this.unsubscribe = [sessionStore.subscribe(schedule), libraryStore.subscribe(schedule)];
    schedule();
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Best next track: the head of the queue, else the best-fitting analysed track. */
  pickNext(onAir: DeckId): string | null {
    const session = sessionStore.getState();
    const library = libraryStore.getState();
    const current = session.decks[onAir].track;
    if (!current) return null;
    const queued = session.queue.find(
      (id) => id !== current.id && library.tracks.some((track) => track.id === id),
    );
    if (queued) return queued;
    const reference = library.tracks.find((track) => track.id === current.id);
    if (!reference) return null;
    const ref = { camelot: reference.camelot, bpm: reference.bpm, energy: reference.energy };
    let best: { id: string; score: number } | null = null;
    for (const track of library.tracks) {
      if (track.id === current.id || track.analysisState !== "ready") continue;
      const fit = compatibilityOf(track, ref);
      if (fit && fit.score >= MIN_FIT && (!best || fit.score > best.score))
        best = { id: track.id, score: fit.score };
    }
    return best?.id ?? null;
  }

  /** Proposals whose situation has changed are expired, never silently left open. */
  private expireStale(session: ReturnType<typeof sessionStore.getState>): void {
    const onAir = session.decks.A.onAir || session.decks.B.onAir;
    for (const proposal of session.proposals) {
      if (proposal.status !== "open") continue;
      const payload = proposal.payload as {
        tool?: string;
        input?: { deck?: DeckId; trackId?: string };
      } | null;
      const deck = payload?.input?.deck;
      if (
        proposal.kind === "load" &&
        deck &&
        (session.decks[deck].onAir || session.decks[deck].track?.id === payload?.input?.trackId)
      ) {
        this.registry.expire(proposal.id);
      } else if ((proposal.kind === "transition" || proposal.kind === "enter") && !onAir) {
        this.registry.expire(proposal.id);
      }
    }
  }

  async evaluate(): Promise<void> {
    if (this.busy) return;
    const session = sessionStore.getState();
    this.expireStale(session);
    if (session.mode === "learn") return; // the Guide owns LEARN
    const onAir: DeckId | null = session.decks.A.onAir ? "A" : session.decks.B.onAir ? "B" : null;
    if (!onAir) return;
    const other = otherDeck(onAir);
    const current = session.decks[onAir].track;
    const target = session.decks[other];
    if (!current) return;
    this.busy = true;
    try {
      if (!target.track && !target.playing) {
        const next = this.pickNext(onAir);
        const key = `load:${current.id}:${next}`;
        if (next && !this.seen.has(key)) {
          this.seen.add(key);
          await this.registry.invoke("load-deck", { deck: other, trackId: next }, { caller: "local" });
        }
        return;
      }
      if (
        target.track &&
        target.analysis &&
        session.decks[onAir].analysis &&
        !target.playing &&
        session.scheduled.length === 0
      ) {
        const key = `transition:${current.id}:${target.track.id}`;
        if (!this.seen.has(key)) {
          this.seen.add(key);
          await this.registry.invoke("arm-transition", { toDeck: other }, { caller: "local" });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
