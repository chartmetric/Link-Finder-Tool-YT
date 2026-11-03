import { useQueryClient } from '@tanstack/react-query';
import { getGetBulkBillingHealthQueryKey, useGetBulkBillingHealth, useClearBulkBillingOutage } from '@workspace/api-client-react';
import { apiError } from '@/lib/bulk';

export function useBulkBillingGate() {
  const query = useGetBulkBillingHealth({ query: { queryKey: getGetBulkBillingHealthQueryKey(), refetchInterval: 5000, staleTime: 0, retry: false } });
  return { query, blocked: !query.data || query.isError || query.data.outages.length > 0 };
}

/** Clearing is an operator attestation, never a paid balance probe or resume. */
export function BillingHealthNotice() {
  const qc = useQueryClient();
  const { query, blocked } = useBulkBillingGate();
  const clear = useClearBulkBillingOutage({ mutation: {
    onSuccess: data => {
      qc.setQueryData(getGetBulkBillingHealthQueryKey(), data);
      void qc.invalidateQueries({ queryKey: getGetBulkBillingHealthQueryKey() });
    },
    onError: () => { void qc.invalidateQueries({ queryKey: getGetBulkBillingHealthQueryKey() }); },
  } });
  if (!blocked && !clear.isSuccess) return null;
  return (
    <div className="inv-history-warn" role="status" data-testid="billing-health-notice">
      {!query.data || query.isError ? <>
        <strong>{query.isError ? 'Shared billing health unavailable.' : 'Checking shared billing health…'}</strong>
        <p>New paid bulk runs and resumes are blocked until this check succeeds.</p>
        <button type="button" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh billing status</button>
      </> : query.data.outages.length ? <>
        <strong>Paid bulk launches and resumes are blocked.</strong>
        <p>A provider reported exhausted credits or a billing limit. This block is shared across servers and survives restarts. Restore funding in the provider account first. Already dispatched requests may still charge.</p>
        {query.data.outages.map(outage => (
          <div key={outage.incidentId} data-testid={`billing-outage-${outage.provider}`}>
            <p><b>{outage.provider}</b> · HTTP {outage.httpStatus} · reported {new Date(outage.observedAt).toLocaleString()}</p>
            <button type="button" disabled={clear.isPending} onClick={() => {
              if (window.confirm(`Have you restored funding for ${outage.provider}? Clearing this block does not verify provider credits or make paid requests. No run will resume automatically. A later explicit start or resume can incur charges and will block again if credits are still exhausted. Stop any active queue and wait for it to finish first.`)) {
                clear.mutate({ data: { provider: outage.provider, incidentId: outage.incidentId, fundingRestored: true } });
              }
            }}>I restored funding — clear {outage.provider} block</button>
          </div>
        ))}
      </> : <p>Billing block cleared by confirmation. Credits have not been verified. No run was started or resumed; use Start or Resume explicitly when ready.</p>}
      {clear.isError && <p role="alert">{apiError(clear.error, 'The billing block could not be cleared.')}</p>}
    </div>
  );
}
