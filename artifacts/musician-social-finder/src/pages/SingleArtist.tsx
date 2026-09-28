import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleAlert, Clipboard, Compass, ExternalLink, Fingerprint, Instagram, Link2, Radar, RefreshCw, SearchCheck, ShieldCheck, Sparkles, Youtube } from 'lucide-react';
import { searchProfiles, type ProfileMatch, type ProfileSearchResponse } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';

const platforms = [
  { name: 'Instagram', icon: Instagram },
  { name: 'TikTok', icon: Activity },
  { name: 'YouTube', icon: Youtube },
] as const;

function isProfileUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const path = url.pathname.split('/').filter(Boolean);
    const handle = host === 'instagram.com' ? path[0] : path[0]?.startsWith('@') ? path[0].slice(1) : '';
    if (path.length !== 1 || !handle || !/^[\w.-]{2,120}$/.test(handle)) return false;
    if (host === 'instagram.com') return !['p', 'reel', 'reels', 'stories', 'explore', 'direct', 'accounts'].includes(handle.toLowerCase());
    if (host === 'tiktok.com' || host === 'youtube.com') return true;
    return false;
  } catch {
    return false;
  }
}

const searchSchema = z.object({
  url: z.string().trim().min(1, 'Paste a profile URL to begin.').max(500, 'The URL must be 500 characters or fewer.').refine(isProfileUrl, 'Enter an Instagram, TikTok or YouTube profile URL, not a post or video link.'),
});
type SearchValues = z.infer<typeof searchSchema>;

const stages = [
  { title: 'Reading the reference', detail: 'Resolving the profile URL as the identity clue.' },
  { title: 'Searching across platforms', detail: 'Looking for possible Instagram, TikTok and YouTube accounts.' },
  { title: 'Comparing the evidence', detail: 'Checking candidate signals and identity overlap.' },
  { title: 'Preparing the review', detail: 'Waiting for the complete response and verification.' },
];

function getStage(seconds: number) {
  return seconds < 4 ? 0 : seconds < 14 ? 1 : seconds < 31 ? 2 : 3;
}

function errorMessage(error: unknown) {
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: string; data?: { error?: string; message?: string } };
    return e.data?.error || e.data?.message || e.message || 'The investigation could not be completed.';
  }
  return 'The investigation could not be completed.';
}

function cleanDisplayUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

