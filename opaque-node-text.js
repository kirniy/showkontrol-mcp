import {hasXmlReference} from './xml-references.js';
import {SaxesParser} from 'saxes';

const referencePattern=/(^|[^A-Za-z0-9_])n\d+([^A-Za-z0-9_]|$)/;

// Mask only the scalar content for reference scanning. The original XML is never changed.
export function maskOpaqueNodeText(xml,node,allowOpaqueNodeText){
 let masked=xml.slice(node.start,node.end);const keys=[];
 if(allowOpaqueNodeText!==true)return {masked,keys};
 const key=node.attributes.type==='processor'&&node.attributes.kind===''?'proc.script':node.attributes.type==='generator'&&node.attributes.kind==='OSC'?'gen.address':null;
 if(!key)return {masked,keys};
 const matches=[];const collect=n=>{if(n.name==='setting'&&n.attributes.key===key)matches.push(n);for(const child of n.children)collect(child);};collect(node);
 if(matches.length!==1)return {masked,keys};
 const setting=matches[0],containers=node.children.filter(n=>n.name==='settings');
 if(containers.length!==1||!containers[0].children.includes(setting)||Object.keys(setting.attributes).length!==1||setting.children.length||setting.selfClosing)return {masked,keys};
 const content=xml.slice(setting.openEnd,setting.closeStart);
 let nonScalar=false;const parser=new SaxesParser();
 parser.on('comment',()=>{nonScalar=true;});parser.on('processinginstruction',()=>{nonScalar=true;});
 parser.write(`<setting>${content}</setting>`).close();if(nonScalar)return {masked,keys};
 if(!hasXmlReference(`<setting>${content}</setting>`,referencePattern))return {masked,keys};
 masked=masked.slice(0,setting.openEnd-node.start)+' '.repeat(setting.closeStart-setting.openEnd)+masked.slice(setting.closeStart-node.start);
 keys.push(key);return {masked,keys};
}
export function opaqueNodeWarnings(entries,part,cueId,idMap){
 return entries.flatMap(({nodeId,keys})=>keys.map(key=>({code:'opaque_node_references_unverified',severity:'warning',scope:{part,cueId,nodeId:idMap[nodeId],key},message:'Opaque setting text contains node-like references that were not verified or remapped.'})));
}
