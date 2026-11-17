import { useEffect, useState } from "react";
import { JitClientError, type JitClient } from "../client";
import type { ClientModelsView, ClientModelStep } from "../client/contracts";
import type { Copy } from "./copy";

/** Current protected configuration and budget facts; never discovers or enables a provider. */
export function ModelsPanel({ client, t, onFailure }: { client: JitClient; t: Copy; onFailure(error: unknown): void }) {
  const [data, setData] = useState<ClientModelsView | null>(null), [failed, setFailed] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    const stop = new AbortController(); setData(null); setFailed(false);
    void client.models(stop.signal).then(value => { if (!stop.signal.aborted) setData(value); }).catch(error => {
      if (stop.signal.aborted) return;
      if (error instanceof JitClientError && error.code === "client_response_stale") return;
      if (error instanceof JitClientError && [401, 403].includes(error.status ?? 0)) { onFailure(error); return; }
      setFailed(true);
    });
    return () => stop.abort();
  }, [client, reload]);
  return <details className="model-settings"><summary>{t("s16.models.title")}</summary>
    {!data && !failed && <p role="status">{t("s16.common.loading")}</p>}
    {failed && <p role="alert">{t("s16.models.loadFailed")} <button type="button" onClick={() => setReload(v => v + 1)}>{t("s16.bots.retry")}</button></p>}
    {data && <><p>{t("s16.models.configuredHint")}</p><a href="/settings/provider">{t("s16.models.signIn")}</a>
      {!data.routes.length && <p>{t("s16.models.empty")}</p>}
      <ul>{data.routes.map((route, index) => <li key={index}><strong>{route.provider} · {route.modelId} · {route.selection.effort}</strong>
        <p className="limits">{t(route.holdCode ? "s16.models.held" : "s16.models.available")}{route.holdCode && <> · <code>{route.holdCode}</code></>}</p>
        <dl className="model-facts"><dt>{t("s16.models.account")}</dt><dd>{route.account.id}</dd><dt>{t("s16.models.billing")}</dt><dd>{route.billing.id} · {route.charge}</dd><dt>{t("s16.models.recipient")}</dt><dd>{route.recipient.id}</dd></dl>
      </li>)}</ul>
      <h3>{t("s16.models.budget")}</h3><p>{t("s16.models.budgetHint")}</p>
      <dl className="model-facts">{data.budget.ceilings.map(row => <div key={row.dimension}><dt>{t(`s16.models.dimension.${row.dimension}`)}</dt><dd>{t("s16.models.reserved")}: {row.charged ?? t("s16.models.unknown")} · {t("s16.models.measured")}: {row.measured ?? t("s16.models.unknown")} · {t("s16.models.ceiling")}: {row.ceiling ?? t("s16.models.unknown")}{row.dimension === "spendMinor" && data.budget.currency ? ` (${data.budget.currency})` : ""}{row.unknown && <p className="limits">{t("s16.models.partial")}</p>}</dd></div>)}</dl>
      {data.budget.subscriptionLimits && <p>{t("s16.models.subscriptionLimits", { calls: data.budget.subscriptionLimits.perWork.calls, steps: data.budget.subscriptionLimits.perWork.steps, activeMs: data.budget.subscriptionLimits.perWork.activeMs, concurrency: data.budget.subscriptionLimits.concurrency })}</p>}
      <p>{t("s16.models.unsettled", { count: data.budget.unsettled })}</p>
      <button type="button" onClick={() => setReload(v => v + 1)}>{t("s16.card.refresh")}</button>
    </>}
  </details>;
}

/** Recorded work observations. Missing tokens/physical sends remain unknown rather than zero or free. */
export function ModelUsage({ records, truncated, t }: { records: ClientModelStep[]; truncated: boolean; t: Copy }) {
  if (!records.length && !truncated) return null;
  const count = (value: number | null | undefined) => value ?? t("s16.models.unknown");
  return <details className="model-usage"><summary>{t("s16.models.workUsage")}</summary>
    {truncated && <p>{t("s16.models.truncated")}</p>}
    {records.map(row => <section key={row.id}><strong>{row.provider} · {row.model} · {t("s16.models.requestedEffort")}: {row.effort.requested}</strong><p>{t("s16.models.stepState")}: {t(`s16.models.state.${row.state}`)}{row.code ? ` · ${row.code}` : ""}</p>
      <p>{t("s16.models.inputTokens")}: {count(row.tokens?.inputTokens)} · {t("s16.models.outputTokens")}: {count(row.tokens?.outputTokens)}</p>
      <p>{t("s16.models.sends")}: {count(row.physicalSends)} · {t("s16.models.reservedCalls")}: {row.reservedCalls}</p>
      <p>{t("s16.models.spend")}: {row.usage.spendMinor ?? t("s16.models.unknown")}</p>
      {row.partial && <p className="limits">{t("s16.models.partial")}</p>}
      <p className="limits">{t("s16.models.effortHint")}</p>
      {row.effort.attempts?.map((attempt, index) => <p key={index}>{t("s16.models.sentEffort")}: {attempt?.sent ?? t("s16.models.unknown")} · {t("s16.models.reportedEffort")}: {attempt?.reported ?? t("s16.models.unknown")}</p>)}
    </section>)}
  </details>;
}
