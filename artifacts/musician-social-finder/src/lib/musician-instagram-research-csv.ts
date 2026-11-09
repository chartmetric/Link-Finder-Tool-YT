import type { MusicianInstagramResearchNoCandidates } from '@workspace/api-client-react';

function escapeCsvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export const MUSICIAN_INSTAGRAM_NO_CANDIDATE_CSV_HEADERS = [
  'artist_name',
  'profile_id',
  'cm_artist',
  'chartmetric_url',
  'outcome',
  'last_search_time',
] as const;

export function musicianInstagramNoCandidatesToCsv(data: MusicianInstagramResearchNoCandidates): string {
  const rows = data.profiles.map(profile => [
    profile.artist,
    profile.profileId,
    profile.cmArtist,
    profile.chartmetricUrl,
    profile.outcome,
    profile.lastSearchAt,
  ]);
  return [MUSICIAN_INSTAGRAM_NO_CANDIDATE_CSV_HEADERS, ...rows]
    .map(row => row.map(escapeCsvCell).join(','))
    .join('\r\n') + '\r\n';
}

export function downloadMusicianInstagramNoCandidatesCsv(data: MusicianInstagramResearchNoCandidates): void {
  const blob = new Blob(['\uFEFF', musicianInstagramNoCandidatesToCsv(data)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `musicians-without-instagram-urls-${data.generatedAt.replace(/[:.]/g, '-')}.csv`;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
