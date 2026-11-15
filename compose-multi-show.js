import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {composeShowCopy} from './compose-show.js';
import {readTrackTemplateDonor} from './timeline.js';
import {editPatchBatchCopy} from './batch-patch.js';
import {addShowSetlistTrackCopy,editShowSetlistCopy} from './setlist.js';
import {createShowSetlistCopy} from './setlist-create.js';
import {compositionWarnings,survivingOpaqueWarnings} from './composition-warnings.js';

export async function composeMultiTrackShowCopy({source,destination,sha256,tracks,patchOperations,setlistOperations}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(tracks)||tracks.length>20)throw Error('Provide between 1 and 20 tracks, or operations');
 for(const track of tracks)if(!track||typeof track!=='object'||Array.isArray(track))throw Error('Each track must be an object');
 if(setlistOperations!==undefined){
  if(!Array.isArray(setlistOperations)||setlistOperations.length<1||setlistOperations.length>100)throw Error('Provide between 1 and 100 set list operations');
  for(const op of setlistOperations){
   const fields={create_setlist:['name','setName'],append_track:['name','setName','trackName'],create_set:['name','newSetName'],remove_set:['name','setName'],remove_track:['name','setName','index'],move_track:['name','setName','index','toIndex']}[op?.operation];
   if(!fields||Object.keys(op).some(key=>key!=='operation'&&!fields.includes(key)&&!(op.operation==='create_setlist'&&key==='tracks')&&!(op.operation==='remove_set'&&key==='allowContentRemoval'))||fields.some(key=>key==='index'||key==='toIndex'?!Number.isInteger(op[key])||op[key]<0:typeof op[key]!=='string'||!op[key])||(op.operation==='remove_set'&&op.allowContentRemoval!==undefined&&typeof op.allowContentRemoval!=='boolean')||(op.operation==='create_setlist'&&op.tracks!==undefined&&(!Array.isArray(op.tracks)||op.tracks.some(track=>typeof track!=='string'||!track))))throw Error('Invalid set list operation');
  }
 }
 if(!tracks.length&&!patchOperations?.length&&!setlistOperations?.length)throw Error('Provide between 1 and 20 tracks, or operations');
 const before=await inspectShow({file:source});if(before.sha256!==sha256)throw Error('Source changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-multitrack-'));
 let current=source,currentHash=sha256,published=false,result;const composed=[],warnings=[],opaqueWarnings=[];
 try{
  if(patchOperations!==undefined){
   const next=path.join(dir,'patch.skshow');
   const patch=await editPatchBatchCopy({source:current,destination:next,format:'skshow',sha256:currentHash,operations:patchOperations});
   if(patch.cleanupWarning)warnings.push(patch.cleanupWarning);
   current=next;currentHash=patch.sha256;
  }
  for(let i=0;i<tracks.length;i++){
   const {templateName,templateDonor,trackName,partName,existingPartName,cues,donor,set,layerOperations,audioClipEdits,cueRemovals,cueEdits,graphSettingEdits}=tracks[i],next=path.join(dir,`${i}.skshow`);
   const track=await composeShowCopy({source:current,destination:next,sha256:currentHash,templateName,templateDonor,trackName,partName,existingPartName,cues,donor,set,layerOperations,audioClipEdits,cueRemovals,cueEdits,graphSettingEdits});
   opaqueWarnings.push(...track.warnings.filter(w=>w.code==='opaque_node_references_unverified'));
   composed.push({... (existingPartName !== undefined ? {existingPartName} : {trackName,partName}),cues:track.cues,...(set?{set}:{})});
   if(track.cleanupWarning)warnings.push(track.cleanupWarning);
   if(current!==source)await rm(current);
   current=next;currentHash=track.sha256;
  }
  for(let i=0;i<(setlistOperations?.length??0);i++){
   const op=setlistOperations[i],next=path.join(dir,`setlist-${i}.skshow`);
   const args={source:current,destination:next,sha256:currentHash,...op};
   const edited=op.operation==='create_setlist'?await createShowSetlistCopy(args):op.operation==='append_track'?await addShowSetlistTrackCopy(args):await editShowSetlistCopy(args);
   if(edited.cleanupWarning)warnings.push(edited.cleanupWarning);
   if(current!==source)await rm(current);
   current=next;currentHash=(await inspectShow({file:next})).sha256;
  }
  if(!tracks.length&&currentHash===sha256)throw Error('Composition must make a change');
  const storedWarnings=[...await compositionWarnings(current,currentHash,tracks.map(track=>track.existingPartName ?? track.partName)),...await survivingOpaqueWarnings(current,currentHash,opaqueWarnings)];
  for(const track of tracks)if(track.templateDonor!==undefined)await readTrackTemplateDonor(track.templateDonor);
  await link(current,destination);published=true;
  result={destination,sha256:currentHash,tracks:composed,setlistOperations:setlistOperations??[],warnings:storedWarnings,note:'Offline copy uses fixture-supported structures only. Media authoring and ShowKontrol compatibility are not validated.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}
  catch(error){if(!published)throw error;warnings.push(`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`);}
 }
 if(warnings.length)result.cleanupWarnings=warnings;
 return result;
}
