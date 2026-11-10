import {instagramProfileUrl} from './musician-instagram-matching.mjs';

const safeUrl = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port;
  } catch { return false; }
};

// This describes provider capture, never ownership or proven absence on Instagram.
export function normalizeInstagramProfile(data, requestedUrl) {
  const user = data?.data?.user;
  const sourceUrl = instagramProfileUrl(`https://www.instagram.com/${user?.username}/`);
  if (!user?.username || !sourceUrl || sourceUrl !== instagramProfileUrl(requestedUrl)) {
    throw Object.assign(new Error('Instagram metadata missing or conflicting response-bound username.'),
      {linkCapture: failedLinkCapture(requestedUrl, 'identity_conflict')});
  }
  const fields = Object.fromEntries(['external_url','bio_links'].map(key => [key,
    !Object.hasOwn(user,key) ? 'missing'
      : key === 'bio_links' ? Array.isArray(user[key]) ? 'list' : 'invalid'
      : user[key] === null || typeof user[key] === 'string' ? 'scalar' : 'invalid']));
  const raw = [user.external_url, ...(Array.isArray(user.bio_links) ? user.bio_links.map(b=>b?.url) : [])];
  const urls = [...new Set(raw.filter(safeUrl))];
  const rejected = raw.filter(v=>v != null && v !== '' && !safeUrl(v)).length
    + (Array.isArray(user.bio_links) ? user.bio_links.filter(b=>!b || typeof b.url!=='string' || !b.url).length : 0);
  const complete = fields.external_url === 'scalar' && fields.bio_links === 'list' && rejected === 0;
  const status = !complete ? 'incomplete_fields' : urls.length ? 'links_captured' : 'explicit_empty';
  return {platform:'instagram',url:sourceUrl,displayName:user.full_name,bio:user.biography,
    externalUrls:urls,directExternalUrls:urls,
    linkCapture:{version:1,source:'scrapecreators_instagram_profile',sourceUrl,status,fields,
      rejectedLinkCount:rejected,capturedLinkCount:urls.length,absenceConfirmed:false,
      fallback:'not_attempted_no_separate_approval'}};
}

export function failedLinkCapture(sourceUrl, status = 'error_response', httpStatus) {
  return {version:1,source:'scrapecreators_instagram_profile',
    sourceUrl:instagramProfileUrl(sourceUrl),status,
    ...(httpStatus ? {httpStatus} : {}),absenceConfirmed:false,
    fallback:'not_attempted_no_separate_approval'};
}

// Old normalized [] arrays cannot be retrospectively called explicit provider empties.
export function profileLinkDiagnostics(profile) {
  const candidate = profile?.identityComparison?.candidate;
  const capture = candidate?.linkCapture ?? profile?.linkCapture ?? {
    status:profile?.metadataLookupError ? 'error_response' : 'unknown_legacy_capture',
    sourceUrl:profile?.url,absenceConfirmed:false,
  };
  const hub = candidate?.externalLinkEvidence;
  const resolution = candidate?.linkResolution ?? (hub?.resolutionCapped ? 'capped'
    : hub?.status === 'exact_catalog_music_identity' ? 'exact_catalog_music_identity'
    : hub?.attempts?.some(a=>a.status==='failed') ? 'error_response'
    : hub ? 'checked_unresolved' : 'not_attempted');
  return {capture,resolution};
}

export function incompleteLinkEvidence(profile) {
  const {capture,resolution} = profileLinkDiagnostics(profile);
  return ['incomplete_fields','restricted_response','error_response','identity_conflict'].includes(capture.status)
    || resolution === 'capped' || resolution === 'error_response';
}
