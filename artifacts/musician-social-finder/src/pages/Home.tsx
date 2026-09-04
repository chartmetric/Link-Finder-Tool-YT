import React, { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Search, MapPin, Globe, ExternalLink, Copy, Check, Download, AlertCircle, Loader2, Music, Hash, Radio, MonitorPlay } from 'lucide-react';
import { toast } from 'sonner';

import { useSearchMusicianProfiles } from '@workspace/api-client-react';
import type { ProfileMatch } from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const searchSchema = z.object({
  musician: z.string().min(2, 'Name must be at least 2 characters').max(120),
  location: z.string().max(100).optional(),
  country: z.string().length(2, 'Must be 2 letters').optional().or(z.literal('')),
});

type SearchFormValues = z.infer<typeof searchSchema>;

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  social: <Hash className="w-4 h-4" />,
  streaming: <Radio className="w-4 h-4" />,
  music: <Music className="w-4 h-4" />,
  website: <Globe className="w-4 h-4" />,
};

export default function Home() {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const form = useForm<SearchFormValues>({
    resolver: zodResolver(searchSchema),
    defaultValues: {
      musician: '',
      location: '',
      country: '',
    },
  });

  const { mutate, data: responseData, isPending, error } = useSearchMusicianProfiles();

  // Orval passes { data } on success directly
  const data = responseData;

  const onSubmit = (values: SearchFormValues) => {
    // clean up empty string for country
    const payload = {
      musician: values.musician,
      ...(values.location ? { location: values.location } : {}),
      ...(values.country ? { country: values.country.toUpperCase() } : {}),
    };
    mutate({ data: payload });
  };

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    toast.success('URL copied to clipboard');
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const handleCopyAll = () => {
    if (!data?.profiles) return;
    const urls = data.profiles.map((p) => p.url).join('\n');
    navigator.clipboard.writeText(urls);
    toast.success(`${data.profiles.length} URLs copied`);
  };

  const handleExportCSV = () => {
    if (!data?.profiles) return;
    const headers = ['Platform', 'Category', 'Title', 'URL', 'Confidence', 'Signals'];
    const rows = data.profiles.map((r) => [
      r.platform,
      r.category,
      r.title,
      r.url,
      r.confidence.toString(),
      r.signals.join('; '),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${data.musician.replace(/\s+/g, '_')}_profiles.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('CSV exported');
  };

  const filteredProfiles = useMemo(() => {
    if (!data?.profiles) return [];
    if (activeCategory === 'all') return data.profiles;
    return data.profiles.filter((p) => p.category === activeCategory);
  }, [data, activeCategory]);

  const hasError = !!error;
  const errorObj = error as any;
  const is503 = errorObj?.response?.status === 503 || errorObj?.status === 503;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans">
      {/* Header / Search Area */}
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border py-4 px-6 lg:px-12 flex flex-col lg:flex-row gap-6 items-start lg:items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary text-primary-foreground flex items-center justify-center rounded-xl shadow-lg shadow-primary/20">
            <MonitorPlay className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-serif text-2xl font-bold leading-none tracking-wide text-foreground">
              Musician Finder
            </h1>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mt-1">
              Social & Streaming Intel
            </p>
          </div>
        </div>

        <div className="w-full lg:w-auto flex-1 max-w-3xl">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col sm:flex-row gap-3 w-full">
              <FormField
                control={form.control}
                name="musician"
                render={({ field }) => (
                  <FormItem className="flex-1 space-y-0">
                    <FormControl>
                      <div className="relative group rounded-md transition-all duration-200 hover:shadow-md hover:shadow-primary/5 focus-within:shadow-md focus-within:shadow-primary/10">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input 
                          placeholder="e.g. Aphex Twin" 
                          className="pl-9 h-11 bg-card text-base font-medium rounded-lg" 
                          {...field} 
                        />
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem className="sm:w-48 space-y-0">
                    <FormControl>
                      <div className="relative group rounded-md transition-all duration-200 hover:shadow-md hover:shadow-primary/5 focus-within:shadow-md focus-within:shadow-primary/10">
                        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input 
                          placeholder="City/Region" 
                          className="pl-9 h-11 bg-card rounded-lg" 
                          {...field} 
                        />
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem className="sm:w-24 space-y-0">
                    <FormControl>
                      <div className="relative group rounded-md transition-all duration-200 hover:shadow-md hover:shadow-primary/5 focus-within:shadow-md focus-within:shadow-primary/10">
                        <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input 
                          placeholder="US" 
                          maxLength={2}
                          className="pl-9 h-11 bg-card uppercase rounded-lg" 
                          {...field} 
                        />
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />
              <Button type="submit" size="lg" disabled={isPending} className="h-11 rounded-lg px-8 font-semibold shadow-lg shadow-primary/20">
                {isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Search'}
              </Button>
            </form>
          </Form>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col p-6 lg:p-12 w-full max-w-7xl mx-auto">
        {!data && !isPending && !hasError && (
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-xl mx-auto animate-in slide-in-from-bottom-4 fade-in duration-700 ease-out">
            <div className="w-24 h-24 mb-8 bg-muted rounded-full flex items-center justify-center">
              <Search className="w-10 h-10 text-muted-foreground" />
            </div>
            <h2 className="font-serif text-4xl mb-4 text-foreground">Find the official links.</h2>
            <p className="text-lg text-muted-foreground mb-10 leading-relaxed">
              Cut through fan pages and unofficial accounts. Instantly verify a musician's footprint across social media, streaming platforms, and official websites.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <span className="text-sm font-medium text-muted-foreground mr-2 self-center">Try:</span>
              <Badge variant="outline" className="cursor-pointer hover:bg-muted py-1.5 px-3" onClick={() => {
                form.setValue('musician', 'Radiohead');
                form.setValue('location', '');
                form.setValue('country', '');
                form.handleSubmit(onSubmit)();
              }}>Radiohead</Badge>
              <Badge variant="outline" className="cursor-pointer hover:bg-muted py-1.5 px-3" onClick={() => {
                form.setValue('musician', 'Four Tet');
                form.setValue('location', 'London');
                form.setValue('country', 'UK');
                form.handleSubmit(onSubmit)();
              }}>Four Tet (London, UK)</Badge>
            </div>
          </div>
        )}

        {isPending && (
          <div className="w-full flex-1 flex flex-col gap-6 animate-in fade-in duration-300">
            <div className="flex items-center justify-between">
              <Skeleton className="h-10 w-64 rounded-md" />
              <div className="flex gap-2">
                <Skeleton className="h-9 w-24 rounded-md" />
                <Skeleton className="h-9 w-24 rounded-md" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-4">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-32 w-full rounded-xl" />
                ))}
              </div>
              <div className="space-y-4">
                <Skeleton className="h-64 w-full rounded-xl" />
              </div>
            </div>
          </div>
        )}

        {hasError && (
          <Card className="border-destructive/50 bg-destructive/5 animate-in fade-in slide-in-from-bottom-2">
            <CardHeader className="flex flex-row items-start gap-4">
              <AlertCircle className="w-6 h-6 text-destructive mt-1" />
              <div>
                <CardTitle className="text-destructive font-serif text-2xl">
                  {is503 ? 'Serper API Key Required' : 'Search Failed'}
                </CardTitle>
                <CardDescription className="text-foreground/80 mt-2 text-base">
                  {is503 
                    ? 'The backend is returning a 503 error, which usually indicates the SERPER_API_KEY environment variable is not configured. Please set it in your Replit secrets.'
                    : 'An unexpected error occurred while searching for the musician. Please try again later.'}
                </CardDescription>
              </div>
            </CardHeader>
          </Card>
        )}

        {data && !isPending && (
          <div className="w-full flex flex-col gap-8 animate-in fade-in duration-500 ease-out">
            {/* Results Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border pb-6">
              <div>
                <h2 className="font-serif text-4xl font-bold mb-2">
                  {data.musician}
                </h2>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge variant="secondary" className="px-2.5 py-1">
                    {data.totalFound} links found
                  </Badge>
                  <Badge variant="default" className="px-2.5 py-1 bg-green-600 hover:bg-green-700 text-white">
                    {data.highConfidenceCount} highly verified
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    Searched at {new Date(data.searchedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={handleCopyAll}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy All
                </Button>
                <Button variant="default" onClick={handleExportCSV}>
                  <Download className="w-4 h-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 items-start">
              {/* Left Column: Results List */}
              <div className="xl:col-span-2 flex flex-col gap-6">
                <Tabs value={activeCategory} onValueChange={setActiveCategory} className="w-full">
                  <TabsList className="w-full sm:w-auto grid grid-cols-5 h-12 p-1 bg-card border">
                    <TabsTrigger value="all" className="h-full rounded-md text-sm">All</TabsTrigger>
                    <TabsTrigger value="social" className="h-full rounded-md text-sm">Social</TabsTrigger>
                    <TabsTrigger value="streaming" className="h-full rounded-md text-sm">Stream</TabsTrigger>
                    <TabsTrigger value="music" className="h-full rounded-md text-sm">Music</TabsTrigger>
                    <TabsTrigger value="website" className="h-full rounded-md text-sm">Web</TabsTrigger>
                  </TabsList>
                </Tabs>

                <div className="flex flex-col gap-4">
                  {filteredProfiles.length === 0 ? (
                    <div className="text-center py-12 border rounded-xl border-dashed bg-card/50">
                      <p className="text-muted-foreground">No profiles found in this category.</p>
                    </div>
                  ) : (
                    filteredProfiles.map((profile) => (
                      <Card key={profile.url} className="group overflow-hidden transition-all duration-300 hover:border-primary/50 hover:shadow-md hover:shadow-primary/5">
                        <div className="flex flex-col sm:flex-row">
                          {/* Left colored accent indicator based on confidence */}
                          <div className={`w-full sm:w-1.5 h-1.5 sm:h-auto ${
                            profile.confidence >= 80 ? 'bg-green-500' :
                            profile.confidence >= 50 ? 'bg-yellow-500' :
                            'bg-orange-500'
                          }`} />
                          
                          <div className="flex-1 p-5 md:p-6 flex flex-col gap-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="text-muted-foreground">
                                    {CATEGORY_ICONS[profile.category] || <Globe className="w-4 h-4" />}
                                  </span>
                                  <Badge variant="outline" className="text-xs uppercase tracking-wider font-semibold border-primary/20 text-primary bg-primary/5">
                                    {profile.platform}
                                  </Badge>
                                </div>
                                <h3 className="font-semibold text-lg line-clamp-1">{profile.title}</h3>
                                <a 
                                  href={profile.url} 
                                  target="_blank" 
                                  rel="noreferrer" 
                                  className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1.5 mt-1 max-w-full"
                                >
                                  <span className="truncate">{profile.displayUrl}</span>
                                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                                </a>
                              </div>
                              
                              <div className="flex flex-col items-end gap-2 shrink-0">
                                <div className="flex flex-col items-end text-right">
                                  <span className="text-2xl font-serif font-bold leading-none">
                                    {profile.confidence}%
                                  </span>
                                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                                    Confidence
                                  </span>
                                </div>
                              </div>
                            </div>
                            
                            <p className="text-sm text-foreground/80 leading-relaxed border-l-2 border-border pl-3">
                              {profile.snippet}
                            </p>
                            
                            <div className="flex items-center justify-between mt-1">
                              <div className="flex flex-wrap gap-1.5">
                                {profile.signals.map((sig, sIdx) => (
                                  <span key={sIdx} className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 rounded-sm bg-muted text-muted-foreground">
                                    {sig}
                                  </span>
                                ))}
                              </div>
                              
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button 
                                      variant="ghost" 
                                      size="icon" 
                                      onClick={() => handleCopy(profile.url)}
                                      className="h-8 w-8 text-muted-foreground hover:text-primary"
                                    >
                                      {copiedUrl === profile.url ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Copy URL</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          </div>
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              </div>

              {/* Right Column: Sources Evidence */}
              <div className="xl:col-span-1 flex flex-col gap-6 sticky top-32">
                <Card className="bg-card shadow-sm border-border/80">
                  <CardHeader className="bg-muted/30 pb-4 border-b">
                    <CardTitle className="flex items-center gap-2 text-lg font-serif">
                      <Globe className="w-5 h-5 text-muted-foreground" />
                      Search Sources
                    </CardTitle>
                    <CardDescription>
                      Evidence analyzed to rank these profiles
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-[600px] overflow-y-auto p-5 flex flex-col gap-5">
                      {data.sources.map((source, idx) => (
                        <div key={source.url} className="flex flex-col gap-2 relative">
                          {idx !== 0 && <div className="absolute -top-3 left-0 w-full h-[1px] bg-border" />}
                          <a 
                            href={source.url} 
                            target="_blank" 
                            rel="noreferrer"
                            className="font-medium text-sm hover:text-primary transition-colors line-clamp-2 leading-snug"
                          >
                            {source.title}
                          </a>
                          <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                            {source.snippet}
                          </p>
                          <span className="text-[10px] text-muted-foreground/60 truncate">
                            {new URL(source.url).hostname}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
