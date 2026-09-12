import React, { useState } from 'react';
import {
  useSearchProfiles,
  type ExistingProfile,
  type ProfileSearchInputMethodsItem,
  type ProfileSearchResponse
} from '@workspace/api-client-react';

import { TableRow, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, ChevronDown, ChevronUp, AlertCircle, Hash, AtSign, ArrowRight, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ProfileRow({ profile, methods }: { profile: ExistingProfile, methods: ProfileSearchInputMethodsItem[] }) {
  const { mutate, data, isPending, error, isError } = useSearchProfiles();
  const [isExpanded, setIsExpanded] = useState(false);

  const handleFetch = () => {
    mutate({
      data: {
        subject: profile.profileName,
        handle: profile.handle,
        handlePlatform: 'instagram', // Default assumption for the database records
        methods: methods.length > 0 ? methods : ['serper'] // fallback
      }
    }, {
      onSuccess: () => {
        setIsExpanded(true);
      },
      onError: () => {
        setIsExpanded(true);
      }
    });
  };

  const hasData = !!data;

  return (
    <>
      <TableRow className={cn("group transition-colors", isPending && "bg-primary/5", isExpanded && "bg-muted/30")}>
        <TableCell className="font-mono text-xs text-muted-foreground py-3 opacity-60 group-hover:opacity-100 transition-opacity">
          {profile.profileId}
        </TableCell>
        <TableCell className="py-3">
          <div className="font-semibold text-foreground">{profile.profileName}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mt-0.5 opacity-70">
            {profile.profileTypes || 'Unknown'}
          </div>
        </TableCell>
        <TableCell className="py-3">
           {profile.handle ? (
             <div className="flex items-center gap-1.5 bg-background border border-border/50 rounded px-2 py-1 w-fit shadow-sm">
               <AtSign className="w-3.5 h-3.5 text-muted-foreground opacity-50" />
               <span className="font-mono text-xs font-medium">{profile.handle}</span>
             </div>
           ) : (
             <span className="text-muted-foreground/50 italic text-xs font-medium">None available</span>
           )}
        </TableCell>
        <TableCell className="py-3">
          <div className="flex items-center gap-2">
            {!hasData && !isPending && !isError && (
               <Badge variant="secondary" className="text-muted-foreground/70 font-bold bg-secondary/30 shadow-none border-border/40 text-[10px] uppercase tracking-widest">
                 Idle
               </Badge>
            )}
            {isPending && (
               <Badge variant="outline" className="border-primary/20 text-primary bg-primary/5 flex gap-1.5 items-center px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold shadow-sm">
                 <Loader2 className="w-3 h-3 animate-spin" /> Enriching
               </Badge>
            )}
            {hasData && (
               <Badge 
                 className="bg-emerald-600/10 text-emerald-700 hover:bg-emerald-600/20 border-emerald-600/20 cursor-pointer transition-colors shadow-sm text-[10px] uppercase tracking-widest font-bold" 
                 onClick={() => setIsExpanded(!isExpanded)}
               >
                 {data.profiles.length} Found
               </Badge>
            )}
            {isError && (
               <Badge 
                 variant="destructive" 
                 className="bg-destructive/10 text-destructive border-destructive/20 cursor-pointer hover:bg-destructive/20 transition-colors shadow-sm text-[10px] uppercase tracking-widest font-bold" 
                 onClick={() => setIsExpanded(!isExpanded)}
               >
                 Failed
               </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right py-3">
          <div className="flex items-center justify-end gap-2">
            {hasData && (
              <Button variant="ghost" size="icon" onClick={() => setIsExpanded(!isExpanded)} className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-background shadow-sm border border-transparent hover:border-border">
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            )}
            <Button 
              onClick={handleFetch} 
              disabled={isPending || methods.length === 0}
              size="sm"
              className={cn("h-8 px-4 text-xs font-bold uppercase tracking-wider shadow-sm transition-all", hasData ? "bg-background border border-border text-foreground hover:bg-muted" : "")}
              variant={hasData ? "secondary" : "default"}
            >
              {isPending ? "Running..." : hasData ? "Refetch" : "Fetch"}
            </Button>
          </div>
        </TableCell>
      </TableRow>
      
      {isExpanded && (
        <TableRow className="bg-muted/10 hover:bg-muted/10">
          <TableCell colSpan={5} className="p-0 border-b-2 border-border/80">
             <div className="p-5 border-l-[3px] border-primary ml-0 my-0 bg-card shadow-inner">
                <ExpandedResult data={data} error={error} />
             </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
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
      {/* Stats Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 text-sm bg-muted/40 p-3 rounded-lg border border-border/60 shadow-sm">
        <div className="flex flex-wrap items-center gap-6">
           <div className="flex flex-col gap-1.5">
             <span className="text-muted-foreground text-[9px] uppercase font-bold tracking-widest">Methods Used</span>
             <div className="flex flex-wrap gap-1.5">
               {data.methodsUsed.map(m => (
                 <Badge key={m.method} variant={m.status === 'used' ? "secondary" : "outline"} className={cn("text-[9px] px-1.5 py-0 bg-background border-border/50", m.status !== 'used' && "opacity-50")}>
                   {m.method}
                 </Badge>
               ))}
             </div>
           </div>
           <div className="h-8 w-px bg-border/50 hidden sm:block" />
           <div className="flex flex-col gap-1.5">
             <span className="text-muted-foreground text-[9px] uppercase font-bold tracking-widest">Est. Cost</span>
             <span className="font-mono text-xs font-semibold text-foreground bg-background px-2 py-0.5 border border-border/50 rounded w-fit">${data.estimatedCostUsd.toFixed(4)}</span>
           </div>
           <div className="h-8 w-px bg-border/50 hidden sm:block" />
           <div className="flex flex-col gap-1.5">
             <span className="text-muted-foreground text-[9px] uppercase font-bold tracking-widest">Highly Confident</span>
             <span className="font-mono text-xs font-bold text-emerald-600 bg-emerald-600/10 px-2 py-0.5 border border-emerald-600/20 rounded w-fit">{data.highConfidenceCount}</span>
           </div>
        </div>
        <div className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground/60">
          {new Date(data.searchedAt).toLocaleTimeString()}
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
