import {writeFile,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';
import {inspectProgram,inspectProgramItemGraph} from './program.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const idPattern=/(^|[^A-Za-z0-9_])n\d+([^A-Za-z0-9_]|$)/;
function walk(n,fn){fn(n);for(const c of n.children)walk(c,fn);}
function number(id){if(!/^n(?:0|[1-9]\d*)$/.test(id||''))throw Error('Unsupported node ID');const n=Number(id.slice(1));if(!Number.isSafeInteger(n)||n>1000000000)throw Error('Node ID exceeds supported range');return n;}
function attribute(xml,node,key){
 const opening=xml.slice(node.start,node.openEnd),re=/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g,matches=[...opening.matchAll(re)].filter(m=>m[1]===key);
 if(matches.length!==1)throw Error('Unsupported attribute serialization');const m=matches[0],start=node.start+m.index+m[0].indexOf(m[2])+1;
 if(xml.slice(start,start+m[2].length-2)!==node.attributes[key])throw Error('Encoded node references are unsupported');
 return {start,end:start+m[2].length-2};
}
// Remap one standalone Program item graph against a checksum-verified target show.
export async function remapProgramItemGraphCopy({source,sha256,index,target,targetSha256,destination}){
 if(!path.isAbsolute(source)||path.extname(source).toLowerCase()!=='.skpr'||!path.isAbsolute(target)||path.extname(target).toLowerCase()!=='.skshow'||!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr'||path.resolve(source)===path.resolve(destination))throw Error('Absolute source .skpr, target .skshow and distinct destination .skpr paths are required');
 if(!/^[a-f0-9]{64}$/.test(sha256||'')||!/^[a-f0-9]{64}$/.test(targetSha256||''))throw Error('Source and target SHA-256 values are required');
 const [program,show,inspection]=await Promise.all([inspectXml({file:source}),readShowSnapshot({file:target}),inspectProgram({file:source})]);
 if(program.sha256!==sha256||inspection.sha256!==sha256)throw Error('Source changed since inspection');
 if(show.sha256!==targetSha256)throw Error('Target changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 await inspectProgramItemGraph({file:source,sha256,index});
 const root=parseXmlSpans(program.xml),item=root.children[index],graph=item.children.find(c=>c.name==='graph');
 const nodes=graph.children.filter(c=>c.name==='node'),connections=graph.children.filter(c=>c.name==='connection');
 if(!nodes.length)throw Error('Graph has no nodes');
 let max=0;for(const part of show.parts.filter(p=>/\.(?:skf|sktl|sksc|skpr)$/i.test(p.name))){const r=parseXmlSpans(readSnapshotPart({snapshot:show,name:part.name}).text);walk(r,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||''))max=Math.max(max,number(n.attributes.id));});}
 // Include all source node IDs so the new IDs cannot collide with other Program items.
 walk(root,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||''))max=Math.max(max,number(n.attributes.id));});
 const mapping={};for(const n of nodes){number(n.attributes.id);if(max>=1000000000)throw Error('No node IDs remain in the supported range');mapping[n.attributes.id]=`n${++max}`;}
 // Reject references outside the selected graph to any of its IDs, including other node IDs.
 const outside=program.xml.slice(0,graph.start)+program.xml.slice(graph.end);
 for(const id of Object.keys(mapping)){const re=new RegExp(`(^|[^A-Za-z0-9_])${id}([^A-Za-z0-9_]|$)`);if(hasXmlReference(outside,re))throw Error('Selected node ID is referenced outside the graph');}
 const edits=[];for(const n of nodes)edits.push({...attribute(program.xml,n,'id'),value:mapping[n.attributes.id]});
 for(const c of connections)for(const key of ['fromNode','toNode'])edits.push({...attribute(program.xml,c,key),value:mapping[c.attributes[key]]});
 // Remove only verified ID and wire attributes before checking for any other reference.
 let sanitized=program.xml.slice(graph.start,graph.end);for(const e of [...edits].sort((a,b)=>b.start-a.start))sanitized=sanitized.slice(0,e.start-graph.start)+'REMAPPED'+sanitized.slice(e.end-graph.start);
 if(hasXmlReference(sanitized,idPattern))throw Error('Graph contains unsupported internal references');
 let output=program.xml;for(const e of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,e.start)+e.value+output.slice(e.end);
 parseXmlSpans(output);const temp=path.join(path.dirname(destination),`.showkontrol-remap-${randomUUID()}.tmp`);let created=false;
 try{await writeFile(temp,output,{flag:'wx'});created=true;if((await inspectXml({file:source})).sha256!==sha256||(await readShowSnapshot({file:target})).sha256!==targetSha256)throw Error('Source or target changed since inspection');await link(temp,destination);}finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(Buffer.from(output)),index,mapping,note:'Static ID remapping only. Runtime ID semantics and ShowKontrol acceptance are unverified.'};
}
