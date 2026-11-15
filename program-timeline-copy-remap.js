import {writeFile,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import path from 'node:path';
import {inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';
import {inspectProgram,inspectProgramBytes} from './program.js';
import {parseTimeline} from './timeline.js';
import {SaxesParser} from 'saxes';

const hash=b=>createHash('sha256').update(b).digest('hex');
const nodeRef=/(^|[^A-Za-z0-9_])n\d+([^A-Za-z0-9_]|$)/;
const walk=(n,fn,parent=null)=>{fn(n,parent);for(const c of n.children)walk(c,fn,n);};
function number(id){if(!/^n(?:0|[1-9]\d*)$/.test(id||''))throw Error('Unsupported node ID');const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');return n;}
function attr(xml,node,key){const opening=xml.slice(node.start,node.openEnd),re=/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g,matches=[...opening.matchAll(re)].filter(m=>m[1]===key);if(matches.length!==1)throw Error('Unsupported attribute serialization');const m=matches[0],start=node.start+m.index+m[0].indexOf(m[2])+1;if(xml.slice(start,start+m[2].length-2)!==node.attributes[key])throw Error('Encoded node references are unsupported');return {start,end:start+m[2].length-2};}
function validShow(show){if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');const names=new Set();for(const p of show.parts){const name=p.name.toLowerCase();if(names.has(name))throw Error('Duplicate part name');names.add(name);}}
async function donorSnapshot(donor,donorName){
 let xml,sha256,otherXml=[];if(path.extname(donor).toLowerCase()==='.sktl'){if(donorName!==undefined)throw Error('Donor part name is only supported for a show');({xml,sha256}=await inspectXml({file:donor}));}
 else if(path.extname(donor).toLowerCase()==='.skshow'){if(typeof donorName!=='string'||!donorName.toLowerCase().endsWith('.sktl'))throw Error('A .sktl donor part name is required');const show=await readShowSnapshot({file:donor});validShow(show);sha256=show.sha256;xml=readSnapshotPart({snapshot:show,name:donorName}).text;otherXml=show.parts.filter(p=>p.name!==donorName&&/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name)).map(p=>readSnapshotPart({snapshot:show,name:p.name}).text);}
 else throw Error('Donor must be a .sktl or .skshow file');parseTimeline(xml);return {xml,sha256,root:parseXmlSpans(xml),otherXml};
}
function validateGraph(xml){
 const parser=new SaxesParser(),stack=[],ids=new Set(),connections=[];let settingsSeen=false,keys;
 parser.on('doctype',()=>{throw Error('DOCTYPE is not supported');});
 parser.on('opentag',tag=>{const parent=stack.at(-1);stack.push(tag.name);const d=stack.length;
  if(d===1&&tag.name==='graph')return;
  if(d===2&&parent==='graph'&&tag.name==='node'){if(!tag.attributes.id||!tag.attributes.type||ids.has(tag.attributes.id))throw Error('Graph node ID and type must be present and unique');ids.add(tag.attributes.id);settingsSeen=false;keys=new Set();}
  else if(d===2&&parent==='graph'&&tag.name==='connection'){if(!tag.attributes.fromNode||!tag.attributes.toNode)throw Error('Connection endpoints are required');connections.push(tag.attributes);}
  else if(d===3&&parent==='node'&&tag.name==='settings'){if(settingsSeen)throw Error('Multiple node settings elements');settingsSeen=true;}
  else if(d===4&&parent==='settings'&&tag.name==='setting'){if(Object.keys(tag.attributes).join(',')!=='key'||!tag.attributes.key||keys.has(tag.attributes.key))throw Error('Setting keys must be present and unique');keys.add(tag.attributes.key);}
  else throw Error('Unsupported graph structure');});
 const content=s=>{if(stack.at(-1)!=='setting'&&s.trim())throw Error('Unsupported graph text');};parser.on('text',content);parser.on('cdata',content);parser.on('closetag',()=>stack.pop());parser.write(xml).close();if(connections.some(c=>!ids.has(c.fromNode)||!ids.has(c.toNode)))throw Error('Connection refers to an unknown node');
}
// Embed an inspected timeline. Cue IDs are preserved and must not collide with either input.
export async function embedProgramTimelineRemappedCopy({source,destination,sha256,index,donor,donorSha256,donorName,target,targetSha256,replaceExisting=false,remapCueIds=false}){
 if(![source,destination,donor,target].every(p=>typeof p==='string'&&path.isAbsolute(p))||path.extname(source).toLowerCase()!=='.skpr'||path.extname(destination).toLowerCase()!=='.skpr'||path.extname(target).toLowerCase()!=='.skshow'||[source,donor,target].some(p=>path.resolve(p)===path.resolve(destination)))throw Error('Absolute source .skpr, donor, target .skshow and distinct destination .skpr paths are required');
 if(![sha256,donorSha256,targetSha256].every(h=>/^[a-f0-9]{64}$/.test(h||'')))throw Error('Program, donor and target SHA-256 values are required');if(typeof replaceExisting!=='boolean'||typeof remapCueIds!=='boolean')throw Error('replaceExisting and remapCueIds must be booleans');
 const [program,inspection,timeline,show]=await Promise.all([inspectXml({file:source}),inspectProgram({file:source}),donorSnapshot(donor,donorName),readShowSnapshot({file:target})]);
 if(program.sha256!==sha256||inspection.sha256!==sha256)throw Error('Program changed since inspection');if(timeline.sha256!==donorSha256)throw Error('Donor changed since inspection');if(show.sha256!==targetSha256)throw Error('Target changed since inspection');validShow(show);
 if(!Number.isInteger(index)||index<0||index>=inspection.items.length)throw Error('Item index out of range');const root=parseXmlSpans(program.xml),item=root.children[index],existing=item.children.find(c=>c.name==='sktimeline');if(existing&&!replaceExisting)throw Error('Item already has a timeline; set replaceExisting to true');
 const donorIds=new Set(),cueIds=new Set(),cues=[],graphs=[];walk(timeline.root,(n,parent)=>{
  if(n.name==='cue'){if(parent!==timeline.root||!n.attributes.id||cueIds.has(n.attributes.id))throw Error('Unsupported or ambiguous donor cue ID or path');cueIds.add(n.attributes.id);cues.push(n);}
  if(n.name==='graph'){if(parent?.name!=='cue'||!timeline.root.children.includes(parent)||parent.children.filter(c=>c.name==='graph').length!==1)throw Error('Unsupported graph path');graphs.push(n);}
  if(n.name==='node'&&!(parent?.name==='graph'&&graphs.includes(parent)))throw Error('Unsupported node path');
 });
 const edits=[],nodes=[];for(const graph of graphs){validateGraph(timeline.xml.slice(graph.start,graph.end));for(const n of graph.children.filter(c=>c.name==='node')){number(n.attributes.id);if(donorIds.has(n.attributes.id))throw Error('Ambiguous donor node ID');donorIds.add(n.attributes.id);nodes.push(n);}}
 let max=0;const allocatedCues=new Set(),allCues=new Set();const scan=r=>walk(r,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||''))max=Math.max(max,number(n.attributes.id));if(n.name==='cue'&&n.attributes.id){allocatedCues.add(n.attributes.id);allCues.add(n.attributes.id);}});
 const outside=existing?program.xml.slice(0,existing.start)+program.xml.slice(existing.end):program.xml;walk(root,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||''))max=Math.max(max,number(n.attributes.id));if(n.name==='cue'&&n.attributes.id)allCues.add(n.attributes.id);});scan(parseXmlSpans(outside));
 for(const part of show.parts.filter(p=>/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name))){const partRoot=parseXmlSpans(readSnapshotPart({snapshot:show,name:part.name}).text);if(part.name==='content/Program.skpr')walk(partRoot,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||''))max=Math.max(max,number(n.attributes.id));if(n.name==='cue'&&n.attributes.id)allCues.add(n.attributes.id);});else scan(partRoot);}
 const cueMappings=[];if(remapCueIds){
  const cueEdits=cues.map(c=>({...attr(timeline.xml,c,'id'),old:c.attributes.id}));let cueSanitized=timeline.xml.slice(timeline.root.start,timeline.root.end);
  for(const e of [...cueEdits].sort((a,b)=>b.start-a.start)){const a=e.start-timeline.root.start,b=e.end-timeline.root.start;cueSanitized=cueSanitized.slice(0,a)+'REMAPPED'+cueSanitized.slice(b);}
  for(const id of cueIds){const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);if(hasXmlReference(cueSanitized,re)||timeline.otherXml.some(xml=>hasXmlReference(xml,re)))throw Error('Donor cue ID has an unsupported reference');}
  for(const e of cueEdits){let id;do{id=`c${Date.now()}_${randomInt(1,1000000000)}`;}while(allCues.has(id)||cueIds.has(id));allCues.add(id);cueMappings.push([e.old,id]);edits.push({start:e.start,end:e.end,value:id});}
 }else for(const id of cueIds)if(allocatedCues.has(id))throw Error('Donor cue ID collides with source Program or target show; cue IDs are not remapped');
 if(existing){walk(existing,n=>{if((n.name==='node'||n.name==='cue')&&n.attributes.id){const id=n.attributes.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),re=new RegExp(`(^|[^A-Za-z0-9_])${id}([^A-Za-z0-9_]|$)`);if(hasXmlReference(outside,re))throw Error('Existing timeline ID is referenced outside the timeline');for(const part of show.parts.filter(p=>p.name!=='content/Program.skpr'&&/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name)))if(hasXmlReference(readSnapshotPart({snapshot:show,name:part.name}).text,re))throw Error('Existing timeline ID occurs in target show');}});}
 const mapping={};for(const n of nodes){if(max>=1000000000)throw Error('No node IDs remain in the supported range');mapping[n.attributes.id]=`n${++max}`;edits.push({...attr(timeline.xml,n,'id'),value:mapping[n.attributes.id]});}
 for(const g of graphs)for(const c of g.children.filter(c=>c.name==='connection'))for(const key of ['fromNode','toNode'])edits.push({...attr(timeline.xml,c,key),value:mapping[c.attributes[key]]});
 let sanitized=timeline.xml.slice(timeline.root.start,timeline.root.end),element=sanitized;for(const e of edits.sort((a,b)=>b.start-a.start)){const a=e.start-timeline.root.start,b=e.end-timeline.root.start;sanitized=sanitized.slice(0,a)+'REMAPPED'+sanitized.slice(b);element=element.slice(0,a)+e.value+element.slice(b);}if(hasXmlReference(sanitized,nodeRef))throw Error('Timeline contains unsupported node references');
 let xml=program.xml;if(existing)xml=xml.slice(0,existing.start)+element+xml.slice(existing.end);else if(item.selfClosing)xml=xml.slice(0,item.start)+xml.slice(item.start,item.openEnd).replace(/\/\s*>$/, '>')+element+'</item>'+xml.slice(item.end);else xml=xml.slice(0,item.closeStart)+element+xml.slice(item.closeStart);
 const bytes=Buffer.from(xml),result=inspectProgramBytes(bytes),temp=path.join(path.dirname(destination),`.showkontrol-timeline-remap-${randomUUID()}.tmp`);let created=false;try{await writeFile(temp,bytes,{flag:'wx'});created=true;const [p,d,t]=await Promise.all([inspectProgram({file:source}),donorSnapshot(donor,donorName),readShowSnapshot({file:target})]);if(p.sha256!==sha256||d.sha256!==donorSha256||t.sha256!==targetSha256)throw Error('Program, donor or target changed since inspection');validShow(t);await link(temp,destination);}finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(bytes),index,mapping,cueMapping:Object.fromEntries(cueMappings),items:result.items,warnings:['Cue ID runtime scope and remapping behavior are unverified.','Media and external dependencies were not copied.','Static remapping only; runtime semantics and ShowKontrol acceptance are unverified.']};
}
