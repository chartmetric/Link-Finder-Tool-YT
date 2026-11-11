// Read archived files only. No provider calls, database connection or verdict writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
const deny=()=>{throw Error('Network access is forbidden during this saved-evidence review');};
globalThis.fetch=deny;
for(const [module,keys] of [[http,['request','get']],[https,['request','get']],
  [net,['connect','createConnection']],[tls,['connect']],[http2,['connect']]])
  for(const key of keys)module[key]=deny;

const source=path.resolve(process.argv[2]??'generated-artifacts/youtube-test-20-usd5-2026-11-11');
const output=path.resolve(process.argv[3]??source+'-offline-review');
assert.ok(output!==source&&!output.startsWith(source+path.sep),'Never write inside the original archive');
const load=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const {evidenceDigest:hash}=await import(pathToFileURL(source+'/runtime/youtube-ownership-policy.mjs'));
const {parseYoutubeDecision,youtubeDecisionRequest}=await import(pathToFileURL(source+'/runtime/youtube-ownership-transport.mjs'));
const approval=await load(source+'/approval.json'),summary=await load(source+'/summary.json');
const packets=await load(source+'/supplemental-catalog/packets.json');
assert.equal(hash(approval.artists),approval.scopeSha256);
assert.equal(hash(packets),approval.catalogEvidenceSha256);
for(const [name,sha] of Object.entries(approval.runtimeFiles))
  assert.equal(hash(await fs.readFile(source+'/runtime/'+name,'utf8')),sha);
