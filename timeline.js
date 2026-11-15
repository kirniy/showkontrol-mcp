import {maskOpaqueNodeText,opaqueNodeWarnings} from './opaque-node-text.js';
import {supportedCueCopyNode,cuePrototypeNote} from './cue-node-copy.js';
import {storedStoppedWarnings} from './stored-stopped-warnings.js';
import {hasXmlReference} from './xml-references.js';
import {scanCueReferences} from './cue-reference-scan.js';
import {validateRouterTarget} from './patch-setting-to-cue.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
import {SaxesParser} from 'saxes';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart,addShowPart} from './xml-copy.js';
import {createHash,randomInt} from 'node:crypto';
import path from 'node:path';
export function parseTimeline(xml) {
 const parser=new SaxesParser();const stack=[];const result={attributes:{},layers:[],audio:[],audioClips:[],cueElements:[]};
 parser.on('opentag',tag=>{
  const parent=stack.at(-1);stack.push(tag.name);
  if(stack.length===1){if(tag.name!=='sktimeline'||tag.attributes.version!=='1')throw Error('Expected a version 1 sktimeline');result.attributes={...tag.attributes};}
  if(tag.name==='layer'&&parent==='layers'&&stack.length===3)result.layers.push({...tag.attributes});
  if(tag.name==='audio'&&parent==='sktimeline'&&stack.length===2)result.audio.push({...tag.attributes});
  if(tag.name==='clip'&&stack.join('/')==='sktimeline/audio/clip')result.audioClips.push({audioIndex:result.audio.length-1,attributes:{...tag.attributes}});
  if(tag.name==='cue')result.cueElements.push({path:stack.join('/'),attributes:{...tag.attributes}});
 });
 parser.on('closetag',()=>stack.pop());parser.write(xml).close();return result;
}
export async function inspectTimeline({file}) {
 const {xml,sha256}=await inspectXml({file});return {file,sha256,...parseTimeline(xml)};
}
export async function inspectShowTimeline({file,name}) {
 if(!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
 const show=await readShowSnapshot({file});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const {text}=readSnapshotPart({snapshot:show,name});return {file,name,sha256:show.sha256,...parseTimeline(text)};
}
function xmlAttr(s) {
 if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(s))throw Error('Invalid XML character in cue label');
 return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll('\t','&#x9;').replaceAll('\n','&#xA;').replaceAll('\r','&#xD;');
}
function addCue(xml,{layer,startMs,lengthMs,label}) {
 if(!Number.isInteger(layer)||layer<0)throw Error('Layer must be a non-negative integer');
 if(!Number.isFinite(startMs)||startMs<0||!Number.isFinite(lengthMs)||lengthMs<=0)throw Error('Start must be non-negative and length must be positive milliseconds');
 if(typeof label!=='string'||!label.trim())throw Error('Cue label is required');
 const info=parseTimeline(xml);if(layer>=info.layers.length)throw Error('Layer index is outside the existing layers');
 const closings=[...xml.matchAll(/<\/sktimeline\s*>/g)];
 if(closings.length!==1||!/^\s*$/.test(xml.slice(closings[0].index+closings[0][0].length)))throw Error('Nested timeline or trailing XML markup is not supported');
 let id;do{id=`c${Date.now()}_${randomInt(1,1000000000)}`}while(info.cueElements.some(c=>c.attributes.id===id));
 const cue=`<cue id="${id}" layer="${layer}" startMs="${startMs}" lenMs="${lengthMs}" label="${xmlAttr(label)}"/>`;
 const at=closings[0].index,modified=xml.slice(0,at)+cue+xml.slice(at);
 const created=parseTimeline(modified).cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===id);
 if(created.length!==1||created[0].attributes.label!==label||created[0].attributes.layer!==String(layer)||created[0].attributes.startMs!==String(startMs)||created[0].attributes.lenMs!==String(lengthMs))throw Error('Cue fields could not be preserved in XML');
 return {id,modified};
}
export async function addTimelineCueCopy({source,destination,sha256,layer,startMs,lengthMs,label}) {
 const {xml,sha256:actual}=await inspectXml({file:source});if(actual!==sha256)throw Error('Source changed since inspection');
 const {id,modified}=addCue(xml,{layer,startMs,lengthMs,label});
 const result=await editXmlCopy({source,destination,sha256,edits:[{find:xml,replace:modified}]});
 return {...result,id,layer,startMs,lengthMs,label,note:'A simple cue was added to an offline copy. No action graph was created.'};
}
export async function addShowTimelineCueCopy({source,destination,sha256,name,layer,startMs,lengthMs,label}) {
 if(!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const {text}=readSnapshotPart({snapshot:show,name});const {id,modified}=addCue(text,{layer,startMs,lengthMs,label});
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:text,replace:modified}]});
 return {...result,id,layer,startMs,lengthMs,label,note:'A simple cue was added to an offline show copy. No action graph was created.'};
}
function cueGraph(xml,cueId){
 const parser=new SaxesParser();const stack=[];let cue=null,currentNode=null,setting=null,text='',matches=0;
 const graphs=[];
 parser.on('opentag',tag=>{
  const parent=stack.at(-1);stack.push(tag.name);
  if(stack.length===1&&(tag.name!=='sktimeline'||tag.attributes.version!=='1'))throw Error('Expected a version 1 sktimeline');
  if(stack.length===2&&tag.name==='cue'&&tag.attributes.id===cueId){matches++;cue={id:cueId,graph:null};}
  if(cue&&stack.length===3&&parent==='cue'&&tag.name==='graph'){if(cue.graph)throw Error('Multiple cue graphs are not supported');cue.graph={nodes:[],connections:[]};}
  if(cue?.graph&&stack.length===4&&parent==='graph'&&tag.name==='node'){currentNode={...tag.attributes,settings:[]};cue.graph.nodes.push(currentNode);}
  if(cue?.graph&&stack.length===4&&parent==='graph'&&tag.name==='connection')cue.graph.connections.push({...tag.attributes});
  if(currentNode&&stack.length===6&&parent==='settings'&&tag.name==='setting'){setting={key:tag.attributes.key};text='';}
  else if(setting)throw Error('Nested setting content is not supported');
 });
 parser.on('text',s=>{if(setting)text+=s});parser.on('cdata',s=>{if(setting)text+=s});
 parser.on('closetag',tag=>{
  if(setting&&tag.name==='setting'){setting.value=text;currentNode.settings.push(setting);setting=null;}
  if(currentNode&&stack.length===4&&tag.name==='node')currentNode=null;
  if(cue&&stack.length===2&&tag.name==='cue'){graphs.push(cue);cue=null;}
  stack.pop();
 });parser.write(xml).close();if(matches!==1)throw Error('Cue ID must occur exactly once as a direct timeline child');return graphs[0];
}
export async function inspectCueGraph({file,format,name,cueId}){
 let xml,sha256;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');sha256=show.sha256;xml=(readSnapshotPart({snapshot:show,name})).text;
 }else if(format==='sktl'){const info=await inspectXml({file});sha256=info.sha256;xml=info.xml;}
 else throw Error('Format must be sktl or skshow');
 return {file,format,...(name?{name}:{}),sha256,...cueGraph(xml,cueId)};
}
function xmlNodeIds(xml){
 const ids=[];const p=new SaxesParser();p.on('opentag',tag=>{if(tag.name==='node'&&tag.attributes.id)ids.push(tag.attributes.id)});p.write(xml).close();return ids;
}
function remapCueGraph(xml,graph,idMap){
 const replacements=[];
 const walk=(node,parent)=>{
  const supported=parent===graph&&node.name==='node'?['id']:parent===graph&&node.name==='connection'?['fromNode','toNode']:[];
  for(const [key,value] of Object.entries(node.attributes))if(!supported.includes(key)&&/node|ref/i.test(key)&&Object.hasOwn(idMap,value))throw Error('Graph contains node references outside supported attributes');
  if(supported.length){
   const opening=xml.slice(node.start,node.openEnd),attr=/\s+([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/y;let pos=1+node.name.length;
   while(pos<opening.length){
    if(/^\s*\/?>$/.test(opening.slice(pos)))break;
    attr.lastIndex=pos;const m=attr.exec(opening);if(!m)throw Error('Unsupported graph attribute serialization');
    if(supported.includes(m[1])){
     const value=node.attributes[m[1]];if(!Object.hasOwn(idMap,value))throw Error('Graph contains unsupported node references');
     const start=node.start+pos+m[0].indexOf(m[2])+1;replacements.push({start,end:start+m[3].length,value:idMap[value]});
    }
    pos=attr.lastIndex;
   }
   for(const key of supported)if(!Object.hasOwn(node.attributes,key))throw Error('Graph node or connection is missing required attributes');
  }
  for(const child of node.children)walk(child,node);
 };
 walk(graph,null);
 let result=xml.slice(graph.start,graph.end);
 for(const r of replacements.sort((a,b)=>b.start-a.start))result=result.slice(0,r.start-graph.start)+r.value+result.slice(r.end-graph.start);
 return result;
}
// Only node IDs and connection endpoints have verified remapping semantics.
function validateGraphReferences(xml,graph,targetShow,allowOpaqueNodeText){
 const pattern=/(^|[^A-Za-z0-9_])n\d+([^A-Za-z0-9_]|$)/;
 const pieces=[], validatedRouterSettings=new Set(), opaque=[];
 for(const child of graph.children){
  if(child.name==='node'){
   const masked=maskOpaqueNodeText(xml,child,allowOpaqueNodeText);let nodeXml=masked.masked;
   if(masked.keys.length)opaque.push({nodeId:child.attributes.id,keys:masked.keys});
   const routerSettings=child.children.filter(c=>c.name==='settings').flatMap(c=>c.children.filter(s=>s.name==='setting'&&s.attributes.key==='route.router_target'));
   const allRouterSettings=[];const collect=node=>{if(node.name==='setting'&&node.attributes.key==='route.router_target')allRouterSettings.push(node);for(const nested of node.children)collect(nested);};collect(child);
   if(routerSettings.length>1||allRouterSettings.length!==routerSettings.length)throw Error('Invalid router target setting');
   for(const setting of routerSettings){
    if(!targetShow)throw Error('Router target cannot be validated for a standalone timeline');
    const settingXml=xml.slice(setting.start,setting.end);let value='',depth=0;
    const p=new SaxesParser();p.on('opentag',()=>{if(++depth>1)throw Error('Nested setting content is unsupported')});p.on('text',s=>value+=s);p.on('cdata',s=>value+=s);p.on('closetag',()=>depth--);p.write(settingXml).close();
    if(child.attributes.type!=='action'||!value||value.trim()!==value||Object.keys(setting.attributes).length!==1||(!/^n\d+$/.test(value)&&hasXmlReference(settingXml,pattern)))throw Error('Invalid router target setting');
    validateRouterTarget(targetShow,value);validatedRouterSettings.add(setting);
    nodeXml=nodeXml.slice(0,setting.start-child.start)+nodeXml.slice(setting.end-child.start);
   }
   if(hasXmlReference(nodeXml,pattern,{ignoreRootId:true}))throw Error('Graph node contains unsupported internal references');
  }else if(child.name==='connection'){
   // Endpoint attributes are remapped; reject ID-like text or other attributes.
   const connectionXml=xml.slice(child.start,child.end);
   if(hasXmlReference(connectionXml,pattern,{ignoreRootAttributes:['fromNode','toNode']}))throw Error('Graph contains unsupported internal references');
  }else pieces.push(xml.slice(child.start,child.end));
 }
 const checkRouterPlacement=node=>{if(node.name==='setting'&&node.attributes.key==='route.router_target'&&!validatedRouterSettings.has(node))throw Error('Invalid router target setting');for(const child of node.children)checkRouterPlacement(child);};checkRouterPlacement(graph);
 let remaining=xml.slice(graph.start,graph.end);
 for(const child of [...graph.children].sort((a,b)=>b.start-a.start))remaining=remaining.slice(0,child.start-graph.start)+remaining.slice(child.end-graph.start);
 if(hasXmlReference(remaining,pattern)||pieces.some(piece=>hasXmlReference(piece,pattern)))throw Error('Graph contains unsupported internal references');
 return opaque;
}
function cueElements(xml,cueId){
 return [...xml.matchAll(/<cue\b(?:[^"'<>]|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/cue\s*>)/g)].filter(match=>{
  const opening=match[0].match(/^<cue\b(?:[^"'<>]|"[^"]*"|'[^']*')*?>/)[0];
  let attributes;const parser=new SaxesParser();parser.on('opentag',tag=>{attributes=tag.attributes});
  parser.write(opening.replace(/\s*\/?>$/,'/>')).close();return attributes.id===cueId;
 });
}
function insertCueGraph(xml,cue,graph){
 if(cue.selfClosing){const open=xml.slice(cue.start,cue.openEnd).replace(/\s*\/>$/,'>');return xml.slice(0,cue.start)+open+graph+'</cue>'+xml.slice(cue.end);}
 if(!/^\s*$/.test(xml.slice(cue.openEnd,cue.closeStart)))throw Error('Target cue must be empty or contain only whitespace');
 return xml.slice(0,cue.closeStart)+graph+xml.slice(cue.closeStart);
}
export async function copyCueGraphInShow({source,destination,sha256,name,sourceName=name,sourceCueId,targetCueId,template,templateSha256,allowOpaqueNodeText}){
 if((template===undefined)!==(templateSha256===undefined))throw Error('Provide both template and templateSha256');
 if(template===undefined&&sourceName===name&&sourceCueId===targetCueId)throw Error('Select two different cues');
 if(!name?.toLowerCase().endsWith('.sktl')||!sourceName?.toLowerCase().endsWith('.sktl'))throw Error('Select .sktl parts');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const donor=template===undefined?show:await readShowSnapshot({file:template});
 if(template!==undefined&&donor.sha256!==templateSha256)throw Error('Template changed since inspection');
 if(!donor.parts.every(p=>p.valid))throw Error('A template part MD5 does not match');
 const xml=readSnapshotPart({snapshot:show,name}).text,sourceXml=readSnapshotPart({snapshot:donor,name:sourceName}).text;
 const src=cueGraph(sourceXml,sourceCueId),target=cueGraph(xml,targetCueId);
 if(!src.graph||!src.graph.nodes.length)throw Error('Source cue has no graph');
 if(target.graph)throw Error('Target cue already has a graph');
 const nodes=src.graph.nodes;const ids=nodes.map(n=>n.id);
 if(ids.some(id=>!/^n\d+$/.test(id))||new Set(ids).size!==ids.length)throw Error('Graph has unsupported or duplicate node IDs');
 if(nodes.some(n=>!supportedCueCopyNode(n)))throw Error('Graph contains node types not present in the verified fixture');
 if(src.graph.connections.some(c=>!ids.includes(c.fromNode)||!ids.includes(c.toNode)))throw Error('Graph has external or invalid connections');
 let max=0;
 for(const entry of show.parts.filter(p=>/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name))){
  const txt=(readSnapshotPart({snapshot:show,name:entry.name})).text;
  for(const id of xmlNodeIds(txt)){if(/^n\d+$/.test(id)){const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,n)}}
 }
 for(const id of ids){const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,n);}
 if(max+ids.length>1000000000)throw Error('No node IDs remain in the supported range');
 const idMap=Object.fromEntries(ids.map(id=>[id,`n${++max}`]));
 const sourceRoot=parseXmlSpans(sourceXml),targetRoot=sourceXml===xml?sourceRoot:parseXmlSpans(xml);
 const sm=selectXmlSpans(sourceRoot,['sktimeline',{name:'cue',attributes:{id:sourceCueId}}]);
 if(sm.length!==1||sm[0].selfClosing)throw Error('Unsupported source cue serialization');
 const gm=selectXmlSpans(sourceRoot,['sktimeline',{name:'cue',attributes:{id:sourceCueId}},'graph']);
 if(gm.length!==1||gm[0].selfClosing)throw Error('Unsupported graph serialization');
 const opaque=validateGraphReferences(sourceXml,gm[0],show,allowOpaqueNodeText);
 const graph=remapCueGraph(sourceXml,gm[0],idMap);
 const tm=selectXmlSpans(targetRoot,['sktimeline',{name:'cue',attributes:{id:targetCueId}}]);if(tm.length!==1)throw Error('Target cue must occur exactly once');
 const changed=insertCueGraph(xml,tm[0],graph);
 const expected={nodes:src.graph.nodes.map(node=>({...node,id:idMap[node.id]})),connections:src.graph.connections.map(connection=>({...connection,fromNode:idMap[connection.fromNode],toNode:idMap[connection.toNode]}))};
 if(JSON.stringify(cueGraph(changed,targetCueId).graph)!==JSON.stringify(expected))throw Error('Copied graph did not match the selected source and target cues');
 const warnings=[...storedStoppedWarnings(changed,name).filter(w=>w.scope.cueId===targetCueId&&Object.values(idMap).includes(w.scope.nodeId)),...opaqueNodeWarnings(opaque,name,targetCueId,idMap)];
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:changed}]});
 return {...result,sourceName,sourceCueId,targetCueId,idMap,warnings,note:'Copied a fixture-supported cue graph into an offline show copy; validate the result in ShowKontrol.'+(nodes.some(n=>['processor','generator'].includes(n.type))?' '+cuePrototypeNote:'')};
}

