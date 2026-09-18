import React, { useState } from 'react';
import {
  useSearchProfiles,
  searchProfiles,
  useApproveProfileSuggestions,
  type ExistingProfile,
  type ProfileSearchInputMethodsItem,
  type ProfileSearchResponse,
  type ProfileMatch,
  type ProfileSearchInputHandlePlatform
} from '@workspace/api-client-react';

import { TableRow, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, AlertCircle, Hash, ArrowRight, Copy, Check, Play, Search, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

function getBestCandidate(data: ProfileSearchResponse | undefined, platform: string, method: string) {
  if (!data) return null;
  const cands = data.profiles.filter(
    p => p.platform.toLowerCase() === platform && p.methods.includes(method),
  );
  if (cands.length === 0) return null;
  return cands.sort((a, b) => b.confidence - a.confidence)[0];
}

function extractSuggestedHandle(candidate: ProfileMatch): string {
  try {
    const url = new URL(candidate.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (candidate.platform.toLowerCase() === 'youtube' && parts[0] === 'channel') {
      return parts[1] ?? candidate.displayUrl;
    }
    return (parts.find(part => part.startsWith('@')) ?? parts.at(-1) ?? candidate.displayUrl).replace(/^@/, '');
  } catch {
    return candidate.displayUrl.replace(/^@/, '');
  }
}

function getApiErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'Approval failed';
  const candidate = error as { message?: string; data?: { error?: string } };
  return candidate.data?.error ?? candidate.message ?? 'Approval failed';
}

function renderCandidate(
  cand: ProfileMatch | null,
  isLoading: boolean,
  data: ProfileSearchResponse | undefined,
  method: 'serper' | 'gemini',
) {
  if (isLoading) return <Skeleton className="h-14 w-full bg-muted/60 rounded-lg" />;
  
  if (!data) return (
    <div className="flex flex-col items-center justify-center h-14 bg-muted/5 border border-dashed border-border/40 rounded-lg">
       <span className="text-[8px] uppercase tracking-widest text-muted-foreground/30 font-bold">Idle</span>
    </div>
  );

  if (!cand) return (
    <div className="flex flex-col items-center justify-center h-14 bg-muted/20 border border-border/50 rounded-lg">
       <span className="text-[8px] uppercase tracking-widest text-muted-foreground/50 font-bold">Not Found</span>
    </div>
  );

  const methodDetails = data.methodsUsed.find(item => item.method === method);

  return (
    <div className="flex flex-col gap-1.5 border border-border/80 bg-card p-2 rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.02)] h-full min-h-[5rem]">
      <span className="text-[8px] uppercase tracking-widest font-bold text-muted-foreground">
        {method === 'serper' ? 'Primary · Serper' : 'Secondary · Gemini'}
      </span>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold truncate text-foreground/90 max-w-[120px]" title={cand.displayUrl}>{cand.displayUrl}</span>
        <Badge className={cn("text-[9px] px-1 py-0 h-4 border shadow-none shrink-0", cand.confidence >= 80 ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20" : cand.confidence >= 50 ? "bg-amber-500/10 text-amber-700 border-amber-500/20" : "bg-rose-500/10 text-rose-700 border-rose-500/20")}>
          {cand.confidence}%
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1 mt-auto">
        {cand.methods.map(m => (
          <span key={m} className="text-[8px] uppercase tracking-widest font-bold text-muted-foreground/80 bg-muted px-1.5 py-0.5 rounded-[3px] border border-border/50">{m}</span>
        ))}
      </div>
      <div className="text-[8px] text-muted-foreground/50 font-mono font-medium mt-0.5">
        Est. ${(methodDetails?.estimatedCostUsd ?? 0).toFixed(4)}
      </div>
    </div>
  );
}

function renderComparison(
  data: ProfileSearchResponse | undefined,
  platform: string,
  isLoading: boolean,
) {
  return (
    <div className="grid grid-cols-2 gap-2 min-w-[330px]">
      {renderCandidate(getBestCandidate(data, platform, 'serper'), isLoading, data, 'serper')}
      {renderCandidate(getBestCandidate(data, platform, 'gemini'), isLoading, data, 'gemini')}
    </div>
  );
}

export function ProfileRow({ profile, methods }: { profile: ExistingProfile, methods: ProfileSearchInputMethodsItem[] }) {
  const { mutate, data, isPending, error, isError } = useSearchProfiles({
    mutation: {
      mutationFn: ({ data: input }) =>
        searchProfiles(input, { signal: AbortSignal.timeout(65_000) }),
    },
  });
  const approveMutation = useApproveProfileSuggestions();
  
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  
  const [approvalStatus, setApprovalStatus] = useState<'idle'|'approving'|'approved'>('idle');
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const priority = ['instagram', 'tiktok', 'youtube'];
  const sortedAccounts = [...(profile.accounts || [])].sort((a, b) => {
      const aP = priority.indexOf(a.platform.toLowerCase());
      const bP = priority.indexOf(b.platform.toLowerCase());
      if (aP !== -1 && bP !== -1) return aP - bP;
      if (aP !== -1) return -1;
      if (bP !== -1) return 1;
      return 0;
  });

  const accountsToShow = showAllAccounts ? sortedAccounts : sortedAccounts.slice(0, 2);
  const hiddenCount = sortedAccounts.length - 2;

  const handleFetch = () => {
    const seedAccount = sortedAccounts[0];
    const compatiblePlatforms = ['instagram', 'tiktok', 'youtube', 'x', 'twitter', 'facebook'];
    let handlePlatform: ProfileSearchInputHandlePlatform | undefined = undefined;

    if (seedAccount && compatiblePlatforms.includes(seedAccount.platform.toLowerCase())) {
        handlePlatform = seedAccount.platform.toLowerCase() as ProfileSearchInputHandlePlatform;
    }

    setApprovalStatus('idle');
    setApprovalError(null);

    mutate({
      data: {
        subject: profile.profileName,
        ...(seedAccount?.handle ? { handle: seedAccount.handle } : {}),
        ...(handlePlatform ? { handlePlatform } : {}),
        ...(seedAccount?.accountUrl ? { knownProfileUrl: seedAccount.accountUrl } : {}),
        methods: methods.length > 0 ? methods : ['serper']
      }
    }, {
      onSuccess: () => {
        setDetailsOpen(true);
      },
      onError: () => {
        setDetailsOpen(true);
      }
    });
  };

  const handleApprove = () => {
    if (!data) return;
    setApprovalStatus('approving');
    setApprovalError(null);

    const suggestions = data.profiles.map(p => ({
        platform: p.platform,
        handle: extractSuggestedHandle(p),
        accountUrl: p.url,
        sourceVendors: p.methods,
        confidence: p.confidence,
        estimatedCostUsd: data.estimatedCostUsd / (data.profiles.length || 1),
        sourceDetails: JSON.stringify({ signals: p.signals, methodsUsed: data.methodsUsed.map(m => m.method) })
    }));

    approveMutation.mutate({
        profileId: profile.profileId,
        data: {
            profileName: profile.profileName,
            suggestions
        }
    }, {
        onSuccess: () => {
            setApprovalStatus('approved');
        },
        onError: (err: unknown) => {
            setApprovalStatus('idle');
            setApprovalError(getApiErrorMessage(err));
        }
    });
  };

  const hasData = !!data;
  
  return (
    <>
      <TableRow className={cn("group transition-colors", isPending && "bg-primary/5")}>
        <TableCell className="py-3 align-top">
          <div className="flex flex-col items-start gap-2 w-full">
            <div className="flex items-center gap-1 w-full">
              <Button 
                onClick={handleFetch} 
                disabled={isPending || methods.length === 0}
                size="icon"
                aria-label={hasData ? "Refetch preview" : "Fetch preview"}
                title={hasData ? "Refetch preview" : "Fetch preview"}
                className={cn("h-8 w-8 shrink-0 shadow-sm transition-all", hasData ? "bg-background border border-border text-foreground hover:bg-muted" : "")}
                variant={hasData ? "secondary" : "default"}
              >
                {isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Play className="h-3.5 w-3.5 fill-current" />}
              </Button>
              {hasData && (
                <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)} className="h-7 px-2 text-[8px] uppercase tracking-wider font-bold shrink-0">
                  Full details
                </Button>
              )}
            </div>
            {hasData && (
              <Button 
                onClick={handleApprove}
                disabled={approvalStatus === 'approving' || approvalStatus === 'approved'}
                size="sm"
                className={cn("h-7 px-3 text-[9px] font-bold uppercase tracking-wider w-full shadow-sm transition-all", approvalStatus === 'approved' ? "bg-emerald-600/10 text-emerald-700 hover:bg-emerald-600/10 border border-emerald-600/20" : "")}
                variant={approvalStatus === 'approved' ? "outline" : "default"}
              >
                {approvalStatus === 'approving' ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : null}
                {approvalStatus === 'approved' ? <><Check className="w-3 h-3 mr-1.5" /> Approved</> : "Approve All"}
              </Button>
            )}
            {approvalError && (
              <div className="text-[9px] text-destructive bg-destructive/10 border border-destructive/20 p-1.5 rounded-md w-full text-center font-semibold leading-tight shadow-sm">
                {approvalError}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell className="py-3 align-top">
          <div className="font-semibold text-foreground">{profile.profileName}</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <Badge variant="outline" className="h-4 px-1.5 text-[8px] uppercase tracking-widest font-bold">
              Tier {profile.tier}
            </Badge>
            <span className="text-[9px] text-muted-foreground font-mono">
              Rank #{profile.tierRank.toLocaleString()}
            </span>
          </div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mt-1.5 opacity-70">
            IG {profile.instagramFollowers === null
              ? 'followers unavailable'
              : `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(profile.instagramFollowers)} followers`}
          </div>
          
          {isError && (
             <Badge variant="destructive" className="bg-destructive/10 text-destructive border-destructive/20 cursor-pointer hover:bg-destructive/20 transition-colors shadow-sm text-[9px] uppercase tracking-widest font-bold mt-2" onClick={() => setDetailsOpen(true)}>
               Fetch Failed
             </Badge>
          )}
        </TableCell>
        <TableCell className="py-3 align-top">
           {sortedAccounts.length === 0 ? (
             <span className="text-muted-foreground/40 italic text-xs font-medium">None</span>
           ) : (
             <div className="flex flex-col gap-1.5">
               {accountsToShow.map((acc, i) => (
                  <div key={i} className="flex flex-col gap-0.5 bg-muted/20 border border-border/50 p-1.5 rounded-md shadow-sm">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-primary/80">{acc.platform}</span>
                      <span className="text-xs font-mono text-foreground/90 truncate">{acc.handle}</span>
                    </div>
                    {acc.source && (
                       <span className="text-[8px] uppercase tracking-widest text-muted-foreground/60 font-bold">via {acc.source}</span>
                    )}
                  </div>
               ))}
               {!showAllAccounts && hiddenCount > 0 && (
                  <button onClick={() => setShowAllAccounts(true)} className="text-[9px] text-primary/70 hover:text-primary text-left font-bold uppercase tracking-widest pt-1 transition-colors">
                     + {hiddenCount} more
                  </button>
               )}
             </div>
           )}
        </TableCell>
        <TableCell className="align-top py-3">
          {renderComparison(data, 'instagram', isPending)}
        </TableCell>
        <TableCell className="align-top py-3">
          {renderComparison(data, 'tiktok', isPending)}
        </TableCell>
        <TableCell className="align-top py-3">
          {renderComparison(data, 'youtube', isPending)}
        </TableCell>
      </TableRow>
      
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-[min(96vw,1400px)] h-[88vh] flex flex-col p-0 overflow-hidden">
          <DialogHeader className="px-6 pt-5 pb-4 border-b border-border">
            <DialogTitle>{profile.profileName} · Full discovery details</DialogTitle>
            <DialogDescription>
              Results are grouped by method with status, elapsed time, and estimated cost.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto p-6">
            <ExpandedResult data={data} error={error} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function getPlatformFromUrl(url: string): 'Instagram' | 'TikTok' | 'YouTube' | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (hostname.endsWith('instagram.com')) return 'Instagram';
    if (hostname.endsWith('tiktok.com')) return 'TikTok';
    if (hostname.endsWith('youtube.com') || hostname.endsWith('youtu.be')) return 'YouTube';
    return null;
  } catch {
    return null;
  }
}

function isAccountUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return !['/p/', '/reel/', '/video/', '/watch', '/shorts/', '/playlist', '/tag/', '/search', '/explore']
      .some(fragment => pathname.includes(fragment));
  } catch {
    return false;
  }
}

function normalizeComparisonUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${parsed.pathname.replace(/\/$/, '').toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

function MethodComparison({ data }: { data: ProfileSearchResponse }) {
  const serper = data.methodsUsed.find(method => method.method === 'serper');
  const gemini = data.methodsUsed.find(method => method.method === 'gemini');
  const platforms = ['Instagram', 'TikTok', 'YouTube'] as const;

  const firstForPlatform = (
    method: typeof serper,
    platform: typeof platforms[number],
  ) => method?.results.find(result =>
    getPlatformFromUrl(result.url) === platform && isAccountUrl(result.url),
  );

  return (
    <section className="rounded-lg border border-border/70 bg-card p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Serper vs Gemini</h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Green means the URLs match, amber means they differ, and gray means a method found nothing.
          </p>
        </div>
        <div className="flex gap-3 text-[9px] font-bold uppercase tracking-wider">
          <span className="text-emerald-700">● Match</span>
          <span className="text-amber-700">● Different</span>
          <span className="text-muted-foreground">● Missing</span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {platforms.map(platform => {
          const serperResult = firstForPlatform(serper, platform);
          const geminiResult = firstForPlatform(gemini, platform);
          const matches = Boolean(
            serperResult
            && geminiResult
            && normalizeComparisonUrl(serperResult.url) === normalizeComparisonUrl(geminiResult.url),
          );
          const state = matches ? 'match' : serperResult && geminiResult ? 'different' : 'missing';
          const stateClasses = state === 'match'
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : state === 'different'
              ? 'border-amber-500/40 bg-amber-500/5'
              : 'border-border bg-muted/20';

          return (
            <div key={platform} className={cn('rounded-lg border p-3', stateClasses)}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-widest">{platform}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    'h-5 text-[8px] font-bold uppercase',
                    state === 'match' && 'border-emerald-500/30 text-emerald-700',
                    state === 'different' && 'border-amber-500/30 text-amber-700',
                  )}
                >
                  {state === 'match' ? 'Matched' : state === 'different' ? 'Different' : 'Missing'}
                </Badge>
              </div>
              <div className="space-y-2">
                {[
                  { label: 'Serper', result: serperResult },
                  { label: 'Gemini', result: geminiResult },
                ].map(({ label, result }) => {
                  const isSerper = label === 'Serper';
                  const MethodIcon = isSerper ? Search : Sparkles;
                  return (
                  <div key={label} className={cn(
                    'rounded border bg-background/80 p-2',
                    isSerper ? 'border-sky-500/25' : 'border-violet-500/25',
                  )}>
                    <div className={cn(
                      'flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest',
                      isSerper ? 'text-sky-700' : 'text-violet-700',
                    )}>
                      <MethodIcon className="h-3 w-3" />
                      {label}
                    </div>
                    {result ? (
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noreferrer"
                        className={cn(
                          'mt-1 block truncate text-[10px] font-mono hover:underline',
                          isSerper ? 'text-sky-700' : 'text-violet-700',
                        )}
                        title={result.url}
                      >
                        {result.url}
                      </a>
                    ) : (
                      <div className="mt-1 text-[10px] text-muted-foreground">No account found</div>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ExpandedResult({ data, error }: { data?: ProfileSearchResponse, error?: any }) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const copyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    window.setTimeout(() => setCopiedUrl(null), 1500);
  };

  if (error) {
    return (
      <div className="flex gap-3 text-destructive p-4 bg-destructive/5 rounded-lg border border-destructive/10">
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 opacity-80" />
        <div>
          <h4 className="font-semibold text-sm tracking-tight">Enrichment Failed</h4>
          <p className="text-xs mt-1 opacity-90 font-medium">{error.response?.data?.message || error.message || "An unexpected error occurred during search."}</p>
        </div>
      </div>
    )
  }

  if (!data) return null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
      <MethodComparison data={data} />
      {/* Stats Header */}
      <div className="flex flex-col gap-4 bg-muted/20 p-4 rounded-lg border border-border/60 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 text-sm border-b border-border/50 pb-3">
          <div className="flex flex-wrap items-center gap-6">
             <div className="flex flex-col gap-1">
               <span className="text-muted-foreground text-[9px] uppercase font-bold tracking-widest">Total Run Cost</span>
               <span className="font-mono text-xs font-semibold text-foreground bg-background px-2 py-0.5 border border-border/50 rounded shadow-sm w-fit">${data.estimatedCostUsd.toFixed(4)}</span>
             </div>
             <div className="h-8 w-px bg-border/50 hidden sm:block" />
             <div className="flex flex-col gap-1">
               <span className="text-muted-foreground text-[9px] uppercase font-bold tracking-widest">Highly Confident</span>
               <span className="font-mono text-xs font-bold text-emerald-700 bg-emerald-600/10 px-2 py-0.5 border border-emerald-600/20 rounded shadow-sm w-fit">{data.highConfidenceCount}</span>
             </div>
          </div>
          <div className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground/60">
            {new Date(data.searchedAt).toLocaleTimeString()}
          </div>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
           {data.methodsUsed.map(m => (
              <div key={m.method} className="bg-background p-3 rounded-md border border-border/60 shadow-sm flex flex-col gap-3 relative overflow-hidden">
                 {m.status === 'used' && <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary/40" />}
                 {m.status === 'failed' && <div className="absolute left-0 top-0 bottom-0 w-1 bg-destructive/40" />}
                 
                  <div className="flex justify-between items-start gap-2">
                     <span className={cn(
                       'flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest leading-tight',
                       m.method === 'serper' && 'text-sky-700',
                       m.method === 'gemini' && 'text-violet-700',
                     )}>
                       {m.method === 'serper' && <Search className="h-3.5 w-3.5" />}
                       {m.method === 'gemini' && <Sparkles className="h-3.5 w-3.5" />}
                       {m.label || m.method}
                     </span>
                    <Badge variant={m.status === 'used' ? "secondary" : m.status === 'failed' ? "destructive" : "outline"} className="text-[8px] px-1 py-0 h-4 uppercase shadow-none font-bold">
                      {m.status}
                    </Badge>
                 </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded border border-border/50 bg-muted/20 px-2 py-1.5">
                      <div className="text-[8px] uppercase tracking-widest text-muted-foreground font-bold">Time</div>
                      <div className="text-[10px] font-mono font-bold mt-0.5">
                        {m.durationMs >= 1000 ? `${(m.durationMs / 1000).toFixed(1)}s` : `${m.durationMs}ms`}
                      </div>
                    </div>
                    <div className="rounded border border-border/50 bg-muted/20 px-2 py-1.5">
                      <div className="text-[8px] uppercase tracking-widest text-muted-foreground font-bold">Cost</div>
                      <div className="text-[10px] font-mono font-bold mt-0.5">${m.estimatedCostUsd.toFixed(4)}</div>
                    </div>
                    <div className="rounded border border-border/50 bg-muted/20 px-2 py-1.5">
                      <div className="text-[8px] uppercase tracking-widest text-muted-foreground font-bold">Results</div>
                      <div className="text-[10px] font-mono font-bold mt-0.5">{m.results.length}</div>
                    </div>
                  </div>

                  {m.results.length > 0 ? (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {m.results.map((result, index) => (
                        <a
                          key={`${result.url}-${index}`}
                          href={result.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded border border-border/50 bg-muted/10 p-2 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                        >
                          <div className="text-[10px] font-semibold truncate">{result.title}</div>
                          <div className="text-[9px] font-mono text-primary/80 truncate mt-0.5">{result.url}</div>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[9px] text-muted-foreground border border-dashed border-border/50 rounded p-2 text-center">
                      No results returned
                    </div>
                  )}
                 {m.costNote && (
                    <div className="text-[9px] text-muted-foreground/80 leading-snug mt-auto pt-1 border-t border-border/40">{m.costNote}</div>
                 )}
              </div>
           ))}
        </div>
      </div>

      {/* Profiles Grid */}
      {data.profiles.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.profiles.map(p => (
            <div key={p.url} className="flex flex-col border border-border/80 rounded-xl p-5 bg-background shadow-sm hover:shadow-md hover:border-primary/40 transition-all duration-200 group">
              <div className="flex justify-between items-start mb-4">
                 <div className="flex items-center gap-2">
                   <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 capitalize text-[10px] px-2 py-0.5 font-bold tracking-wider">
                     {p.platform}
                   </Badge>
                   <span className={cn("text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border", p.confidence >= 80 ? "text-emerald-600 bg-emerald-600/5 border-emerald-600/10" : p.confidence >= 50 ? "text-amber-600 bg-amber-600/5 border-amber-600/10" : "text-rose-600 bg-rose-600/5 border-rose-600/10")}>
                     {p.confidence}% CONF
                   </span>
                 </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Copy ${p.platform} URL`}
                      onClick={() => void copyUrl(p.url)}
                      className="text-muted-foreground hover:text-primary transition-colors bg-muted p-1.5 rounded-md group-hover:bg-primary/10"
                    >
                      {copiedUrl === p.url ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${p.platform} profile`}
                      className="text-muted-foreground hover:text-primary transition-colors bg-muted p-1.5 rounded-md group-hover:bg-primary/10 group-hover:shadow-sm"
                    >
                      <ArrowRight className="w-3.5 h-3.5 -rotate-45" />
                    </a>
                  </div>
              </div>
              <h4 className="font-bold text-sm line-clamp-1 mb-1.5 tracking-tight" title={p.title}>{p.title}</h4>
              <div className="font-mono text-[11px] text-muted-foreground truncate mb-4 flex items-center gap-1.5 bg-muted/40 px-2 py-1 rounded border border-border/40 w-fit max-w-full">
                <Hash className="w-3 h-3 shrink-0 opacity-50" />
                <span className="truncate">{p.displayUrl}</span>
              </div>
              <p className="text-xs text-muted-foreground/90 line-clamp-2 leading-relaxed border-l-[3px] border-muted pl-3 mb-5 flex-1 font-medium">
                {p.snippet}
              </p>
              <div className="flex gap-1.5 flex-wrap mt-auto pt-4 border-t border-border/40">
                {p.signals.map(s => (
                   <span key={s} className="text-[9px] uppercase font-bold tracking-widest bg-secondary text-secondary-foreground px-2 py-0.5 rounded-sm">{s}</span>
                ))}
                 {p.methods.map(method => (
                    <span key={method} className="text-[9px] uppercase font-bold tracking-widest bg-primary/10 text-primary px-2 py-0.5 rounded-sm">{method}</span>
                 ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground border border-dashed border-border/60 rounded-xl bg-background/50">
          <Hash className="w-8 h-8 opacity-20 mb-3" />
          <p className="text-sm font-semibold text-foreground/80">No verified profiles found.</p>
          <p className="text-xs opacity-70 mt-1 font-medium">Try falling back to broader search methods or adjust threshold.</p>
        </div>
      )}
    </div>
  )
}
