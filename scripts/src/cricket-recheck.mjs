/** Retain provider-qualified identity and prior evidence without approving it. */
export function buildRecheckPlayers(rows, pilot = []) {
  const players = new Map();
  const add = (player, result, runId) => {
    if (!player.provider || !Number.isSafeInteger(Number(player.provider_player_id)) || !player.name) {
      throw new Error('Invalid provider-qualified cricket identity; no paid work may start.');
    }
    const key = `${player.provider}:${player.provider_player_id}`;
    let selected = players.get(key);
    if (!selected) {
      selected = { ...player, priorDiscovery: { runIds: [], candidateUrls: [] } };
      players.set(key, selected);
    }
    const prior = selected.priorDiscovery;
    if (!prior.runIds.includes(runId)) prior.runIds.push(runId);
    for (const candidate of result.profiles ?? []) {
      if (candidate.url && !prior.candidateUrls.includes(candidate.url)) prior.candidateUrls.push(candidate.url);
    }
  };
  for (const row of rows) {
    if (['queued', 'running'].includes(row.latest[0])) {
      throw new Error('An original cricket job is unfinished; review it before creating a paid recheck.');
    }
    add(JSON.parse(row.latest[1]), JSON.parse(row.latest[2]), row.run_id);
  }
  for (const row of pilot) add(row.player, row.result ?? {}, 'original-10-player-pilot');
  return [...players.values()];
}

export function requireSerper(result, player) {
  if (!result.methodsUsed?.some(method => method.method === 'serper' && method.status === 'used')) {
    throw new Error('Required Serper search did not complete. Rerun stopped; account availability is unknown. Review provider status before explicitly resuming.');
  }
  const normalize = value => {
    try {
      const url = new URL(value);
      return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
    }
    catch { return undefined; }
  };
  const priorUrls = player.priorDiscovery?.candidateUrls ?? [];
  const priorPaths = new Set(priorUrls.map(normalize).filter(Boolean));
  return {
    requiredProvider: 'serper',
    priorCandidateUrls: priorUrls,
    previouslySuggestedUrlsFoundAgain: (result.profiles ?? [])
      .filter(profile => priorPaths.has(normalize(profile.url))).map(profile => profile.url),
    identityVerified: false,
    note: 'Indexed search evidence, not identity approval. No candidate is not proof of account absence.',
  };
}
