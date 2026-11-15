import {SaxesParser} from 'saxes';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart,addShowPart} from './xml-copy.js';
import {randomInt} from 'node:crypto';
function parseTimeline(xml) {
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
 return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
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
 const at=closings[0].index;return {id,modified:xml.slice(0,at)+cue+xml.slice(at)};
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
function regexEscape(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
export async function copyCueGraphInShow({source,destination,sha256,name,sourceCueId,targetCueId}){
 if(sourceCueId===targetCueId)throw Error('Select two different cues');
 if(!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const part=readSnapshotPart({snapshot:show,name});const xml=part.text;
 const src=cueGraph(xml,sourceCueId),target=cueGraph(xml,targetCueId);
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
 if(max+ids.length>1000000000)throw Error('No node IDs remain in the supported range');
 const idMap=Object.fromEntries(ids.map(id=>[id,`n${++max}`]));
 const srcRe=new RegExp('<cue\\b(?=[^>]*\\sid=["\\\']'+regexEscape(sourceCueId)+'["\\\'])[^>]*>([\\s\\S]*?)<\\/cue\\s*>','g');
 const sm=[...xml.matchAll(srcRe)];if(sm.length!==1)throw Error('Unsupported source cue serialization');
 const gm=[...sm[0][1].matchAll(/<graph(?:\s[^>]*)?>[\s\S]*?<\/graph\s*>/g)];if(gm.length!==1)throw Error('Unsupported graph serialization');
 let graph=gm[0][0];
 for(const [oldId,newId] of Object.entries(idMap)){
  const re=new RegExp('((?:\\sid|\\sfromNode|\\stoNode)=["\\\'])'+regexEscape(oldId)+'(["\\\'])','g');graph=graph.replace(re,(_,a,b)=>a+newId+b);
 }
 for(const oldId of ids)if(new RegExp('(^|[^A-Za-z0-9_])'+regexEscape(oldId)+'([^A-Za-z0-9_]|$)').test(graph))throw Error('Graph contains node references outside supported attributes');
 const targetRe=new RegExp('<cue\\b(?=[^>]*\\sid=["\\\']'+regexEscape(targetCueId)+'["\\\'])[^>]*/>','g');
 const tm=[...xml.matchAll(targetRe)];if(tm.length!==1)throw Error('Target cue must use the simple self-closing form');
 const open=tm[0][0].replace(/\s*\/>$/,'>');const changed=xml.slice(0,tm[0].index)+open+graph+'</cue>'+xml.slice(tm[0].index+tm[0][0].length);
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:changed}]});
 return {...result,sourceCueId,targetCueId,idMap,note:'Copied a fixture-supported cue graph into an offline show copy; validate the result in ShowKontrol.'};
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
 const openingRe=/<cue\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
 const openings=[...xml.matchAll(openingRe)].filter(m=>{
  let attrs;const p=new SaxesParser();p.on('opentag',t=>attrs=t.attributes);p.write(m[0].replace(/\s*\/?>$/,'/>')).close();return attrs.id===cueId;
 });
 if(openings.length!==1)throw Error('Cannot uniquely locate cue serialization');
 const match=openings[0];let changed=match[0];
 for(const [key,value] of Object.entries(updates))if(value!==undefined){
  const re=new RegExp('(\\s'+key+'\\s*=\\s*)(["\'])(.*?)\\2','g');
  if([...changed.matchAll(re)].length!==1)throw Error(`Cue field ${key} must exist exactly once`);
  changed=changed.replace(re,(_,prefix,quote)=>prefix+quote+xmlAttr(String(value)).replaceAll("'",'&apos;')+quote);
 }
 const modified=xml.slice(0,match.index)+changed+xml.slice(match.index+match[0].length);parseTimeline(modified);
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
 const roots=[...template.matchAll(/<sktimeline\b[^>]*>/g)];if(roots.length!==1)throw Error('Unsupported timeline serialization');
 const root=roots[0][0], re=/(\sname\s*=\s*)(["'])(.*?)\2/g;if([...root.matchAll(re)].length!==1)throw Error('Timeline name must exist exactly once');
 const changed=root.replace(re,(_,prefix,quote)=>prefix+quote+xmlAttr(trackName)+quote);
 const text=template.slice(0,roots[0].index)+changed+template.slice(roots[0].index+root.length);parseTimeline(text);
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
 const cueMatches=[...xml.matchAll(/<cue\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/cue\s*>)/g)].filter(m=>{
  let attrs;const p=new SaxesParser();p.on('opentag',t=>{if(!attrs)attrs=t.attributes});p.write(m[0]).close();return attrs.id===cueId;
 });
 if(cueMatches.length!==1)throw Error('Unsupported or ambiguous cue serialization');
 const cue=cueMatches[0];
 const nodeMatches=[...cue[0].matchAll(/<node\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/node\s*>/g)].filter(m=>{
  let attrs;const p=new SaxesParser();p.on('opentag',t=>{if(!attrs)attrs=t.attributes});p.write(m[0]).close();return attrs.id===nodeId;
 });
 if(nodeMatches.length!==1)throw Error('Unsupported or ambiguous node serialization');
 const node=nodeMatches[0];
 const settings=[...node[0].matchAll(/(<setting\b(?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([^<]*)<\/setting\s*>)/g)].filter(m=>{
  let attrs;const p=new SaxesParser();p.on('opentag',t=>{if(!attrs)attrs=t.attributes});p.write(m[0]).close();return attrs.key===key;
 });
 if(settings.length!==1)throw Error('Unsupported or ambiguous setting serialization');
 const setting=settings[0],encoded=value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const newNode=node[0].slice(0,setting.index)+setting[1]+ '>'+encoded+'</setting>'+node[0].slice(setting.index+setting[0].length);
 const newCue=cue[0].slice(0,node.index)+newNode+cue[0].slice(node.index+node[0].length);
 const modified=xml.slice(0,cue.index)+newCue+xml.slice(cue.index+cue[0].length);cueGraph(modified,cueId);
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,nodeId,key,value,note:'Changed an existing cue graph setting in an offline copy. Value semantics and ShowKontrol acceptance are not validated.'};
}
