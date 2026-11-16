// Pure verification of the mixed capture contract, not the older uploader contract.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {identityArchivePath,identityJson,sourceFile} from './youtube-video-identity-source.mjs';
import {validateMixedCapturePlan,approveMixedCaptures} from './youtube-mixed-channel-captures.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';

export function mixedIdentitySourceNames(plan){
  const root='generated-artifacts/'+plan.id;
  return [...new Set([...Object.keys(plan.sourceFiles),
    ...Object.keys(plan.runtimeFiles).map(n=>root+'/'+n),
    ...['plan.json','approval.json','summary.json','returns.json'].map(n=>root+'/'+n),
    ...plan.operations.flatMap(op=>['.json','.raw'].map(ext=>root+'/receipts/'+digest(op.key)+ext))])].sort();
}

export function verifyMixedIdentitySource(source){
  assert.match(source.id??'',/^youtube-mixed-captures-[a-z0-9-]{4,80}$/);
  const root='generated-artifacts/'+source.id,read=name=>identityJson(sourceFile(source,name));
  const plan=validateMixedCapturePlan(read(root+'/plan.json'));
  assert.equal(plan.id,source.id);
  assert.deepEqual(Object.keys(source.files).sort(),mixedIdentitySourceNames(plan));
  for(const name of Object.keys(source.files))identityArchivePath(name);
  const approval=read(root+'/approval.json');
  assert.deepEqual(approveMixedCaptures(plan,approval),approval);
  for(const [name,hash] of Object.entries(plan.sourceFiles))
    assert.equal(digest(sourceFile(source,name)),hash,'Changed original source: '+name);
  for(const [name,hash] of Object.entries(plan.runtimeFiles))
    assert.equal(digest(sourceFile(source,root+'/'+name)),hash,'Changed capture runtime: '+name);
  // This runner never updated its preparation summary. Do not require or invent
  // a completed summary, and do not claim a fresh coordinator acknowledgment.
  const summary=read(root+'/summary.json');
  assert.equal(summary.id,plan.id);assert.equal(summary.planSha256,digest(plan));
  const searchName='generated-artifacts/'+plan.sourceSearchId+'/plan.json';
  assert.ok(Object.hasOwn(plan.sourceFiles,searchName),'Missing original catalog packets');
  const search=read(searchName);assert.equal(search.id,plan.sourceSearchId);
  assert.equal(search.catalogEvidenceSha256,digest(search.packets));
  const artists=plan.artists.map(a=>{
    const matches=search.packets.filter(p=>p.profileId===a.profileId&&p.cmArtist===a.cmArtist);
    assert.equal(matches.length,1,'Missing or ambiguous catalog identity');
    const packet=matches[0],artist=youtubeArtistFromCatalogPacket(packet);
    // Tier-refresh context is not artist identity evidence.
    const {tier,startingTier,...original}=a;
    assert.deepEqual(artist,original,'Catalog identity/context differs from original packet');
    return {artist,tier,catalogPacket:packet,catalogPacketSha256:digest(packet)};
  });
  const returns=read(root+'/returns.json');
  assert.equal(returns.planSha256,digest(plan));
  assert.equal(returns.returns.length,plan.operations.length,'Incomplete channel returns');
  const keys=new Set();
  const captures=returns.returns.map(saved=>{
    const r=saved.receipt,op=plan.operations.find(o=>o.key===r.operationKey);
    assert.ok(op,'Unexpected capture operation');
    assert.ok(!keys.has(op.key),'Duplicate capture return');keys.add(op.key);
    const receiptName=root+'/receipts/'+digest(op.key)+'.json';
    const receiptBytes=sourceFile(source,receiptName);
    assert.deepEqual(identityJson(receiptBytes),r,'Return does not match immutable receipt bytes');
    assert.equal(r.runId,plan.id);assert.equal(r.planSha256,digest(plan));
    assert.equal(r.approvalSha256,digest(approval));
    for(const name of ['profileId','cmArtist','kind','inputSha256'])assert.equal(r[name],op[name]);
    assert.equal(r.kind,'metadata');assert.equal(r.targetUrl,op.targetUrl);
    assert.deepEqual(r.request,op.request);assert.equal(r.inputSha256,digest(r.request));
    assert.equal(r.status,200);assert.ok(Number.isFinite(Date.parse(r.capturedAt)));
    assert.ok(Date.parse(r.capturedAt)>=Date.parse(approval.approvedAt),'Capture predates approval');
    assert.equal(r.rawPath,'receipts/'+digest(op.key)+'.raw');
    const raw=sourceFile(source,root+'/'+r.rawPath);
    assert.ok(raw.length&&raw.length<=2*1024*1024);
    assert.equal(digest(raw),r.rawBodySha256);
    const data=identityJson(raw);assert.equal(data.success,true);
    assert.ok(Number.isInteger(data.credits_charged)&&data.credits_charged>=0&&data.credits_charged<=1,
      'Unknown/increased capture billing');
    const capture=normalizeYoutubeChannel({at:r.capturedAt,status:200,kind:'metadata',
      operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data},op.targetUrl);
    const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound,'Unbound returned channel');
    if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
    assert.deepEqual(saved.capture,capture,'Do not trust an editable normalized capture');
    assert.equal(saved.ownershipAccepted,false);assert.equal(saved.importEligible,false);
    return {op,capture,aliases:bound.aliases,channelId:bound.body.channelId,
      receiptFileSha256:digest(receiptBytes),receiptSha256:digest(r),rawBodySha256:digest(raw),
      billedCredits:data.credits_charged};
  });
  return {plan,approval,artists,captures,sourceBinding:{
    id:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
    returnsFileSha256:digest(sourceFile(source,root+'/returns.json')),
    summaryFileSha256:digest(sourceFile(source,root+'/summary.json')),
    summaryStatus:summary.status,localReturnsComplete:true,
    liveCoordinatorReconciled:false,
    filesSha256:Object.fromEntries(Object.keys(source.files).sort().map(n=>[n,digest(sourceFile(source,n))]))}};
}
