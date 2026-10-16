export function normalizeProfileUrl(value: string) {
  const trimmed = value.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function isProfileUrl(value: string) {
  try {
    const url = new URL(normalizeProfileUrl(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'open.spotify.com') return parts.length === 2 && parts[0] === 'artist' && /^[a-zA-Z0-9]{22}$/.test(parts[1]);
    if (host === 'youtube.com' && parts.length === 2) return parts[0] === 'channel' && /^UC[\w-]{22}$/.test(parts[1]);
    if (!['instagram.com', 'tiktok.com', 'youtube.com'].includes(host)) {
      return !url.port
        && /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}$/i.test(url.hostname)
        && !/\.(?:localhost|local|internal|test|invalid|example)$/i.test(url.hostname);
    }
    const handle = host === 'instagram.com' ? parts[0] : parts[0]?.startsWith('@') ? parts[0].slice(1) : '';
    if (parts.length !== 1 || !handle || !/^[\w.-]{2,120}$/.test(handle)) return false;
    if (host === 'instagram.com') return !['p', 'reel', 'reels', 'stories', 'explore', 'direct', 'accounts'].includes(handle.toLowerCase());
    return host === 'tiktok.com' || host === 'youtube.com';
  } catch {
    return false;
  }
}
