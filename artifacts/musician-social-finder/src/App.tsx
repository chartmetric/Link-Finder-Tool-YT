import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import SingleArtist from '@/pages/SingleArtist';
import BulkBrands from '@/pages/BulkBrands';

// We'll create a minimal NotFound page if one doesn't exist.
function NotFound() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background text-foreground">
      <h1 className="text-4xl font-serif font-bold">404</h1>
      <p className="text-muted-foreground mt-2">The page you're looking for doesn't exist.</p>
    </div>
  );
}

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={SingleArtist} />
        <Route path="/single-artist" component={SingleArtist} />
        <Route path="/bulk" component={BulkBrands} />
        <Route path="/bulk/brands" component={BulkBrands} />
        <Route path="/bulk/creators" component={BulkBrands} />
        <Route path="/bulk/artists" component={BulkBrands} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster position="top-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
