import { ArrowUpRight } from "lucide-react";

type AliasProfile = { url: string; channelId?: string; urlAliases?: string[] };

export function ProfileUrlAliases({ profile, compact = false }: { profile?: AliasProfile; compact?: boolean }) {
  if (!profile?.channelId || !profile.urlAliases?.length) return null;
  const aliases = [...new Set(profile.urlAliases)].filter(url => url !== profile.url);
  if (!aliases.length) return null;
  return (
    <span className={`inv-url-aliases${compact ? " compact" : ""}`} data-testid="profile-url-aliases">
      {aliases.map(url => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer">
          <span>{new URL(url).pathname.startsWith("/channel/") ? "Channel ID" : "Handle"}:</span>{" "}
          {url.replace(/^https?:\/\/(www\.)?/, "")} <ArrowUpRight size={11} aria-hidden="true" />
        </a>
      ))}
      <small title={`Resolved YouTube channel ID: ${profile.channelId}`}>Same channel confirmed · artist match assessed separately</small>
    </span>
  );
}
