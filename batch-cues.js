import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShowTimeline,addShowTimelineCueCopy} from './timeline.js';

// Each intermediate is private to this invocation; the final hard link is exclusive.
export async function addShowTimelineCuesCopy({source,destination,sha256,cues}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(cues)||cues.length<1||cues.length>100)throw Error('Provide between 1 and 100 cues');
 if(cues.some(c=>!c||typeof c.name!=='string'))throw Error('Each cue requires a timeline part name');
 let current=source,inspection=await inspectShowTimeline({file:source,name:cues[0].name});
 if(inspection.sha256!==sha256)throw Error('Source changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-cues-'));const added=[];let published=false,result;
 try{
  for(let i=0;i<cues.length;i++){
   const {name,layer,startMs,lengthMs,label}=cues[i];
   if(i>0)inspection=await inspectShowTimeline({file:current,name});
   const next=path.join(dir,`${i}.skshow`);
   const result=await addShowTimelineCueCopy({source:current,destination:next,sha256:inspection.sha256,name,layer,startMs,lengthMs,label});
   added.push({name,id:result.id,layer,startMs,lengthMs,label});
   if(current!==source)await rm(current);
   current=next;
  }
  const final=await inspectShowTimeline({file:current,name:cues.at(-1).name});
  await link(current,destination);
  published=true;
  result={destination,sha256:final.sha256,cues:added,note:'Simple cues were added to an offline show copy. No action graphs were created; validate in ShowKontrol.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}
  catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
