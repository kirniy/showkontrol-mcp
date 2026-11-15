import {parseXmlSpans} from './xml-spans.js';
import {parseTimeline} from './timeline.js';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';

function renameElement(xml,node,name){
 const opening=xml.slice(node.start,node.openEnd);
 const attrs=[...opening.matchAll(/\sname\s*=\s*(["'])(.*?)\1/gs)];
 if(attrs.length!==1)throw Error('Unsupported layer name serialization');
 const escaped=name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
 const match=attrs[0],replacement=match[0].replace(/(["'])(.*?)\1/s,(_,quote)=>quote+escaped+quote);
 return opening.slice(0,match.index)+replacement+opening.slice(match.index+match[0].length)+xml.slice(node.openEnd,node.end);
}
function transform(xml,{operation,layerName,newName}){
 if(!['append','rename'].includes(operation))throw Error('Only append and rename are supported');
 if(typeof newName!=='string'||!newName.trim()||/[\x00-\x1f\ufffe\uffff]/u.test(newName))throw Error('A valid new layer name is required');
 if(typeof layerName!=='string'||!layerName)throw Error('A layer template or existing layer name is required');
 const before=parseTimeline(xml),root=parseXmlSpans(xml);
 const containers=root.children.filter(n=>n.name==='layers');
 if(containers.length!==1||containers[0].selfClosing)throw Error('Expected exactly one nonempty layers container');
 const container=containers[0];
 if(container.children.some(n=>n.name!=='layer'))throw Error('Unsupported layers structure');
 const nodes=container.children;
 if(nodes.length!==before.layers.length||nodes.some(n=>typeof n.attributes.name!=='string'))throw Error('Unsupported layers structure');
 const matches=nodes.filter(n=>n.attributes.name===layerName);
 if(matches.length!==1)throw Error('Layer name must match exactly one layer');
 if(nodes.some(n=>n.attributes.name===newName))throw Error('New layer name already exists');
 const node=matches[0],changed=renameElement(xml,node,newName);
 if(operation==='append'&&(node.children.length||!/^\s*$/.test(xml.slice(node.openEnd,node.closeStart))))throw Error('Layer template must have empty content');
 const modified=operation==='rename'?xml.slice(0,node.start)+changed+xml.slice(node.end):xml.slice(0,container.closeStart)+changed+xml.slice(container.closeStart);
 const after=parseTimeline(modified),expected=structuredClone(before);
 const index=nodes.indexOf(node),layer={...expected.layers[index],name:newName};
 if(operation==='rename')expected.layers[index]=layer;else expected.layers.push(layer);
 if(JSON.stringify(after)!==JSON.stringify(expected))throw Error('Layer edit failed semantic readback');
 return {modified,index:operation==='rename'?index:nodes.length,layers:after.layers};
}
export async function editTimelineLayerCopy({source,destination,sha256,format='sktl',name,operation,layerName,newName}){
 let xml;
 if(format==='sktl'){
  const inspected=await inspectXml({file:source});if(inspected.sha256!==sha256)throw Error('Source changed since inspection');xml=inspected.xml;
 }else if(format==='skshow'){
  if(typeof name!=='string'||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
  if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');xml=readSnapshotPart({snapshot:show,name}).text;
 }else throw Error('Format must be sktl or skshow');
 const {modified,index,layers}=transform(xml,{operation,layerName,newName});
 const edits=[{find:xml,replace:modified}];
 const result=format==='sktl'?await editXmlCopy({source,destination,sha256,edits}):await editShowPart({source,destination,sha256,name,edits});
 return {...result,operation,index,layers,note:'Changed an offline copy. Validate in ShowKontrol.'};
}