// Edit only the cue's opening tag, leaving any action graph intact.
export async function editTimelineCueCopy({source,destination,format,sha256,name,cueId,layer,startMs,lengthMs,label}) {
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(typeof cueId!=='string'||!cueId)throw Error('Cue ID is required');
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  actual=show.sha256;xml=(readSnapshotPart({snapshot:show,name})).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const info=parseTimeline(xml);
 const cues=info.cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId);
 if(cues.length!==1)throw Error('Cue ID must occur exactly once as a direct timeline child');
 if(layer!==undefined&&(!Number.isInteger(layer)||layer<0||layer>=info.layers.length))throw Error('Layer index is outside the existing layers');
 if(startMs!==undefined&&(!Number.isFinite(startMs)||startMs<0))throw Error('Start must be non-negative milliseconds');
 if(lengthMs!==undefined&&(!Number.isFinite(lengthMs)||lengthMs<=0))throw Error('Length must be positive milliseconds');
 if(label!==undefined&&(typeof label!=='string'||!label.trim()))throw Error('Cue label is required');
 const updates={layer,startMs,lenMs:lengthMs,label};
 if(Object.values(updates).every(v=>v===undefined))throw Error('Provide at least one cue field');
 const root=parseXmlSpans(xml),matches=selectXmlSpans(root,['sktimeline',{name:'cue',attributes:{id:cueId}}]);
 if(matches.length!==1)throw Error('Cannot uniquely locate cue serialization');
 const match=matches[0],opening=xml.slice(match.start,match.openEnd);
 const replacements=[];let pos=4;const attr=/\s+([^\s=/>]+)\s*=\s*(["'])([^"']*(?:(?!\2)["'][^"']*)*)\2/y;
 while(pos<opening.length){
  if(/^\s*\/?>$/.test(opening.slice(pos)))break;
  attr.lastIndex=pos;const m=attr.exec(opening);if(!m)throw Error('Unsupported cue attribute serialization');
  const key=m[1];if(Object.hasOwn(updates,key)&&updates[key]!==undefined){
   const valueStart=pos+m[0].indexOf(m[2])+1;replacements.push({key,start:valueStart,end:valueStart+m[3].length,value:xmlAttr(String(updates[key])).replaceAll("'",'&apos;')});
  }
  pos=attr.lastIndex;
 }
 for(const [key,value] of Object.entries(updates))if(value!==undefined&&!replacements.some(r=>r.key===key))throw Error(`Cue field ${key} must exist exactly once`);
 let changed=opening;for(const r of replacements.reverse())changed=changed.slice(0,r.start)+r.value+changed.slice(r.end);
 const modified=xml.slice(0,match.start)+changed+xml.slice(match.openEnd);
 const checked=parseTimeline(modified).cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId);
 if(checked.length!==1||Object.entries(updates).some(([key,value])=>value!==undefined&&checked[0].attributes[key]!==String(value)))throw Error('Cue edit did not produce requested values');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};
 const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,note:'Cue fields changed in an offline copy; existing graph was preserved. Validate in ShowKontrol.'};
}

