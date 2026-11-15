import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {composeShowCopy} from './compose-show.js';
import {editPatchBatchCopy} from './batch-patch.js';

export async function composeMultiTrackShowCopy({source,destination,sha256,tracks,patchOperations}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(tracks)||tracks.length<1||tracks.length>20)throw Error('Provide between 1 and 20 tracks');
 for(const track of tracks)if(!track||typeof track!=='object'||Array.isArray(track))throw Error('Each track must be an object');
 const before=await inspectShow({file:source});if(before.sha256!==sha256)throw Error('Source changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-multitrack-'));
 let current=source,currentHash=sha256,published=false,result;const composed=[],warnings=[];
 try{
  if(patchOperations!==undefined){
   const next=path.join(dir,'patch.skshow');
   const patch=await editPatchBatchCopy({source:current,destination:next,format:'skshow',sha256:currentHash,operations:patchOperations});
   if(patch.cleanupWarning)warnings.push(patch.cleanupWarning);
   current=next;currentHash=patch.sha256;
  }
  for(let i=0;i<tracks.length;i++){
   const {templateName,trackName,partName,existingPartName,cues,donor,set,layerOperations,audioClipEdits,cueEdits}=tracks[i],next=path.join(dir,`${i}.skshow`);
   const track=await composeShowCopy({source:current,destination:next,sha256:currentHash,templateName,trackName,partName,existingPartName,cues,donor,set,layerOperations,audioClipEdits,cueEdits});
   composed.push({... (existingPartName !== undefined ? {existingPartName} : {trackName,partName}),cues:track.cues,...(set?{set}:{})});
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
