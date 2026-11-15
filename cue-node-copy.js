import {readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';
function walk(node,fn){fn(node);for(const child of node.children)walk(child,fn);}
function graphParts(xml,cueId){
 const root=parseXmlSpans(xml),path=['sktimeline',{name:'cue',attributes:{id:cueId}}];if(root.name!=='sktimeline'||root.attributes.version!=='1')throw Error('Expected a version 1 timeline');
 const cues=selectXmlSpans(root,path),graphs=selectXmlSpans(root,[...path,'graph']);if(cues.length!==1||graphs.length!==1)throw Error('Cue and graph must occur exactly once');return {root,path,graph:graphs[0],nodes:selectXmlSpans(root,[...path,'graph','node'])};
}
function replaceId(xml,node,newId){
 const opening=xml.slice(node.start,node.openEnd),attr=/\s+([^\s=/>]+)\s*=\s*(["'])([^"']*(?:(?!\2)["'][^"']*)*)\2/y;let pos='<node'.length,id;
 while(pos<opening.length){if(/^\s*\/?>$/.test(opening.slice(pos)))break;attr.lastIndex=pos;const m=attr.exec(opening);if(!m)throw Error('Unsupported node attribute serialization');if(m[1]==='id'){const start=pos+m[0].indexOf(m[2])+1;id={start,end:start+m[3].length};}pos=attr.lastIndex;}
 if(!id)throw Error('Node ID attribute is missing');
 return {copy:opening.slice(0,id.start)+newId+opening.slice(id.end)+xml.slice(node.openEnd,node.end),outsideId:opening.slice(0,id.start)+opening.slice(id.end)+xml.slice(node.openEnd,node.end)};
}
export async function copyCueGraphNodeShowCopy({source,destination,sha256,name,cueId,template,templateSha256,templateName,templateCueId,nodeId}){
 if(!name?.toLowerCase().endsWith('.sktl')||!templateName?.toLowerCase().endsWith('.sktl'))throw Error('Select timeline parts');
 if(!cueId||!templateCueId||!/^n\d+$/.test(nodeId||''))throw Error('Cue IDs and supported node ID are required');
 const [target,donor]=await Promise.all([readShowSnapshot({file:source}),readShowSnapshot({file:template})]);
 if(target.sha256!==sha256)throw Error('Source changed since inspection');if(donor.sha256!==templateSha256)throw Error('Template changed since inspection');
 if(!target.parts.every(p=>p.valid)||!donor.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const xml=readSnapshotPart({snapshot:target,name}).text,donorXml=readSnapshotPart({snapshot:donor,name:templateName}).text,targetGraph=graphParts(xml,cueId),donorGraph=graphParts(donorXml,templateCueId);
 const nodes=donorGraph.nodes.filter(n=>n.attributes.id===nodeId);if(nodes.length!==1)throw Error('Template node ID must occur exactly once');const node=nodes[0];if(!['groupin','trigger','action'].includes(node.attributes.type))throw Error('Node type is not supported by the fixture');
 let max=0;for(const part of target.parts.filter(p=>/\.(?:skf|sktl|sksc)$/i.test(p.name))){const root=parseXmlSpans(readSnapshotPart({snapshot:target,name:part.name}).text);walk(root,n=>{if(n.name==='node'&&/^n\d+$/.test(n.attributes.id||'')){const num=Number(n.attributes.id.slice(1));if(!Number.isSafeInteger(num)||num>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,num);}});}
 const donorId=Number(nodeId.slice(1));if(!Number.isSafeInteger(donorId)||donorId>1000000000)throw Error('Node ID exceeds supported range');max=Math.max(max,donorId);if(max>=1000000000)throw Error('No node IDs remain in the supported range');const newNodeId=`n${max+1}`;
 const {copy}=replaceId(donorXml,node,newNodeId);
 if(hasXmlReference(copy,/(^|[^A-Za-z0-9_])n\d+([^A-Za-z0-9_]|$)/,{ignoreRootId:true}))throw Error('Node contains unsupported internal references');
 const graph=targetGraph.graph;let modified;
 if(graph.selfClosing){const opening=xml.slice(graph.start,graph.openEnd).replace(/\s*\/>$/,'>');modified=xml.slice(0,graph.start)+opening+copy+'</graph>'+xml.slice(graph.end);}
 else modified=xml.slice(0,graph.closeStart)+copy+xml.slice(graph.closeStart);
 const after=graphParts(modified,cueId),copied=after.nodes.filter(n=>n.attributes.id===newNodeId);
 if(JSON.stringify(after.graph.attributes)!==JSON.stringify(graph.attributes))throw Error('Graph attributes changed unexpectedly');
 if(copied.length!==1||after.nodes.length!==targetGraph.nodes.length+1||modified.slice(copied[0].start,copied[0].end)!==copy||JSON.stringify({...copied[0].attributes,id:nodeId})!==JSON.stringify(node.attributes))throw Error('Copied node did not match template');
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:modified}]});return {...result,nodeId,newNodeId,note:'Copied an unconnected fixture-supported node. Internal references, hardware dependencies and ShowKontrol acceptance require validation.'};
}