// Read an inspected external template again whenever it is used or published.
export async function readTrackTemplateDonor(donor) {
 if(!donor || typeof donor!=='object' || Array.isArray(donor) || !path.isAbsolute(donor.file||'') || !['sktl','skshow'].includes(donor.format) || typeof donor.sha256!=='string' || !/^[a-fA-F0-9]{64}$/.test(donor.sha256) || Object.keys(donor).some(k=>!['file','format','sha256','name'].includes(k)) || (donor.format==='skshow' ? typeof donor.name!=='string'||!donor.name.toLowerCase().endsWith('.sktl') : donor.name!==undefined)) throw Error('Template donor requires an absolute file, format, SHA-256 and, for a show, a timeline part name');
 let xml,actual;
 if(donor.format==='skshow'){
  const show=await readShowSnapshot({file:donor.file});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  actual=show.sha256;xml=readSnapshotPart({snapshot:show,name:donor.name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:donor.file}));
 if(actual.toLowerCase()!==donor.sha256.toLowerCase())throw Error('Template donor changed since inspection');
 return xml;
}
// New tracks use an empty app-saved timeline as a template.
export async function createShowTrackCopy({source,destination,sha256,templateName,templateDonor,trackName,partName}) {
 if(!/^[A-Za-z0-9 _-]+$/.test(trackName||'')||!trackName.trim())throw Error('Track name must use letters, digits, spaces, underscores or hyphens');
 if(!/^content\/[A-Za-z0-9_-]+\.sktl$/.test(partName||''))throw Error('Part name must be a content/ timeline filename with letters, digits, underscores or hyphens');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 if((templateName===undefined)===(templateDonor===undefined) || (templateName!==undefined && (typeof templateName!=='string'||!templateName.toLowerCase().endsWith('.sktl'))))throw Error('Select exactly one empty timeline template or template donor');
 let template=templateDonor===undefined?undefined:await readTrackTemplateDonor(templateDonor);
 for(const part of show.parts.filter(p=>p.name.toLowerCase().endsWith('.sktl'))){
  const xml=(readSnapshotPart({snapshot:show,name:part.name})).text, info=parseTimeline(xml);
  if(info.attributes.name?.toLowerCase()===trackName.toLowerCase())throw Error('Track name already exists');
  if(part.name===templateName)template=xml;
 }
 if(!template)throw Error('Timeline template was not found');
 const info=parseTimeline(template);if(info.cueElements.length||info.attributes.media||info.attributes.mediaWave||info.attributes.mediaGrid||info.attributes.mediaStructS||info.attributes.mediaStructE||info.attributes.mediaStructL)throw Error('Template must be empty and have no media');
 // Only clone the structure observed in the app-saved empty track fixture.
 const stack=[];const allowed=new Set(['sktimeline','sktimeline/titles','sktimeline/layers','sktimeline/layers/layer','sktimeline/audio']);
 const p=new SaxesParser();p.on('opentag',tag=>{stack.push(tag.name);if(!allowed.has(stack.join('/')))throw Error('Template contains unsupported content');});
 p.on('text',text=>{if(text.trim())throw Error('Template contains unsupported text');});p.on('cdata',()=>{throw Error('Template contains unsupported content');});p.on('closetag',()=>stack.pop());p.write(template).close();
 const root=parseXmlSpans(template);if(root.name!=='sktimeline'||!Object.hasOwn(root.attributes,'name'))throw Error('Timeline name must exist exactly once');
 const opening=template.slice(root.start,root.openEnd),attr=/\s+([^\s=/>]+)\s*=\s*(["'])([^"']*(?:(?!\2)["'][^"']*)*)\2/y;let pos='<sktimeline'.length,selected;
 while(pos<opening.length){
  if(/^\s*\/?>$/.test(opening.slice(pos)))break;
  attr.lastIndex=pos;const m=attr.exec(opening);if(!m)throw Error('Unsupported timeline attribute serialization');
  if(m[1]==='name'){const start=pos+m[0].indexOf(m[2])+1;selected={start,end:start+m[3].length};}pos=attr.lastIndex;
 }
 if(!selected)throw Error('Timeline name must exist exactly once');
 const changed=opening.slice(0,selected.start)+xmlAttr(trackName)+opening.slice(selected.end);
 const text=template.slice(0,root.start)+changed+template.slice(root.openEnd);
 if(parseTimeline(text).attributes.name!==trackName)throw Error('Track name could not be preserved in XML');
 if(templateDonor!==undefined)await readTrackTemplateDonor(templateDonor);
 const result=await addShowPart({source,destination,sha256,name:partName,text});
 return {...result,trackName,...(templateDonor===undefined?{templateName}:{templateDonor}),note:'Added an empty timeline part to an offline show copy. The set list is unchanged. Validate in ShowKontrol.'};
}

export async function deleteTimelineCueCopy({source,destination,format,sha256,name,cueId,deleteGraph=false}) {
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(typeof cueId!=='string'||!cueId)throw Error('Cue ID is required');
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  actual=show.sha256;xml=(readSnapshotPart({snapshot:show,name})).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const info=parseTimeline(xml);const cues=info.cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId);
 if(cues.length!==1)throw Error('Cue ID must occur exactly once as a direct timeline child');
 const graph=cueGraph(xml,cueId).graph;if(graph&&!deleteGraph)throw Error('Cue has an action graph; set deleteGraph to true to remove it');
 const candidates=[...xml.matchAll(/<cue\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/cue\s*>)/g)].filter(m=>{
  let attrs;const p=new SaxesParser();p.on('opentag',tag=>{if(!attrs)attrs=tag.attributes});p.write(m[0]).close();return attrs.id===cueId;
 });
 if(candidates.length!==1)throw Error('Unsupported or ambiguous cue serialization');
 const m=candidates[0],modified=xml.slice(0,m.index)+xml.slice(m.index+m[0].length);parseTimeline(modified);
 if(format==='skshow'){
  const scan=await scanCueReferences({file:source,name,cueId,sha256});
  if(scan.diagnosticsTruncated||scan.diagnostics.some(d=>/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(d.part)))throw Error('A supported XML part could not be scanned for references');
  if(scan.referencesTotal)throw Error('Cue or graph node has surviving XML references');
 }else{
  const ids=[cueId,...(graph?.nodes.map(node=>node.id).filter(id=>typeof id==='string'&&id.length)||[])];
  if(ids.length>1001||ids.some(id=>id.length>1024))throw Error('Cue or graph node exceeds reference scan limit');
  const alternatives=[...new Set(ids)].sort((a,b)=>b.length-a.length).map(id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  if(hasXmlReference(modified,new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`)))throw Error('Cue or graph node has surviving XML references');
 }
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};
 const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,deletedGraph:!!graph,note:format==='sktl'?'Deleted a cue from an offline timeline copy. Other show parts cannot be checked; validate in ShowKontrol.':'Deleted a cue from an offline show copy. Literal XML references were checked; binary, encoded and external references may be missed. Validate in ShowKontrol.'};
}

export async function setCueGraphNodeStoppedCopy({source,destination,format,sha256,name,cueId,nodeId,stopped}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(typeof cueId!=='string'||!cueId||!/^[A-Za-z0-9_.:-]+$/.test(nodeId||'')||typeof stopped!=='boolean')throw Error('Invalid cue ID, node ID or stopped state');
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const graph=cueGraph(xml,cueId).graph;if(!graph)throw Error('Cue has no action graph');
 if(graph.nodes.filter(n=>n.id===nodeId).length!==1)throw Error('Node ID must occur exactly once in cue graph');
 const root=parseXmlSpans(xml),nodes=selectXmlSpans(root,['sktimeline',{name:'cue',attributes:{id:cueId}},'graph',{name:'node',attributes:{id:nodeId}}]);
 if(nodes.length!==1)throw Error('Unsupported or ambiguous node serialization');
 const node=nodes[0],containers=node.children.filter(c=>c.name==='settings');
 if(containers.length>1)throw Error('Ambiguous node settings');
 const allSettings=[];const visit=n=>{for(const c of n.children){if(c.name==='setting'&&c.attributes.key==='node.stopped')allSettings.push(c);visit(c)}};visit(node);
 if(allSettings.length>1||allSettings.some(s=>!containers[0]?.children.includes(s)))throw Error('Unsupported or ambiguous stopped setting');
 const setting=allSettings[0],hasAttr=Object.hasOwn(node.attributes,'stopped');
 if(!hasAttr&&!setting)throw Error('Node has no explicit stopped state');
 const edits=[];
 if(hasAttr){
  if(!['0','1'].includes(node.attributes.stopped))throw Error('Unsupported stopped attribute value');
  const opening=xml.slice(node.start,node.openEnd),matches=[...opening.matchAll(/(?:^|\s)stopped\s*=\s*(["'])([01])\1/g)];
  if(matches.length!==1)throw Error('Unsupported stopped attribute serialization');
  const m=matches[0],offset=m.index+m[0].lastIndexOf(m[2]);edits.push({start:node.start+offset,end:node.start+offset+1,value:stopped?'1':'0'});
 }
 if(setting){
  const content=xml.slice(setting.openEnd,setting.closeStart);
  if(setting.selfClosing||setting.children.length||!['true','false'].includes(content))throw Error('Unsupported stopped setting value or serialization');
  edits.push({start:setting.openEnd,end:setting.closeStart,value:stopped?'true':'false'});
 }
 let modified=xml;for(const e of edits.sort((a,b)=>b.start-a.start))modified=modified.slice(0,e.start)+e.value+modified.slice(e.end);
 const checked=cueGraph(modified,cueId).graph.nodes.filter(n=>n.id===nodeId);
 if(checked.length!==1||(hasAttr&&checked[0].stopped!==(stopped?'1':'0'))||(setting&&checked[0].settings.filter(s=>s.key==='node.stopped'&&s.value===(stopped?'true':'false')).length!==1))throw Error('Stopped state edit could not be verified');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,nodeId,stopped,note:'Changed explicit stopped state in an offline copy. ShowKontrol acceptance is unverified.'};
}

export async function editCueGraphSettingCopy({source,destination,format,sha256,name,cueId,nodeId,key,value}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(!/^[A-Za-z0-9_.:-]+$/.test(nodeId||'')||!/^[A-Za-z0-9_.:-]+$/.test(key||''))throw Error('Unsupported node ID or setting key');
 if(typeof cueId!=='string'||!cueId||typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value))throw Error('Invalid cue ID or setting value');
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=(readSnapshotPart({snapshot:show,name})).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const graph=cueGraph(xml,cueId).graph;if(!graph)throw Error('Cue has no action graph');
 const nodes=graph.nodes.filter(n=>n.id===nodeId);if(nodes.length!==1)throw Error('Node ID must occur exactly once in cue graph');
 if(nodes[0].settings.filter(s=>s.key===key).length!==1)throw Error('Setting must exist exactly once in selected node');
 if(key==='node.stopped'){
  if(!['true','false'].includes(value))throw Error('node.stopped value must be exactly true or false');
  const {stopped:_,...result}=await setCueGraphNodeStoppedCopy({source,destination,format,sha256,name,cueId,nodeId,stopped:value==='true'});
  return {...result,key,value,note:'Changed an existing cue graph setting in an offline copy. Value semantics and ShowKontrol acceptance are not validated.'};
 }
 const root=parseXmlSpans(xml),settings=selectXmlSpans(root,['sktimeline',{name:'cue',attributes:{id:cueId}},'graph',{name:'node',attributes:{id:nodeId}},'settings',{name:'setting',attributes:{key}}]);
 if(settings.length!==1)throw Error('Unsupported or ambiguous setting serialization');
 const setting=settings[0],encoded=value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const opening=xml.slice(setting.start,setting.openEnd);
 const replacement=setting.selfClosing?opening.replace(/\s*\/>$/,'>')+encoded+'</setting>':opening+encoded+xml.slice(setting.closeStart,setting.end);
 const modified=xml.slice(0,setting.start)+replacement+xml.slice(setting.end);
 const checked=cueGraph(modified,cueId).graph?.nodes.filter(n=>n.id===nodeId);
 if(checked?.length!==1||checked[0].settings.filter(s=>s.key===key&&s.value===value).length!==1)throw Error('Cue graph setting edit did not produce requested value');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,nodeId,key,value,note:'Changed an existing cue graph setting in an offline copy. Value semantics and ShowKontrol acceptance are not validated.'};
}

export async function copyCueGraphBetweenTimelines(args){
 return copyCueGraphBetweenTimelinesInternal(args,null);
}

// Internal composition helper: the caller supplies the destination show's snapshot.
export async function copyCueGraphBetweenTimelinesWithShow(args,targetShow){
 if(!targetShow||!Array.isArray(targetShow.parts)||!targetShow.parts.length||!targetShow.parts.every(p=>p&&p.valid===true&&Buffer.isBuffer(p.bytes)&&typeof p.md5==='string'&&/^[a-fA-F0-9]{32}$/.test(p.md5)&&createHash('md5').update(p.bytes).digest('hex')===p.md5.toLowerCase()))throw Error('A validated destination show snapshot is required');
 return copyCueGraphBetweenTimelinesInternal(args,targetShow);
}

async function copyCueGraphBetweenTimelinesInternal({source,destination,sha256,template,templateSha256,sourceCueId,targetCueId,allowOpaqueNodeText},targetShow){
 const [target,donor]=await Promise.all([inspectXml({file:source}),inspectXml({file:template})]);
 if(target.sha256!==sha256)throw Error('Source changed since inspection');if(donor.sha256!==templateSha256)throw Error('Template changed since inspection');
 const src=cueGraph(donor.xml,sourceCueId),dst=cueGraph(target.xml,targetCueId);if(!src.graph||!src.graph.nodes.length)throw Error('Source cue has no graph');if(dst.graph)throw Error('Target cue already has a graph');
 const ids=src.graph.nodes.map(n=>n.id);if(ids.some(id=>!/^n\d+$/.test(id))||new Set(ids).size!==ids.length)throw Error('Graph has unsupported or duplicate node IDs');
 if(src.graph.nodes.some(n=>!supportedCueCopyNode(n)))throw Error('Graph contains node types not present in the verified fixture');
 if(src.graph.connections.some(c=>!ids.includes(c.fromNode)||!ids.includes(c.toNode)))throw Error('Graph has external or invalid connections');
 let max=0;for(const id of [...xmlNodeIds(target.xml),...ids])if(/^n\d+$/.test(id)){const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,n);}
 if(max+ids.length>1000000000)throw Error('No node IDs remain in the supported range');const idMap=Object.fromEntries(ids.map(id=>[id,`n${++max}`]));
 const donorRoot=parseXmlSpans(donor.xml),targetRoot=parseXmlSpans(target.xml);
 const graphs=selectXmlSpans(donorRoot,['sktimeline',{name:'cue',attributes:{id:sourceCueId}},'graph']);if(graphs.length!==1||graphs[0].selfClosing)throw Error('Unsupported source graph serialization');
 const cues=selectXmlSpans(targetRoot,['sktimeline',{name:'cue',attributes:{id:targetCueId}}]);if(cues.length!==1)throw Error('Target cue must occur exactly once');
 const opaque=validateGraphReferences(donor.xml,graphs[0],targetShow,allowOpaqueNodeText);
 const graph=remapCueGraph(donor.xml,graphs[0],idMap);
 const modified=insertCueGraph(target.xml,cues[0],graph);
 const expected={nodes:src.graph.nodes.map(node=>({...node,id:idMap[node.id]})),connections:src.graph.connections.map(c=>({...c,fromNode:idMap[c.fromNode],toNode:idMap[c.toNode]}))};
 if(JSON.stringify(cueGraph(modified,targetCueId).graph)!==JSON.stringify(expected))throw Error('Copied graph did not match selected source and target cues');
 const warnings=[...storedStoppedWarnings(modified,destination).filter(w=>w.scope.cueId===targetCueId&&Object.values(idMap).includes(w.scope.nodeId)),...opaqueNodeWarnings(opaque,destination,targetCueId,idMap)];
 const result=await editXmlCopy({source,destination,sha256,edits:[{find:target.xml,replace:modified}]});return {...result,sourceCueId,targetCueId,idMap,warnings,note:'Copied a fixture-supported cue graph into an offline timeline copy. Node IDs are checked within this timeline only; validate in ShowKontrol before combining with a show.'+(src.graph.nodes.some(n=>['processor','generator'].includes(n.type))?' '+cuePrototypeNote:'')};
}

export async function removeCueGraphCopy({source,destination,format,sha256,name,cueId}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(typeof cueId!=='string'||!cueId)throw Error('Cue ID is required');
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const before=cueGraph(xml,cueId);if(!before.graph)throw Error('Cue has no action graph');
 const root=parseXmlSpans(xml),cues=selectXmlSpans(root,['sktimeline',{name:'cue',attributes:{id:cueId}}]),graphs=selectXmlSpans(root,['sktimeline',{name:'cue',attributes:{id:cueId}},'graph']);
 if(cues.length!==1||graphs.length!==1)throw Error('Cue and graph must each occur exactly once');
 const graph=graphs[0];
 const checkStructure=(element,parent)=>{
  if(element!==graph&&(element.name==='graph'||(element.name==='node'&&parent!==graph)))throw Error('Nested graph or node structure is unsupported');
  for(const child of element.children)checkStructure(child,element);
 };
 checkStructure(graph,null);
 const modified=xml.slice(0,graph.start)+xml.slice(graph.end),after=cueGraph(modified,cueId);
 if(after.graph!==null)throw Error('Cue graph removal could not be verified');
 const beforeCue=parseTimeline(xml).cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId),afterCue=parseTimeline(modified).cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId);
 if(beforeCue.length!==1||afterCue.length!==1||JSON.stringify(beforeCue[0])!==JSON.stringify(afterCue[0]))throw Error('Cue attributes changed unexpectedly');
 const ids=before.graph.nodes.map(node=>node.id);
 if(ids.length>1000||ids.some(id=>typeof id!=='string'||!id||id.length>1024))throw Error('Graph node ID exceeds reference scan limits or is missing');
 if(ids.length){
  const alternatives=[...new Set(ids)].sort((a,b)=>b.length-a.length).map(id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  if(hasXmlReference(modified,new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`)))throw Error('Graph node has surviving XML references');
 }
 if(format==='skshow'){
  const scan=await scanCueReferences({file:source,name,cueId,sha256});
  if(scan.diagnosticsTruncated||scan.diagnostics.some(d=>/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(d.part)))throw Error('A supported XML part could not be scanned for references');
  if(scan.referencesTruncated)throw Error('Reference scan results were truncated');
  if(scan.references.some(ref=>ref.type==='node'))throw Error('Graph node has surviving XML references');
 }
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,removedNodeCount:before.graph.nodes.length,removedConnectionCount:before.graph.connections.length,note:'Removed a cue action graph from an offline copy. Cue attributes were preserved; external references and ShowKontrol acceptance are not validated.'};
}

