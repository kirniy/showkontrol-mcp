import {hasXmlReference} from './xml-references.js';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';

function hasReference(xml,nodeId){return hasXmlReference(xml,new RegExp('(^|[^A-Za-z0-9_])'+nodeId+'([^A-Za-z0-9_]|$)'));}
export async function removeCueGraphNodeCopy({source,destination,format,sha256,name,cueId,nodeId}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');if(typeof cueId!=='string'||!cueId||!/^n\d+$/.test(nodeId||''))throw Error('Cue ID and supported node ID are required');
 let xml,actual,show;if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));if(actual!==sha256)throw Error('Source changed since inspection');
 const root=parseXmlSpans(xml);if(root.name!=='sktimeline'||root.attributes.version!=='1')throw Error('Expected a version 1 timeline');const path=['sktimeline',{name:'cue',attributes:{id:cueId}},'graph'],graphs=selectXmlSpans(root,path),nodes=selectXmlSpans(root,[...path,'node']),selected=nodes.filter(n=>n.attributes.id===nodeId);
 if(graphs.length!==1||selected.length!==1)throw Error('Graph and selected node must each occur exactly once');
 const node=selected[0],modified=xml.slice(0,node.start)+xml.slice(node.end);
 if(hasReference(modified,nodeId))throw Error('Node has a connection or other explicit reference');
 if(show)for(const part of show.parts.filter(p=>p.name!==name&&/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(p.name)))if(hasReference(readSnapshotPart({snapshot:show,name:part.name}).text,nodeId))throw Error('Node has a reference in another show part');
 const afterRoot=parseXmlSpans(modified),after=selectXmlSpans(afterRoot,[...path,'node']);if(after.length!==nodes.length-1||after.some(n=>n.attributes.id===nodeId))throw Error('Node removal could not be verified');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,nodeId,note:'Removed an unreferenced cue graph node from an offline copy. External references and ShowKontrol acceptance are not validated.'};
}