const receipts=new Map(),proof=[];
for(const file of await fs.readdir(source+'/receipts')){
  const receipt=await load(source+'/receipts/'+file);
  assert.equal(file,hash(receipt.operationKey)+'.json');
  assert.equal(hash(receipt.request),receipt.inputSha256);
  assert.equal(receipt.status,200);
  receipts.set(receipt.operationKey,receipt);
  proof.push({file:'receipts/'+file,sha256:hash(receipt),kind:receipt.kind,requestSha256:receipt.inputSha256});
}
const records=[];
for(const a of approval.artists)records.push(await load(source+'/artists/'+a.profile_id+'.json'));
const preparation=await fs.readFile(source+'/runtime/instagram-artist-metadata-overlay.mjs','utf8');
assert.ok(preparation.includes("platform!='instagram'"));
const triage={
  '289196':['matching_music_id_but_ownership_unresolved',
    'Both tested URLs resolve to the same DJ PANDA SC channel. Its localized Spotify artist URL contains the exact catalog artist ID. Both recorded verdicts were likely, but both channel types were unknown. The strict URL comparison does not recognize the localized path.',
    'Preserve the existing hold. Normalize the observed Spotify path, deduplicate the resolved channel, and obtain ownership-role evidence before any separately approved recheck.'],
  '4142953':['name_consistent_but_ownership_unresolved',
    'One channel is explicitly Topic and was correctly kept separate; the other has the artist name and social links but no captured biography or independent catalog cross-link.',
    'Retain Topic separately. Look for exact catalog-bound social references in a future preparation.'],
  '215527':['name_consistent_but_ownership_unresolved',
    'Sweatbaby channel has a music biography and a music-link page. Five catalog releases were supplied, but no captured videos or official reference page connected them. Keith Sweat is a separate name and was rejected.',
    'Use exact catalog-bound references and attributed release/video evidence, not the similar Keith Sweat name.'],
  '3553426':['name_consistent_but_ownership_unresolved',
    'HugeBoi channel matches the artist name but has a short biography; one catalog track was supplied. The Big Boi alternative was rejected.',
    'Disambiguate using the saved catalog track and exact official accounts, without accepting name agreement alone.'],
  '3558239':['name_consistent_but_ownership_unresolved',
    'Channel name agrees with jo from school, but the supplied artist context has no releases and only a brief channel biography.',
    'Find bound reference links or channel-attributed catalog music before rechecking.'],
  '3574870':['name_consistent_but_ownership_unresolved',
    'MALIA is a matching but potentially ambiguous name. No catalog releases or exact identity cross-link were supplied.',
    'Resolve the specific catalog artist using official references; do not accept the shared name alone.'],
  '3688313':['name_consistent_but_ownership_unresolved',
    'Two different channels use Deep Current. Neither has an independent identity link to the catalog artist in the supplied evidence.',
    'Disambiguate the channels using exact references; do not merge them by display name.'],
  '3888869':['name_consistent_but_ownership_unresolved',
    'Blue is a generic artist name. Official Blue and The Blue Van are distinct candidates, with no catalog releases or direct identity reference supplied.',
    'Use artist-specific music context and exact catalog accounts before choosing a channel.'],
  '256603':['search_relevance_or_alias_disambiguation',
    'Returned KXLLSWXTCH and Jordan G. Welch rather than a demonstrated WLCH identity. KXLLSWXTCH links to a different Spotify artist ID, so that candidate has a recorded conflict.',
    'Preserve the Spotify conflict. Improve music-specific, exact-name discovery without assuming Welch is an alias.'],
  '3552110':['search_relevance_or_alias_disambiguation',
    'Returned Lecrae and ERA without any supplied alias or exact identity path connecting either to Ecra.',
    'Use music-specific exact-name searching and bound artist context; similar spelling is not an alias.'],
  '3570941':['search_relevance_or_alias_disambiguation',
    'Returned The Bar-Kays Music rather than a demonstrated BARAS FUNKY identity.',
    'Improve exact-artist music discovery before spending on unrelated channel checks.'],
  '3766408':['search_relevance_or_alias_disambiguation',
    'The ODF search returned mostly Official Artist Channel help pages; its only channel candidate was Bob Ross.',
    'Change generic artist/official-channel wording to musician-specific discovery anchored to the actual artist.'],
  '3892503':['search_relevance_or_alias_disambiguation',
    'Pencing searches returned drawing/art channels, including Proko and pencil tutorials, not demonstrated musician identities.',
    'Disambiguate music from visual art and retain relevant musical context.'],
  '3932597':['search_relevance_or_alias_disambiguation',
    'Junior Sanchez and DJ Jose Sanchez were returned, but no supplied alias or account link connects them to Sanchezz DJ.',
    'Use artist-specific music context and explicit aliases, not broad surname/profession overlap.'],
  '3933503':['search_relevance_or_alias_disambiguation',
    'Nuk and Grace Potter were checked without a demonstrated connection to Nucro. An uninspected later result is Nucro - Topic; its title alone does not establish an artist-owned channel.',
    'Rank exact-name music leads ahead of unrelated popular channels; keep Topic separate and unverified.'],
  '3934478':['search_relevance_or_alias_disambiguation',
    'Ciara and CiaraVEVO were returned, with no supplied evidence connecting either to Ritah Ciara.',
    'Preserve the full artist name and disambiguate identity before channel ownership.'],
  '3838401':['search_relevance_or_alias_disambiguation',
    'islandman was returned for the catalog name 島民. No supplied evidence establishes a translation/alias or exact account relationship.',
    'Seek explicit alias or cross-account evidence; do not infer identity from a possible translation.'],
};
const counts={},rows=[],uniqueChannels=new Set(),pairs=new Map();
for(const r of records)for(const c of r.candidates){
  const key=r.artist.profileId+':'+c.capture.body.channelId;
  pairs.set(key,(pairs.get(key)??0)+1);uniqueChannels.add(c.capture.body.channelId);
}
const spotifyId=raw=>{
  try{
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.hostname!=='open.spotify.com'||u.username||u.password||u.port)return null;
    const p=u.pathname.split('/').filter(Boolean);
    if(p.length===3&&/^intl-[a-z]{2}$/i.test(p[0]))p.shift();
    return p.length===2&&p[0]==='artist'&&/^[A-Za-z0-9]{22}$/.test(p[1])?p[1]:null;
  }catch{return null;}
};
let modelCount=0,missingReasonCount=0,deliveredDeclarations=0,deliveredVideos=0,duplicateChecks=0;
const bodyBytes=[];
for(const r of records){
  const artist=r.artist,id=artist.profileId;
  const finding=triage[id]??(r.classification.likely?
    ['existing_likely_suggestion','Original likely suggestion, not independent ownership adjudication.','Keep as a review suggestion; no catalog import was authorized.']:
    ['no_channel_found_in_this_search','The single saved search found no accepted channel URL; this does not establish that the artist has no channel.','Use a better scoped search only under separate approval.']);
  counts[finding[0]]=(counts[finding[0]]??0)+1;
  const search=receipts.get('search-'+id+'-0');
  assert.equal(search.data.searchParameters.q,search.request.body.q);
  const known=artist.accounts.filter(a=>a.platform==='spotify').map(a=>spotifyId(a.account_url)).filter(Boolean);
  for(const c of r.candidates.length?r.candidates:[null]){
    const body=c?.capture?.body,answer=c?.recordedAnswer?.answer;
    let evidence=null;
    if(c?.recordedAnswer){
      const model=receipts.get('model-'+id+'-'+hash(c.url)),input=c.metadataActuallyUsed;
      assert.equal(hash(parseYoutubeDecision(model,input,approval.model,model.inputSha256)),hash(c.recordedAnswer));
      assert.equal(hash(youtubeDecisionRequest(input,approval.model).request),hash(model.request));
      evidence=input.state.artist.ownershipEvidence;
      assert.equal(hash(evidence),hash(model.request.body.state.artist.ownershipEvidence));
      deliveredDeclarations+=evidence.declarations.length;
      deliveredVideos+=evidence.channelAttributedVideos.length;
      assert.equal(input.state.artist.accounts.filter(a=>a.platform==='instagram').length,0);
      bodyBytes.push(Buffer.byteLength(JSON.stringify(model.request.body)));
      modelCount++;if(!('reasons' in answer)&&!('reason' in answer))missingReasonCount++;
    }
    const observed=(body?.externalUrls??[]).map(spotifyId).filter(Boolean);
    const pair=body?pairs.get(id+':'+body.channelId):0;
    rows.push({artist:artist.name,profile_id:id,cm_artist:artist.cmArtist,tier:r.tier,
      offline_triage:finding[0],saved_evidence_review:finding[1],recommended_next_check:finding[2],
      youtube_url:c?.url??'',resolved_channel_id:body?.channelId??'',captured_channel_name:body?.displayName??'',
      original_status:c?.decision.status??'no_channel_found',original_reason:c?.decision.reason??'no_channel_url_in_saved_search',
      original_review_suggestion:c?.decision.reviewSuggestion??false,original_score:c?.decision.score??'',
      original_model_verdict:answer?.verdict??'',original_model_channel_type:answer?.channelType??'',
      duplicate_address_observations:pair,known_spotify_artist_ids:known,observed_normalized_spotify_artist_ids:observed,
      normalized_spotify_id_agrees:observed.some(v=>known.includes(v)),
      localized_spotify_link:(body?.externalUrls??[]).some(v=>/open\.spotify\.com\/intl-/.test(v)),
      catalog_release_records_supplied:artist.releases.length,
      source_bound_youtube_declarations_supplied:evidence?.declarations.length??null,
      channel_attributed_videos_supplied:evidence?.channelAttributedVideos.length??null,
      instagram_reference_collection:'excluded_by_reused_preparation_query; actual_catalog_availability_not_checked',
      original_model_explanation_available:false,review_is_new_verification:false,
    });
  }
}
for(const n of pairs.values())if(n>1)duplicateChecks+=n-1;
assert.equal(records.length,20);assert.equal(rows.length,32);assert.equal(modelCount,29);
assert.equal(triage['289196'][0],'matching_music_id_but_ownership_unresolved');
assert.equal(rows.filter(r=>r.normalized_spotify_id_agrees).length,2);
const stats={sourceId:approval.id,providerRequests:0,databaseQueries:0,sourceArchiveModified:false,
  records:20,candidateObservations:31,distinctChannels:uniqueChannels.size,
  distinctArtistChannelPairs:pairs.size,duplicateChannelChecks:duplicateChecks,
  receiptsValidated:receipts.size,modelInputsValidated:modelCount,originalModelExplanationsMissing:missingReasonCount,
  minimumModelBodyBytes:Math.min(...bodyBytes),maximumModelBodyBytes:Math.max(...bodyBytes),
  originalModelByteCap:approval.model.model.maxRequestBytes,
  suppliedDeclarationObservations:deliveredDeclarations,suppliedChannelAttributedVideoObservations:deliveredVideos,
  artistsWithSavedReleaseFacts:packets.filter(p=>p.releases.length||p.catalogTracks.length).length,
  artistsWithInstagramAccountsInInputs:0,actualCatalogInstagramAvailability:'unknown; excluded from collection',
  originalResult:summary,offlineArtistTriage:counts,newAcceptedMatches:0,newFalsePositiveAdjudications:0};
