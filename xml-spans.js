import {SaxesParser} from 'saxes';

// Offsets are UTF-16 code-unit indexes into the original JavaScript string.
export function parseXmlSpans(xml){
 if(typeof xml!=='string')throw Error('XML must be a string');
 const parser=new SaxesParser(),stack=[];let root,pendingStart;
 parser.on('doctype',()=>{throw Error('DOCTYPE is not supported');});
 parser.on('opentagstart',()=>{
  pendingStart=xml.lastIndexOf('<',parser.position-1);
  if(pendingStart<0)throw Error('Cannot locate opening tag');
 });
 parser.on('opentag',tag=>{
  if(pendingStart===undefined)throw Error('Cannot locate opening tag');
  const node={name:tag.name,attributes:{...tag.attributes},start:pendingStart,openEnd:parser.position,closeStart:null,end:null,selfClosing:tag.isSelfClosing,children:[]};
  pendingStart=undefined;
  if(stack.length)stack.at(-1).children.push(node);else{if(root)throw Error('Multiple XML roots');root=node;}
  stack.push(node);
 });
 parser.on('closetag',tag=>{
  const node=stack.pop();if(!node||node.name!==tag.name)throw Error('Mismatched closing tag');
  node.end=parser.position;
  if(node.selfClosing)node.closeStart=node.openEnd;
  else{node.closeStart=xml.lastIndexOf('</',parser.position-1);if(node.closeStart<node.openEnd)throw Error('Cannot locate closing tag');}
 });
 parser.write(xml).close();if(!root||stack.length)throw Error('Incomplete XML');return root;
}

// Each path item is an element name or {name, attributes}; attributes match exactly.
export function selectXmlSpans(root,path){
 if(!Array.isArray(path)||!path.length)throw Error('Path must contain at least one element');
 const matches=(node,part)=>{
  if(typeof part==='string')return node.name===part;
  if(!part||typeof part.name!=='string'||part.attributes!==undefined&&(typeof part.attributes!=='object'||part.attributes===null||Array.isArray(part.attributes)))throw Error('Invalid path element');
  return node.name===part.name&&Object.entries(part.attributes||{}).every(([key,value])=>node.attributes[key]===value);
 };
 let nodes=matches(root,path[0])?[root]:[];
 for(const part of path.slice(1))nodes=nodes.flatMap(n=>n.children.filter(child=>matches(child,part)));
 return nodes;
}
