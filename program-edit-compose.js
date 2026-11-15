import {mkdtemp,rm,link,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {extractShowProgramCopy,createProgramCopy,attachShowProgramCopy,inspectShowProgram,editProgramItemGraphSettingCopy,extractProgramTimelineCopy,embedProgramTimelineCopy} from './program.js';
import {addTimelineCueCopy,deleteTimelineCueCopy,editTimelineCueCopy,editCueGraphSettingCopy,copyCueGraphBetweenTimelinesWithShow,removeCueGraphCopy} from './timeline.js';
import {inspectXml,readShowSnapshot,readSnapshotPart,addShowPart} from './xml-copy.js';
import {assembleMixedCueGraphShowCopy} from './cue-graph-mixed.js';
import {copyProgramItemGraphRemappedCopy} from './program-graph-copy-remap.js';
import {validateShow} from './validate-show.js';
import {parseXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';
import {editCueGraphWireCopy} from './cue-wires.js';
import {copyCueGraphNodeShowCopy} from './cue-node-copy.js';
import {copyPatchNodeToCueShowCopy} from './patch-node-to-cue.js';
import {removeCueGraphNodeCopy} from './cue-node-remove.js';
import {copyPatchSettingToCueShowCopy} from './patch-setting-to-cue.js';

function keys(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('Unsupported edit composition input');
}

async function checkCueRemovalReferences(program,index,cueId,source,sha256){
 const xml=await readFile(program,'utf8'),root=parseXmlSpans(xml),item=root.children[index];
 if(!Number.isInteger(index)||index<0||!item)throw Error('Item index out of range');
 const timelines=item.children.filter(n=>n.name==='sktimeline');
 if(timelines.length!==1)throw Error('Item must contain exactly one timeline');
 const cues=timelines[0].children.filter(n=>n.name==='cue'&&n.attributes.id===cueId);
 if(cues.length!==1)throw Error('Cue ID must occur exactly once as a direct timeline child');
 const cue=cues[0],ids=[];
 function visit(node){
  if(node.name==='node'||node.name==='cue'){
   const id=node.attributes.id;
   if(!id||id.length>1024||ids.includes(id))throw Error('Cannot safely remove cue with unidentified or ambiguous IDs');
   ids.push(id);
  }
  for(const child of node.children)visit(child);
 }
 visit(cue);if(ids.length>1001)throw Error('Cue exceeds reference scan limit');
 const alternatives=ids.sort((a,b)=>b.length-a.length).map(id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const pattern=new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`);
 if(hasXmlReference(xml.slice(0,cue.start)+xml.slice(cue.end),pattern))throw Error('Cue or graph node has surviving XML references in Program');
 const show=await readShowSnapshot({file:source});
 if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 const names=new Set();
 for(const part of show.parts){
  if(!/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(part.name))continue;
  if(names.has(part.name))throw Error('Duplicate supported XML part name');names.add(part.name);
  if(part.name==='content/Program.skpr')continue;
  let text;
  try{text=readSnapshotPart({snapshot:show,name:part.name}).text;parseXmlSpans(text);}
  catch{throw Error(`A supported XML part could not be scanned: ${part.name}`);}
  if(hasXmlReference(text,pattern))throw Error(`Cue or graph node has surviving XML references in ${part.name}`);
 }
}

async function checkGraphRemovalReferences(program,index,cueId,source,sha256){
 const xml=await readFile(program,'utf8');resolveTargetCue(xml,index,cueId);
 const root=parseXmlSpans(xml),item=root.children[index],timeline=item.children.find(n=>n.name==='sktimeline');
 const cue=timeline.children.find(n=>n.name==='cue'&&n.attributes.id===cueId),graphs=cue.children.filter(n=>n.name==='graph');
 if(graphs.length!==1)throw Error('Cue must contain exactly one action graph');
 const graph=graphs[0],ids=[],counts=new Map();
 function visit(node,parent,inGraph){
  if(inGraph&&node!==graph&&(node.name==='graph'||(node.name==='node'&&parent!==graph)))throw Error('Nested graph or node structure is unsupported');
  if(node.name==='node'){
   const id=node.attributes.id;
   if(inGraph&&(!id||id.length>1024))throw Error('Cannot safely remove graph with unidentified node ID');
   if(id){counts.set(id,(counts.get(id)??0)+1);if(inGraph)ids.push(id);}
  }
  for(const child of node.children)visit(child,node,inGraph||child===graph);
 }
 visit(root,null,false);
 if(ids.length>1000||ids.some(id=>counts.get(id)!==1))throw Error('Cannot safely remove graph with ambiguous node IDs');
 const show=await readShowSnapshot({file:source});
 if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 const alternatives=ids.sort((a,b)=>b.length-a.length).map(id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const pattern=ids.length?new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`):null;
 if(pattern&&hasXmlReference(xml.slice(0,graph.start)+xml.slice(graph.end),pattern))throw Error('Graph node has surviving XML references in Program');
 const names=new Set();
 for(const part of show.parts){
  if(!/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(part.name))continue;
  if(names.has(part.name))throw Error('Duplicate supported XML part name');names.add(part.name);
  if(part.name==='content/Program.skpr')continue;
  let text;try{text=readSnapshotPart({snapshot:show,name:part.name}).text;parseXmlSpans(text);}catch{throw Error(`A supported XML part could not be scanned: ${part.name}`);}
  if(pattern&&hasXmlReference(text,pattern))throw Error(`Graph node has surviving XML references in ${part.name}`);
 }
}

async function checkNodeRemovalReferences(program,index,cueId,nodeId,source,sha256){
 const xml=await readFile(program,'utf8');resolveTargetCue(xml,index,cueId);
 const root=parseXmlSpans(xml),item=root.children[index],timeline=item.children.find(n=>n.name==='sktimeline'),cue=timeline.children.find(n=>n.name==='cue'&&n.attributes.id===cueId),graphs=cue.children.filter(n=>n.name==='graph');
 if(graphs.length!==1||!/^n\d+$/.test(nodeId||''))throw Error('Cue must contain one graph and a supported node ID');
 const graph=graphs[0],selected=graph.children.filter(n=>n.name==='node'&&n.attributes.id===nodeId);let count=0;
 function visit(n,parent,inGraph){
  if(inGraph&&n!==graph&&(n.name==='graph'||(n.name==='node'&&parent!==graph)))throw Error('Nested graph or node structure is unsupported');
  if(n.name==='node'&&n.attributes.id===nodeId)count++;
  for(const child of n.children)visit(child,n,inGraph||child===graph);
 }
 visit(root,null,false);if(selected.length!==1||count!==1)throw Error('Node ID must be unique in Program');
 const node=selected[0],pattern=new RegExp(`(?<![A-Za-z0-9_])${nodeId}(?![A-Za-z0-9_])`);
 if(hasXmlReference(xml.slice(0,node.start)+xml.slice(node.end),pattern))throw Error('Node has surviving XML references in Program');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 const names=new Set();for(const part of show.parts){
  if(!/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(part.name))continue;
  const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate supported XML part name');names.add(key);
  if(part.name==='content/Program.skpr')continue;
  let text;try{text=readSnapshotPart({snapshot:show,name:part.name}).text;parseXmlSpans(text);}catch{throw Error(`A supported XML part could not be scanned: ${part.name}`);}
  if(hasXmlReference(text,pattern))throw Error(`Node has surviving XML references in ${part.name}`);
 }
}

async function checkItemNodeRemovalReferences(program,index,nodeId,source,sha256){
 const xml=await readFile(program,'utf8'),root=parseXmlSpans(xml),item=root.children[index];
 if(root.name!=='skprogram'||!Number.isInteger(index)||index<0||!item||item.name!=='item'||!/^n\d+$/.test(nodeId||''))throw Error('Item and supported node ID are required');
 const graphs=item.children.filter(n=>n.name==='graph');if(graphs.length!==1)throw Error('Item must contain exactly one graph');
 const graph=graphs[0],selected=graph.children.filter(n=>n.name==='node'&&n.attributes.id===nodeId);let count=0;
 function visit(n,parent,inGraph){
  if(inGraph&&n!==graph&&(n.name==='graph'||(n.name==='node'&&parent!==graph)))throw Error('Nested graph or node structure is unsupported');
  if(n.name==='node'&&n.attributes.id===nodeId)count++;
  for(const child of n.children)visit(child,n,inGraph||child===graph);
 }
 visit(root,null,false);if(selected.length!==1||count!==1)throw Error('Node ID must be unique in Program');
 const node=selected[0],pattern=new RegExp(`(?<![A-Za-z0-9_])${nodeId}(?![A-Za-z0-9_])`);
 if(hasXmlReference(xml.slice(0,node.start)+xml.slice(node.end),pattern))throw Error('Node has surviving XML references in Program');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 const names=new Set();for(const part of show.parts){
  if(!/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(part.name))continue;
  const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate supported XML part name');names.add(key);
  if(key==='content/program.skpr')continue;
  let text;try{text=readSnapshotPart({snapshot:show,name:part.name}).text;parseXmlSpans(text);}catch{throw Error(`A supported XML part could not be scanned: ${part.name}`);}
  if(hasXmlReference(text,pattern))throw Error(`Node has surviving XML references in ${part.name}`);
 }
}

// Inspect all descendants, including extensions, so that hidden definitions cannot be
// removed without checking references. Duplicate definitions are ambiguous.
async function checkRemovalReferences(program,index){
 const xml=await readFile(program,'utf8'),root=parseXmlSpans(xml),item=root.children[index];
 if(!Number.isInteger(index)||index<0||!item)throw Error('Item index out of range');
 const counts=new Map(),removed=new Set();
 function visit(node,inRemoved){
  if(node.name==='node'||node.name==='cue'){
   const id=node.attributes.id;
   if(!id)throw Error('Cannot safely remove item with an unidentified node or cue');
   counts.set(id,(counts.get(id)??0)+1);if(inRemoved)removed.add(id);
  }
  for(const child of node.children)visit(child,inRemoved);
 }
 for(const child of root.children)visit(child,child===item);
 for(const id of removed)if(counts.get(id)!==1)throw Error('Cannot safely remove item with ambiguous node or cue ID');
 const remaining=xml.slice(0,item.start)+xml.slice(item.end);
 for(const id of removed){
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(hasXmlReference(remaining,new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`)))throw Error(`Removed Program ID is referenced in remaining Program: ${id}`);
 }
}

// Allocate beyond every numeric node ID in both the show and staged Program.
async function graphAllocationMaximum(program,source,sha256){
 const show=await readShowSnapshot({file:source});
 if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 let max=0;const scan=xml=>{
  const root=parseXmlSpans(xml);const visit=node=>{
   if(node.name==='node'&&node.attributes.id&&/^n\d+$/.test(node.attributes.id)){
    const n=Number(node.attributes.id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,n);
   }
   for(const child of node.children)visit(child);
  };visit(root);
 };
 scan(await readFile(program,'utf8'));const names=new Set();
 for(const part of show.parts){
  if(!/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(part.name))continue;
  const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate supported XML part name');names.add(key);
  try{scan(readSnapshotPart({snapshot:show,name:part.name}).text);}catch(e){throw Error(`A supported XML part could not be scanned: ${part.name}: ${e.message}`);}
 }
 return {max,show};
}
function resolveCreatedCue(xml,index,created,operationIndex){
 if(!Number.isInteger(operationIndex)||operationIndex<0)throw Error('cueFromOperation must identify a prior add_timeline_cue');
 const entry=created.find(c=>c.operationIndex===operationIndex);if(!entry)throw Error('cueFromOperation must identify a prior add_timeline_cue');
 return resolveTargetCue(xml,index,entry.id);
}
function resolveTargetCue(xml,index,cueId){
 if(typeof cueId!=='string'||!cueId)throw Error('cueId must identify a direct timeline cue');
 const root=parseXmlSpans(xml),item=root.children[index];if(!Number.isInteger(index)||index<0||!item)throw Error('Item index out of range');
 let count=0;const visit=n=>{if(n.name==='cue'&&n.attributes.id===cueId)count++;for(const c of n.children)visit(c);};visit(root);
 const timelines=item.children.filter(n=>n.name==='sktimeline');
 if(count!==1||timelines.length!==1||timelines[0].children.filter(n=>n.name==='cue'&&n.attributes.id===cueId).length!==1)throw Error('Cue is not unique in the selected current item and Program');
 return cueId;
}
const digest=text=>createHash('sha256').update(text).digest('hex');
async function copyCreatedCueGraph({timeline,edited,program,source,sha256,index,cueId,donor,donorName,donorSha256,donorCueId,dir,step}){
 if(typeof donor!=='string'||!path.isAbsolute(donor)||!['.sktl','.skshow'].includes(path.extname(donor).toLowerCase())||typeof donorSha256!=='string'||!/^[a-f0-9]{64}$/.test(donorSha256)||typeof donorCueId!=='string'||!donorCueId)throw Error('An absolute .sktl or .skshow donor, donor SHA-256 and donor cue ID are required');
 let template=donor,templateSha256=donorSha256;
 if(path.extname(donor).toLowerCase()==='.skshow'){
  if(typeof donorName!=='string'||!donorName.toLowerCase().endsWith('.sktl'))throw Error('A .sktl donor part name is required');
  const show=await readShowSnapshot({file:donor});
  if(show.sha256!==donorSha256)throw Error('Donor changed since inspection');
  if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
  const names=new Set();for(const part of show.parts){const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate part name');names.add(key);}
  const xml=readSnapshotPart({snapshot:show,name:donorName}).text;
  template=path.join(dir,`graph-donor-${step}.sktl`);await writeFile(template,xml,{flag:'wx'});templateSha256=digest(xml);
 }else if(donorName!==undefined)throw Error('Donor part name is only supported for a show');
 const {max,show}=await graphAllocationMaximum(program,source,sha256);
 const target=await inspectXml({file:timeline});const root=parseXmlSpans(target.xml);
 if(root.name!=='sktimeline'||root.selfClosing)throw Error('Unsupported timeline serialization');
 // The sentinel makes the existing copier allocate beyond the complete show and Program.
 const marker=`<cue id="__composition_allocation_sentinel__"><graph><node id="n${max}" type="groupin"/></graph></cue>`;
 if(target.xml.includes('__composition_allocation_sentinel__'))throw Error('Allocation sentinel conflicts with timeline');
 const augmented=target.xml.slice(0,root.closeStart)+marker+target.xml.slice(root.closeStart);
 const augmentedFile=path.join(dir,`graph-augmented-${step}.sktl`),copiedFile=path.join(dir,`graph-copied-${step}.sktl`);
 await writeFile(augmentedFile,augmented,{flag:'wx'});
 const result=await copyCueGraphBetweenTimelinesWithShow({source:augmentedFile,destination:copiedFile,sha256:digest(augmented),template,templateSha256,sourceCueId:donorCueId,targetCueId:cueId},show);
 const output=await readFile(copiedFile,'utf8');if(output.split(marker).length!==2)throw Error('Allocation sentinel was not preserved');
 const final=output.replace(marker,'');parseXmlSpans(final);await writeFile(edited,final,{flag:'wx'});
 return {...result,sha256:digest(final),note:'Copied a fixture-supported graph. Router targets were checked against the destination show; application acceptance is unverified.'+(result.note.includes('patch prototypes only')?' '+result.note:'')};
}

async function assembleProgramCueGraph({timeline,edited,program,source,sha256,currentSha,index,cueId,nodes,wires,dir,step}){
 const {max}=await graphAllocationMaximum(program,source,sha256);
 const xml=await readFile(timeline,'utf8'),root=parseXmlSpans(xml);
 const cues=root.children.filter(n=>n.name==='cue'&&n.attributes.id===cueId);
 if(root.name!=='sktimeline'||root.selfClosing||cues.length!==1||cues[0].children.some(n=>n.name==='graph'))throw Error('Target cue must be graph-free');
 const marker=`<cue id="__composition_allocation_sentinel__"><graph><node id="n${max}" type="groupin"/></graph></cue>`;
 if(xml.includes('__composition_allocation_sentinel__'))throw Error('Allocation sentinel conflicts with timeline');
 const augmented=xml.slice(0,root.closeStart)+marker+xml.slice(root.closeStart);
 const staged=path.join(dir,`mixed-program-${step}.skshow`),withTimeline=path.join(dir,`mixed-timeline-${step}.skshow`),assembled=path.join(dir,`mixed-result-${step}.skshow`);
 const attached=await attachShowProgramCopy({source,destination:staged,sha256,program,programSha256:currentSha,replaceExisting:true});
 const snapshot=await readShowSnapshot({file:staged});
 let name='content/CompositionTimeline.sktl',suffix=0;
 while(snapshot.parts.some(p=>p.name.toLowerCase()===name.toLowerCase()))name=`content/CompositionTimeline${++suffix}.sktl`;
 await addShowPart({source:staged,destination:withTimeline,sha256:attached.sha256,name,text:augmented});
 const result=await assembleMixedCueGraphShowCopy({source:withTimeline,destination:assembled,sha256:(await inspectXml({file:withTimeline})).sha256,name,cueId,nodes,wires});
 const output=readSnapshotPart({snapshot:await readShowSnapshot({file:assembled}),name}).text;
 if(output.split(marker).length!==2)throw Error('Allocation sentinel was not preserved');
 const final=output.replace(marker,'');parseXmlSpans(final);await writeFile(edited,final,{flag:'wx'});
 return {...result,sha256:digest(final)};
}

async function checkItemGraphReplacement(program,index,source,sha256){
 const xml=await readFile(program,'utf8'),root=parseXmlSpans(xml),item=root.children[index];
 if(!Number.isInteger(index)||index<0||!item)throw Error('Item index out of range');
 const graphs=item.children.filter(n=>n.name==='graph');if(graphs.length>1)throw Error('Item has ambiguous graphs');if(!graphs.length)return;
 const graph=graphs[0],ids=[],counts=new Map();
 const visit=(n,inGraph)=>{if(inGraph&&n!==graph&&(n.name==='graph'||(n.name==='node'&&!graph.children.includes(n))))throw Error('Nested graph or node structure is unsupported');if(n.name==='node'){const id=n.attributes.id;if(inGraph&&(!id||id.length>1024))throw Error('Existing graph has unsupported node ID');if(id){counts.set(id,(counts.get(id)??0)+1);if(inGraph)ids.push(id);}}for(const c of n.children)visit(c,inGraph||c===graph);};visit(root,false);
 if(ids.length>1000||ids.some(id=>counts.get(id)!==1))throw Error('Existing graph has ambiguous node IDs');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 const names=new Set(),parts=[xml.slice(0,graph.start)+xml.slice(graph.end)];
 for(const part of show.parts){if(!/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(part.name))continue;const name=part.name.toLowerCase();if(names.has(name))throw Error('Duplicate supported XML part name');names.add(name);if(name==='content/program.skpr')continue;const text=readSnapshotPart({snapshot:show,name:part.name}).text;parseXmlSpans(text);parts.push(text);}
 for(const id of ids){const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);if(parts.some(text=>hasXmlReference(text,pattern)))throw Error('Existing graph node ID is referenced outside the graph');}
}

async function assembleProgramItemGraph({program,destination,source,sha256,currentSha,index,operation,dir,step}){
 const staged=path.join(dir,`item-stage-${step}.skshow`),withTimeline=path.join(dir,`item-timeline-${step}.skshow`),assembled=path.join(dir,`item-assembled-${step}.skshow`);
 const attached=await attachShowProgramCopy({source,destination:staged,sha256,program,programSha256:currentSha,replaceExisting:true});
 const snapshot=await readShowSnapshot({file:staged});let name='content/CompositionTimeline.sktl',suffix=0;
 while(snapshot.parts.some(p=>p.name.toLowerCase()===name.toLowerCase()))name=`content/CompositionTimeline${++suffix}.sktl`;
 const cueId='__composition_item_graph__';
 await addShowPart({source:staged,destination:withTimeline,sha256:attached.sha256,name,text:`<sktimeline version="1"><layers/><cue id="${cueId}"/></sktimeline>`});
 const mixed=await assembleMixedCueGraphShowCopy({source:withTimeline,destination:assembled,sha256:(await inspectXml({file:withTimeline})).sha256,name,cueId,nodes:operation.nodes,wires:operation.wires});
 const copied=await copyProgramItemGraphRemappedCopy({source:program,destination,sha256:currentSha,index,donor:assembled,donorSha256:mixed.sha256,donorName:name,donorCueId:cueId,target:staged,targetSha256:attached.sha256,replaceExisting:operation.replaceExisting});
 return {...copied,nodeIds:mixed.nodeIds.map(id=>copied.mapping[id]),warnings:[...mixed.warnings,...copied.warnings],note:mixed.note};
}
function itemGraphContains(xml,index,nodeIds){
 const root=parseXmlSpans(xml),item=root.children[index];
 if(!Number.isInteger(index)||index<0||!item)throw Error('Item index out of range');
 const graphs=item.children.filter(n=>n.name==='graph');
 return graphs.length===1&&nodeIds.every(id=>graphs[0].children.filter(n=>n.name==='node'&&n.attributes.id===id).length===1);
}

async function copyProgramNode({timeline,edited,program,source,sha256,currentSha,cueId,operation,dir,step}){
 const {max}=await graphAllocationMaximum(program,source,sha256);
 const xml=await readFile(timeline,'utf8'),root=parseXmlSpans(xml);
 if(root.name!=='sktimeline'||root.selfClosing)throw Error('Unsupported timeline serialization');
 const marker=`<cue id="__composition_allocation_sentinel__"><graph><node id="n${max}" type="groupin"/></graph></cue>`;
 if(xml.includes('__composition_allocation_sentinel__'))throw Error('Allocation sentinel conflicts with timeline');
 const augmented=xml.slice(0,root.closeStart)+marker+xml.slice(root.closeStart);
 const staged=path.join(dir,`node-program-${step}.skshow`),withTimeline=path.join(dir,`node-timeline-${step}.skshow`),copied=path.join(dir,`node-result-${step}.skshow`);
 const attached=await attachShowProgramCopy({source,destination:staged,sha256,program,programSha256:currentSha,replaceExisting:true});
 const snapshot=await readShowSnapshot({file:staged});let name='content/CompositionTimeline.sktl',suffix=0;
 while(snapshot.parts.some(p=>p.name.toLowerCase()===name.toLowerCase()))name=`content/CompositionTimeline${++suffix}.sktl`;
 await addShowPart({source:staged,destination:withTimeline,sha256:attached.sha256,name,text:augmented});
 const common={source:withTimeline,destination:copied,sha256:(await inspectXml({file:withTimeline})).sha256,name,cueId,template:operation.donor,templateSha256:operation.donorSha256,nodeId:operation.donorNodeId};
 const result=operation.donorType==='cue'
  ?await copyCueGraphNodeShowCopy({...common,templateName:operation.donorName,templateCueId:operation.donorCueId})
  :await copyPatchNodeToCueShowCopy({...common,templateFormat:operation.donorFormat});
 const output=readSnapshotPart({snapshot:await readShowSnapshot({file:copied}),name}).text;
 if(output.split(marker).length!==2)throw Error('Allocation sentinel was not preserved');
 const final=output.replace(marker,'');parseXmlSpans(final);await writeFile(edited,final,{flag:'wx'});
 return {...result,sha256:digest(final)};
}

async function changeItemGraphNode({program,destination,source,sha256,currentSha,index,operation,dir,step}){
 const xml=await readFile(program,'utf8');if(digest(xml)!==currentSha)throw Error('Program changed since inspection');
 const root=parseXmlSpans(xml),item=root.children[index];
 if(root.name!=='skprogram'||!Number.isInteger(index)||index<0||!item||item.name!=='item')throw Error('Item index out of range');
 const graphs=item.children.filter(n=>n.name==='graph');if(graphs.length!==1)throw Error('Target item must contain exactly one graph');
 const graph=graphs[0],cueId='__composition_item_node__';
 const timeline=path.join(dir,`item-node-${step}.sktl`),edited=path.join(dir,`item-node-edited-${step}.sktl`);
 const proxy=`<sktimeline version="1"><cue id="${cueId}">${xml.slice(graph.start,graph.end)}</cue></sktimeline>`;
 await writeFile(timeline,proxy,{flag:'wx'});
 const result=operation.action==='copy_item_graph_node'
  ?await copyProgramNode({timeline,edited,program,source,sha256,currentSha,cueId,operation,dir,step})
  :await removeCueGraphNodeCopy({source:timeline,destination:edited,format:'sktl',sha256:digest(proxy),cueId,nodeId:operation.nodeId});
 const output=await readFile(edited,'utf8'),parsed=parseXmlSpans(output),cues=parsed.children.filter(n=>n.name==='cue'&&n.attributes.id===cueId),outGraphs=cues.length===1?cues[0].children.filter(n=>n.name==='graph'):[];
 if(outGraphs.length!==1)throw Error('Edited item graph could not be verified');
 const modified=xml.slice(0,graph.start)+output.slice(outGraphs[0].start,outGraphs[0].end)+xml.slice(graph.end);
 parseXmlSpans(modified);await writeFile(destination,modified,{flag:'wx'});
 return {...result,sha256:digest(modified)};
}

async function copyProgramPatchSetting({timeline,edited,program,source,sha256,currentSha,cueId,nodeId,operation,dir,step}){
 const staged=path.join(dir,`setting-program-${step}.skshow`),withTimeline=path.join(dir,`setting-timeline-${step}.skshow`),copied=path.join(dir,`setting-result-${step}.skshow`);
 const attached=await attachShowProgramCopy({source,destination:staged,sha256,program,programSha256:currentSha,replaceExisting:true});
 const snapshot=await readShowSnapshot({file:staged});let name='content/CompositionTimeline.sktl',suffix=0;
 while(snapshot.parts.some(p=>p.name.toLowerCase()===name.toLowerCase()))name=`content/CompositionTimeline${++suffix}.sktl`;
 await addShowPart({source:staged,destination:withTimeline,sha256:attached.sha256,name,text:await readFile(timeline,'utf8')});
 const result=await copyPatchSettingToCueShowCopy({source:withTimeline,destination:copied,sha256:(await inspectXml({file:withTimeline})).sha256,name,cueId,nodeId,template:operation.donor,templateFormat:operation.donorFormat,templateSha256:operation.donorSha256,templateNodeId:operation.donorNodeId,key:operation.key});
 const output=readSnapshotPart({snapshot:await readShowSnapshot({file:copied}),name}).text;
 parseXmlSpans(output);await writeFile(edited,output,{flag:'wx'});
 return {...result,sha256:digest(output)};
}

async function copyItemPatchSetting({program,destination,source,sha256,currentSha,index,nodeId,operation,dir,step}){
 const xml=await readFile(program,'utf8'),root=parseXmlSpans(xml),item=root.children[index];
 if(root.name!=='skprogram'||!Number.isInteger(index)||index<0||!item||item.name!=='item')throw Error('Item index out of range');
 const graphs=item.children.filter(n=>n.name==='graph');
 if(graphs.length!==1||graphs[0].children.filter(n=>n.name==='node'&&n.attributes.id===nodeId).length!==1)throw Error('Target item graph and node must be unique');
 const graph=graphs[0],cueId='__composition_item_setting__';
 const timeline=path.join(dir,`item-setting-${step}.sktl`),edited=path.join(dir,`item-setting-edited-${step}.sktl`);
 await writeFile(timeline,`<sktimeline version="1"><cue id="${cueId}">${xml.slice(graph.start,graph.end)}</cue></sktimeline>`,{flag:'wx'});
 const result=await copyProgramPatchSetting({timeline,edited,program,source,sha256,currentSha,cueId,nodeId,operation,dir,step});
 const output=await readFile(edited,'utf8'),proxy=parseXmlSpans(output),cues=proxy.children.filter(n=>n.name==='cue'&&n.attributes.id===cueId),outGraphs=cues.length===1?cues[0].children.filter(n=>n.name==='graph'):[];
 if(outGraphs.length!==1)throw Error('Copied item graph could not be verified');
 const modified=xml.slice(0,graph.start)+output.slice(outGraphs[0].start,outGraphs[0].end)+xml.slice(graph.end);
 parseXmlSpans(modified);await writeFile(destination,modified,{flag:'wx'});
 return {...result,sha256:digest(modified),note:'Copied a setting from a patch node into an offline Program item graph. Values, external dependencies and ShowKontrol acceptance are not validated.'};
}

async function editItemGraphWire({program,destination,currentSha,index,operation,fromNode,toNode,dir,step}){
 const xml=await readFile(program,'utf8');
 if(digest(xml)!==currentSha)throw Error('Program changed since inspection');
 const root=parseXmlSpans(xml),item=root.children[index];
 if(root.name!=='skprogram'||!Number.isInteger(index)||index<0||!item||item.name!=='item')throw Error('Item index out of range');
 const graphs=item.children.filter(n=>n.name==='graph');
 if(graphs.length!==1)throw Error('Target item must contain exactly one graph');
 const graph=graphs[0],cueId='__composition_item_wire__';
 const timeline=path.join(dir,`item-wire-${step}.sktl`),edited=path.join(dir,`item-wire-edited-${step}.sktl`);
 const proxy=`<sktimeline version="1"><cue id="${cueId}">${xml.slice(graph.start,graph.end)}</cue></sktimeline>`;
 await writeFile(timeline,proxy,{flag:'wx'});
 const result=await editCueGraphWireCopy({source:timeline,destination:edited,format:'sktl',sha256:digest(proxy),cueId,operation,fromNode,toNode});
 const output=await readFile(edited,'utf8'),parsed=parseXmlSpans(output),cues=parsed.children.filter(n=>n.name==='cue'&&n.attributes.id===cueId),outGraphs=cues.length===1?cues[0].children.filter(n=>n.name==='graph'):[];
 if(outGraphs.length!==1)throw Error('Edited item graph could not be verified');
 const modified=xml.slice(0,graph.start)+output.slice(outGraphs[0].start,outGraphs[0].end)+xml.slice(graph.end);
 parseXmlSpans(modified);await writeFile(destination,modified,{flag:'wx'});
 return {...result,sha256:digest(modified),note:'Changed a fixture-supported pin 0 connection in an offline Program item graph. Validate operation in ShowKontrol.'};
}

// Each index addresses the current Program file order after all preceding operations.
export async function composeProgramEditsCopy(args){
 keys(args,['source','destination','sha256','operations']);
 const {source,destination,sha256,operations}=args;
 if(typeof source!=='string'||typeof destination!=='string'||![source,destination].every(p=>path.isAbsolute(p)&&path.extname(p).toLowerCase()==='.skshow')||path.resolve(source)===path.resolve(destination)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw Error('Distinct absolute source and destination .skshow paths and source SHA-256 are required');
 if(!Array.isArray(operations)||operations.length>100)throw Error('Expected at most 100 operations');
 for(const op of operations){
  if(!op||typeof op!=='object'||Array.isArray(op))throw Error('Invalid operation');
  if(op.action==='add')keys(op,['action','start','name','notes']);
  else if(op.action==='edit')keys(op,['action','index'],['start','name','notes']);
  else if(op.action==='remove'){keys(op,['action','index'],['allowContentRemoval']);if(op.allowContentRemoval!==undefined&&typeof op.allowContentRemoval!=='boolean')throw Error('allowContentRemoval must be a boolean');}
  else if(op.action==='edit_graph_setting')keys(op,['action','index','nodeId','key','value']);
  else if(op.action==='assemble_item_graph'){keys(op,['action','index','nodes'],['wires','replaceExisting']);if(op.replaceExisting!==undefined&&typeof op.replaceExisting!=='boolean')throw Error('replaceExisting must be a boolean');}
  else if(op.action==='edit_assembled_item_graph_setting')keys(op,['action','index','graphFromOperation','nodeIndex','key','value']);
  else if(op.action==='edit_item_graph_wire'){
   keys(op,['action','index','operation','from','to']);
   if(!['add','remove'].includes(op.operation))throw Error('Operation must be add or remove');
   for(const endpoint of [op.from,op.to]){
    keys(endpoint,[],['nodeId','nodeFromOperation','graphFromOperation','nodeIndex']);
    const forms=Number(Object.hasOwn(endpoint,'nodeId'))+Number(Object.hasOwn(endpoint,'nodeFromOperation'))+Number(Object.hasOwn(endpoint,'graphFromOperation'));
    if(forms!==1||Object.hasOwn(endpoint,'nodeIndex')!==Object.hasOwn(endpoint,'graphFromOperation'))throw Error('Endpoint must contain exactly one of nodeId, nodeFromOperation, or graphFromOperation with nodeIndex');
    if(Object.hasOwn(endpoint,'nodeId')&&(typeof endpoint.nodeId!=='string'||!endpoint.nodeId))throw Error('nodeId must be a nonempty string');
    if(Object.hasOwn(endpoint,'nodeFromOperation')&&(!Number.isInteger(endpoint.nodeFromOperation)||endpoint.nodeFromOperation<0))throw Error('nodeFromOperation must identify an active prior copy_item_graph_node');
    if(Object.hasOwn(endpoint,'graphFromOperation')&&(!Number.isInteger(endpoint.graphFromOperation)||endpoint.graphFromOperation<0||!Number.isInteger(endpoint.nodeIndex)||endpoint.nodeIndex<0))throw Error('Invalid graphFromOperation or nodeIndex');
   }
  }
  else if(op.action==='copy_patch_setting_to_item_graph'){
   keys(op,['action','index','donor','donorFormat','donorSha256','donorNodeId','key'],['nodeId','nodeFromOperation','graphFromOperation','nodeIndex']);
   if(['nodeId','nodeFromOperation','graphFromOperation'].filter(k=>Object.hasOwn(op,k)).length!==1||Object.hasOwn(op,'nodeIndex')!==Object.hasOwn(op,'graphFromOperation'))throw Error('Provide exactly one of nodeId, nodeFromOperation, or graphFromOperation with nodeIndex');
   if(Object.hasOwn(op,'nodeId')&&(typeof op.nodeId!=='string'||!op.nodeId))throw Error('nodeId must be a nonempty string');
   if(Object.hasOwn(op,'nodeFromOperation')&&(!Number.isInteger(op.nodeFromOperation)||op.nodeFromOperation<0))throw Error('Invalid nodeFromOperation');
   if(Object.hasOwn(op,'graphFromOperation')&&(!Number.isInteger(op.graphFromOperation)||op.graphFromOperation<0||!Number.isInteger(op.nodeIndex)||op.nodeIndex<0))throw Error('Invalid graphFromOperation or nodeIndex');
   if(typeof op.donor!=='string'||!path.isAbsolute(op.donor)||!['skf','skshow'].includes(op.donorFormat)||!/^[a-f0-9]{64}$/.test(op.donorSha256||'')||!/^n\d+$/.test(op.donorNodeId||''))throw Error('Absolute donor path, donor format, donor SHA-256 and node ID are required');
  }
  else if(op.action==='edit_timeline_graph_setting')keys(op,['action','index','cueId','nodeId','key','value']);
  else if(op.action==='edit_timeline_graph_wire')keys(op,['action','index','cueId','operation','fromNode','toNode']);
  else if(op.action==='edit_timeline_graph_wire_mapped'){
   keys(op,['action','index','operation','from','to'],['cueId','cueFromOperation']);
   if(Object.hasOwn(op,'cueFromOperation')===Object.hasOwn(op,'cueId'))throw Error('Provide exactly one of cueId or cueFromOperation');
   for(const endpoint of [op.from,op.to]){
    keys(endpoint,[],['nodeId','nodeFromOperation','graphFromOperation','nodeIndex']);
    const forms=Number(Object.hasOwn(endpoint,'nodeId'))+Number(Object.hasOwn(endpoint,'nodeFromOperation'))+Number(Object.hasOwn(endpoint,'graphFromOperation'));
    if(forms!==1||Object.hasOwn(endpoint,'nodeIndex')!==Object.hasOwn(endpoint,'graphFromOperation'))throw Error('Endpoint must contain exactly one of nodeId, nodeFromOperation, or graphFromOperation with nodeIndex');
    if(Object.hasOwn(endpoint,'nodeId')&&(typeof endpoint.nodeId!=='string'||!endpoint.nodeId))throw Error('nodeId must be a nonempty string');
    if(Object.hasOwn(endpoint,'nodeFromOperation')&&(!Number.isInteger(endpoint.nodeFromOperation)||endpoint.nodeFromOperation<0))throw Error('nodeFromOperation must identify an active prior copy_timeline_cue_node');
    if(Object.hasOwn(endpoint,'graphFromOperation')&&(!Number.isInteger(endpoint.graphFromOperation)||endpoint.graphFromOperation<0||!Number.isInteger(endpoint.nodeIndex)||endpoint.nodeIndex<0))throw Error('graphFromOperation and nodeIndex must identify an active prior assemble_timeline_cue_graph node');
   }
  }
  else if(op.action==='copy_patch_setting_to_timeline_cue'){
   keys(op,['action','index','donor','donorFormat','donorSha256','donorNodeId','key'],['cueId','cueFromOperation','nodeId','nodeFromOperation','graphFromOperation','nodeIndex','copiedGraphFromOperation','copiedGraphDonorNodeId']);
   if(Object.hasOwn(op,'cueFromOperation')===Object.hasOwn(op,'cueId'))throw Error('Provide exactly one of cueId or cueFromOperation');
   const forms=['nodeId','nodeFromOperation','graphFromOperation','copiedGraphFromOperation'].filter(k=>Object.hasOwn(op,k));
   if(forms.length!==1||Object.hasOwn(op,'nodeIndex')!==Object.hasOwn(op,'graphFromOperation')||Object.hasOwn(op,'copiedGraphDonorNodeId')!==Object.hasOwn(op,'copiedGraphFromOperation'))throw Error('Provide exactly one node selector: nodeId, nodeFromOperation, graphFromOperation with nodeIndex, or copiedGraphFromOperation with copiedGraphDonorNodeId');
   if(Object.hasOwn(op,'nodeId')&&(typeof op.nodeId!=='string'||!op.nodeId))throw Error('nodeId must be a nonempty string');
   if(Object.hasOwn(op,'nodeFromOperation')&&(!Number.isInteger(op.nodeFromOperation)||op.nodeFromOperation<0))throw Error('Invalid nodeFromOperation');
   if(Object.hasOwn(op,'graphFromOperation')&&(!Number.isInteger(op.graphFromOperation)||op.graphFromOperation<0||!Number.isInteger(op.nodeIndex)||op.nodeIndex<0))throw Error('Invalid graphFromOperation or nodeIndex');
   if(Object.hasOwn(op,'copiedGraphFromOperation')&&(!Number.isInteger(op.copiedGraphFromOperation)||op.copiedGraphFromOperation<0||typeof op.copiedGraphDonorNodeId!=='string'||!op.copiedGraphDonorNodeId))throw Error('Invalid copiedGraphFromOperation or copiedGraphDonorNodeId');
   if(typeof op.donor!=='string'||!path.isAbsolute(op.donor)||!['skf','skshow'].includes(op.donorFormat)||!/^[a-f0-9]{64}$/.test(op.donorSha256||'')||!/^n\d+$/.test(op.donorNodeId||''))throw Error('Absolute donor path, donor format, donor SHA-256 and node ID are required');
  }
  else if(op.action==='copy_item_graph_node'){
   keys(op,['action','index','donorType','donor','donorSha256','donorNodeId'],['donorName','donorCueId','donorFormat']);
   if(!path.isAbsolute(op.donor||'')||!/^[a-f0-9]{64}$/.test(op.donorSha256||'')||!/^n\d+$/.test(op.donorNodeId||''))throw Error('Absolute donor path, donor SHA-256 and node ID are required');
   if(op.donorType==='cue'){if(!op.donorName||!op.donorCueId||op.donorFormat!==undefined)throw Error('Cue donor requires donorName and donorCueId');}
   else if(op.donorType==='patch'){if(!['skf','skshow'].includes(op.donorFormat)||op.donorName!==undefined||op.donorCueId!==undefined)throw Error('Patch donor requires donorFormat');}
   else throw Error('Unsupported donor type');
  }
  else if(op.action==='remove_item_graph_node')keys(op,['action','index','nodeId']);
  else if(op.action==='edit_copied_item_node_setting')keys(op,['action','index','nodeFromOperation','key','value']);
  else if(op.action==='copy_timeline_cue_node'){
   keys(op,['action','index','donorType','donor','donorSha256','donorNodeId'],['donorName','donorCueId','donorFormat','cueId','cueFromOperation']);
   if(Object.hasOwn(op,'cueFromOperation')===Object.hasOwn(op,'cueId'))throw Error('Provide exactly one of cueId or cueFromOperation');
   if(!path.isAbsolute(op.donor||'')||!/^[a-f0-9]{64}$/.test(op.donorSha256||'')||!/^n\d+$/.test(op.donorNodeId||''))throw Error('Absolute donor path, donor SHA-256 and node ID are required');
   if(op.donorType==='cue'){if(!op.donorName||!op.donorCueId||op.donorFormat!==undefined)throw Error('Cue donor requires donorName and donorCueId');}
   else if(op.donorType==='patch'){if(!['skf','skshow'].includes(op.donorFormat)||op.donorName!==undefined||op.donorCueId!==undefined)throw Error('Patch donor requires donorFormat');}
   else throw Error('Unsupported donor type');
  }
  else if(op.action==='remove_timeline_cue_node')keys(op,['action','index','cueId','nodeId']);
  else if(op.action==='edit_copied_timeline_node_setting')keys(op,['action','index','nodeFromOperation','key','value']);
  else if(op.action==='remove_timeline_cue_graph')keys(op,['action','index','cueId']);
  else if(op.action==='edit_copied_timeline_graph_setting')keys(op,['action','index','graphFromOperation','donorNodeId','key','value']);
  else if(op.action==='edit_assembled_timeline_graph_setting')keys(op,['action','index','graphFromOperation','nodeIndex','key','value']);
  else if(op.action==='add_timeline_cue')keys(op,['action','index','layer','startMs','lengthMs','label']);
  else if(op.action==='assemble_timeline_cue_graph'){
   keys(op,['action','index','nodes'],['wires','cueFromOperation','cueId']);
   if(Object.hasOwn(op,'cueFromOperation')===Object.hasOwn(op,'cueId'))throw Error('Provide exactly one of cueId or cueFromOperation');
  }
  else if(op.action==='copy_timeline_cue_graph'){
   keys(op,['action','index','donor','donorSha256','donorCueId'],['donorName','cueFromOperation','cueId']);
   if(Object.hasOwn(op,'cueFromOperation')===Object.hasOwn(op,'cueId'))throw Error('Provide exactly one of cueId or cueFromOperation');
  }
  else if(op.action==='delete_timeline_cue'){keys(op,['action','index','cueId'],['deleteGraph']);if(op.deleteGraph!==undefined&&typeof op.deleteGraph!=='boolean')throw Error('deleteGraph must be a boolean');}
  else if(op.action==='edit_timeline_cue'){
   keys(op,['action','index','cueId'],['layer','startMs','lengthMs','label']);
   if(['layer','startMs','lengthMs','label'].every(k=>op[k]===undefined))throw Error('Provide at least one cue field');
  }
  else throw Error('Invalid operation');
 }
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-program-edit-'));
 try{
  let step=0;const next=()=>path.join(dir,`${step++}.skpr`);
  const warnings=new Set();
  const createdCues=[],copiedCueGraphs=[],assembledCueGraphs=[],assembledItemGraphs=[],copiedItemNodes=[],copiedCueNodes=[],donors=[],invalidatedGraphs=new Set();
  const collect=result=>{for(const warning of [...(result.warnings??[]),result.note])if(typeof warning==='string'&&warning)warnings.add(warning);};
  let program=next(),current=await extractShowProgramCopy({source,destination:program,sha256});collect(current);
  for(const [operationIndex,operation] of operations.entries()){
   if(operation.action==='remove'){
    await checkRemovalReferences(program,operation.index);
    const item=parseXmlSpans(await readFile(program,'utf8')).children[operation.index];
    for(const receipt of [...assembledItemGraphs,...copiedItemNodes])if(itemGraphContains(await readFile(program,'utf8'),operation.index,receipt.nodeIds??[receipt.nodeId]))invalidatedGraphs.add(receipt.operationIndex);
    const ids=new Set();const visit=n=>{if(n.name==='cue')ids.add(n.attributes.id);for(const c of n.children)visit(c);};visit(item);
    for(const receipt of [...copiedCueNodes,...copiedCueGraphs,...assembledCueGraphs])if(ids.has(receipt.cueId))invalidatedGraphs.add(receipt.operationIndex);
   }
   const destination=next();
   if(['copy_item_graph_node','remove_item_graph_node'].includes(operation.action)){
    const xml=await readFile(program,'utf8');
    if(operation.action==='remove_item_graph_node')await checkItemNodeRemovalReferences(program,operation.index,operation.nodeId,source,sha256);
    const prior=assembledItemGraphs.filter(r=>!invalidatedGraphs.has(r.operationIndex)&&itemGraphContains(xml,operation.index,r.nodeIds));
    current=await changeItemGraphNode({program,destination,source,sha256,currentSha:current.sha256,index:operation.index,operation,dir,step});
    if(operation.action==='remove_item_graph_node'){for(const r of prior)if(r.nodeIds.includes(operation.nodeId))invalidatedGraphs.add(r.operationIndex);}
    else {const updated=await readFile(destination,'utf8');for(const r of prior)if(!itemGraphContains(updated,operation.index,r.nodeIds))invalidatedGraphs.add(r.operationIndex);}
    if(operation.action==='copy_item_graph_node'){
     copiedItemNodes.push({operationIndex,nodeId:current.newNodeId});donors.push({file:operation.donor,sha256:operation.donorSha256});
    }else for(const r of copiedItemNodes)if(r.nodeId===operation.nodeId&&itemGraphContains(xml,operation.index,[r.nodeId]))invalidatedGraphs.add(r.operationIndex);
   }else if(operation.action==='edit_copied_item_node_setting'){
    const ref=operation.nodeFromOperation,entry=Number.isInteger(ref)&&ref>=0&&ref<operationIndex?copiedItemNodes.find(n=>n.operationIndex===ref):undefined;
    if(!entry||invalidatedGraphs.has(ref)||!itemGraphContains(await readFile(program,'utf8'),operation.index,[entry.nodeId]))throw Error('nodeFromOperation must identify an active prior copy_item_graph_node in the selected item');
    current=await editProgramItemGraphSettingCopy({source:program,destination,sha256:current.sha256,index:operation.index,nodeId:entry.nodeId,key:operation.key,value:operation.value});
   }else if(operation.action==='assemble_item_graph'){
    if(operation.replaceExisting)await checkItemGraphReplacement(program,operation.index,source,sha256);
    const xml=await readFile(program,'utf8');
    const prior=assembledItemGraphs.filter(r=>!invalidatedGraphs.has(r.operationIndex)&&itemGraphContains(xml,operation.index,r.nodeIds));
    current=await assembleProgramItemGraph({program,destination,source,sha256,currentSha:current.sha256,index:operation.index,operation,dir,step});
    for(const r of prior)invalidatedGraphs.add(r.operationIndex);
    for(const r of copiedItemNodes)if(itemGraphContains(xml,operation.index,[r.nodeId]))invalidatedGraphs.add(r.operationIndex);
    assembledItemGraphs.push({operationIndex,nodeIds:current.nodeIds});
    for(const node of operation.nodes)donors.push({file:node.template,sha256:node.templateSha256});
   }else if(operation.action==='edit_assembled_item_graph_setting'){
    const ref=operation.graphFromOperation,graph=Number.isInteger(ref)&&ref>=0&&ref<operationIndex?assembledItemGraphs.find(g=>g.operationIndex===ref):undefined;
    if(!graph||invalidatedGraphs.has(ref)||!itemGraphContains(await readFile(program,'utf8'),operation.index,graph.nodeIds))throw Error('graphFromOperation must identify an active prior assemble_item_graph in the selected item');
    if(!Number.isInteger(operation.nodeIndex)||operation.nodeIndex<0||operation.nodeIndex>=graph.nodeIds.length)throw Error('nodeIndex must identify a node in the assembled graph');
    current=await editProgramItemGraphSettingCopy({source:program,destination,sha256:current.sha256,index:operation.index,nodeId:graph.nodeIds[operation.nodeIndex],key:operation.key,value:operation.value});
   }else if(operation.action==='edit_item_graph_wire'){
    const xml=await readFile(program,'utf8');
    const resolveEndpoint=endpoint=>{
     if(Object.hasOwn(endpoint,'nodeId'))return endpoint.nodeId;
     if(Object.hasOwn(endpoint,'nodeFromOperation')){
      const ref=endpoint.nodeFromOperation,entry=ref<operationIndex?copiedItemNodes.find(n=>n.operationIndex===ref):undefined;
      if(!entry||invalidatedGraphs.has(ref)||!itemGraphContains(xml,operation.index,[entry.nodeId]))throw Error('nodeFromOperation must identify an active prior copy_item_graph_node in the selected item');
      return entry.nodeId;
     }
     const ref=endpoint.graphFromOperation,graph=ref<operationIndex?assembledItemGraphs.find(g=>g.operationIndex===ref):undefined;
     if(!graph||invalidatedGraphs.has(ref)||!itemGraphContains(xml,operation.index,graph.nodeIds)||endpoint.nodeIndex>=graph.nodeIds.length)throw Error('graphFromOperation and nodeIndex must identify an active prior assemble_item_graph node in the selected item');
     return graph.nodeIds[endpoint.nodeIndex];
    };
    current=await editItemGraphWire({program,destination,currentSha:current.sha256,index:operation.index,operation:operation.operation,fromNode:resolveEndpoint(operation.from),toNode:resolveEndpoint(operation.to),dir,step});
   }else if(operation.action==='copy_patch_setting_to_item_graph'){
    let nodeId=operation.nodeId;
    if(Object.hasOwn(operation,'nodeFromOperation')){
     const ref=operation.nodeFromOperation,entry=ref<operationIndex?copiedItemNodes.find(n=>n.operationIndex===ref):undefined;
     if(!entry||invalidatedGraphs.has(ref)||!itemGraphContains(await readFile(program,'utf8'),operation.index,[entry.nodeId]))throw Error('nodeFromOperation must identify an active prior copy_item_graph_node in the selected item');
     nodeId=entry.nodeId;
    }else if(Object.hasOwn(operation,'graphFromOperation')){
     const ref=operation.graphFromOperation,graph=ref<operationIndex?assembledItemGraphs.find(g=>g.operationIndex===ref):undefined;
     if(!graph||invalidatedGraphs.has(ref)||!itemGraphContains(await readFile(program,'utf8'),operation.index,graph.nodeIds))throw Error('graphFromOperation must identify an active prior assemble_item_graph in the selected item');
     if(operation.nodeIndex>=graph.nodeIds.length)throw Error('nodeIndex must identify a node in the assembled graph');
     nodeId=graph.nodeIds[operation.nodeIndex];
    }
    current=await copyItemPatchSetting({program,destination,source,sha256,currentSha:current.sha256,index:operation.index,nodeId,operation,dir,step});
    donors.push({file:operation.donor,sha256:operation.donorSha256});
   }else if(operation.action==='edit_graph_setting'){
    const {index,nodeId,key,value}=operation;
    current=await editProgramItemGraphSettingCopy({source:program,destination,sha256:current.sha256,index,nodeId,key,value});
   }else if(['edit_timeline_cue','edit_timeline_graph_setting','edit_timeline_graph_wire','edit_timeline_graph_wire_mapped','edit_copied_timeline_graph_setting','edit_assembled_timeline_graph_setting','add_timeline_cue','delete_timeline_cue','copy_timeline_cue_graph','assemble_timeline_cue_graph','remove_timeline_cue_graph','copy_timeline_cue_node','remove_timeline_cue_node','edit_copied_timeline_node_setting','copy_patch_setting_to_timeline_cue'].includes(operation.action)){
    const {index,layer,startMs,lengthMs,label}=operation;
    let cueId=operation.cueId,nodeId=operation.nodeId;
    let fromNode=operation.fromNode,toNode=operation.toNode;
    if(operation.action==='edit_timeline_graph_wire')cueId=resolveTargetCue(await readFile(program,'utf8'),index,cueId);
    if(['copy_timeline_cue_node','edit_timeline_graph_wire_mapped','copy_patch_setting_to_timeline_cue'].includes(operation.action)){
     const xml=await readFile(program,'utf8');
     cueId=Object.hasOwn(operation,'cueId')?resolveTargetCue(xml,index,operation.cueId):resolveCreatedCue(xml,index,createdCues,operation.cueFromOperation);
    }
    if(operation.action==='copy_patch_setting_to_timeline_cue'&&Object.hasOwn(operation,'nodeFromOperation')){
     const ref=operation.nodeFromOperation,entry=Number.isInteger(ref)&&ref>=0&&ref<operationIndex?copiedCueNodes.find(n=>n.operationIndex===ref):undefined;
     if(!entry||invalidatedGraphs.has(ref)||entry.cueId!==cueId)throw Error('nodeFromOperation must identify an active prior copy_timeline_cue_node in the selected cue');
     nodeId=entry.nodeId;
    }
    if(operation.action==='copy_patch_setting_to_timeline_cue'&&Object.hasOwn(operation,'graphFromOperation')){
     const ref=operation.graphFromOperation,entry=ref<operationIndex?assembledCueGraphs.find(g=>g.operationIndex===ref):undefined;
     if(!entry||invalidatedGraphs.has(ref)||entry.cueId!==cueId||operation.nodeIndex>=entry.nodeIds.length)throw Error('graphFromOperation and nodeIndex must identify an active prior assemble_timeline_cue_graph node in the selected cue');
     nodeId=entry.nodeIds[operation.nodeIndex];
    }
    if(operation.action==='copy_patch_setting_to_timeline_cue'&&Object.hasOwn(operation,'copiedGraphFromOperation')){
     const ref=operation.copiedGraphFromOperation,entry=ref<operationIndex?copiedCueGraphs.find(g=>g.operationIndex===ref):undefined;
     if(!entry||invalidatedGraphs.has(ref)||entry.cueId!==cueId)throw Error('copiedGraphFromOperation must identify an active prior copy_timeline_cue_graph in the selected cue');
     if(!Object.hasOwn(entry.idMap,operation.copiedGraphDonorNodeId)||typeof entry.idMap[operation.copiedGraphDonorNodeId]!=='string'||!entry.idMap[operation.copiedGraphDonorNodeId])throw Error('copiedGraphDonorNodeId must identify a node in the copied graph');
     nodeId=entry.idMap[operation.copiedGraphDonorNodeId];
    }
    if(operation.action==='edit_timeline_graph_wire_mapped'){
     const resolveEndpoint=endpoint=>{
      if(Object.hasOwn(endpoint,'nodeId'))return endpoint.nodeId;
      if(Object.hasOwn(endpoint,'graphFromOperation')){
       const ref=endpoint.graphFromOperation,entry=ref<operationIndex?assembledCueGraphs.find(g=>g.operationIndex===ref):undefined;
       if(!entry||invalidatedGraphs.has(ref)||entry.cueId!==cueId||endpoint.nodeIndex>=entry.nodeIds.length)throw Error('graphFromOperation and nodeIndex must identify an active prior assemble_timeline_cue_graph node in the selected cue');
       return entry.nodeIds[endpoint.nodeIndex];
      }
      const ref=endpoint.nodeFromOperation,entry=ref<operationIndex?copiedCueNodes.find(n=>n.operationIndex===ref):undefined;
      if(!entry||invalidatedGraphs.has(ref)||entry.cueId!==cueId)throw Error('nodeFromOperation must identify an active prior copy_timeline_cue_node in the selected cue');
      return entry.nodeId;
     };
     fromNode=resolveEndpoint(operation.from);toNode=resolveEndpoint(operation.to);
    }
    if(['copy_timeline_cue_graph','assemble_timeline_cue_graph'].includes(operation.action)){
     const xml=await readFile(program,'utf8');
     cueId=Object.hasOwn(operation,'cueId')?resolveTargetCue(xml,index,operation.cueId):resolveCreatedCue(xml,index,createdCues,operation.cueFromOperation);
    }
    if(operation.action==='edit_copied_timeline_graph_setting'){
     const reference=operation.graphFromOperation;
     const graph=Number.isInteger(reference)&&reference>=0&&reference<operationIndex?copiedCueGraphs.find(g=>g.operationIndex===reference):undefined;
     if(!graph||invalidatedGraphs.has(reference))throw Error('graphFromOperation must identify an active prior copy_timeline_cue_graph');
     if(typeof operation.donorNodeId!=='string'||!Object.hasOwn(graph.idMap,operation.donorNodeId)||typeof graph.idMap[operation.donorNodeId]!=='string'||!graph.idMap[operation.donorNodeId])throw Error('donorNodeId must identify a node in the copied graph');
     cueId=resolveCreatedCue(await readFile(program,'utf8'),index,[{operationIndex:reference,id:graph.cueId}],reference);
     nodeId=graph.idMap[operation.donorNodeId];
    }
    if(operation.action==='edit_assembled_timeline_graph_setting'){
     const reference=operation.graphFromOperation;
     const graph=Number.isInteger(reference)&&reference>=0&&reference<operationIndex?assembledCueGraphs.find(g=>g.operationIndex===reference):undefined;
     if(!graph||invalidatedGraphs.has(reference))throw Error('graphFromOperation must identify an active prior assemble_timeline_cue_graph');
     if(!Number.isInteger(operation.nodeIndex)||operation.nodeIndex<0||operation.nodeIndex>=graph.nodeIds.length)throw Error('nodeIndex must identify a node in the assembled graph');
     cueId=resolveTargetCue(await readFile(program,'utf8'),index,graph.cueId);
     nodeId=graph.nodeIds[operation.nodeIndex];
    }
    if(operation.action==='edit_copied_timeline_node_setting'){
     const ref=operation.nodeFromOperation,entry=Number.isInteger(ref)&&ref>=0&&ref<operationIndex?copiedCueNodes.find(n=>n.operationIndex===ref):undefined;
     if(!entry||invalidatedGraphs.has(ref))throw Error('nodeFromOperation must identify an active prior copy_timeline_cue_node');
     cueId=resolveTargetCue(await readFile(program,'utf8'),index,entry.cueId);nodeId=entry.nodeId;
    }
    if(operation.action==='remove_timeline_cue_node')cueId=resolveTargetCue(await readFile(program,'utf8'),index,cueId);
    const timeline=path.join(dir,`${step++}.sktl`),edited=path.join(dir,`${step++}.sktl`);
    const extracted=await extractProgramTimelineCopy({source:program,destination:timeline,sha256:current.sha256,index});
    collect(extracted);
    if(operation.action==='delete_timeline_cue')await checkCueRemovalReferences(program,index,cueId,source,sha256);
    if(operation.action==='remove_timeline_cue_node')await checkNodeRemovalReferences(program,index,cueId,nodeId,source,sha256);
    if(operation.action==='remove_timeline_cue_graph')await checkGraphRemovalReferences(program,index,cueId,source,sha256);
    const changed=operation.action==='add_timeline_cue'
     ?await addTimelineCueCopy({source:timeline,destination:edited,sha256:extracted.sha256,layer,startMs,lengthMs,label})
     :operation.action==='copy_patch_setting_to_timeline_cue'
     ?await copyProgramPatchSetting({timeline,edited,program,source,sha256,currentSha:current.sha256,cueId,nodeId,operation,dir,step})
     :operation.action==='copy_timeline_cue_node'
     ?await copyProgramNode({timeline,edited,program,source,sha256,currentSha:current.sha256,cueId,operation,dir,step})
     :operation.action==='remove_timeline_cue_node'
     ?await removeCueGraphNodeCopy({source:timeline,destination:edited,format:'sktl',sha256:extracted.sha256,cueId,nodeId})
     :operation.action==='assemble_timeline_cue_graph'
     ?await assembleProgramCueGraph({timeline,edited,program,source,sha256,currentSha:current.sha256,index,cueId,nodes:operation.nodes,wires:operation.wires,dir,step})
     :operation.action==='copy_timeline_cue_graph'
     ?await copyCreatedCueGraph({timeline,edited,program,source,sha256,index,cueId,donor:operation.donor,donorName:operation.donorName,donorSha256:operation.donorSha256,donorCueId:operation.donorCueId,dir,step})
     :operation.action==='delete_timeline_cue'
     ?await deleteTimelineCueCopy({source:timeline,destination:edited,format:'sktl',sha256:extracted.sha256,cueId,deleteGraph:operation.deleteGraph})
     :operation.action==='remove_timeline_cue_graph'
     ?await removeCueGraphCopy({source:timeline,destination:edited,format:'sktl',sha256:extracted.sha256,cueId})
     :operation.action==='edit_timeline_cue'
     ?await editTimelineCueCopy({source:timeline,destination:edited,format:'sktl',sha256:extracted.sha256,cueId,layer,startMs,lengthMs,label})
     :['edit_timeline_graph_wire','edit_timeline_graph_wire_mapped'].includes(operation.action)
     ?await editCueGraphWireCopy({source:timeline,destination:edited,format:'sktl',sha256:extracted.sha256,cueId,operation:operation.operation,fromNode,toNode})
     :await editCueGraphSettingCopy({source:timeline,destination:edited,format:'sktl',sha256:extracted.sha256,cueId,nodeId,key:operation.key,value:operation.value});
    if(operation.action==='delete_timeline_cue')collect({...changed,note:'Deleted a cue from an offline Program copy. Literal XML references were checked; binary, encoded and external references may be missed. Validate in ShowKontrol.'});
    else collect(changed);
    if(operation.action==='copy_patch_setting_to_timeline_cue')donors.push({file:operation.donor,sha256:operation.donorSha256});
    if(operation.action==='copy_timeline_cue_node'){copiedCueNodes.push({operationIndex,cueId,nodeId:changed.newNodeId});donors.push({file:operation.donor,sha256:operation.donorSha256});}
    if(operation.action==='copy_timeline_cue_graph'){copiedCueGraphs.push({operationIndex,cueId,idMap:changed.idMap});donors.push({file:operation.donor,sha256:operation.donorSha256});}
    if(operation.action==='assemble_timeline_cue_graph'){assembledCueGraphs.push({operationIndex,cueId,nodeIds:changed.nodeIds});for(const node of operation.nodes)donors.push({file:node.template,sha256:node.templateSha256});}
    if(['remove_timeline_cue_graph','remove_timeline_cue_node','delete_timeline_cue'].includes(operation.action)){
     for(const graph of [...copiedCueGraphs,...assembledCueGraphs])if(graph.cueId===cueId)invalidatedGraphs.add(graph.operationIndex);
     for(const node of copiedCueNodes)if(node.cueId===cueId&&(operation.action!=='remove_timeline_cue_node'||node.nodeId===nodeId))invalidatedGraphs.add(node.operationIndex);
    }
    if(operation.action==='add_timeline_cue')createdCues.push({operationIndex,index,id:changed.id});
    current=await embedProgramTimelineCopy({source:program,destination,sha256:current.sha256,index,donor:edited,donorSha256:changed.sha256,replaceExisting:true});
    if(operation.action==='add_timeline_cue')await checkCueRemovalReferences(destination,index,changed.id,source,sha256);
   }else current=await createProgramCopy({source:program,destination,sha256:current.sha256,operation});
   collect(current);program=destination;
  }
  const candidate=path.join(dir,'candidate.skshow');
  const attached=await attachShowProgramCopy({source,destination:candidate,sha256,program,programSha256:current.sha256,replaceExisting:true});
  const validation=await validateShow({file:candidate});
  if(validation.diagnostics.some(d=>d.severity==='error'))throw Error(`Final show validation failed: ${validation.diagnostics.filter(d=>d.severity==='error').map(d=>d.code).join(', ')}`);
  const final=await inspectShowProgram({file:candidate});
  if(final.sha256!==attached.sha256||final.programSha256!==current.sha256)throw Error('Final show checksum mismatch');
  if((await inspectShowProgram({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  for(const donor of donors)if((await inspectXml({file:donor.file})).sha256!==donor.sha256)throw Error('Donor changed since inspection');
  await link(candidate,destination);
  return {destination,sha256:attached.sha256,programSha256:current.sha256,items:final.items,createdCues,copiedCueGraphs,assembledCueGraphs,assembledItemGraphs,copiedItemNodes,copiedCueNodes,warnings:[...warnings],validation:{...validation,file:destination,note:`${validation.note} Validation was performed before publication.`}};
 }finally{await rm(dir,{recursive:true,force:true});}
}
