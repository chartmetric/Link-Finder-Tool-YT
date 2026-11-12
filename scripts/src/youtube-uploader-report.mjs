// Read-only projection: raw uploader evidence stays separate from review candidates.
import {triageVideoUploader} from './youtube-uploader-triage.mjs';

const cell=v=>{
  let s=String(v??'');if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
const csv=(columns,rows)=>'\ufeff'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
export function buildVideoUploaderReport(artists,results){
  const owners=new Map();
  for(const r of results){
    const pairs=owners.get(r.url)??new Set();pairs.add(JSON.stringify([r.profileId,r.cmArtist]));owners.set(r.url,pairs);
  }
  const records=results.map(result=>{
    const artist=artists.find(a=>String(a.profileId)===String(result.profileId)&&String(a.cmArtist)===String(result.cmArtist));
    if(!artist)throw Error('Missing exact catalog artist for uploader evidence');
    return {result,triage:triageVideoUploader(artist,result,{shared:owners.get(result.url).size>1})};
  });
  const columns=['artist','tier','profile_id','cm_artist','video_url','youtube_url','uploader_name',
    'channel_type_label','review_category','review_reason','identity_status','import_eligible',
    'ownership_accepted','evidence_video_urls'];
  const row=({result:r,triage:t},videos=[r.videoUrl])=>[r.artist,r.tier,r.profileId,r.cmArtist,r.videoUrl,r.url,r.uploaderName,
    t.channelLabel,t.category,t.reason,'Not accepted — uploader discovery only',false,false,JSON.stringify(videos)];
  const selected=new Map();
  for(const record of records.filter(r=>r.triage.candidate)){
    const r=record.result,key=JSON.stringify([r.profileId,r.cmArtist,r.url]);
    const item=selected.get(key)??{record,videos:new Set()};item.videos.add(r.videoUrl);selected.set(key,item);
  }
  const categories={};
  for(const {triage:t} of records)categories[t.category]=(categories[t.category]??0)+1;
  return {records,evidenceCsv:csv(columns,records.map(r=>row(r))),
    candidatesCsv:csv(columns,[...selected.values()].map(v=>row(v.record,[...v.videos]))),
    summary:{rawVideoObservations:results.length,reviewCandidateChannels:selected.size,
      artistsWithReviewCandidates:new Set([...selected.values()].map(v=>v.record.result.profileId)).size,
      categories,acceptedArtistOwnedLinks:0,importEligibleLinks:0,
      warning:'Candidate names are not ownership proof. Held uploaders are not proven wrong identities.'}};
}
