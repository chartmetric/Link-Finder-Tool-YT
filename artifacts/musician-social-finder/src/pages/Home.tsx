import React, { useState, useEffect } from 'react';
import { Search, Database, ChevronLeft, ChevronRight, Activity, ServerCrash, Settings2, SlidersHorizontal, FileText, ArrowUpRight, Link2 } from 'lucide-react';
import { Link } from 'wouter';

import {
  getListExistingProfilesQueryKey,
  useListExistingProfiles,
  type ProfileSearchInputMethodsItem,
} from '@workspace/api-client-react';
import { useDebounce } from '@/hooks/use-debounce';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfileRow } from '@/components/profile-row';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const GEMINI_SEARCH_PROMPT = `Use live web search to find the official Instagram, TikTok, and YouTube profile URLs for {{creator_name}}{{location_context}}.

Known {{known_profile_platform}} handle: @{{known_profile_handle}}.
Known identity profile: {{known_profile_url}}.
Use the known profile as an identity clue and check whether the same or linked identity appears on other platforms.

Return only JSON:
{
  "profiles": [
    {
      "platform": "Instagram|TikTok|YouTube",
      "url": "https://...",
      "title": "...",
      "snippet": "evidence",
      "confidence": 0-100
    }
  ]
}

Omit platforms you cannot verify. Never invent URLs.`;

const SERPER_SEARCH_QUERIES = `{{creator_name}}{{location_context}} {{known_profile_url}} @{{known_profile_handle}} {{known_profile_platform}} official Instagram
{{creator_name}}{{location_context}} {{known_profile_url}} @{{known_profile_handle}} {{known_profile_platform}} official TikTok
{{creator_name}}{{location_context}} {{known_profile_url}} @{{known_profile_handle}} {{known_profile_platform}} official YouTube`;

