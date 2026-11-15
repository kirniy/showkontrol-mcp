import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {editCueGraphSettingCopy} from './timeline.js';

// Publish only after every edit succeeds; the hard link refuses an existing destination.
export async function editCueGraphSettingsShowCopy({source,destination,sha256,settings}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(settings)||settings.length<1||settings.length>100)throw Error('Provide between 1 and 100 settings');
 for(const item of settings){
  if(!item||typeof item.name!=='string'||!item.name||typeof item.cueId!=='string'||!item.cueId||typeof item.nodeId!=='string'||!item.nodeId||typeof item.key!=='string'||!item.key||typeof item.value!=='string')throw Error('Each setting requires a timeline name, cue ID, node ID, key and string value');
 }
 const initial=await inspectShow({file:source});if(initial.sha256!==sha256)throw Error('Source changed since inspection');
 let current=source,currentHash=sha256,published=false,result;
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-settings-'));
 try{
  for(let i=0;i<settings.length;i++){
   const next=path.join(dir,`${i}.skshow`);
   const {name,cueId,nodeId,key,value}=settings[i];
   await editCueGraphSettingCopy({source:current,destination:next,format:'skshow',sha256:currentHash,name,cueId,nodeId,key,value});
   const info=await inspectShow({file:next});
   if(current!==source)await rm(current);
   current=next;currentHash=info.sha256;
  }
  await link(current,destination);published=true;
  result={destination,sha256:currentHash,settings:settings.map(({name,cueId,nodeId,key,value})=>({name,cueId,nodeId,key,value})),note:'Changed existing cue graph settings in an offline show copy. Value semantics and ShowKontrol acceptance are not validated.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}
  catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
