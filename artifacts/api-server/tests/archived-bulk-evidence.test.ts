import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ListArchivedBulkEvidenceResponse, SearchProfilesResponse, GetBulkBrandRunResponse } from "@workspace/api-zod";
import { projectArchivedEvidence, readArchivedBulkEvidence } from "../src/lib/archived-bulk-evidence.ts";

const delivery = {matchedPostRecords:8,retainedPostRecords:3,omittedPostRecords:5};
const candidate = {url:"https://www.instagram.com/example/",jevVerification:{verdict:"uncertain",sameIdentityProbability:0.5}};
const raw = {profileId:"42",status:"needs_review",contextDelivery:delivery,rawResult:{profiles:[candidate]}};
const packet = {decisionRequest:{state:{artist:"Example",candidates:[{url:candidate.url}],
  artistContext:{candidateSignals:[{songTitlesInCandidatePosts:{diagnostics:{
    availableEvidence:45,inspectedEvidence:40,uninspectedEvidence:5,truncatedEvidence:2,
    matchedRecords:8,retainedRecords:3,omittedRecords:5,
  }}}]}}}};

test("saved delivery survives projection and response validation without altering decisions",()=>{
  const before = JSON.stringify(raw);
  const projected = projectArchivedEvidence(raw,packet);
  const parsed = ListArchivedBulkEvidenceResponse.parse({archives:["test"],records:[projected],page:1,hasMore:false});
  assert.equal(parsed.records[0].contextDelivery?.omittedPostRecords,5);
  assert.equal(parsed.records[0].contextDelivery?.candidatePostDiagnostics?.[0].diagnostics.uninspectedEvidence,5);
  assert.equal(parsed.records[0].candidates[0].verdict,"uncertain");
  assert.equal(parsed.records[0].deliverySource,"saved_result");
  assert.equal(JSON.stringify(raw),before);
});

test("partial results, zero counts, missing diagnostics and original request diagnostics stay distinct",()=>{
  assert.equal(projectArchivedEvidence({profileId:"1",status:"needs_review"}).contextDelivery,undefined);
  const partial = projectArchivedEvidence({partialEvidence:{contextDelivery:{matchedPostRecords:0,retainedPostRecords:0,omittedPostRecords:0}}});
  assert.equal(partial.contextDelivery?.omittedPostRecords,0);
  assert.equal(partial.deliverySource,"saved_result");
  const request = projectArchivedEvidence({}, {decisionRequest:{state:{contextDelivery:delivery}}});
  assert.equal(request.deliverySource,"archived_request");
  assert.equal(request.contextDelivery?.matchedPostRecords,8);
  assert.equal(projectArchivedEvidence({},packet).contextDelivery?.matchedPostRecords,undefined);
});

test("single-profile and managed bulk schemas preserve optional audit fields for saved readers",()=>{
  const result = {subject:"Example",query:"example",searchedAt:new Date().toISOString(),profiles:[],
    sources:[],totalFound:0,highConfidenceCount:0,estimatedCostUsd:0,methodsUsed:[],contextDelivery:delivery};
  assert.deepEqual(SearchProfilesResponse.parse(result).contextDelivery,delivery);
  const run = GetBulkBrandRunResponse.parse({id:"test",status:"completed",createdAt:"now",updatedAt:"now",
    heartbeatAt:"now",workerId:"test",resumeVersion:0,stopRequested:false,estimatedCostUsd:0,items:[{
      candidate:{profileId:42,profileName:"Example",tier:null,tierRank:null,accountId:"a",platform:"Spotify",handle:"example",url:candidate.url},
      status:"completed",platforms:[],result,contextDelivery:delivery,partialEvidence:{contextDelivery:delivery},
    }]});
  assert.equal(run.items[0].contextDelivery?.omittedPostRecords,5);
  assert.equal(run.items[0].partialEvidence?.contextDelivery?.omittedPostRecords,5);
});

test("archive reads are bounded, paginated, allowlisted, and leave saved bytes unchanged",async()=>{
  const root = await mkdtemp(path.join(os.tmpdir(),"bulk-evidence-"));
  const archive = "instagram-bulk-shadow-fixture";
  try {
    const dir = path.join(root,archive);
    await mkdir(path.join(dir,"responses"),{recursive:true});
    const data = Array.from({length:21},(_,i)=>JSON.stringify({...raw,profileId:String(i+1)})).join("\n");
    await writeFile(path.join(dir,"results.jsonl"),data);
    await writeFile(path.join(dir,"responses","1-jev-0.json"),JSON.stringify(packet));
    await mkdir(path.join(root,"unrelated"));
    await symlink(dir,path.join(root,"instagram-bulk-shadow-symlink"));
    const first = ListArchivedBulkEvidenceResponse.parse(await readArchivedBulkEvidence(undefined,1,root));
    assert.deepEqual(first.archives,[archive]);
    assert.equal(first.records.length,20);
    assert.equal(first.hasMore,true);
    assert.equal(first.records[0].contextDelivery?.candidatePostDiagnostics?.length,1);
    const second = await readArchivedBulkEvidence(archive,2,root);
    assert.equal(second.records.length,1);
    assert.equal(second.hasMore,false);
    await assert.rejects(()=>readArchivedBulkEvidence("../unrelated",1,root),/INVALID_ARCHIVE/);
    assert.equal(await readFile(path.join(dir,"results.jsonl"),"utf8"),data);
    await writeFile(path.join(dir,"responses","1-jev-1.json"),JSON.stringify(packet));
    const ambiguous = await readArchivedBulkEvidence(archive,1,root);
    assert.match(ambiguous.records[0].warning!,/Multiple archived requests/);
    assert.equal(ambiguous.records[0].contextDelivery?.candidatePostDiagnostics,undefined);
    await writeFile(path.join(dir,"results.jsonl"),"{broken");
    await assert.rejects(()=>readArchivedBulkEvidence(archive,1,root));
  } finally {await rm(root,{recursive:true,force:true});}
});
