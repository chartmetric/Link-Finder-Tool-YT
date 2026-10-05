import { SiInstagram, SiSpotify, SiTiktok, SiYoutube } from 'react-icons/si';

export const presetProfileLinks = [
  { url: 'https://youtube.com/channel/UCmv1CLT6ZcFdTJMHxaR9XeA', label: 'UCmv1CLT6ZcFdTJMHxaR9XeA', Icon: SiYoutube },
  { url: 'https://www.instagram.com/tribbs', label: '@tribbs', Icon: SiInstagram },
  { url: 'https://www.tiktok.com/@iamchasematthew', label: '@iamchasematthew', Icon: SiTiktok },
  { url: 'https://www.youtube.com/channel/UChumNJVpgIOi3sd3j3Y8kpQ', label: 'UChumNJVpgIOi3sd3j3Y8kpQ', Icon: SiYoutube },
  { url: 'https://www.tiktok.com/@aimyon_official', label: '@aimyon_official', Icon: SiTiktok },
  { url: 'https://www.youtube.com/channel/UCxU6nh0LHqH9H4-fxWMGsgw', label: 'UCxU6nh0LHqH9H4-fxWMGsgw', Icon: SiYoutube },
  { url: 'https://open.spotify.com/artist/6nxWCVXbOlEVRexSbLsTer', label: 'Flume · Spotify', Icon: SiSpotify },
  { url: 'https://www.instagram.com/tribedaloca', label: '@tribedaloca', Icon: SiInstagram },
  { url: 'https://www.tiktok.com/@raja_kumari', label: '@raja_kumari', Icon: SiTiktok },
  { url: 'https://www.instagram.com/latinmafia', label: '@latinmafia', Icon: SiInstagram },
  { url: 'https://www.youtube.com/channel/UCZGBua-dvwfSdcF9AskDIgw', label: 'UCZGBua-dvwfSdcF9AskDIgw', Icon: SiYoutube },
] as const;

export function PresetProfileLinks({ value, disabled, onSelect }: { value: string; disabled: boolean; onSelect: (url: string) => void }) {
  return (
    <div className="inv-presets" aria-labelledby="preset-links-title" data-testid="section-preset-links">
      <div className="inv-presets-heading"><span id="preset-links-title">Try a preset profile</span><span>Choose a link, then investigate.</span></div>
      <div className="inv-preset-pills">
        {presetProfileLinks.map(({ url, label, Icon }, index) => (
          <button key={url} type="button" className="inv-preset-pill" title={url} aria-label={`Use ${url}`} aria-pressed={value.trim() === url} disabled={disabled} onClick={() => onSelect(url)} data-testid={`button-preset-${index}`}>
            <Icon size={14} aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
