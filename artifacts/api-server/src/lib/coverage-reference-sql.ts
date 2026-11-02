/** Conservative account equivalence, not identity inference. Preserve case-sensitive
 * IDs (notably YouTube channel IDs) and query-based identity on other websites. */
export function coverageReferenceKeySql(column: string): string {
  const url = `ifNull(${column}, '')`;
  const host = `replaceRegexpOne(lowerUTF8(domain(${url})), '^(www[.]|m[.])', '')`;
  const path = `trimRight(path(${url}), '/')`;
  return `if(protocol(${url}) IN ('http', 'https') AND notEmpty(domain(${url})),
    multiIf(
      ${host} = 'instagram.com' AND match(${path}, '^/[A-Za-z0-9_.]+$')
        AND lowerUTF8(${path}) NOT IN ('/p', '/reel', '/reels', '/stories', '/explore'),
        concat(${host}, lowerUTF8(${path})),
      ${host} = 'tiktok.com' AND match(${path}, '^/@[A-Za-z0-9_.]+$'),
        concat(${host}, lowerUTF8(${path})),
      ${host} = 'youtube.com' AND match(${path}, '^/@[^/]+$'),
        concat(${host}, lowerUTF8(${path})),
      ${host} = 'youtube.com' AND match(${path}, '^/(channel|user|c)/[^/]+$'),
        concat(${host}, ${path}),
      ${host} = 'open.spotify.com' AND match(${path}, '^/artist/[^/]+$'),
        concat(${host}, ${path}),
      ${host} IN ('instagram.com', 'tiktok.com', 'youtube.com', 'open.spotify.com'), '',
      concat(lowerUTF8(domain(${url})), ${path},
        if(empty(queryString(${url})), '', concat('?', queryString(${url}))))
    ), '')`;
}
