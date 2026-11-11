// A read-only observer. No worker imports, provider dispatches, admissions,
// catalog writes, or DDL. Mirroring never restarts a paid worker.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {workspaceRoot} from "../lib/artist-campaign-progress";
import {YOUTUBE_CAMPAIGN_ID as id, youtubeDigest, validateYoutubeArtistProgress} from "../lib/youtube-artist-progress-model";
import {publishYoutubeCampaignProgress} from "../lib/youtube-artist-progress";
import {artistExportObject} from "../lib/artist-result-storage";
import {logger} from "../lib/logger";
import {pool} from "@workspace/db";

async function main() {
  assert.ok(process.argv.includes("--publish"));
  assert.ok(process.argv.includes(`--run-id=${id}`));
  const root=path.join(await workspaceRoot(),"generated-artifacts",id);
  const approval=JSON.parse(await readFile(path.join(root,"approval.json"),"utf8"));
  const queue=JSON.parse(await readFile(path.join(root,"queue.json"),"utf8"));
  assert.equal(approval.id,id);assert.equal(approval.explicitApproval,true);
  assert.equal(approval.maximumSpendCents,null);
  assert.equal(youtubeDigest(queue),approval.scopeSha256);
  assert.equal(queue.length,approval.totalArtists);
  const approvalHash=youtubeDigest(approval);
  const archived=new Set<string>();
  const outcomes=new Map<string,{held:number;pending:number}>();
  const mirror=async(name:string)=>{
    if(archived.has(name))return;
    const bytes=await readFile(path.join(root,name));
    const hash=createHash("sha256").update(bytes).digest("hex");
    const file=artistExportObject(`youtube-campaign-archive/${id}/${name}`);
    try{
      await file.save(bytes,{resumable:false,validation:"crc32c",contentType:"application/json",
        preconditionOpts:{ifGenerationMatch:0},metadata:{cacheControl:"no-store",metadata:{sha256:hash}}});
    }catch(e:any){
      if(e.code!==412)throw e;
      const [meta]=await file.getMetadata();assert.equal(meta.metadata?.sha256,hash,"Archived YouTube evidence changed.");
    }
    archived.add(name);
  };
  await mirror("approval.json");await mirror("queue.json");
  async function publish(){
    const c=await pool.connect();
    let campaign,artists,receipts;
    try{
      await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await c.query("SET LOCAL statement_timeout='15s'");
      campaign=(await c.query("SELECT * FROM youtube_link_campaigns WHERE id=$1",[id])).rows[0];
      assert.ok(campaign);assert.equal(campaign.scope_sha256,approval.scopeSha256);
      assert.equal(campaign.approval_sha256,approvalHash);assert.equal(campaign.maximum_spend_cents,null);
      assert.equal(campaign.total_artists,queue.length);
      if(campaign.status==="prepared"){await c.query("COMMIT");return;}
      artists=(await c.query(`SELECT profile_id,status,searched,checked,likely,candidates,result_sha256
        FROM youtube_link_campaign_artists WHERE campaign_id=$1 AND status!='queued'`,[id])).rows;
      const totals=(await c.query(`SELECT coalesce(sum(reserved_cents),0)::bigint reserved
        FROM youtube_link_campaign_admissions WHERE campaign_id=$1`,[id])).rows[0];
      assert.equal(String(totals.reserved),String(campaign.reserved_cents),"YouTube admission reservations disagree.");
      receipts=(await c.query(`SELECT operation_key,receipt_sha256 FROM youtube_link_campaign_admissions
        WHERE campaign_id=$1 AND status='returned'`,[id])).rows;
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
    // Only committed receipts are immutable. Never archive a file merely
    // because it exists: the worker might still be writing it.
    for(const receipt of receipts){
      const name="receipts/"+youtubeDigest(receipt.operation_key)+".json";
      if(archived.has(name))continue;
      const packet=JSON.parse(await readFile(path.join(root,name),"utf8"));
      assert.equal(youtubeDigest(packet),receipt.receipt_sha256);
      await mirror(name);
    }
    let searched=0,checked=0,likely=0,withCandidates=0,noChannel=0,deferred=0,held=0,pending=0;
    for(const a of artists){
      if(a.status==="deferred"){deferred++;continue;}
      if(a.status!=="completed")continue;
      assert.equal(a.searched,true);searched++;checked+=Number(a.checked);likely+=Number(a.likely);
      withCandidates+=Number(a.candidates>0);noChannel+=Number(a.candidates===0);
      let counts=outcomes.get(a.profile_id);
      if(!counts){
        const record=JSON.parse(await readFile(path.join(root,"artists",a.profile_id+".json"),"utf8"));
        assert.equal(youtubeDigest(record),a.result_sha256);
        assert.equal(record.artist.profileId,a.profile_id);
        await mirror("artists/"+a.profile_id+".json");
        await mirror("metadata/"+a.profile_id+".json");
        counts={held:0,pending:0};
        for(const candidate of record.candidates){
          await mirror("inputs/"+a.profile_id+"-"+youtubeDigest(candidate.url)+".json");
          if(candidate.decision.reason==="model_request_exceeds_approved_byte_limit")counts.held++;
          if(["needs_identity_check","needs_channel_metadata"].includes(candidate.decision.status))counts.pending++;
        }
        outcomes.set(a.profile_id,counts);
      }
      held+=counts.held;pending+=counts.pending;
    }
    const progress=validateYoutubeArtistProgress({
      runId:id,scopeSha256:approval.scopeSha256,status:campaign.status,totalArtists:queue.length,
      searchedArtists:searched,processedPercent:searched/queue.length*100,
      artistsWithCandidates:withCandidates,checkedArtists:checked,likelyMatches:likely,
      notAcceptedArtists:checked-likely,uncheckedArtists:withCandidates-checked,
      noChannelFound:noChannel,deferredArtists:deferred,heldCandidates:held,pendingCandidates:pending,
      successRate:checked?likely/checked*100:null,reservedUsd:Number(campaign.reserved_cents)/100,
      maximumSpendUsd:null,updatedAt:campaign.updated_at.toISOString(),capturedAt:new Date().toISOString(),
    });
    await publishYoutubeCampaignProgress(progress);
    logger.info({processed:searched,total:queue.length,likely,status:campaign.status},
      "YouTube campaign counters and evidence mirrored; no paid work performed");
  }
  try{
    do{
      await publish();
      if(!process.argv.includes("--watch"))break;
      await new Promise(resolve=>setTimeout(resolve,15000));
    }while(true);
  }finally{await pool.end();}
}
main().catch(e=>{
  logger.error({err:e},"YouTube progress publication stopped; paid worker was not restarted");
  process.exitCode=1;
});
