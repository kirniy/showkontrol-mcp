import {mkdtemp,link,rm} from 'node:fs/promises';import path from 'node:path';
import {inspectShow,readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';import {copyCueGraphNodeShowCopy} from './cue-node-copy.js';import {editCueGraphWireCopy} from './cue-wires.js';

// Wire endpoints are zero-based indices into nodes, not node IDs.
export async function assembleCueGraphShowCopy({source,destination,sha256,name,cueId,nodes,wires=[]}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(!Array.isArray(nodes)||nodes.length<1||nodes.length>50||!Array.isArray(wires)||wires.length>100)throw Error('Provide 1–50 nodes and at most 100 wires');
 for(const node of nodes)if(!node||typeof node.template!=='string'||typeof node.templateSha256!=='string'||typeof node.templateName!=='string'||typeof node.templateCueId!=='string'||typeof node.nodeId!=='string')throw Error('Each node requires a template show, hash, timeline, cue ID and node ID');
 for(const wire of wires)if(!wire||!Number.isInteger(wire.from)||!Number.isInteger(wire.to)||wire.from<0||wire.to<0||wire.from>=nodes.length||wire.to>=nodes.length)throw Error('Wire indices must identify supplied nodes');
 const original=await inspectShow({file:source});if(original.sha256!==sha256)throw Error('Source changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-graph-'));let current=source,currentSha=sha256,published=false,result;const added=[];
 try{
  const snapshot=await readShowSnapshot({file:source});if(snapshot.sha256!==sha256)throw Error('Source changed since inspection');if(!snapshot.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  const xml=readSnapshotPart({snapshot,name}).text,root=parseXmlSpans(xml),cuePath=['sktimeline',{name:'cue',attributes:{id:cueId}}],cues=selectXmlSpans(root,cuePath),graphs=selectXmlSpans(root,[...cuePath,'graph']);
  if(root.name!=='sktimeline'||root.attributes.version!=='1'||cues.length!==1||graphs.length>1)throw Error('Target cue must occur exactly once in a version 1 timeline');
  if(graphs.length===0){
   const cue=cues[0];let modified;
   if(cue.selfClosing){const open=xml.slice(cue.start,cue.openEnd).replace(/\s*\/>$/,'>');modified=xml.slice(0,cue.start)+open+'<graph></graph></cue>'+xml.slice(cue.end);}
   else{if(!/^\s*$/.test(xml.slice(cue.openEnd,cue.closeStart)))throw Error('Graph-free target cue must be empty or contain only whitespace');modified=xml.slice(0,cue.closeStart)+'<graph></graph>'+xml.slice(cue.closeStart);}
   const checked=selectXmlSpans(parseXmlSpans(modified),[...cuePath,'graph']);if(checked.length!==1)throw Error('Could not create target graph');
   const next=path.join(dir,'initial.skshow');await editShowPart({source,destination:next,sha256,name,edits:[{find:xml,replace:modified}]});current=next;currentSha=(await inspectShow({file:current})).sha256;
  }
  for(const [i,node] of nodes.entries()){
   const next=path.join(dir,`node-${i}.skshow`),result=await copyCueGraphNodeShowCopy({source:current,destination:next,sha256:currentSha,name,cueId,template:node.template,templateSha256:node.templateSha256,templateName:node.templateName,templateCueId:node.templateCueId,nodeId:node.nodeId});
   const nextSha=(await inspectShow({file:next})).sha256;added.push(result.newNodeId);if(current!==source)await rm(current);current=next;currentSha=nextSha;
  }
  for(const [i,wire] of wires.entries()){
   const next=path.join(dir,`wire-${i}.skshow`);await editCueGraphWireCopy({source:current,destination:next,format:'skshow',sha256:currentSha,name,cueId,operation:'add',fromNode:added[wire.from],toNode:added[wire.to]});
   const nextSha=(await inspectShow({file:next})).sha256;if(current!==source)await rm(current);current=next;currentSha=nextSha;
  }
  await link(current,destination);published=true;result={destination,sha256:currentSha,nodeIds:added,wires:wires.map(w=>({fromNode:added[w.from],toNode:added[w.to]})),note:'Assembled an offline fixture-supported cue graph. Pin compatibility, external dependencies and ShowKontrol acceptance are not validated.'};
 }finally{try{await rm(dir,{recursive:true,force:true});}catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}}
 return result;
}
