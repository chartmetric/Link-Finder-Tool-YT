// Saved-evidence review only: no provider, coordinator, claim or catalog writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
export const BATCH_ROOT='generated-artifacts/youtube-test-100-review-parallel-2026-11-17';
export const PREVIOUS_ROOT='generated-artifacts/youtube-test-100-review-e2e-2026-11-17';
export const AUDIT_ROOT='generated-artifacts/youtube-held-28-evidence-review-2026-11-17';

// Resource identity, not display-name similarity. Spotify IDs are case-sensitive.
export function referenceKey(value){
  let u;try{u=new URL(value);}catch{return null;}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)return null;
  const host=u.hostname.toLowerCase().replace(/^(?:www|m)\./,'');
  const p=u.pathname.replace(/\/+$/,'');
  if(host==='open.spotify.com'){
    const m=p.match(/^\/(?:intl-[a-z]{2}\/)?artist\/([A-Za-z0-9]{22})$/);
    return m?'spotify:artist:'+m[1]:null;
  }
  if(host==='instagram.com'&&/^\/[\w.]+$/.test(p)&&!['/p','/reel','/stories'].includes(p.toLowerCase()))
    return 'instagram:'+p.slice(1).toLowerCase();
  if(host==='tiktok.com'&&/^\/@[\w.]+$/.test(p))return 'tiktok:'+p.slice(2).toLowerCase();
  if(['twitter.com','x.com'].includes(host)&&/^\/\w+$/.test(p))return 'twitter:'+p.slice(1).toLowerCase();
  if(host==='facebook.com'){
    if(p==='/profile.php')return /^\d+$/.test(u.searchParams.get('id')??'')?'facebook:id:'+u.searchParams.get('id'):null;
    if(/^\/[\w.]+$/.test(p))return 'facebook:'+p.slice(1).toLowerCase();
  }
  return null;
}
export function exactCatalogCrosslinks(artist,capture){
  assert.equal(capture.bodySha256,digest(capture.body));
  const known=new Map();
  for(const a of artist.accounts??[]){
    assert.equal(a.profile_id,artist.profileId);assert.equal(a.cm_artist,artist.cmArtist);
    if(!a.is_active||a.disconnected_at)continue;
    const k=referenceKey(a.account_url);if(k)known.set(k,a);
  }
  return (capture.body.externalUrls??[]).flatMap(link=>{
    const key=referenceKey(link),a=key&&known.get(key);
    return a?[{key,channelDeclaredUrl:link,catalogUrl:a.account_url,accountId:a.account_id,
      catalogObservedAt:a.catalogReferenceProvenance?.observedAt??null,
      binding:a.binding??'catalog_link_not_independently_verified',
      direction:'candidate_channel_to_catalog_account',establishesOwnership:false}]:[];
  });
}
const notes={
  '197884':['strong','Channel links the exact catalog Spotify, Instagram and Twitter accounts. Its captured Rocks announcement also agrees with a catalog release.','Cross-links support identity, not who personally logs in.'],
  '4147835':['hold','Duo name, Osmosis and Mack Avenue agree with saved profile-level Instagram context, but no captured channel link points to a catalog reference account.','The saved Instagram bio is not account-bound ownership proof; the channel Spotify ID has no catalog counterpart in this packet.'],
  '206524':['strong','Exact catalog Instagram and TikTok links agree. The indexed channel snippets also mention catalog song titles.','Song titles are search snippets, not independently captured video credits.'],
  '3927575':['hold','Only the matching name and an indexed La Zone title are available; channel description, external links and catalog reference accounts are empty.','Cannot confirm this exact catalog artist from a name match alone.'],
  '267949':['strong','The channel links the exact catalog Spotify artist ID and uses the same artist name.','A sparse channel description does not negate the specific catalog cross-link.'],
  '203190':['hold','The channel Instagram handle sillysilky_ differs from catalog handle sillybutsilky; no catalog Spotify link was captured.','The handles might be aliases, but the saved evidence does not establish that. Official in the title is only a self-claim.'],
  '4151727':['hold','A detailed self-biography and several music links exist, but the packet contains no catalog accounts or releases with which to bind them.','A detailed official-channel self-claim does not independently identify this cm_artist.'],
  '4140721':['hold','The channel presents Abraham H., while the catalog name is AbrahamH Music; the indexed result shows them as credited collaborators. No bound reference accounts are saved.','An alias or a collaboration must be resolved before treating these as the same artist.'],
  '275599':['hold','The channel description and external links are empty. The search snippet says the channel has no content; its catalog Spotify account is not linked.','A matching handle is not sufficient confirmation. The no-content statement is a search snippet.'],
  '203275':['strong','Exact catalog Spotify, Instagram and TikTok links agree. The channel tagline also agrees with saved profile-level context.','The matching profile bio adds context, not a new independent account-bound source.'],
  '241840':['strong','The channel links the exact catalog Spotify artist ID and describes its own Polo Vibes music project.','AI-assisted music is not itself evidence of a wrong artist or third-party uploader.'],
  '3645344':['hold','The detailed DJ biography and channel music links are plausible, but the only catalog reference here is Twitter Rifoxx1, which the channel does not link.','The newly encountered Spotify and Instagram links are leads, not pre-existing catalog corroboration.'],
  '3977746':['hold','The channel has the same artist name and a music self-description, but no catalog reference accounts or releases are saved.','Names and self-description alone do not bind this channel to the exact catalog record.'],
  '67375':['strong','Exact catalog Spotify, Instagram and TikTok links agree; the channel search snippet also names saved releases.','The release mentions are indexed snippets, not independent channel-capture credits.'],
  '4014078':['hold','The matching-name channel links social profiles, but none can be compared with catalog accounts in the saved packet. Indexed videos include covers.','Cover performances do not automatically make a channel wrong, but do not establish this exact artist identity either.'],
  '3801299':['hold','The duo name matches; the captured description is only a contact address, with no external or catalog reference links.','No independent artist-channel connection is saved.'],
  '272871':['hold','Calling Up Above (Piano Version) agrees with the catalog in a search snippet, and the channel links a similarly named website.','The website has not been independently captured or catalog-bound; a search snippet is weaker than captured release credits.'],
  '271000':['hold','The channel describes a Christian-lofi collaboration and links its website and Instagram, but neither is a catalog reference in the packet.','A collaborative artist project should not be rejected merely for being a group; an exact catalog connection is still missing.'],
  '287999':['strong','The captured channel links the exact catalog Spotify artist ID, with consistent artist branding.','A missing official-artist badge is not a reason to discard this identity connection.'],
  '195821':['strong','The captured channel links the exact catalog Spotify artist ID, and its handle agrees with the catalog Instagram handle.','The separately listed Instagram URL uses a different handle. Do not infer those Instagram accounts are aliases without evidence.'],
  '211549':['strong','Exact catalog Instagram and TikTok links agree, with consistent singer-songwriter branding.','The captured social cross-links support identity; channel management remains unverified.'],
  '47828':['strong','Exact catalog Spotify, Instagram and Facebook links agree, along with the artist name and music-producer description.','An artist-facing channel need not prove which individual logs in to be a useful review candidate.'],
  '3726477':['hold','A matching artist name, detailed biography and music-platform links are saved, but there are no catalog accounts or releases to compare them against.','Self-published detail is not independent catalog identity evidence.'],
  '295977':['hold','The channel describes a band with the correct name, but it does not link the catalog Spotify account or mention the saved Traces release.','Band membership detail alone cannot establish this exact catalog band.'],
  '4013071':['hold','Only the matching name, generic description, named payment link and indexed music titles are available; there are no catalog reference accounts.','A matching payment handle does not prove artist identity or channel management.'],
  '246960':['strong','The channel links the exact catalog Spotify artist ID and presents itself consistently as Nikki Sparks.','Its official-channel statement is self-published; the specific Spotify cross-link is the additional identity evidence.'],
  '4148016':['hold','The channel claims to represent Shahrid Belal and names a digital partner, but no catalog reference accounts or releases are saved.','A digital partner does not automatically make this a third-party channel; the missing exact artist connection is the issue.'],
  '266680':['hold','The channel name matches, but its description is generic and it has no external links. No exact catalog release match is established by the indexed Heavenly Gate title.','Do not conflate Heavenly Gate with differently titled catalog releases such as Celestial Gates.'],
};
export async function auditHeld28(){
  const files={};
  const read=async f=>{const bytes=await fs.readFile(f);files[f]=digest(bytes);return JSON.parse(bytes);};
  const records=await read(BATCH_ROOT+'/results.json'),plan=await read(BATCH_ROOT+'/plan.json');
  const approval=await read(BATCH_ROOT+'/approval.json');
  assert.equal(approval.planSha256,digest(plan));
  const selected=records.filter(r=>!r.candidates.some(c=>c.status==='review_suggestion')&&
    r.candidates.some(c=>c.assessment?.modelAssessment.category==='identity_supported_control_uncertain'));
  assert.equal(selected.length,28);
  assert.deepEqual(selected.map(r=>r.artist.profileId).sort(),Object.keys(notes).sort());
  // Reconstruct channel captures from original provider bytes, not from model explanations.
  const receipts=[];
  for(const root of [PREVIOUS_ROOT,BATCH_ROOT]){
    for(const name of await fs.readdir(root+'/receipts')){
      if(!name.endsWith('.json'))continue;
      const packet=await read(root+'/receipts/'+name);
      if(packet.kind!=='metadata'||packet.status!==200)continue;
      const rawPath=root+'/'+packet.rawPath,raw=await fs.readFile(rawPath);
      files[rawPath]=digest(raw);assert.equal(files[rawPath],packet.rawBodySha256);
      assert.equal(packet.inputSha256,digest(packet.request));
      receipts.push({...packet,data:JSON.parse(raw),sourcePath:root+'/receipts/'+name,
        rawBodyBase64:raw.toString('base64')});
    }
  }
  const rows=[];
  for(const r of selected){
    const candidates=r.candidates.filter(c=>c.assessment?.modelAssessment.category==='identity_supported_control_uncertain');
    assert.equal(candidates.length,1,'Keep artist counts separate if this changes');
    const c=candidates[0],body=c.capture.body,[strength,reason,caution]=notes[r.artist.profileId];
    assert.ok(!c.sharedChannelConflict&&!c.contradictoryPair);
    const receipt=receipts.find(p=>p.profileId===r.artist.profileId&&p.cmArtist===r.artist.cmArtist&&
      new URL(p.request.url).searchParams.get('url')===c.capture.requestedUrl&&p.at===c.capture.capturedAt);
    assert.ok(receipt,'Missing exact original provider receipt');
    const restored=normalizeYoutubeChannel(receipt,c.capture.requestedUrl);assert.ok(restored);
    assert.deepEqual(restored.body,body);assert.equal(restored.bodySha256,c.capture.bodySha256);
    assert.equal(restored.rawReceiptSha256,c.capture.rawReceiptSha256);
    const links=exactCatalogCrosslinks(r.artist,c.capture);
    assert.equal(links.length>0,strength==='strong','Manual conclusion must agree with source cross-links');
    rows.push({artist:r.artist.name,tier:r.tier,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,
      youtube_url:'https://www.youtube.com/channel/'+body.channelId,channel_name:body.displayName,
      offline_review:strength==='strong'?'Stronger candidate — exact catalog cross-link':'Keep on hold — insufficient independent evidence',
      reason,caution,matched_catalog_urls:JSON.stringify(links.map(l=>l.catalogUrl)),
      matched_channel_urls:JSON.stringify(links.map(l=>l.channelDeclaredUrl)),
      match_details:links,channel_captured_at:c.capture.capturedAt,
      channel_capture_body_sha256:c.capture.bodySha256,source_receipt:receipt.sourcePath,
      original_model_assessment:c.assessment.modelAssessment.category,original_result_status:c.status,
      review_only:true,ownership_confirmed:false,import_eligible:false});
  }
  const stronger=rows.filter(r=>r.match_details.length).length;
  const summary={artistsReviewed:28,strongerCandidates:stronger,remainOnHold:28-stronger,
    originalSuggestedArtists:records.filter(r=>r.candidates.some(c=>c.status==='review_suggestion')).length,
    paidCalls:0,catalogWrites:0,coordinatorWrites:0,originalResultsChanged:false,policyChanged:false,
    ownershipConfirmed:0,originalInputsSha256:files,
    limitation:'A source review of an exposed, selected set, not a held-out accuracy test. Candidate-to-catalog cross-links support identity, not independently proven management. Profile-only bios and indexed snippets remain context.'};
  await frozenFileVerifier(files)();await fs.mkdir(AUDIT_ROOT);
  await fs.writeFile(AUDIT_ROOT+'/audit.json',JSON.stringify({summary,rows},null,2),{flag:'wx'});
  const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_name','offline_review','reason',
    'caution','matched_catalog_urls','matched_channel_urls','channel_captured_at','source_receipt',
    'channel_capture_body_sha256','original_model_assessment','original_result_status',
    'review_only','ownership_confirmed','import_eligible'];
  const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
  await fs.writeFile(AUDIT_ROOT+'/held-28-review.csv','\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))]
    .map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
  await frozenFileVerifier(files)();
  console.log(JSON.stringify({artistsReviewed:28,strongerCandidates:stronger,remainOnHold:28-stronger,
    paidCalls:0,catalogWrites:0,originalResultsChanged:false,csv:AUDIT_ROOT+'/held-28-review.csv'}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--offline-review']);await auditHeld28();
}