await fs.mkdir(output,{recursive:false});
const cell=value=>{
  let s=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
  if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
const headers=Object.keys(rows[0]);
await fs.writeFile(output+'/saved-evidence-review.csv','\ufeff'+
  [headers,...rows.map(r=>headers.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n'));
await fs.writeFile(output+'/summary.json',JSON.stringify(stats,null,2));
await fs.writeFile(output+'/archive-proof.json',JSON.stringify({approvalSha256:hash(approval),receipts:proof},null,2));
await fs.writeFile(output+'/review.txt',`OFFLINE REVIEW OF THE 20-ARTIST YOUTUBE TEST

Original result: 2 likely suggestions; 17 checked without an accepted suggestion;
1 completed search without a channel URL. Nothing was rechecked or relabeled.

MAIN FINDINGS
1. Instagram references were excluded during preparation.
   The frozen shared metadata collector filters Instagram accounts and snapshots.
   All saved model inputs consequently contain zero Instagram catalog accounts.
   This is not evidence that the catalog lacks Instagram links. Its actual
   availability was not re-queried. Collection must be target-platform aware.

2. The single generic search often returned unrelated kinds of artist or music.
   ODF returned channel-setup help pages and Bob Ross. Pencing returned drawing
   tutorials. Nucro's first two choices were Nuk and Grace Potter; a later,
   uninspected result was Nucro - Topic, which is not an artist-owned account.
   All 20 returned search-parameter echoes match the exact requested query;
   this review found poor relevance, not proof of a transport/query substitution.

3. DJ PANDA SC is the strongest held lead, but is not newly verified.
   Its handle URL and channel-ID URL resolve to ONE channel, checked twice.
   The channel's intl-pt Spotify artist link has the exact catalog artist ID.
   That locale prefix is not recognized by the frozen strict URL comparator.
   Both original model verdicts were likely; the channel type was unknown, so
   the application kept both on hold. Scores were 0.49 and 0.54. A 0.90
   threshold did not cause the hold. This is at most ONE additional artist,
   not two recovered matches, and ownership is still unconfirmed.

4. Successfully retrieved channel metadata was not sufficient identity evidence.
   All 31 channel captures were usable, covering 30 unique channels.
   Only 5 of 20 supplied artist packets have release facts. The model requests
   contain no source-bound YouTube declarations or channel-attributed videos.
   All 29 model requests fit the unchanged 64,000-byte limit (largest:
   ${stats.maximumModelBodyBytes} bytes); this was not a size-limit failure.

5. The saved model replies contain no written explanation.
   The typed request asks for score, verdict and channel type, but not a separate
   explanation answer. Application hold reasons are known; attributing a specific
   internal model rationale to missing facts would be speculation.

OFFLINE TRIAGE OF THE 17 NOT-ACCEPTED ARTISTS
1 matching-music-ID lead with unresolved ownership (DJ PANDA SC).
7 name-consistent leads requiring stronger exact-artist ownership evidence.
9 requiring substantial search relevance or alias/identity disambiguation.
These are review categories, not truth labels or additional model verdicts.

RECOMMENDED ORDER
1. Retain exact catalog-bound Instagram references for future YouTube preparation.
2. Use music-specific, artist-anchored discovery instead of generic official-
   channel wording; preserve real alias/translation uncertainty.
3. Resolve channel aliases before repeated model checks, normalize observed
   localized Spotify artist URLs, and ask for concise evidence explanations.
4. Validate offline first. A fresh paid comparison needs separate approval.

No new paid calls, database queries, acceptance changes, catalog writes, campaign
resume or active-worker changes occurred. Original inputs and replies remain
unchanged. Verified ${receipts.size} receipts and all ${modelCount} archived model-input bindings.
`);
console.log(JSON.stringify(stats));
