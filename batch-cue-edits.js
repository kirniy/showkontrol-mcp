import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShowTimeline,editTimelineCueCopy} from './timeline.js';

// Stage every ordered edit privately and publish only the completed copy.
export async function editShowTimelineCuesCopy({source,destination,sha256,edits}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(edits)||edits.length<1||edits.length>100)throw Error('Provide between 1 and 100 edits');
 if(edits.some(e=>!e||typeof e.name!=='string'))throw Error('Each edit requires a timeline part name');
 let current=source,inspection=await inspectShowTimeline({file:source,name:edits[0].name});
 if(inspection.sha256!==sha256)throw Error('Source changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-cue-edits-'));let published=false,result;
 try{
  for(let i=0;i<edits.length;i++){
   const {name,cueId,layer,startMs,lengthMs,label}=edits[i];
   if(i>0)inspection=await inspectShowTimeline({file:current,name});
   const next=path.join(dir,`${i}.skshow`);
   await editTimelineCueCopy({source:current,destination:next,format:'skshow',sha256:inspection.sha256,name,cueId,layer,startMs,lengthMs,label});
   if(current!==source)await rm(current);
   current=next;
  }
  const final=await inspectShowTimeline({file:current,name:edits.at(-1).name});
  await link(current,destination);
  published=true;
  result={destination,sha256:final.sha256,edits,note:'Cue fields changed in an offline show copy; existing graphs were preserved. Validate in ShowKontrol.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}
  catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
