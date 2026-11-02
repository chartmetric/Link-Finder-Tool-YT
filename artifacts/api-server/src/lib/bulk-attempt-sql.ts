/** Parse only identity and admission fields, never copy large provider results
 * into one JSON string per item and parse those strings repeatedly. All saved
 * snapshots remain authoritative, not just each run's latest snapshot. */
export const allPaidProfilesSql = `
  SELECT DISTINCT
    attemptedItem.candidate.profileId AS profile_id,
    arrayDistinct(arrayFilter(id -> notEmpty(id), arrayConcat(
      [attemptedItem.candidate.accountId],
      arrayMap(account -> account.accountId, attemptedItem.candidate.accounts)
    ))) AS account_ids
  FROM poc_new_verticals.profile_bulk_events
  ARRAY JOIN arrayFilter(entry ->
    (entry.status IN ('completed', 'failed', 'running') OR notEmpty(entry.startedAt)),
    JSONExtract(data_json, 'items',
      'Array(Tuple(candidate Tuple(profileId UInt64, accountId String, accounts Array(Tuple(accountId String))), status String, startedAt String))')
  ) AS attemptedItem
  PREWHERE event_type = 'snapshot'
`;

export const compactPaidProfilesSql = `${allPaidProfilesSql}
  WHERE profile_id IN {ids:Array(UInt64)}
    OR hasAny(account_ids, JSONExtract({accounts:String}, 'Array(String)'))
`;