// Only settings and node types seen together in the app-saved cue graph are supported.
export async function addCueGraphSettingCopy({source,destination,format,sha256,name,cueId,nodeId,key,value}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(typeof cueId!=='string'||!cueId||!/^[A-Za-z0-9_.:-]+$/.test(nodeId||'')||typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value))throw Error('Invalid cue ID, node ID or setting value');
 let xml,actual;if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const graph=cueGraph(xml,cueId).graph;if(!graph)throw Error('Cue has no action graph');const nodes=graph.nodes.filter(n=>n.id===nodeId);if(nodes.length!==1)throw Error('Node ID must occur exactly once in cue graph');
 const node=nodes[0],allowed={trigger:['trigger.path','trigger.on'],action:['action.category']};if(!Object.hasOwn(allowed,node.type)||!allowed[node.type].includes(key))throw Error('Setting and node type are not supported by the fixture');
 if(node.settings.some(s=>s.key===key))throw Error('Setting already exists');
 const root=parseXmlSpans(xml),settings=selectXmlSpans(root,['sktimeline',{name:'cue',attributes:{id:cueId}},'graph',{name:'node',attributes:{id:nodeId}},'settings']);if(settings.length!==1)throw Error('Node settings element must occur exactly once');
 const scope=settings[0],encoded=value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\r','&#xD;'),entry=`<setting key="${key}">${encoded}</setting>`;
 let modified;if(scope.selfClosing){const open=xml.slice(scope.start,scope.openEnd).replace(/\s*\/>$/,'>');modified=xml.slice(0,scope.start)+open+entry+'</settings>'+xml.slice(scope.end);}else modified=xml.slice(0,scope.closeStart)+entry+xml.slice(scope.closeStart);
 const checked=cueGraph(modified,cueId).graph?.nodes.filter(n=>n.id===nodeId);if(checked?.length!==1||checked[0].settings.filter(s=>s.key===key&&s.value===value).length!==1)throw Error('Cue graph setting could not be preserved in XML');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,nodeId,key,value,note:'Added a fixture-supported setting to an offline cue graph. Values and ShowKontrol acceptance are not validated.'};
}

