import { useEffect } from 'react';
import { MusicianPlatformCoverage } from './bulk/musician-platform-coverage';

export function ArtistPlatformCoverageOverview() {
  useEffect(() => {
    if (window.location.hash !== '#artist-platform-coverage') return;
    const frame = requestAnimationFrame(() => document.getElementById('artist-platform-coverage')?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section id="artist-platform-coverage" className="inv-cov scroll-mt-6" aria-labelledby="artist-platform-coverage-title" data-testid="section-artist-platform-coverage">
      <div className="inv-section-head">
        <div>
          <div className="inv-kicker">Artist coverage / Tiers 1–5</div>
          <h2 id="artist-platform-coverage-title">Instagram &amp; YouTube coverage</h2>
        </div>
      </div>
      <p className="inv-cov-note">Existing catalog links and saved suggestions, counted once per artist. Suggestions still need review; they are not live catalog links.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        {(['instagram', 'youtube'] as const).map(platform => (
          <article key={platform} className="min-w-0 rounded-xl border border-border bg-card p-4" aria-labelledby={`overview-${platform}-title`}>
            <h3 id={`overview-${platform}-title`} className="text-base font-bold">{platform === 'youtube' ? 'YouTube' : 'Instagram'}</h3>
            <MusicianPlatformCoverage platform={platform} />
          </article>
        ))}
      </div>
    </section>
  );
}
