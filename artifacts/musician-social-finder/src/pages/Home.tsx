import React, { useState, useEffect } from 'react';
import { Search, Database, ChevronLeft, ChevronRight, Activity, ServerCrash, Settings2, SlidersHorizontal } from 'lucide-react';

import {
  getListExistingProfilesQueryKey,
  useListExistingProfiles,
  type ProfileSearchInputMethodsItem,
} from '@workspace/api-client-react';
import { useDebounce } from '@/hooks/use-debounce';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfileRow } from '@/components/profile-row';

export default function Home() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 400);
  const [page, setPage] = useState(1);
  const limit = 50;
  const [tier, setTier] = useState<number | undefined>(3);
  const [profileType, setProfileType] = useState<'musician' | 'brand' | 'creator' | 'actor'>('musician');
  const [sortBy, setSortBy] = useState<'tier_rank' | 'name'>('tier_rank');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const [methods, setMethods] = useState<ProfileSearchInputMethodsItem[]>([
    'serper', 'tavily', 'scrapecreators', 'socialcrawl'
  ]);

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

  const toggleMethod = (method: ProfileSearchInputMethodsItem) => {
    setMethods(prev => {
      if (prev.includes(method)) {
         if (prev.length === 1) return prev; // prevent zero selection
         return prev.filter(m => m !== method);
      }
      return [...prev, method];
    });
  }

  const allMethods: ProfileSearchInputMethodsItem[] = ['serper', 'tavily', 'scrapecreators', 'socialcrawl'];

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">
      <header className="border-b border-border/80 bg-card px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-6 sticky top-0 z-20 shadow-[0_1px_4px_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-primary flex items-center justify-center rounded-xl shadow-sm shadow-primary/20 text-primary-foreground">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground leading-none">
              Find Social Links
            </h1>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mt-1.5 opacity-80">
               Profile Catalog · Human Review
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 bg-muted/30 px-4 py-3 rounded-xl border border-border/60 shadow-sm">
          <div className="flex items-center gap-2">
            <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Discovery Engine Setup</span>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 items-center">
            {allMethods.map(m => (
              <label key={m} className="flex items-center gap-2.5 text-sm cursor-pointer group">
                <Checkbox 
                  checked={methods.includes(m)}
                  onCheckedChange={() => toggleMethod(m)}
                  className="group-hover:border-primary transition-colors data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground rounded border-border"
                />
                <span className="capitalize text-xs font-bold tracking-wide select-none group-hover:text-primary transition-colors text-foreground/80">{m}</span>
              </label>
            ))}
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
            <Table className="min-w-[1200px]">
              <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-md border-b border-border/80 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[11%] min-w-[145px] text-[9px] uppercase tracking-widest font-bold py-4">Action</TableHead>
                  <TableHead className="w-[13%] min-w-[150px] text-[9px] uppercase tracking-widest font-bold py-4">Profile</TableHead>
                  <TableHead className="w-[18%] min-w-[180px] text-[9px] uppercase tracking-widest font-bold py-4">Existing Handles</TableHead>
                  <TableHead className="w-[15%] min-w-[160px] text-[9px] uppercase tracking-widest font-bold py-4">Suggested Instagram</TableHead>
                  <TableHead className="w-[15%] min-w-[160px] text-[9px] uppercase tracking-widest font-bold py-4">Suggested TikTok</TableHead>
                  <TableHead className="w-[15%] min-w-[160px] text-[9px] uppercase tracking-widest font-bold py-4">Suggested YouTube</TableHead>
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
    </div>
  )
}