// Edit only existing attributes on a direct audio clip. Text fields follow the add-clip limits.
export async function editTimelineAudioClipCopy({source,destination,format,sha256,name,audioIndex,clipIndex,attributes}) {
 const allowed=['name','file','wave','grid','pps','offsetMs','vol','trimStartMs','trimEndMs','fadeInMs','fadeOutMs'];
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(!Number.isSafeInteger(audioIndex)||audioIndex<0||!Number.isSafeInteger(clipIndex)||clipIndex<0)throw Error('Audio and clip indices must be non-negative integers');
 if(!attributes||typeof attributes!=='object'||Array.isArray(attributes)||!Object.keys(attributes).length||Object.entries(attributes).some(([key,value])=>!allowed.includes(key)||typeof value!=='string'))throw Error('Provide supported attributes as strings');
 for(const key of ['name','file','wave','grid'])if(Object.hasOwn(attributes,key)&&(attributes[key].length>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(attributes[key])))throw Error(`Clip ${key} must be at most 4096 characters without control characters`);
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 parseTimeline(xml);
 const root=parseXmlSpans(xml),lanes=root.children.filter(n=>n.name==='audio');
 const clip=lanes[audioIndex]?.children.filter(n=>n.name==='clip')[clipIndex];
 if(!clip)throw Error('Audio clip index is outside the existing direct clips');
 // The meaning of wave and grid is unverified; they may describe the previous media.
 if(Object.hasOwn(attributes,'file')&&attributes.file!==clip.attributes.file)for(const key of ['wave','grid'])if(clip.attributes[key]&&!Object.hasOwn(attributes,key))throw Error(`Changing the clip file requires an explicit ${key} value because the existing nonempty ${key} may describe the previous media`);
 const opening=xml.slice(clip.start,clip.openEnd),replacements=[];
 const attr=/\s+([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/y;let pos='<clip'.length;
 while(pos<opening.length){
  if(/^\s*\/?>$/.test(opening.slice(pos)))break;
  attr.lastIndex=pos;const m=attr.exec(opening);if(!m)throw Error('Unsupported clip attribute serialization');
  if(Object.hasOwn(attributes,m[1])){
   const start=pos+m[0].indexOf(m[2])+1;
   replacements.push({key:m[1],start,end:start+m[3].length,value:xmlAttr(attributes[m[1]]).replaceAll("'",'&apos;')});
  }
  pos=attr.lastIndex;
 }
 for(const key of Object.keys(attributes))if(replacements.filter(r=>r.key===key).length!==1)throw Error(`Clip attribute ${key} must exist exactly once`);
 let changed=opening;for(const r of replacements.reverse())changed=changed.slice(0,r.start)+r.value+changed.slice(r.end);
 const modified=xml.slice(0,clip.start)+changed+xml.slice(clip.openEnd);
 const checked=parseXmlSpans(modified).children.filter(n=>n.name==='audio')[audioIndex]?.children.filter(n=>n.name==='clip')[clipIndex];
 if(!checked||Object.entries(attributes).some(([key,value])=>checked.attributes[key]!==value))throw Error('Clip edit did not preserve requested values');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};
 const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 const previous=Object.fromEntries(Object.keys(attributes).map(key=>[key,clip.attributes[key]]));
 return {...result,audioIndex,clipIndex,attributes,previous,note:`Changed existing audio clip attributes in an offline copy.${Object.hasOwn(attributes,'file')?' The new file is not opened; media format, duration against the trims, waveform caches and media.map rows are not checked.':''} Value meanings and ShowKontrol acceptance are not validated.`};
}

// Add a clip shaped like the R27 imported-WAV fixture to an existing lane.
export async function addTimelineAudioClipCopy({source,destination,format,sha256,name,audioIndex,clip}) {
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(!Number.isSafeInteger(audioIndex)||audioIndex<0)throw Error('Audio index must be a non-negative integer');
 if(!clip||typeof clip!=='object'||Array.isArray(clip))throw Error('Clip is required');
 const keys=['name','file','wave','grid','pps','offsetMs','trimStartMs','trimEndMs','fadeInMs','fadeOutMs'];
 if(Object.keys(clip).some(k=>!keys.includes(k))||keys.some(k=>typeof clip[k]!=='string'||clip[k].length>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(clip[k])))throw Error('Provide all supported clip fields as strings without control characters');
 if(!clip.name||!clip.file)throw Error('Clip name and file are required');
 for(const k of ['pps','offsetMs','trimStartMs','trimEndMs','fadeInMs','fadeOutMs'])if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(clip[k])||!Number.isFinite(Number(clip[k])))throw Error(`Invalid non-negative numeric clip field: ${k}`);
 if(Number(clip.trimEndMs)<=Number(clip.trimStartMs))throw Error('trimEndMs must exceed trimStartMs');
 const duration=Number(clip.trimEndMs)-Number(clip.trimStartMs);if(Number(clip.fadeInMs)>duration||Number(clip.fadeOutMs)>duration)throw Error('Fade exceeds clip duration');
 let xml,actual;
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');parseTimeline(xml);
 const lane=parseXmlSpans(xml).children.filter(n=>n.name==='audio')[audioIndex];if(!lane)throw Error('Audio lane does not exist');
 const entry='<clip '+keys.map(k=>`${k}="${xmlAttr(clip[k])}"`).join(' ')+'/>';
 let modified;if(lane.selfClosing){const open=xml.slice(lane.start,lane.openEnd).replace(/\s*\/>$/,'>');modified=xml.slice(0,lane.start)+open+entry+'</audio>'+xml.slice(lane.end);}else modified=xml.slice(0,lane.closeStart)+entry+xml.slice(lane.closeStart);
 const parsed=parseTimeline(modified),matching=parsed.audioClips.filter(c=>c.audioIndex===audioIndex);if(!matching.length||keys.some(k=>matching.at(-1).attributes[k]!==clip[k]))throw Error('Clip could not be preserved');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,audioIndex,clipIndex:matching.length-1,note:'Added an offline clip using an observed imported-WAV structure. Media files and waveform caches are not copied or generated. App acceptance and playback are unverified.'};
}

