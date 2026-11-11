// Local-only adapter for already-saved Instagram captures. Never fetches links.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bindSavedInstagramReference,assertYoutubeCatalogBinding} from './youtube-ownership-evidence.mjs';

export async function collectYoutubeSavedReferences(catalogFile,archiveRoot,outputFile){
  const packets=JSON.parse(await fs.readFile(catalogFile,'utf8'));
  const byId=new Map(packets.map(p=>[p.profileId,p]));
  for(const p of packets)assertYoutubeCatalogBinding({profileId:p.profileId,cmArtist:p.cmArtist},p);
  let scanned=0,bound=0,declarations=0;
  // Known saved response directories only; no runtime copies or model inputs.
  const dirs=(await fs.readdir(archiveRoot,{withFileTypes:true})).filter(e=>e.isDirectory())
    .flatMap(e=>['responses','receipts'].map(d=>path.join(archiveRoot,e.name,d)));
  for(const dir of dirs){
    let files;try{files=await fs.readdir(dir);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    for(const file of files.filter(f=>f.endsWith('.json')).sort()){
      const sourceFile=path.join(dir,file),receipt=JSON.parse(await fs.readFile(sourceFile,'utf8'));
      scanned++;
      if(!['scrapecreators_candidate','metadata'].includes(receipt.kind))continue;
      const id=receipt.profileId??receipt.operationKey?.match(/^metadata-(\d+)-[a-f0-9]{64}$/)?.[1];
      const packet=byId.get(String(id));if(!packet)continue;
      const reference=bindSavedInstagramReference({profileId:packet.profileId,cmArtist:packet.cmArtist},packet,receipt);
      if(!reference)continue;
      bound++;
      if(reference.body.declaredLinks.length){
        declarations++;
        (packet.savedOfficialAccountCaptures??=[]).push({sourceFile,receipt});
      }
    }
  }
  await fs.writeFile(outputFile,JSON.stringify(packets),{flag:'wx'});
  return {scanned,boundSavedAccountCaptures:bound,savedCapturesWithYoutubeDeclarations:declarations,networkRequests:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==5)throw Error('Use CATALOG_PACKETS ARCHIVE_ROOT OUTPUT_FILE.');
  console.log(JSON.stringify(await collectYoutubeSavedReferences(...process.argv.slice(2))));
}
