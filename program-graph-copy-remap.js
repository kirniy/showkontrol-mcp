import {maskOpaqueNodeText,opaqueNodeWarnings} from './opaque-node-text.js';
import {writeFile,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';
import {inspectProgram,inspectProgramBytes} from './program.js';
import {parseTimeline} from './timeline.js';
import {SaxesParser} from 'saxes';
import {programGraphWarnings} from './program-graph-warnings.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const idPattern=/(^|[^A-Za-z0-9_])n\d+([^A-Za-z0-9_]|$)/;
const walk=(n,fn)=>{fn(n);for(const c of n.children)walk(c,fn);};
function number(id){if(!/^n(?:0|[1-9]\d*)$/.test(id||''))throw Error('Unsupported node ID');const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');return n;}
function attribute(xml,node,key){const opening=xml.slice(node.start,node.openEnd),re=/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g,matches=[...opening.matchAll(re)].filter(m=>m[1]===key);if(matches.length!==1)throw Error('Unsupported attribute serialization');const m=matches[0],start=node.start+m.index+m[0].indexOf(m[2])+1;if(xml.slice(start,start+m[2].length-2)!==node.attributes[key])throw Error('Encoded node references are unsupported');return {start,end:start+m[2].length-2};}
async function donorSnapshot(donor,donorName){
 if(!path.isAbsolute(donor))throw Error('Donor must be an absolute path');let xml,sha256;
 if(path.extname(donor).toLowerCase()==='.sktl'){if(donorName!==undefined)throw Error('Donor part name is only supported for a show');({xml,sha256}=await inspectXml({file:donor}));}
 else if(path.extname(donor).toLowerCase()==='.skshow'){if(typeof donorName!=='string'||!donorName.toLowerCase().endsWith('.sktl'))throw Error('A .sktl donor part name is required');const show=await readShowSnapshot({file:donor});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');const names=new Set();for(const p of show.parts){const name=p.name.toLowerCase();if(names.has(name))throw Error('Duplicate part name');names.add(name);}sha256=show.sha256;xml=readSnapshotPart({snapshot:show,name:donorName}).text;}
 else throw Error('Donor must be a .sktl or .skshow file');parseTimeline(xml);return {xml,sha256,root:parseXmlSpans(xml)};
}
function validateGraph(element){
 const parser=new SaxesParser(),stack=[],ids=new Set(),connections=[];let settingsSeen=false,keys;
 parser.on('doctype',()=>{throw Error('DOCTYPE is not supported');});
 parser.on('opentag',tag=>{const parent=stack.at(-1);stack.push(tag.name);const d=stack.length;
  if(d===1){if(tag.name!=='graph')throw Error('Expected graph');}
  else if(d===2&&parent==='graph'&&tag.name==='node'){if(!tag.attributes.id||!tag.attributes.type||ids.has(tag.attributes.id))throw Error('Graph node ID and type must be present and node IDs unique');ids.add(tag.attributes.id);settingsSeen=false;keys=new Set();}
  else if(d===2&&parent==='graph'&&tag.name==='connection'){if(!tag.attributes.fromNode||!tag.attributes.toNode)throw Error('Connection endpoints are required');connections.push(tag.attributes);}
  else if(d===3&&parent==='node'&&tag.name==='settings'){if(settingsSeen)throw Error('Multiple node settings elements');settingsSeen=true;}
  else if(d===4&&parent==='settings'&&tag.name==='setting'){if(Object.keys(tag.attributes).join(',')!=='key'||!tag.attributes.key||keys.has(tag.attributes.key))throw Error('Setting keys must be present and unique');keys.add(tag.attributes.key);}
  else throw Error('Unsupported graph structure');});
 const content=s=>{if(stack.at(-1)!=='setting'&&s.trim())throw Error('Unsupported graph text');};parser.on('text',content);parser.on('cdata',content);parser.on('closetag',()=>stack.pop());parser.write(element).close();
 if(connections.some(c=>!ids.has(c.fromNode)||!ids.has(c.toNode)))throw Error('Connection refers to an unknown node');
}
export async function copyProgramItemGraphRemappedCopy({source,destination,sha256,index,donor,donorSha256,donorName,donorCueId,target,targetSha256,replaceExisting=false,allowOpaqueNodeText}){
 if(allowOpaqueNodeText!==undefined&&typeof allowOpaqueNodeText!=='boolean')throw Error('allowOpaqueNodeText must be a boolean');
 if(typeof source!=='string'||typeof donor!=='string'||typeof target!=='string'||!path.isAbsolute(source)||path.extname(source).toLowerCase()!=='.skpr'||!path.isAbsolute(target)||path.extname(target).toLowerCase()!=='.skshow'||!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr'||[source,donor,target].some(p=>path.resolve(p)===path.resolve(destination)))throw Error('Absolute source .skpr, target .skshow and distinct destination .skpr paths are required');
 if(![sha256,donorSha256,targetSha256].every(h=>/^[a-f0-9]{64}$/.test(h||'')))throw Error('Source, donor and target SHA-256 values are required');if(typeof replaceExisting!=='boolean')throw Error('replaceExisting must be a boolean');if(typeof donorCueId!=='string'||!donorCueId)throw Error('Donor cue ID is required');
 const [program,inspection,timeline,show]=await Promise.all([inspectXml({file:source}),inspectProgram({file:source}),donorSnapshot(donor,donorName),readShowSnapshot({file:target})]);
 if(program.sha256!==sha256||inspection.sha256!==sha256)throw Error('Source changed since inspection');if(timeline.sha256!==donorSha256)throw Error('Donor changed since inspection');if(show.sha256!==targetSha256)throw Error('Target changed since inspection');if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 if(!Number.isInteger(index)||index<0||index>=inspection.items.length)throw Error('Item index out of range');const root=parseXmlSpans(program.xml),item=root.children[index],existing=item.children.find(c=>c.name==='graph');if(existing&&!replaceExisting)throw Error('Item already has a graph; set replaceExisting to true');
 if(existing){const outside=program.xml.slice(0,existing.start)+program.xml.slice(existing.end);const targetParts=show.parts.filter(p=>/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name)&&p.name!=='content/Program.skpr').map(p=>readSnapshotPart({snapshot:show,name:p.name}).text);for(const n of existing.children.filter(c=>c.name==='node')){const id=n.attributes.id;if(!id)throw Error('Existing graph has unsupported node ID');const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);if(hasXmlReference(outside,pattern)||targetParts.some(xml=>hasXmlReference(xml,pattern)))throw Error('Existing graph node ID is referenced outside the graph');}}
 const cues=timeline.root.children.filter(c=>c.name==='cue'&&c.attributes.id===donorCueId);if(cues.length!==1)throw Error('Donor cue must match exactly one direct cue');const graphs=cues[0].children.filter(c=>c.name==='graph');if(graphs.length!==1)throw Error('Donor cue must contain exactly one direct graph');const graph=graphs[0],element=timeline.xml.slice(graph.start,graph.end);validateGraph(element);
 const nodes=graph.children.filter(c=>c.name==='node'),connections=graph.children.filter(c=>c.name==='connection');if(!nodes.length)throw Error('Graph has no nodes');let max=0;const scan=r=>walk(r,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||''))max=Math.max(max,number(n.attributes.id));});scan(root);for(const part of show.parts.filter(p=>/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name)))scan(parseXmlSpans(readSnapshotPart({snapshot:show,name:part.name}).text));
 const mapping={};for(const n of nodes){number(n.attributes.id);if(max>=1000000000)throw Error('No node IDs remain in the supported range');mapping[n.attributes.id]=`n${++max}`;}
 const edits=[];for(const n of nodes)edits.push({...attribute(timeline.xml,n,'id'),value:mapping[n.attributes.id]});for(const c of connections)for(const key of ['fromNode','toNode'])edits.push({...attribute(timeline.xml,c,key),value:mapping[c.attributes[key]]});
 const opaque=[];let sanitized=element,remapped=element;for(const n of nodes){const masked=maskOpaqueNodeText(timeline.xml,n,allowOpaqueNodeText);opaque.push({nodeId:n.attributes.id,keys:masked.keys});sanitized=sanitized.slice(0,n.start-graph.start)+masked.masked+sanitized.slice(n.end-graph.start);}for(const e of edits.sort((a,b)=>b.start-a.start)){const a=e.start-graph.start,b=e.end-graph.start;sanitized=sanitized.slice(0,a)+'REMAPPED'+sanitized.slice(b);remapped=remapped.slice(0,a)+e.value+remapped.slice(b);}if(hasXmlReference(sanitized,idPattern))throw Error('Graph contains unsupported internal references');
 let xml=program.xml;if(existing)xml=xml.slice(0,existing.start)+remapped+xml.slice(existing.end);else if(item.selfClosing)xml=xml.slice(0,item.start)+xml.slice(item.start,item.openEnd).replace(/\/\s*>$/, '>')+remapped+'</item>'+xml.slice(item.end);else xml=xml.slice(0,item.closeStart)+remapped+xml.slice(item.closeStart);
 const bytes=Buffer.from(xml),outputHash=hash(bytes);const result=inspectProgramBytes(bytes);const temp=path.join(path.dirname(destination),`.showkontrol-graph-${randomUUID()}.skpr`);let created=false,graphWarnings;try{await writeFile(temp,bytes,{flag:'wx'});created=true;const [p,d,t,w]=await Promise.all([inspectProgram({file:source}),donorSnapshot(donor,donorName),readShowSnapshot({file:target}),programGraphWarnings(temp,outputHash,index)]);graphWarnings=w;if(p.sha256!==sha256||d.sha256!==donorSha256||t.sha256!==targetSha256)throw Error('Source, donor or target changed since inspection');await link(temp,destination);}finally{if(created)await unlink(temp);}
 return {destination,sha256:outputHash,index,mapping,items:result.items,warnings:['Inspect trigger settings and dependencies; settings and media were not changed.','Static ID remapping only; runtime semantics and ShowKontrol acceptance are unverified.',...graphWarnings,...opaqueNodeWarnings(opaque,destination,undefined,mapping).map(w=>({...w,scope:{part:destination,itemIndex:index,nodeId:w.scope.nodeId,key:w.scope.key}}))]};
}