// Insert an empty audio lane using the app-saved R27 lane shape.
export async function addTimelineAudioLaneCopy({source,destination,format,sha256,name,laneName,follow}) {
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(typeof laneName!=='string'||!laneName.trim()||laneName.length>4096||/[\x00-\x1f\ufffe\uffff]/u.test(laneName))throw Error('Lane name must be a nonempty single-line string');
 if(typeof follow!=='boolean')throw Error('follow must be a boolean');
 let xml,actual;if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');const parsed=parseTimeline(xml),root=parseXmlSpans(xml);
 const lanes=root.children.filter(n=>n.name==='audio');if(lanes.some(n=>n.attributes.name===laneName))throw Error('Audio lane name already exists');
 const decks=root.children.filter(n=>n.name==='deck');if(decks.length!==1)throw Error('Expected exactly one direct deck element for audio lane insertion');
 if(lanes.some(n=>n.start>decks[0].start))throw Error('Audio lane order is unsupported');
 const entry=`<audio name="${xmlAttr(laneName)}" follow="${follow?'1':'0'}"/>`,pos=decks[0].start,modified=xml.slice(0,pos)+entry+xml.slice(pos);
 const verified=parseTimeline(modified);if(verified.audio.length!==parsed.audio.length+1||verified.audio.at(-1)?.name!==laneName)throw Error('Audio lane could not be preserved');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,audioIndex:lanes.length,laneName,follow,note:'Added an offline lane using an app-saved structure. App acceptance and follow behavior are unverified.'};
}

