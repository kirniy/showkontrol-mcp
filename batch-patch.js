import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectPatch,editPatchSettingCopy,editPatchGraphCopy,copyPatchNode} from './patch.js';

// Each step consumes the checksum produced by the preceding step.
export async function editPatchBatchCopy({source,destination,format,sha256,operations}) {
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!['skf','skshow'].includes(format)||!Array.isArray(operations)||operations.length<1||operations.length>100)throw Error('Provide a supported format and 1–100 operations');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-patch-'));
 let current=source,currentSha=sha256,published=false,result;
 try {
  for(const [i,op] of operations.entries()) {
   if(!op||typeof op!=='object')throw Error('Invalid patch operation');
   const next=path.join(dir,`step-${i}.${format}`), common={source:current,destination:next,format,sha256:currentSha};
   if(op.kind==='setting')await editPatchSettingCopy({...common,nodeId:op.nodeId,key:op.key,value:op.value});
   else if(op.kind==='graph')await editPatchGraphCopy({...common,operation:op.operation,nodeId:op.nodeId,newNodeId:op.newNodeId,connection:op.connection});
   else if(op.kind==='copy_node')await copyPatchNode({...common,template:op.template,templateFormat:op.templateFormat,templateSha256:op.templateSha256,nodeId:op.nodeId,newNodeId:op.newNodeId});
   else throw Error('Unsupported patch batch operation');
   const nextSha=(await inspectPatch({file:next,format})).sha256;
   if(current!==source)await rm(current);
   current=next;currentSha=nextSha;
  }
  await link(current,destination);published=true;
  result={destination,sha256:currentSha,operations:operations.length,note:'Offline patch copy only. Copied or duplicated nodes retain titles, positions, settings and internal references; connections and dependencies are not copied. Names or references may collide. Values, hardware, node and pin compatibility, input occupancy, dependencies and ShowKontrol acceptance are not validated.'};
 } finally {
  try {await rm(dir,{recursive:true,force:true});} catch(error) {if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
