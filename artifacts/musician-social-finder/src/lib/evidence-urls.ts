/** Only saved, metadata-confirmed channel IDs and aliases establish equivalence.
 * Similar handles, names, or identity-match verdicts must not merge accounts. */
export type EvidenceAccount = {
  platform: string;
  url: string;
  channelId?: string;
  urlAliases?: string[];
};

export type EvidenceUrlGroup = {
  urls: string[];
  confirmedAccount: boolean;
};

export function groupEvidenceUrls(urls: string[], accounts: EvidenceAccount[]): EvidenceUrlGroup[] {
  const channelsByUrl = new Map<string, Set<string>>();
  for (const account of accounts) {
    if (account.platform.toLowerCase() !== 'youtube' || !/^UC[\w-]{22}$/.test(account.channelId ?? '')) continue;
    for (const url of [account.url, ...(account.urlAliases ?? [])]) {
      const channels = channelsByUrl.get(url) ?? new Set<string>();
      channels.add(account.channelId!);
      channelsByUrl.set(url, channels);
    }
  }

  const groups = new Map<string, EvidenceUrlGroup>();
  for (const url of new Set(urls)) {
    const channels = channelsByUrl.get(url);
    // Conflicting metadata must not turn two possibly different accounts into one.
    const channelId = channels?.size === 1 ? [...channels][0] : undefined;
    const key = channelId ? `channel:${channelId}` : `url:${url}`;
    const group = groups.get(key) ?? { urls: [], confirmedAccount: !!channelId };
    group.urls.push(url);
    groups.set(key, group);
  }
  return [...groups.values()];
}