function Candidate({ candidate, index }: { candidate: ProfileMatch; index: number }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const comparison = candidate.identityComparison;
  const jev = candidate.jevVerification;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(candidate.url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="inv-candidate" data-testid={`card-candidate-${index}`}>
      <div className="inv-candidate-top">
        <div style={{ minWidth: 0 }}>
          <div className="inv-candidate-label">Candidate {String(index + 1).padStart(2, '0')} / {candidate.platform}</div>
          <h4 data-testid={`text-candidate-title-${index}`}>{candidate.title || cleanDisplayUrl(candidate.url)}</h4>
          <a data-testid={`link-candidate-${index}`} className="inv-candidate-link" href={candidate.url} target="_blank" rel="noopener noreferrer">
            {candidate.displayUrl || cleanDisplayUrl(candidate.url)} <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </div>
        <div className="inv-score" title="Discovery score, not the probability that this is the correct identity">
          <strong data-testid={`text-candidate-confidence-${index}`}>{candidate.confidence}%</strong>
          <span>Search score</span>
        </div>
      </div>
      {candidate.snippet && <p className="inv-candidate-snippet" data-testid={`text-candidate-snippet-${index}`}>{candidate.snippet}</p>}
      {(comparison || jev || candidate.identityVerificationNote) && <div className="inv-candidate-findings">
        {jev && <div className="inv-finding-line" data-testid={`status-jev-summary-${index}`}><ShieldCheck size={15} /><span><b>JEV {jev.verdict}</b> · {(jev.verdictConfidence * 100).toFixed(1)}% verdict confidence · {(jev.sameIdentityProbability * 100).toFixed(1)}% same identity</span></div>}
        {comparison && <div className="inv-finding-line" data-testid={`text-identity-summary-${index}`}><Fingerprint size={15} /><span><b>Identity {comparison.status}</b> · {comparison.score}/100{comparison.reasons[0] ? ` — ${comparison.reasons[0]}` : ''}</span></div>}
        {candidate.identityVerificationNote && <div className="inv-finding-line"><CircleAlert size={15} /><span>{candidate.identityVerificationNote}</span></div>}
      </div>}
      {(candidate.signals.length > 0 || candidate.methods.length > 0) && (
        <div className="inv-chips">
          {candidate.signals.map((signal, i) => <span className="inv-chip signal" key={`${signal}-${i}`}>{signal}</span>)}
          {candidate.methods.map((method, i) => <span className="inv-chip" key={`${method}-${i}`}>via {method}</span>)}
        </div>
      )}
      <details className="inv-evidence" data-testid={`details-evidence-${index}`}>
        <summary data-testid={`button-evidence-${index}`}>Examine evidence <ChevronDown size={13} aria-hidden="true" /></summary>
        <div className="inv-evidence-body">
          {comparison ? (
            <div className="inv-evidence-block">
              <b>Identity comparison</b>
              <div className="inv-verdict"><span>{comparison.status}</span><span>Score {comparison.score}/100</span></div>
              {comparison.reasons.length > 0 && <ul>{comparison.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
              <p>Reference: {comparison.reference.displayName || comparison.reference.handle} ({comparison.reference.platform}) · Candidate: {comparison.candidate.displayName || comparison.candidate.handle} ({comparison.candidate.platform})</p>
            </div>
          ) : <div className="inv-evidence-block"><b>Identity comparison</b><p>No comparison was returned for this candidate.</p></div>}
          {jev ? (
            <div className="inv-evidence-block">
              <b>JEV verification</b>
              <div className="inv-verdict">
                <span data-testid={`status-jev-${index}`}>Verdict: {jev.verdict}</span>
                <span>Same identity: {(jev.sameIdentityProbability * 100).toFixed(1)}%</span>
                <span>Verdict confidence: {(jev.verdictConfidence * 100).toFixed(1)}%</span>
              </div>
              {Object.keys(jev.probabilities).length > 0 && <p>Probability breakdown: {Object.entries(jev.probabilities).map(([key, value]) => `${key} ${(value * 100).toFixed(1)}%`).join(' · ')}</p>}
            </div>
          ) : <div className="inv-evidence-block"><b>JEV verification</b><p>No JEV verdict was returned for this candidate.</p></div>}
          {candidate.identityVerificationNote && <div className="inv-evidence-block"><b>Verification note</b><p>{candidate.identityVerificationNote}</p></div>}
          <button className="inv-retry" type="button" onClick={copy} data-testid={`button-copy-candidate-${index}`}>
            {copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? 'Copied' : 'Copy profile URL'}
          </button>
        </div>
      </details>
    </article>
  );
}

export default function SingleArtist() {
  const form = useForm<SearchValues>({ resolver: zodResolver(searchSchema), defaultValues: { url: '' } });
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<ProfileSearchResponse | null>(null);
  const [failure, setFailure] = useState('');
  const [searchedUrl, setSearchedUrl] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const requestId = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'pending') return;
    const started = Date.now();
    const interval = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  async function runSearch(values: SearchValues) {
    if (status === 'pending') return;
    const url = values.url.trim();
    const currentRequest = ++requestId.current;
    setSearchedUrl(url);
    setResult(null);
    setFailure('');
    setElapsed(0);
    setStatus('pending');
    window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }), 80);
    try {
      const response = await searchProfiles({ knownProfileUrl: url, methods: ['serper', 'gemini'] }, { signal: AbortSignal.timeout(65000) });
      if (currentRequest !== requestId.current) return;
      setResult(response);
      setStatus('success');
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      setFailure(errorMessage(error));
      setStatus('error');
    }
  }

  const stage = getStage(elapsed);
  const sortedProfiles = result ? [...result.profiles].sort((a, b) => b.confidence - a.confidence) : [];
  const sources = result?.sources ?? [];

  return (
    <div className="investigation">
      <header className="inv-nav">
        <div className="inv-wrap inv-nav-inner">
          <Link href="/" className="inv-brand" data-testid="link-brand-home" aria-label="Find Social Links, return to catalog">
            <span className="inv-brand-mark"><Activity size={19} strokeWidth={2.5} /></span>
            <span className="inv-brand-name">Find Social Links<span className="inv-brand-caption inv-mono">Human review workspace</span></span>
          </Link>
          <div className="inv-nav-right">
            <span className="inv-nav-tag inv-mono"><i />Single-profile investigation</span>
            <Link href="/" className="inv-back" data-testid="link-return-catalog"><ArrowLeft size={15} /> Back to catalog</Link>
          </div>
        </div>
      </header>

      <main>
        <section className="inv-wrap inv-hero" aria-labelledby="investigation-title">
          <div className="inv-hero-copy">
            <div className="inv-eyebrow inv-mono">The investigation desk / 01</div>
            <h1 id="investigation-title">Start with<br /><em>one link.</em></h1>
            <p className="inv-hero-desc">A single known profile can open the trail. Search for connected accounts, inspect the evidence, and decide what belongs to the same person.</p>
            <div className="inv-hero-foot inv-mono">
              <span><Fingerprint size={15} /> Identity-first search</span>
              <span><ShieldCheck size={15} /> Evidence over assumptions</span>
            </div>
          </div>
          <div className="inv-visual" aria-hidden="true">
            <div className="inv-orbit three" /><div className="inv-orbit two" /><div className="inv-orbit one" />
            <div className="inv-orbit-core"><Radar size={38} strokeWidth={1.6} /></div>
            <div className="inv-float ig"><Instagram size={14} /> Instagram</div>
            <div className="inv-float tt"><Activity size={14} /> TikTok</div>
            <div className="inv-float yt"><Youtube size={15} /> YouTube</div>
            <div className="inv-visual-caption inv-mono">Reference / discovery / verification</div>
          </div>
        </section>

        <div className="inv-wrap inv-workspace">
          <div className="inv-section-head">
            <div><div className="inv-kicker">01 / Starting point</div><h2>Enter a known profile</h2></div>
            <p className="inv-section-note">Use a profile page, not a post, reel, short or video.</p>
          </div>
          <div className="inv-search-card">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(runSearch)} noValidate data-testid="form-single-profile-search">
                <div className="inv-search-top">
                  <div className="inv-search-entry">
                    <label htmlFor="single-profile-url" className="inv-label">Instagram, TikTok or YouTube profile URL</label>
                    <div className="inv-input-row">
                      <FormField control={form.control} name="url" render={({ field }) => (
                        <FormItem style={{ flex: 1, minWidth: 0 }}>
                          <div className="inv-input-wrap"><Link2 size={19} aria-hidden="true" /><FormControl><input {...field} id="single-profile-url" className="inv-input" type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://www.instagram.com/artistname" aria-label="Known social profile URL" disabled={status === 'pending'} data-testid="input-profile-url" /></FormControl></div>
                          <FormMessage className="inv-form-error" data-testid="text-url-error" />
                        </FormItem>
                      )} />
                      <button type="submit" className="inv-submit" disabled={status === 'pending'} data-testid="button-start-investigation">
                        {status === 'pending' ? 'Investigating' : 'Investigate link'} <ArrowRight size={16} />
                      </button>
                    </div>
                    <p className="inv-input-hint">The URL is used as the identity clue. Results are suggestions for human review, not automatic approvals.</p>
                  </div>
                  <div className="inv-search-aside">
                    <span className="inv-mono">Search scope</span>
                    <strong>Instagram</strong><strong>TikTok</strong><strong>YouTube</strong>
                  </div>
                </div>
                <div className="inv-search-bottom inv-mono"><span>SEARCH INPUT / ONE PROFILE URL</span><span>REQUESTED DISCOVERY / <b>SERPER + GEMINI</b></span></div>
              </form>
            </Form>
          </div>

          <div ref={resultRef} aria-live="polite">
            {status === 'pending' && (
              <section className="inv-panel" aria-label="Search progress" data-testid="status-investigation-pending">
                <div className="inv-panel-head"><div><h2>Following the signal</h2><p>One request is in progress. No results are available yet.</p></div><span className="inv-running">Request pending</span></div>
                <div className="inv-journey">
                  <div className="inv-journey-main">
                    <div className="inv-progress-note"><CircleAlert size={14} /> Visual progress indicator only — not live provider events or statuses.</div>
                    {stages.map((item, i) => <div key={item.title} className={`inv-stage ${i === stage ? 'current' : i < stage ? 'past' : ''}`}>
                      <span className="inv-stage-index">{i < stage ? <Check size={13} /> : String(i + 1).padStart(2, '0')}</span>
                      <div><div className="inv-stage-title">{item.title}</div><p className="inv-stage-detail">{item.detail}</p></div>
                    </div>)}
                  </div>
                  <div className="inv-journey-side"><div><div className="inv-side-label">Visual sequence / not a provider feed</div><div className="inv-side-num">{String(stage + 1).padStart(2, '0')}<span style={{ fontSize: 23, opacity: .5 }}>/04</span></div><p className="inv-side-copy">The actual provider outcomes and verification details appear only when the API responds.</p></div><div><div className="inv-side-label">Elapsed {elapsed}s · request may take up to 65s</div><div className="inv-progress-track"><div className="inv-progress-fill" /></div></div></div>
                </div>
              </section>
            )}

            {status === 'error' && (
              <section className="inv-panel" aria-label="Search failed" data-testid="status-investigation-error">
                <div className="inv-panel-head"><div><h2>Investigation interrupted</h2><p>No candidate or provider result was returned.</p></div></div>
                <div className="inv-error-card"><span className="inv-state-icon"><CircleAlert size={23} /></span><div className="inv-state-copy"><h3>We couldn’t complete this search.</h3><p data-testid="text-search-error">{failure}</p><p>Check the profile URL or try again. The same link is still in the field above.</p><button type="button" className="inv-retry" onClick={form.handleSubmit(runSearch)} data-testid="button-retry-search"><RefreshCw size={14} /> Retry investigation</button></div></div>
              </section>
            )}

            {status === 'success' && result && (
              <section className="inv-panel" aria-labelledby="result-title" data-testid="section-investigation-results">
                <div className="inv-panel-head">
                  <div><div className="inv-kicker">02 / Review the findings</div><h2 id="result-title">Investigation complete</h2><p>Read the evidence before treating any candidate as official.</p></div>
                  <div className="inv-results-meta"><span className="inv-meta-pill" data-testid="text-searched-at">{new Date(result.searchedAt).toLocaleString()}</span></div>
                </div>
                <div className="inv-summary">
                  <div className="inv-summary-lead"><span>Reference profile</span><h3 data-testid="text-result-subject">{result.subject || cleanDisplayUrl(searchedUrl)}</h3><p title={searchedUrl}>{cleanDisplayUrl(searchedUrl)}</p></div>
                  <div className="inv-summary-stat"><span>Candidates</span><strong data-testid="text-total-found">{result.totalFound}</strong></div>
                  <div className="inv-summary-stat"><span>High search score</span><strong data-testid="text-high-confidence">{result.highConfidenceCount}</strong></div>
                  <div className="inv-summary-stat"><span>Est. cost</span><strong data-testid="text-estimated-cost" style={{ fontSize: 16 }}>${result.estimatedCostUsd.toFixed(4)}</strong></div>
                </div>
                <div className="inv-results-layout">
                  <div>
                    {sortedProfiles.length === 0 && <div className="inv-empty-card" data-testid="status-no-candidates"><span className="inv-state-icon"><Compass size={23} /></span><div className="inv-state-copy"><h3>No candidate accounts returned</h3><p>This search completed without profile matches. Review the provider statuses and sources alongside this result, or try another known profile URL.</p><button type="button" className="inv-retry" onClick={form.handleSubmit(runSearch)} data-testid="button-retry-empty"><RefreshCw size={14} /> Run this search again</button></div></div>}
                    {platforms.map(({ name, icon: Icon }) => {
                      const matches = sortedProfiles.filter(p => p.platform.toLowerCase() === name.toLowerCase());
                      return <div className="inv-result-section" key={name}>
                        <div className="inv-result-section-header"><h3><Icon size={18} /> {name}</h3><span className="inv-result-count">{matches.length} {matches.length === 1 ? 'CANDIDATE' : 'CANDIDATES'}</span></div>
                        {matches.length ? matches.map((candidate, i) => <Candidate key={`${candidate.url}-${i}`} candidate={candidate} index={sortedProfiles.indexOf(candidate)} />) : <div className="inv-no-platform" data-testid={`status-no-${name.toLowerCase()}`}>No {name} candidate returned in this search.</div>}
                      </div>;
                    })}
                    {sortedProfiles.filter(p => !platforms.some(platform => platform.name.toLowerCase() === p.platform.toLowerCase())).map((candidate, i) => <Candidate key={`${candidate.url}-other-${i}`} candidate={candidate} index={sortedProfiles.indexOf(candidate)} />)}
                  </div>
                  <aside className="inv-sidebar">
                    <div className="inv-aside-card" data-testid="section-provider-statuses">
                      <div className="inv-aside-title"><SearchCheck size={16} /> Provider report</div>
                      {result.methodsUsed.length ? result.methodsUsed.map((method, i) => <div className="inv-method" key={`${method.method}-${i}`} data-testid={`status-provider-${method.method}-${i}`}>
                        <div className="inv-method-top"><strong>{method.label || method.method}</strong><span className={`inv-status ${method.status}`}>{method.status}</span></div>
                        <div className="inv-method-detail">{method.durationMs >= 1000 ? `${(method.durationMs / 1000).toFixed(1)}s` : `${method.durationMs}ms`} · {method.results.length} results · ${method.estimatedCostUsd.toFixed(4)}</div>
                        {method.costNote && <p className="inv-method-note">{method.costNote}</p>}
                      </div>) : <p className="inv-method-note" style={{ marginTop: 15 }}>No provider status was returned.</p>}
                    </div>
                    <div className="inv-aside-card" data-testid="section-search-sources">
                      <div className="inv-aside-title"><ExternalLink size={15} /> Search sources <span style={{ marginLeft: 'auto' }}>{sources.length}</span></div>
                      {sources.length ? sources.map((source, i) => <a key={`${source.url}-${i}`} className="inv-source" href={source.url} target="_blank" rel="noopener noreferrer" data-testid={`link-search-source-${i}`}><strong>{source.title || cleanDisplayUrl(source.url)}</strong><span>{cleanDisplayUrl(source.url)}</span></a>) : <p className="inv-method-note" style={{ marginTop: 15 }}>No source links were returned.</p>}
                    </div>
                    <div className="inv-aside-card"><div className="inv-aside-title"><Sparkles size={15} /> Review note</div><p className="inv-method-note" style={{ marginTop: 14, fontSize: 11 }}>Confidence and verification are different signals. Open each candidate’s evidence and visit the profile before making a decision.</p></div>
                  </aside>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
      <footer className="inv-footer inv-wrap"><span>FIND SOCIAL LINKS / HUMAN REVIEW WORKSPACE</span><span>One reference. Evidence-led discovery.</span></footer>
    </div>
  );
}