export default function Home() {
  const [promptModal, setPromptModal] = useState<'serper' | 'gemini' | null>(null);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 400);
  const [page, setPage] = useState(1);
  const limit = 50;
  const [tier, setTier] = useState<number | undefined>(3);
  const [profileType, setProfileType] = useState<'musician' | 'brand' | 'creator' | 'actor'>('musician');
  const [sortBy, setSortBy] = useState<'tier_rank' | 'name'>('tier_rank');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const methods: ProfileSearchInputMethodsItem[] = ['serper', 'gemini'];

  const { data, isLoading, isError, error, isFetching } = useListExistingProfiles(
    { query: debouncedQuery, page, limit, tier, profileType, sortBy, sortDirection },
    {
      query: {
        queryKey: getListExistingProfilesQueryKey({
          query: debouncedQuery,
          page,
          limit,
          tier,
          profileType,
          sortBy,
          sortDirection,
        }),
        placeholderData: (previousData) => previousData,
      },
    }
  );

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, tier, profileType, sortBy, sortDirection]);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">
      <header className="border-b border-border/80 bg-card px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-6 sticky top-0 z-20 shadow-[0_1px_4px_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-primary flex items-center justify-center rounded-xl shadow-sm shadow-primary/20 text-primary-foreground">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground leading-none">
              Profile Handles Online
            </h1>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mt-1.5 opacity-80">
               Profile Catalog · Human Review
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <Link href="/single-artist" data-testid="link-single-artist" className="group flex items-center justify-between gap-4 rounded-xl border border-primary/20 bg-primary px-4 py-3 text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5 hover:shadow-md">
          <span className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-foreground/15"><Link2 className="h-4 w-4" /></span><span><strong className="block text-xs font-extrabold tracking-tight">Investigate one link</strong><small className="block text-[9px] opacity-75 mt-0.5">Start with a known profile URL</small></span></span><ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </Link>
        <div className="flex flex-col gap-2 bg-muted/30 px-4 py-3 rounded-xl border border-border/60 shadow-sm">
          <div className="flex items-center gap-2">
            <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Discovery Engine Setup</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">
              Primary · Serper
            </span>
            <span className="rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">
              Secondary · Gemini Online
            </span>
            <Button variant="outline" size="sm" onClick={() => setPromptModal('serper')} className="h-7 text-[9px] font-bold uppercase tracking-wider">
              <FileText className="mr-1.5 h-3 w-3" />
              Serper queries
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPromptModal('gemini')} className="h-7 text-[9px] font-bold uppercase tracking-wider">
              <FileText className="mr-1.5 h-3 w-3" />
              Gemini prompt
            </Button>
          </div>
        </div>
        </div>
      </header>

      <main className="flex-1 p-6 flex flex-col max-w-[1600px] w-full mx-auto gap-5 overflow-hidden">
        
        <div className="flex flex-col xl:flex-row xl:items-center justify-between bg-card p-2 rounded-xl border border-border/80 shadow-sm gap-3 shrink-0">
           <div className="relative w-full xl:max-w-md">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
             <Input 
               value={query}
               onChange={e => setQuery(e.target.value)}
               placeholder="Filter catalog by name or handle..."
               className="pl-10 h-10 border-none bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm font-semibold tracking-wide"
             />
           </div>
           <div className="flex flex-wrap items-center gap-2 px-2">
             <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground hidden sm:block" />
             <select
               aria-label="Filter by profile type"
               value={profileType}
               onChange={(event) => setProfileType(event.target.value as 'musician' | 'brand' | 'creator' | 'actor')}
               className="h-9 rounded-md border border-border bg-background px-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-ring"
             >
               <option value="musician">Musicians</option>
               <option value="brand">Brands</option>
               <option value="creator">Creators</option>
               <option value="actor">Actors</option>
             </select>
             <select
               aria-label="Filter by tier"
               value={tier ?? ''}
               onChange={(event) => setTier(event.target.value ? Number(event.target.value) : undefined)}
               className="h-9 rounded-md border border-border bg-background px-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-ring"
             >
               <option value="">All tiers</option>
               {[1, 2, 3, 4, 5].map(value => (
                 <option key={value} value={value}>Tier {value}</option>
               ))}
             </select>
             <select
               aria-label="Sort profiles"
               value={sortBy}
               onChange={(event) => setSortBy(event.target.value as 'tier_rank' | 'name')}
               className="h-9 rounded-md border border-border bg-background px-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-ring"
             >
               <option value="tier_rank">Popularity rank</option>
               <option value="name">Name</option>
             </select>
             <select
               aria-label="Sort direction"
               value={sortDirection}
               onChange={(event) => setSortDirection(event.target.value as 'asc' | 'desc')}
               className="h-9 rounded-md border border-border bg-background px-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-ring"
             >
               <option value="asc">{sortBy === 'name' ? 'A → Z' : 'Highest first'}</option>
               <option value="desc">{sortBy === 'name' ? 'Z → A' : 'Lowest first'}</option>
             </select>
           </div>
           
           <div className="flex items-center gap-5 px-4 xl:border-l border-border/60 justify-between xl:justify-end">
             <div className="text-xs text-muted-foreground font-mono font-semibold tracking-wide">
               {data ? (
                 <span className="flex items-center gap-2.5">
                   <Database className="w-3.5 h-3.5 opacity-60" />
                   {(page - 1) * limit + 1} - {Math.min(page * limit, (page - 1) * limit + data.profiles.length)}
                 </span>
               ) : '...'}
             </div>
             <div className="flex gap-1.5">
               <Button variant="outline" size="icon" className="h-8 w-8 bg-background shadow-sm border-border hover:bg-muted" disabled={page === 1 || isLoading} onClick={() => setPage(p => p - 1)}>
                 <ChevronLeft className="w-4 h-4" />
               </Button>
               <Button variant="outline" size="icon" className="h-8 w-8 bg-background shadow-sm border-border hover:bg-muted" disabled={!data?.hasMore || isLoading} onClick={() => setPage(p => p + 1)}>
                 <ChevronRight className="w-4 h-4" />
               </Button>
             </div>
           </div>
        </div>

        <div className="bg-card border border-border/80 rounded-xl shadow-sm flex-1 flex flex-col overflow-hidden relative min-h-[500px]">
          {isFetching && !isLoading && (
            <div className="absolute top-0 left-0 w-full h-[2px] bg-primary/10 overflow-hidden z-20">
               <div className="h-full bg-primary animate-in slide-in-from-left duration-1000 ease-out w-1/3" />
            </div>
          )}

          <div className="overflow-auto flex-1 absolute inset-0">
            <Table className="min-w-[1750px]">
              <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-md border-b border-border/80 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[11%] min-w-[145px] text-[9px] uppercase tracking-widest font-bold py-4">Action</TableHead>
                  <TableHead className="w-[13%] min-w-[150px] text-[9px] uppercase tracking-widest font-bold py-4">Profile</TableHead>
                  <TableHead className="w-[18%] min-w-[180px] text-[9px] uppercase tracking-widest font-bold py-4">Existing Handles</TableHead>
                  <TableHead className="min-w-[350px] text-[9px] uppercase tracking-widest font-bold py-4">Suggested Instagram · Serper vs Gemini</TableHead>
                  <TableHead className="min-w-[350px] text-[9px] uppercase tracking-widest font-bold py-4">Suggested TikTok · Serper vs Gemini</TableHead>
                  <TableHead className="min-w-[350px] text-[9px] uppercase tracking-widest font-bold py-4">Suggested YouTube · Serper vs Gemini</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 15 }).map((_, i) => (
                    <TableRow key={i} className="border-border/40">
                      <TableCell><Skeleton className="h-8 w-full bg-muted rounded-md" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24 bg-muted" /><Skeleton className="h-2 w-16 mt-2 bg-muted/60" /></TableCell>
                      <TableCell><Skeleton className="h-12 w-full bg-muted rounded-md" /></TableCell>
                      <TableCell><Skeleton className="h-14 w-full bg-muted rounded-lg" /></TableCell>
                      <TableCell><Skeleton className="h-14 w-full bg-muted rounded-lg" /></TableCell>
                      <TableCell><Skeleton className="h-14 w-full bg-muted rounded-lg" /></TableCell>
                      <TableCell className="text-right">
                        <Skeleton className="h-7 w-full ml-auto rounded bg-muted" />
                        <Skeleton className="h-7 w-full ml-auto rounded bg-muted mt-2" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : isError ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center text-destructive">
                        <ServerCrash className="w-8 h-8 mb-4 opacity-80" />
                        <h3 className="font-bold text-lg tracking-tight">Catalog Disconnected</h3>
                        <p className="text-sm mt-1 opacity-80 max-w-md mx-auto font-medium">{error?.message || 'Could not reach the profiles catalog. Please verify connectivity.'}</p>
                        <Button variant="outline" className="mt-6 border-destructive/30 hover:bg-destructive/10 text-destructive font-bold uppercase tracking-wider text-xs h-9 px-6" onClick={() => window.location.reload()}>Retry Connection</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : data?.profiles.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <Database className="w-8 h-8 mb-4 opacity-30" />
                        <h3 className="font-bold text-foreground">No records found</h3>
                        <p className="text-sm mt-1 font-medium opacity-80">Adjust your filter to see catalog profiles.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.profiles.map(profile => (
                    <ProfileRow key={profile.profileId} profile={profile} methods={methods} />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </main>
      <Dialog open={promptModal !== null} onOpenChange={(open) => !open && setPromptModal(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {promptModal === 'serper' ? 'Serper search queries' : 'Gemini Online Search prompt'}
            </DialogTitle>
            <DialogDescription>
              {promptModal === 'serper'
                ? 'Serper receives three separate search strings, one per platform. It does not use an AI prompt.'
                : 'Gemini receives one AI prompt covering Instagram, TikTok, and YouTube.'}
              {' '}Dynamic values are shown in double braces. creator_name is the entity name; known_profile_url, known_profile_handle, and known_profile_platform identify an existing account. location_context is optional and currently unavailable for catalog rows.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-4 text-xs leading-6 font-mono">
            {promptModal === 'serper' ? SERPER_SEARCH_QUERIES : GEMINI_SEARCH_PROMPT}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}
