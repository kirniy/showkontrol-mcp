import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {copyCueGraphInShow} from './timeline.js';

export async function copyCueGraphsInShow({source,destination,sha256,copies}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(copies)||copies.length<1||copies.length>100)throw Error('Provide between 1 and 100 graph copies');
 for(const item of copies){
  if(!item||typeof item.name!=='string'||(item.sourceName!==undefined&&typeof item.sourceName!=='string')||typeof item.sourceCueId!=='string'||!item.sourceCueId||typeof item.targetCueId!=='string'||!item.targetCueId)throw Error('Each copy requires a target timeline name and cue IDs');
  if((item.template===undefined)!==(item.templateSha256===undefined))throw Error('Provide both template and templateSha256');
 }
 const initial=await inspectShow({file:source});if(initial.sha256!==sha256)throw Error('Source changed since inspection');
 let current=source,currentHash=sha256,published=false,result;const created=[],warnings=[];
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-graphs-'));
 try{
  for(let i=0;i<copies.length;i++){
   const {name,sourceName=name,sourceCueId,targetCueId,template,templateSha256,allowOpaqueNodeText}=copies[i],next=path.join(dir,`${i}.skshow`);
   const copied=await copyCueGraphInShow({source:current,destination:next,sha256:currentHash,name,sourceName,sourceCueId,targetCueId,template,templateSha256,allowOpaqueNodeText});
   warnings.push(...copied.warnings);
   const info=await inspectShow({file:next});
   created.push({name,sourceName,sourceCueId,targetCueId,idMap:copied.idMap,...(template===undefined?{}:{template,templateSha256})});
   if(current!==source)await rm(current);
   current=next;currentHash=info.sha256;
  }
  await link(current,destination);published=true;
  result={destination,sha256:currentHash,copies:created,warnings,note:'Copied supported cue graphs into an offline show copy. ShowKontrol compatibility is not validated.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}
  catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
