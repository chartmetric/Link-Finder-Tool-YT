SELECT
    toString(p.id) AS profile_id,
    toString(p.cm_source_id) AS cm_artist,
    p.name AS artist,
    concat('https://app.chartmetric.com/artist/', toString(p.cm_source_id)) AS chartmetric_url,
    t.tier_rank,
    t.tier,
    sp.monthly_listeners
FROM (
    SELECT profile, tier_rank, tier
    FROM new_vertical.l_profile_tier FINAL
    WHERE profile_type = 'musician'
      AND tier = 3
      AND computed_at >= toStartOfDay(now())
) AS t
INNER JOIN (
    SELECT id, name, cm_source_id
    FROM new_vertical.profile FINAL
    WHERE cm_source = 'cm_artist' AND cm_source_id IS NOT NULL
) AS p ON p.id = t.profile
LEFT JOIN (
    SELECT cm_artist, argMax(monthly_listeners, timestp) AS monthly_listeners
    FROM new_vertical.spotify_artist_stat
    WHERE timestp >= today() - 120
    GROUP BY cm_artist
) AS sp ON sp.cm_artist = p.cm_source_id
WHERE t.profile NOT IN (
    SELECT l.profile_id
    FROM new_vertical.l_profile_account AS l FINAL
    INNER JOIN (SELECT id, platform FROM new_vertical.account FINAL) AS a
        ON a.id = l.account_id
    WHERE a.platform = 'instagram'
)
ORDER BY t.tier ASC, coalesce(sp.monthly_listeners, 0) DESC
