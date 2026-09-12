import React, { useState, useEffect } from 'react';
import { Search, Database, ChevronLeft, ChevronRight, Activity, ServerCrash, Settings2 } from 'lucide-react';

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

  const [methods, setMethods] = useState<ProfileSearchInputMethodsItem[]>([
    'serper', 'tavily', 'scrapecreators', 'socialcrawl'
  ]);

  const { data, isLoading, isError, error, isFetching } = useListExistingProfiles(
    { query: debouncedQuery, page, limit },
    {
      query: {
        queryKey: getListExistingProfilesQueryKey({ query: debouncedQuery, page, limit }),
        placeholderData: (previousData) => previousData,
      },
    }
  );

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery]);

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
              Enrichment Console
            </h1>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mt-1.5 opacity-80">
               Workspace · Bulk Validation
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

      <main className="flex-1 p-6 flex flex-col max-w-[1600px] w-full mx-auto gap-5">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between bg-card p-2 rounded-xl border border-border/80 shadow-sm gap-4">
           <div className="relative w-full max-w-md">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
             <Input 
               value={query}
               onChange={e => setQuery(e.target.value)}
               placeholder="Filter catalog by name or handle..."
               className="pl-10 h-10 border-none bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm font-semibold tracking-wide"
             />
           </div>
           
           <div className="flex items-center gap-5 px-4 sm:border-l border-border/60 justify-between sm:justify-end">
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
            <Table>
              <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-md border-b border-border/80 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-24 font-mono text-[9px] uppercase tracking-widest font-bold py-4">Ref ID</TableHead>
                  <TableHead className="w-[30%] text-[9px] uppercase tracking-widest font-bold py-4">Catalog Subject</TableHead>
                  <TableHead className="w-[20%] text-[9px] uppercase tracking-widest font-bold py-4">Known Handle</TableHead>
                  <TableHead className="w-40 text-[9px] uppercase tracking-widest font-bold py-4">Status</TableHead>
                  <TableHead className="text-right text-[9px] uppercase tracking-widest font-bold py-4">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 15 }).map((_, i) => (
                    <TableRow key={i} className="border-border/40">
                      <TableCell><Skeleton className="h-3 w-10 bg-muted" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-32 bg-muted" /><Skeleton className="h-2 w-20 mt-2 bg-muted/60" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24 bg-muted" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-16 rounded bg-muted" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-8 w-20 ml-auto rounded bg-muted" /></TableCell>
                    </TableRow>
                  ))
                ) : isError ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-64 text-center">
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
                    <TableCell colSpan={5} className="h-64 text-center">
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
