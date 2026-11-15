import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
import {SaxesParser} from 'saxes';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart,addShowPart} from './xml-copy.js';
import {randomInt} from 'node:crypto';
export function parseTimeline(xml) {
 const parser=new SaxesParser();const stack=[];const result={attributes:{},layers:[],audio:[],cueElements:[]};
 parser.on('opentag',tag=>{
  const parent=stack.at(-1);stack.push(tag.name);
  if(stack.length===1){if(tag.name!=='sktimeline'||tag.attributes.version!=='1')throw Error('Expected a version 1 sktimeline');result.attributes={...tag.attributes};}
  if(tag.name==='layer'&&parent==='layers'&&stack.length===3)result.layers.push({...tag.attributes});
  if(tag.name==='audio'&&parent==='sktimeline'&&stack.length===2)result.audio.push({...tag.attributes});
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
export async function copyCueGraphInShow({source,destination,sha256,name,sourceName=name,sourceCueId,targetCueId,template,templateSha256}){
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
 if(nodes.some(n=>!['groupin','trigger','action'].includes(n.type)))throw Error('Graph contains node types not present in the verified fixture');
 if(src.graph.connections.some(c=>!ids.includes(c.fromNode)||!ids.includes(c.toNode)))throw Error('Graph has external or invalid connections');
 let max=0;
 for(const entry of show.parts.filter(p=>/\.(?:skf|sktl|sksc)$/i.test(p.name))){
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
 const graph=remapCueGraph(sourceXml,gm[0],idMap);
 const tm=selectXmlSpans(targetRoot,['sktimeline',{name:'cue',attributes:{id:targetCueId}}]);if(tm.length!==1)throw Error('Target cue must occur exactly once');
 const changed=insertCueGraph(xml,tm[0],graph);
 const expected={nodes:src.graph.nodes.map(node=>({...node,id:idMap[node.id]})),connections:src.graph.connections.map(connection=>({...connection,fromNode:idMap[connection.fromNode],toNode:idMap[connection.toNode]}))};
 if(JSON.stringify(cueGraph(changed,targetCueId).graph)!==JSON.stringify(expected))throw Error('Copied graph did not match the selected source and target cues');
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:changed}]});
 return {...result,sourceName,sourceCueId,targetCueId,idMap,note:'Copied a fixture-supported cue graph into an offline show copy; validate the result in ShowKontrol.'};
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

// New tracks use an empty app-saved timeline as a template.
export async function createShowTrackCopy({source,destination,sha256,templateName,trackName,partName}) {
 if(!/^[A-Za-z0-9 _-]+$/.test(trackName||'')||!trackName.trim())throw Error('Track name must use letters, digits, spaces, underscores or hyphens');
 if(!/^content\/[A-Za-z0-9_-]+\.sktl$/.test(partName||''))throw Error('Part name must be a content/ timeline filename with letters, digits, underscores or hyphens');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 if(!templateName||!templateName.toLowerCase().endsWith('.sktl'))throw Error('Select an empty timeline template');
 let template;
 for(const part of show.parts.filter(p=>p.name.toLowerCase().endsWith('.sktl'))){
  const xml=(readSnapshotPart({snapshot:show,name:part.name})).text, info=parseTimeline(xml);
  if(info.attributes.name?.toLowerCase()===trackName.toLowerCase())throw Error('Track name already exists');
  if(part.name===templateName){if(info.cueElements.length||info.attributes.media||info.attributes.mediaWave||info.attributes.mediaGrid||info.attributes.mediaStructS||info.attributes.mediaStructE||info.attributes.mediaStructL)throw Error('Template must be empty and have no media');template=xml;}
 }
 if(!template)throw Error('Timeline template was not found');
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
 const result=await addShowPart({source,destination,sha256,name:partName,text});
 return {...result,trackName,templateName,note:'Added an empty timeline part to an offline show copy. The set list is unchanged. Validate in ShowKontrol.'};
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
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};
 const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,deletedGraph:!!graph,note:'Deleted a cue from an offline copy. Validate in ShowKontrol.'};
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

export async function copyCueGraphBetweenTimelines({source,destination,sha256,template,templateSha256,sourceCueId,targetCueId}){
 const [target,donor]=await Promise.all([inspectXml({file:source}),inspectXml({file:template})]);
 if(target.sha256!==sha256)throw Error('Source changed since inspection');if(donor.sha256!==templateSha256)throw Error('Template changed since inspection');
 const src=cueGraph(donor.xml,sourceCueId),dst=cueGraph(target.xml,targetCueId);if(!src.graph||!src.graph.nodes.length)throw Error('Source cue has no graph');if(dst.graph)throw Error('Target cue already has a graph');
 const ids=src.graph.nodes.map(n=>n.id);if(ids.some(id=>!/^n\d+$/.test(id))||new Set(ids).size!==ids.length)throw Error('Graph has unsupported or duplicate node IDs');
 if(src.graph.nodes.some(n=>!['groupin','trigger','action'].includes(n.type)))throw Error('Graph contains node types not present in the verified fixture');
 if(src.graph.connections.some(c=>!ids.includes(c.fromNode)||!ids.includes(c.toNode)))throw Error('Graph has external or invalid connections');
 let max=0;for(const id of [...xmlNodeIds(target.xml),...ids])if(/^n\d+$/.test(id)){const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,n);}
 if(max+ids.length>1000000000)throw Error('No node IDs remain in the supported range');const idMap=Object.fromEntries(ids.map(id=>[id,`n${++max}`]));
 const donorRoot=parseXmlSpans(donor.xml),targetRoot=parseXmlSpans(target.xml);
 const graphs=selectXmlSpans(donorRoot,['sktimeline',{name:'cue',attributes:{id:sourceCueId}},'graph']);if(graphs.length!==1||graphs[0].selfClosing)throw Error('Unsupported source graph serialization');
 const cues=selectXmlSpans(targetRoot,['sktimeline',{name:'cue',attributes:{id:targetCueId}}]);if(cues.length!==1)throw Error('Target cue must occur exactly once');
 const graph=remapCueGraph(donor.xml,graphs[0],idMap);
 const modified=insertCueGraph(target.xml,cues[0],graph);
 const expected={nodes:src.graph.nodes.map(node=>({...node,id:idMap[node.id]})),connections:src.graph.connections.map(c=>({...c,fromNode:idMap[c.fromNode],toNode:idMap[c.toNode]}))};
 if(JSON.stringify(cueGraph(modified,targetCueId).graph)!==JSON.stringify(expected))throw Error('Copied graph did not match selected source and target cues');
 const result=await editXmlCopy({source,destination,sha256,edits:[{find:target.xml,replace:modified}]});return {...result,sourceCueId,targetCueId,idMap,note:'Copied a fixture-supported cue graph into an offline timeline copy. Node IDs are checked within this timeline only; validate in ShowKontrol before combining with a show.'};
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
 const graph=graphs[0],modified=xml.slice(0,graph.start)+xml.slice(graph.end),after=cueGraph(modified,cueId);
 if(after.graph!==null)throw Error('Cue graph removal could not be verified');
 const beforeCue=parseTimeline(xml).cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId),afterCue=parseTimeline(modified).cueElements.filter(c=>c.path==='sktimeline/cue'&&c.attributes.id===cueId);
 if(beforeCue.length!==1||afterCue.length!==1||JSON.stringify(beforeCue[0])!==JSON.stringify(afterCue[0]))throw Error('Cue attributes changed unexpectedly');
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