// Read one timeline and, for a show, the other XML parts that may hold references (set lists name tracks and sets only).
async function readTimelineSource({source,format,sha256,name,withParts=false}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 let xml,actual,parts=[];
 if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
  if(withParts)parts=show.parts.filter(p=>p.name!==name&&/\.(?:skf|sktl|sksc|skpr|skcp)$/i.test(p.name)).map(p=>({name:p.name,xml:readSnapshotPart({snapshot:show,name:p.name}).text}));
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 parseTimeline(xml);return {xml,parts};
}
const writeTimelineEdit=({format,source,destination,sha256,name,xml,modified})=>{const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};return format==='skshow'?editShowPart({...args,name}):editXmlCopy(args);};
const descendantsOf=node=>[node,...node.children.flatMap(descendantsOf)];
// Observed clips and lanes carry no IDs. An id would allow references that cannot be checked here.
const hasIdentity=node=>descendantsOf(node).some(n=>Object.hasOwn(n.attributes,'id'));
const directClips=(root,audioIndex)=>root.children.filter(n=>n.name==='audio')[audioIndex]?.children.filter(n=>n.name==='clip');
const clipList=xml=>parseTimeline(xml).audioClips.map(c=>JSON.stringify([c.audioIndex,c.attributes]));

// Remove one direct audio clip element. Every other byte is unchanged.
export async function removeTimelineAudioClipCopy({source,destination,format,sha256,name,audioIndex,clipIndex}) {
 if(!Number.isSafeInteger(audioIndex)||audioIndex<0||!Number.isSafeInteger(clipIndex)||clipIndex<0)throw Error('Audio and clip indices must be non-negative integers');
 const {xml}=await readTimelineSource({source,format,sha256,name});
 const clip=directClips(parseXmlSpans(xml),audioIndex)?.[clipIndex];
 if(!clip)throw Error('Audio clip index is outside the existing direct clips');
 if(hasIdentity(clip))throw Error('Clip carries an id attribute; references to it cannot be checked');
 const modified=xml.slice(0,clip.start)+xml.slice(clip.end);
 const before=clipList(xml),after=clipList(modified),flat=parseTimeline(xml).audioClips.findIndex(c=>c.audioIndex===audioIndex)+clipIndex;
 before.splice(flat,1);if(after.join('\n')!==before.join('\n'))throw Error('Clip removal did not preserve the other clips');
 const result=await writeTimelineEdit({format,source,destination,sha256,name,xml,modified});
 return {...result,audioIndex,clipIndex,removed:clip.attributes,remainingClips:directClips(parseXmlSpans(modified),audioIndex).length,note:'Removed one audio clip in an offline copy. Later clips in the lane move down one index. Media files and media.map rows are unchanged. ShowKontrol acceptance is unverified.'};
}

