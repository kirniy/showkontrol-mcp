import {mkdtemp,rm,link,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {extractShowProgramCopy,createProgramCopy,attachShowProgramCopy,inspectShowProgram,editProgramItemGraphSettingCopy,extractProgramTimelineCopy,embedProgramTimelineCopy} from './program.js';
import {addTimelineCueCopy,deleteTimelineCueCopy,editTimelineCueCopy,editCueGraphSettingCopy,copyCueGraphBetweenTimelinesWithShow,removeCueGraphCopy} from './timeline.js';
import {inspectXml,readShowSnapshot,readSnapshotPart,addShowPart} from './xml-copy.js';
import {assembleMixedCueGraphShowCopy} from './cue-graph-mixed.js';
import {validateShow} from './validate-show.js';
import {parseXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';
import {editCueGraphWireCopy} from './cue-wires.js';
import {copyCueGraphNodeShowCopy} from './cue-node-copy.js';
import {copyPatchNodeToCueShowCopy} from './patch-node-to-cue.js';
import {removeCueGraphNodeCopy} from './cue-node-remove.js';

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
  if(names.has(part.name))throw Error('Duplicate supported XML part name');names.add(part.name);
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
 return {...result,sha256:digest(final),note:'Copied a fixture-supported graph. Router targets were checked against the destination show; application acceptance is unverified.'};
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
  else if(op.action==='edit_timeline_graph_setting')keys(op,['action','index','cueId','nodeId','key','value']);
  else if(op.action==='edit_timeline_graph_wire')keys(op,['action','index','cueId','operation','fromNode','toNode']);
  else if(op.action==='edit_timeline_graph_wire_mapped'){
   keys(op,['action','index','cueId','operation','from','to']);
   for(const endpoint of [op.from,op.to]){
    keys(endpoint,[],['nodeId','nodeFromOperation']);
    if(Object.hasOwn(endpoint,'nodeId')===Object.hasOwn(endpoint,'nodeFromOperation'))throw Error('Endpoint must contain exactly one of nodeId or nodeFromOperation');
    if(Object.hasOwn(endpoint,'nodeId')&&(typeof endpoint.nodeId!=='string'||!endpoint.nodeId))throw Error('nodeId must be a nonempty string');
    if(Object.hasOwn(endpoint,'nodeFromOperation')&&(!Number.isInteger(endpoint.nodeFromOperation)||endpoint.nodeFromOperation<0))throw Error('nodeFromOperation must identify an active prior copy_timeline_cue_node');
   }
  }
  else if(op.action==='copy_timeline_cue_node'){
   keys(op,['action','index','cueId','donorType','donor','donorSha256','donorNodeId'],['donorName','donorCueId','donorFormat']);
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
  const createdCues=[],copiedCueGraphs=[],assembledCueGraphs=[],copiedCueNodes=[],donors=[],invalidatedGraphs=new Set();
  const collect=result=>{for(const warning of [...(result.warnings??[]),result.note])if(typeof warning==='string'&&warning)warnings.add(warning);};
  let program=next(),current=await extractShowProgramCopy({source,destination:program,sha256});collect(current);
  for(const [operationIndex,operation] of operations.entries()){
   if(operation.action==='remove'){
    await checkRemovalReferences(program,operation.index);
    const item=parseXmlSpans(await readFile(program,'utf8')).children[operation.index];
    const ids=new Set();const visit=n=>{if(n.name==='cue')ids.add(n.attributes.id);for(const c of n.children)visit(c);};visit(item);
    for(const receipt of copiedCueNodes)if(ids.has(receipt.cueId))invalidatedGraphs.add(receipt.operationIndex);
   }
   const destination=next();
   if(operation.action==='edit_graph_setting'){
    const {index,nodeId,key,value}=operation;
    current=await editProgramItemGraphSettingCopy({source:program,destination,sha256:current.sha256,index,nodeId,key,value});
   }else if(['edit_timeline_cue','edit_timeline_graph_setting','edit_timeline_graph_wire','edit_timeline_graph_wire_mapped','edit_copied_timeline_graph_setting','edit_assembled_timeline_graph_setting','add_timeline_cue','delete_timeline_cue','copy_timeline_cue_graph','assemble_timeline_cue_graph','remove_timeline_cue_graph','copy_timeline_cue_node','remove_timeline_cue_node','edit_copied_timeline_node_setting'].includes(operation.action)){
    const {index,layer,startMs,lengthMs,label}=operation;
    let cueId=operation.cueId,nodeId=operation.nodeId;
    let fromNode=operation.fromNode,toNode=operation.toNode;
    if(['edit_timeline_graph_wire','edit_timeline_graph_wire_mapped'].includes(operation.action))cueId=resolveTargetCue(await readFile(program,'utf8'),index,cueId);
    if(operation.action==='edit_timeline_graph_wire_mapped'){
     const resolveEndpoint=endpoint=>{
      if(Object.hasOwn(endpoint,'nodeId'))return endpoint.nodeId;
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
    if(['copy_timeline_cue_node','remove_timeline_cue_node'].includes(operation.action))cueId=resolveTargetCue(await readFile(program,'utf8'),index,cueId);
    const timeline=path.join(dir,`${step++}.sktl`),edited=path.join(dir,`${step++}.sktl`);
    const extracted=await extractProgramTimelineCopy({source:program,destination:timeline,sha256:current.sha256,index});
    collect(extracted);
    if(operation.action==='delete_timeline_cue')await checkCueRemovalReferences(program,index,cueId,source,sha256);
    if(operation.action==='remove_timeline_cue_node')await checkNodeRemovalReferences(program,index,cueId,nodeId,source,sha256);
    if(operation.action==='remove_timeline_cue_graph')await checkGraphRemovalReferences(program,index,cueId,source,sha256);
    const changed=operation.action==='add_timeline_cue'
     ?await addTimelineCueCopy({source:timeline,destination:edited,sha256:extracted.sha256,layer,startMs,lengthMs,label})
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
  return {destination,sha256:attached.sha256,programSha256:current.sha256,items:final.items,createdCues,copiedCueGraphs,assembledCueGraphs,copiedCueNodes,warnings:[...warnings],validation:{...validation,file:destination,note:`${validation.note} Validation was performed before publication.`}};
 }finally{await rm(dir,{recursive:true,force:true});}
}
