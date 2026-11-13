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
  const selected=[...grouped.values()].filter(g=>g.records.some(r=>r.triage.candidate));
  const row=group=>{
    const r=group.records[0].result;
    const distinct=fn=>[...new Set(group.records.map(fn))].join('; ');
    return [r.artist,r.tier,r.profileId,r.cmArtist,r.url,distinct(x=>x.result.uploaderName),
      distinct(x=>x.triage.channelLabel),distinct(x=>x.triage.category),distinct(x=>x.triage.reason),
      group.records.some(x=>x.triage.category==='user_rejected')
        ?'Rejected — user review':'Not accepted — uploader discovery only',
      false,false,group.videos.size,JSON.stringify([...group.videos])];
  };
  const categories={};
  for(const {triage:t} of records)categories[t.category]=(categories[t.category]??0)+1;
  return {records,evidenceCsv:csv(columns,[...grouped.values()].map(row)),
    candidatesCsv:csv(columns,selected.map(row)),
    summary:{rawVideoObservations:results.length,artistChannelRows:grouped.size,
      reviewCandidateChannels:selected.length,
      artistsWithReviewCandidates:new Set(selected.map(v=>String(v.records[0].result.profileId))).size,
      categories,acceptedArtistOwnedLinks:0,importEligibleLinks:0,
      warning:'Candidate names are not ownership proof. Held uploaders are not proven wrong identities.'}};
}
