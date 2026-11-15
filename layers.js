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
function transform(xml,{operation,layerName,newName,targetIndex}){
 if(!['append','rename','move','remove'].includes(operation))throw Error('Unsupported layer operation');
 if(operation!=='move'&&targetIndex!==undefined)throw Error('Only move accepts targetIndex');
 if(['move','remove'].includes(operation)&&newName!==undefined)throw Error('Only append and rename accept newName');
 if(['append','rename'].includes(operation)&&(typeof newName!=='string'||!newName.trim()||/[\x00-\x1f\ufffe\uffff]/u.test(newName)))throw Error('A valid new layer name is required');
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
 const node=matches[0],index=nodes.indexOf(node);
 if(operation==='move'||operation==='remove'){
  if(operation==='move'&&(!Number.isSafeInteger(targetIndex)||targetIndex<0||targetIndex>=nodes.length||targetIndex===index))throw Error('Target index must select a different existing layer');
  const cues=[];
  const visit=(n,parent,grandparent,greatGrandparent)=>{
   if((n.name==='layers'&&n!==container)||(n.name==='layer'&&parent!==container))throw Error('Ambiguous layers structure');
   if(n.name==='cue'){
    if(parent!==root)throw Error('Nested cues are unsupported');
    const value=n.attributes.layer;
    if(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>=nodes.length)throw Error('Cue has an invalid layer index');
    cues.push(n);
   }
   if(n!==container&&n.name!=='layer'&&n.name!=='cue'&&/layer/i.test(n.name))throw Error('Unsupported layer reference');
   for(const [key,value] of Object.entries(n.attributes)){
    if(/layer/i.test(key)&&!(n.name==='cue'&&parent===root&&key==='layer')&&!(n.name==='node'&&parent?.name==='graph'&&grandparent?.name==='cue'&&greatGrandparent===root&&key==='layer'&&value==='-1'))throw Error('Unsupported layer reference');
    if((key==='key'||/ref/i.test(key))&&/layer/i.test(value))throw Error('Unsupported layer reference');
   }
   for(const child of n.children)visit(child,n,parent,grandparent);
  };
  visit(root,null);
  if(operation==='remove'&&cues.some(c=>Number(c.attributes.layer)===index))throw Error('Cannot remove an occupied layer');
  if(operation==='remove'&&(node.children.length||(!node.selfClosing&&!/^\s*$/.test(xml.slice(node.openEnd,node.closeStart)))))throw Error('Cannot remove a layer with content');
  const map=i=>operation==='remove'?(i>index?i-1:i):i===index?targetIndex:index<targetIndex&&i>index&&i<=targetIndex?i-1:index>targetIndex&&i>=targetIndex&&i<index?i+1:i;
  const edits=[];
  for(const cue of cues){
   const opening=xml.slice(cue.start,cue.openEnd),attrs=[...opening.matchAll(/\slayer\s*=\s*(["'])(.*?)\1/gs)];
   if(attrs.length!==1||attrs[0][2]!==cue.attributes.layer)throw Error('Unsupported cue layer serialization');
   const m=attrs[0],start=cue.start+m.index+m[0].indexOf(m[1])+1;
   edits.push({start,end:start+m[2].length,value:String(map(Number(m[2])))});
  }
  const reordered=[...nodes];reordered.splice(index,1);if(operation==='move')reordered.splice(targetIndex,0,node);
  // Replace element spans only, leaving whitespace and comments in their original slots.
  for(let i=0;i<nodes.length;i++)edits.push({start:nodes[i].start,end:nodes[i].end,value:i<reordered.length?xml.slice(reordered[i].start,reordered[i].end):''});
  let modified=xml;for(const edit of edits.sort((a,b)=>b.start-a.start))modified=modified.slice(0,edit.start)+edit.value+modified.slice(edit.end);
  const expected=structuredClone(before);expected.layers=reordered.map(n=>({...n.attributes}));
  for(const cue of expected.cueElements)cue.attributes.layer=String(map(Number(cue.attributes.layer)));
  const after=parseTimeline(modified);if(JSON.stringify(after)!==JSON.stringify(expected))throw Error('Layer edit failed semantic readback');
  return {modified,index:operation==='move'?targetIndex:index,layers:after.layers};
 }
 if(nodes.some(n=>n.attributes.name===newName))throw Error('New layer name already exists');
 const changed=renameElement(xml,node,newName);
 if(operation==='append'&&(node.children.length||!/^\s*$/.test(xml.slice(node.openEnd,node.closeStart))))throw Error('Layer template must have empty content');
 const modified=operation==='rename'?xml.slice(0,node.start)+changed+xml.slice(node.end):xml.slice(0,container.closeStart)+changed+xml.slice(container.closeStart);
 const after=parseTimeline(modified),expected=structuredClone(before);
 const layer={...expected.layers[index],name:newName};
 if(operation==='rename')expected.layers[index]=layer;else expected.layers.push(layer);
 if(JSON.stringify(after)!==JSON.stringify(expected))throw Error('Layer edit failed semantic readback');
 return {modified,index:operation==='rename'?index:nodes.length,layers:after.layers};
}
export async function editTimelineLayerCopy({source,destination,sha256,format='sktl',name,operation,layerName,newName,targetIndex}){
 let xml;
 if(format==='sktl'){
  const inspected=await inspectXml({file:source});if(inspected.sha256!==sha256)throw Error('Source changed since inspection');xml=inspected.xml;
 }else if(format==='skshow'){
  if(typeof name!=='string'||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');
  const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
  if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');xml=readSnapshotPart({snapshot:show,name}).text;
 }else throw Error('Format must be sktl or skshow');
 const {modified,index,layers}=transform(xml,{operation,layerName,newName,targetIndex});
 const edits=[{find:xml,replace:modified}];
 const result=format==='sktl'?await editXmlCopy({source,destination,sha256,edits}):await editShowPart({source,destination,sha256,name,edits});
 return {...result,operation,index,layers,note:'Changed an offline copy. Validate in ShowKontrol.'};
}
