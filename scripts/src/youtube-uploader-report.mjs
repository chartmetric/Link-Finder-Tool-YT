// Channel-level export: saved video observations remain untouched as evidence.
import {triageVideoUploader} from './youtube-uploader-triage.mjs';
import {normalizeDiscoveryChannel} from './youtube-video-discovery-offline.mjs';

const cell=v=>{
  let s=String(v??'');if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
const csv=(columns,rows)=>'\ufeff'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
export function buildVideoUploaderReport(artists,results){
  const canonicalResults=results.map(r=>({...r,url:normalizeDiscoveryChannel(r.url)}));
  const owners=new Map();
  for(const r of canonicalResults){
    const pairs=owners.get(r.url)??new Set();pairs.add(JSON.stringify([r.profileId,r.cmArtist]));owners.set(r.url,pairs);
  }
  const records=canonicalResults.map(result=>{
    const artist=artists.find(a=>String(a.profileId)===String(result.profileId)&&String(a.cmArtist)===String(result.cmArtist));
    if(!artist)throw Error('Missing exact catalog artist for uploader evidence');
    return {result,triage:triageVideoUploader(artist,result,{shared:owners.get(result.url).size>1})};
  });
  const columns=['artist','tier','profile_id','cm_artist','youtube_url','uploader_name',
    'channel_type_label','review_category','review_reason','identity_status','import_eligible',
    'ownership_accepted','source_video_count','evidence_video_urls'];
  const grouped=new Map();
  for(const record of records){
    const r=record.result,key=JSON.stringify([String(r.profileId),String(r.cmArtist),r.url]);
    const item=grouped.get(key)??{records:[],videos:new Set()};
    item.records.push(record);if(r.videoUrl)item.videos.add(r.videoUrl);grouped.set(key,item);
  }
  const groups=[...grouped.values()];
  for(const group of groups){
    const names=new Set(group.records.map(x=>String(x.result.uploaderName??'').normalize('NFKC').toLowerCase().trim()));
    group.conflictingNames=names.size>1;
    group.disposition=group.records.some(x=>x.triage.category==='user_rejected')?'rejected':
      group.records.every(x=>x.triage.candidate)&&!group.conflictingNames?'candidate':'held';
  }
  // A single positive video must never hide a conflicting observation for the
  // same channel. The primary deliverable contains candidates only.
  const selected=groups.filter(g=>g.disposition==='candidate');
  const row=group=>{
    const r=group.records[0].result;
    const distinct=fn=>[...new Set(group.records.map(fn))].join('; ');
    return [r.artist,r.tier,r.profileId,r.cmArtist,r.url,distinct(x=>x.result.uploaderName),
      distinct(x=>x.triage.channelLabel),
      group.conflictingNames&&group.disposition!=='rejected'?'conflicting_channel_observations_hold':distinct(x=>x.triage.category),
      (group.conflictingNames?'Conflicting saved uploader names; independent channel identity evidence required. ':'')+distinct(x=>x.triage.reason),
      group.disposition==='rejected'?'Rejected — user review':
        group.disposition==='held'?'Excluded — artist-channel match not established':'Candidate only — identity verification needed',
      false,false,group.videos.size,JSON.stringify([...group.videos]),group.disposition];
  };
  columns.push('export_disposition');
  const categories={};
  for(const {triage:t} of records)categories[t.category]=(categories[t.category]??0)+1;
  return {records,evidenceCsv:csv(columns,groups.map(row)),
    candidatesCsv:csv(columns,selected.map(row)),
    excludedCsv:csv(columns,groups.filter(g=>g.disposition!=='candidate').map(row)),
    summary:{rawVideoObservations:results.length,artistChannelRows:grouped.size,
      reviewCandidateChannels:selected.length,
      artistsWithReviewCandidates:new Set(selected.map(v=>String(v.records[0].result.profileId))).size,
      heldArtistChannelRows:groups.filter(g=>g.disposition==='held').length,
      rejectedArtistChannelRows:groups.filter(g=>g.disposition==='rejected').length,
      categories,acceptedArtistOwnedLinks:0,importEligibleLinks:0,
      warning:'Candidate names are not ownership proof. Held uploaders are not proven wrong identities.'}};
}
