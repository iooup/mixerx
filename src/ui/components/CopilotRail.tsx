import { Bot, PanelRightClose, PanelRightOpen, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { registry } from "../../agent";
import { activityStore, canUndo, undoActivity, useActivity } from "../../agent/activity-store";
import { explainAvailable, explainProposal } from "../../agent/explain";
import { t } from "../../app/i18n-core";
import { useGuide } from "../../coach/guide-store";
import { lesson1 } from "../../coach/lessons/lesson1";
import { previewActions } from "../../engine/actions";
import type { Proposal } from "../../state/session";
import { AUTONOMY_LEVELS, sessionStore, useSession } from "../../state/session-store";
import { useRail } from "../hooks";
import { Segmented } from "./Segmented";

function proposalTrackId(proposal: Proposal): string | null {
  const payload = proposal.payload as { input?: { trackId?: string } } | null;
  return payload?.input?.trackId ?? null;
}

function ProposalCard({ proposal, explain }: { proposal: Proposal; explain: boolean }) {
  const { autonomy, routing } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const trackId = proposalTrackId(proposal);
  const canPreview = Boolean(trackId) && routing.mode !== "single" && routing.cueConnected;

  const accept = async () => {
    setBusy(true);
    setError(null);
    const result = await registry.accept(proposal.id);
    if (result.status !== "ok") setError(result.error ?? result.status);
    setBusy(false);
  };

  const askExplanation = async () => {
    setBusy(true);
    try {
      setExplanation(await explainProposal(proposal));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={`proposal proposal--${proposal.kind}`}
      data-testid={`proposal-${proposal.id}`}
      data-kind={proposal.kind}
    >
      <header className="proposal__head">
        <strong className="proposal__title">{proposal.title}</strong>
        <span className={`badge badge--${proposal.source === "webmcp" ? "agent" : "muted"} proposal__source`}>
          {t(`proposal.source.${proposal.source}`)}
        </span>
      </header>
      {proposal.reasons.length > 0 && (
        <ul className="proposal__reasons">
          {proposal.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <p className="proposal__why muted">{t("proposal.why", { level: t(`autonomy.${autonomy}`) })}</p>
      {explanation && <p className="proposal__explanation">{explanation}</p>}
      {error && (
        <p className="proposal__error" role="alert">
          {error}
        </p>
      )}
      <div className="proposal__actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void accept()}
          data-testid={`proposal-accept-${proposal.id}`}
        >
          {t(`proposal.accept.${proposal.kind}`)}
        </button>
        {canPreview && trackId && (
          <button type="button" disabled={busy} onClick={() => void previewActions.toggle(trackId)}>
            {t("library.preview")}
          </button>
        )}
        {explain && (
          <button type="button" disabled={busy} onClick={() => void askExplanation()}>
            {t("proposal.explain")}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => registry.dismiss(proposal.id)}
          data-testid={`proposal-dismiss-${proposal.id}`}
        >
          {t("proposal.dismiss")}
        </button>
      </div>
    </article>
  );
}

function ActivityLog() {
  const { entries } = useActivity();
  const recent = [...entries].reverse().slice(0, 12);
  if (!recent.length) return <p className="rail__empty">{t("rail.noActivity")}</p>;
  return (
    <ol className="activity" data-testid="activity-log">
      {recent.map((entry) => (
        <li
          key={entry.id}
          className={`activity__item activity__item--${entry.status}`}
          data-testid={`activity-${entry.id}`}
        >
          <span className="activity__line">
            <b>{entry.tool}</b>
            <span className="activity__caller">
              {t(`proposal.source.${entry.caller === "harness" ? "local" : entry.caller}`)}
            </span>
            <span className="num">{entry.durationMs} ms</span>
          </span>
          <span className="activity__args num">{entry.args}</span>
          <span className="activity__result">
            {t(`activity.${entry.status}`)}
            {entry.confirmedBy ? ` · ${t("activity.confirmedByUser")}` : ""}
            {entry.error ? ` · ${entry.error}` : ""}
            {entry.undone ? ` · ${t("activity.undone")}` : ""}
          </span>
          {canUndo(entry.id) && !entry.undone && (
            <button
              type="button"
              className="btn-small"
              onClick={() => void undoActivity(entry.id)}
              data-testid={`undo-${entry.id}`}
            >
              <Undo2 size={12} /> {t("activity.undo")} · {entry.undoLabel}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

export function CopilotRail() {
  const session = useSession();
  const { collapsed, toggle } = useRail();
  const guide = useGuide();
  const learning = session.mode === "learn" && guide.status !== "idle";
  const [explain, setExplain] = useState(false);
  useEffect(() => {
    void explainAvailable().then(setExplain);
  }, []);
  const open = session.proposals
    .filter((proposal) => proposal.status === "open")
    .slice()
    .reverse();
  const agentText =
    session.agent.webmcp === "registered"
      ? t("agent.registeredTools", { count: session.agent.toolCount })
      : session.agent.webmcp === "available"
        ? t("agent.availableNone")
        : t("agent.unavailableLocal");

  return (
    <aside
      className={collapsed ? "panel rail rail--collapsed" : "panel rail"}
      aria-labelledby="rail-title"
      data-testid="copilot-rail"
      data-collapsed={collapsed}
    >
      <header className="panel__head">
        <span className="rail__head-title">
          <Bot size={16} aria-hidden="true" />
          <h2 id="rail-title" className="label">
            {t("rail.title")}
          </h2>
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label={collapsed ? t("rail.expand") : t("rail.collapse")}
          aria-expanded={!collapsed}
          onClick={toggle}
          data-testid="rail-toggle"
        >
          {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
      </header>
      <div className="rail__body panel__body">
        {learning && (
          <section className="rail__section rail__learn" data-testid="learn-rail">
            <h3 className="label">{t("rail.learn")}</h3>
            <p className="rail__note">{t(lesson1.title)}</p>
            <ol className="learn-steps">
              {lesson1.steps.map((step, index) => {
                const status =
                  index < guide.stepIndex ? "done" : index === guide.stepIndex ? "current" : "todo";
                return (
                  <li
                    key={step.id}
                    className={`learn-step learn-step--${status}`}
                    aria-current={status === "current" ? "step" : undefined}
                  >
                    <span className="learn-step__n num">{index + 1}</span>
                    <span className="learn-step__label">{t(`guide.l1.short.${step.id}`)}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        <section className="rail__section">
          <h3 className="label">{t("rail.autonomy")}</h3>
          <Segmented
            label={t("rail.autonomy")}
            value={session.autonomy}
            options={AUTONOMY_LEVELS.map((level) => ({ value: level, label: t(`autonomy.${level}`) }))}
            onChange={(autonomy) => sessionStore.dispatch({ type: "autonomy/set", autonomy })}
            testId="autonomy-switch"
            tone="agent"
          />
          <p className="muted rail__note">{t(`autonomy.hint.${session.autonomy}`)}</p>
          <p className="muted rail__note" data-testid="webmcp-status">
            {agentText}
          </p>
        </section>
        <section className="rail__section" data-testid="proposals">
          <h3 className="label">
            {t("rail.proposals")} {open.length ? <span className="num">{open.length}</span> : null}
          </h3>
          {open.length === 0 ? (
            <p className="rail__empty">{t("rail.noProposals")}</p>
          ) : (
            open.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} explain={explain} />)
          )}
        </section>
        <section className="rail__section">
          <h3 className="label">
            {t("rail.activity")}
            <button
              type="button"
              className="btn-small rail__clear"
              onClick={() => activityStore.dispatch({ type: "activity/clear" })}
            >
              {t("activity.clear")}
            </button>
          </h3>
          <ActivityLog />
        </section>
      </div>
    </aside>
  );
}