// A lane name equal to an attribute value or element text elsewhere may be a reference.
// Track, lane and clip names are definitions, not references.
function laneNameReference(xml,laneName){
 const parser=new SaxesParser(),stack=[];let found=false;
 parser.on('opentag',tag=>{
  stack.push({name:tag.name,text:''});const at=stack.map(n=>n.name).join('/');
  for(const [key,value] of Object.entries(tag.attributes)){
   if(key==='name'&&(tag.name==='sktimeline'||/(?:^|\/)sktimeline\/audio(?:\/clip)?$/.test(at)))continue;
   if(value===laneName)found=true;
  }
 });
 parser.on('text',text=>{if(stack.length)stack.at(-1).text+=text;});parser.on('cdata',text=>{if(stack.length)stack.at(-1).text+=text;});
 parser.on('closetag',()=>{if(stack.pop().text===laneName)found=true;});
 parser.write(xml).close();return found;
}

// Remove one direct audio lane. Clips go only with removeClips; any other lane content is rejected.
export async function removeTimelineAudioLaneCopy({source,destination,format,sha256,name,audioIndex,removeClips=false}) {
 if(!Number.isSafeInteger(audioIndex)||audioIndex<0)throw Error('Audio index must be a non-negative integer');
 if(typeof removeClips!=='boolean')throw Error('removeClips must be a boolean');
 const {xml,parts}=await readTimelineSource({source,format,sha256,name,withParts:true});
 const lane=parseXmlSpans(xml).children.filter(n=>n.name==='audio')[audioIndex];
 if(!lane)throw Error('Audio lane does not exist');
 if(lane.children.some(n=>n.name!=='clip'))throw Error('Audio lane contains unsupported content');
 if(!lane.selfClosing){let cursor=lane.openEnd;for(const child of [...lane.children,{start:lane.closeStart,end:lane.closeStart}]){if(xml.slice(cursor,child.start).trim())throw Error('Audio lane contains unsupported text');cursor=child.end;}}
 if(lane.children.length&&!removeClips)throw Error('Audio lane contains clips; set removeClips to true');
 if(hasIdentity(lane))throw Error('Audio lane or clip carries an id attribute; references to it cannot be checked');
 const modified=xml.slice(0,lane.start)+xml.slice(lane.end),laneName=lane.attributes.name;
 if(laneName)for(const item of [{name:format==='skshow'?name:source,xml:modified},...parts])if(laneNameReference(item.xml,laneName))throw Error(`Audio lane name ${JSON.stringify(laneName)} appears literally in ${item.name}; it may be a reference`);
 const before=parseTimeline(xml),after=parseTimeline(modified);
 const expected=before.audioClips.filter(c=>c.audioIndex!==audioIndex).map(c=>JSON.stringify([c.audioIndex>audioIndex?c.audioIndex-1:c.audioIndex,c.attributes]));
 const lanesExpected=before.audio.filter((_,i)=>i!==audioIndex).map(a=>JSON.stringify(a));
 if(after.audio.map(a=>JSON.stringify(a)).join('\n')!==lanesExpected.join('\n')||clipList(modified).join('\n')!==expected.join('\n'))throw Error('Lane removal did not preserve the other lanes');
 const result=await writeTimelineEdit({format,source,destination,sha256,name,xml,modified});
 return {...result,audioIndex,removed:lane.attributes,removedClips:lane.children.map(c=>c.attributes),note:'Removed one audio lane in an offline copy. Later lanes move down one index; whether anything refers to lanes by position is unknown. Literal name references in supported XML were checked. Media files and media.map rows are unchanged. ShowKontrol acceptance is unverified.'};
}
