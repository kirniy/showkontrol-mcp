import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {composeShowCopy} from './compose-show.js';

export async function composeMultiTrackShowCopy({source,destination,sha256,tracks}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(tracks)||tracks.length<1||tracks.length>20)throw Error('Provide between 1 and 20 tracks');
 for(const track of tracks)if(!track||typeof track.templateName!=='string'||typeof track.trackName!=='string'||typeof track.partName!=='string'||!Array.isArray(track.cues))throw Error('Each track requires a template name, track name, part name and cues');
 const before=await inspectShow({file:source});if(before.sha256!==sha256)throw Error('Source changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-multitrack-'));
 let current=source,currentHash=sha256,published=false,result;const composed=[],warnings=[];
 try{
  for(let i=0;i<tracks.length;i++){
   const {templateName,trackName,partName,cues,donor,set}=tracks[i],next=path.join(dir,`${i}.skshow`);
   const track=await composeShowCopy({source:current,destination:next,sha256:currentHash,templateName,trackName,partName,cues,donor,set});
   composed.push({trackName,partName,cues:track.cues,...(set?{set}:{})});
   if(track.cleanupWarning)warnings.push(track.cleanupWarning);
   if(current!==source)await rm(current);
   current=next;currentHash=track.sha256;
  }
  await link(current,destination);published=true;
  result={destination,sha256:currentHash,tracks:composed,note:'Offline copy uses fixture-supported structures only. Media authoring and ShowKontrol compatibility are not validated.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}
  catch(error){if(!published)throw error;warnings.push(`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`);}
 }
 if(warnings.length)result.cleanupWarnings=warnings;
 return result;
}
