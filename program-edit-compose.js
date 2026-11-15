import {mkdtemp,rm,link,readFile} from 'node:fs/promises';
import path from 'node:path';
import {extractShowProgramCopy,createProgramCopy,attachShowProgramCopy,inspectShowProgram} from './program.js';
import {validateShow} from './validate-show.js';
import {parseXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';

function keys(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('Unsupported edit composition input');
}

// Inspect all descendants, including extensions, so that hidden definitions cannot be
// removed without checking references. Duplicate definitions are ambiguous.
async function checkRemovalReferences(program,index){
 const xml=await readFile(program,'utf8'),root=parseXmlSpans(xml),item=root.children[index];
 if(!Number.isInteger(index)||index<0||!item)throw Error('Item index out of range');
 const counts=new Map(),removed=new Set();
 function visit(node,inRemoved){
  if(node.name==='node'||node.name==='cue'){
   const id=node.attributes.id;
   if(!id)throw Error('Cannot safely remove item with an unidentified node or cue');
   counts.set(id,(counts.get(id)??0)+1);if(inRemoved)removed.add(id);
  }
  for(const child of node.children)visit(child,inRemoved);
 }
 for(const child of root.children)visit(child,child===item);
 for(const id of removed)if(counts.get(id)!==1)throw Error('Cannot safely remove item with ambiguous node or cue ID');
 const remaining=xml.slice(0,item.start)+xml.slice(item.end);
 for(const id of removed){
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(hasXmlReference(remaining,new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`)))throw Error(`Removed Program ID is referenced in remaining Program: ${id}`);
 }
}

// Each index addresses the current Program file order after all preceding operations.
export async function composeProgramEditsCopy(args){
 keys(args,['source','destination','sha256','operations']);
 const {source,destination,sha256,operations}=args;
 if(typeof source!=='string'||typeof destination!=='string'||![source,destination].every(p=>path.isAbsolute(p)&&path.extname(p).toLowerCase()==='.skshow')||path.resolve(source)===path.resolve(destination)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw Error('Distinct absolute source and destination .skshow paths and source SHA-256 are required');
 if(!Array.isArray(operations)||operations.length>100)throw Error('Expected at most 100 operations');
 for(const op of operations){
  if(!op||typeof op!=='object'||Array.isArray(op))throw Error('Invalid operation');
  if(op.action==='add')keys(op,['action','start','name','notes']);
  else if(op.action==='edit')keys(op,['action','index'],['start','name','notes']);
  else if(op.action==='remove'){keys(op,['action','index'],['allowContentRemoval']);if(op.allowContentRemoval!==undefined&&typeof op.allowContentRemoval!=='boolean')throw Error('allowContentRemoval must be a boolean');}
  else throw Error('Invalid operation');
 }
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-program-edit-'));
 try{
  let step=0;const next=()=>path.join(dir,`${step++}.skpr`);
  let program=next(),current=await extractShowProgramCopy({source,destination:program,sha256});
  for(const operation of operations){if(operation.action==='remove')await checkRemovalReferences(program,operation.index);const destination=next();current=await createProgramCopy({source:program,destination,sha256:current.sha256,operation});program=destination;}
  const candidate=path.join(dir,'candidate.skshow');
  const attached=await attachShowProgramCopy({source,destination:candidate,sha256,program,programSha256:current.sha256,replaceExisting:true});
  const validation=await validateShow({file:candidate});
  if(validation.diagnostics.some(d=>d.severity==='error'))throw Error(`Final show validation failed: ${validation.diagnostics.filter(d=>d.severity==='error').map(d=>d.code).join(', ')}`);
  const final=await inspectShowProgram({file:candidate});
  if(final.sha256!==attached.sha256||final.programSha256!==current.sha256)throw Error('Final show checksum mismatch');
  if((await inspectShowProgram({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  await link(candidate,destination);
  return {destination,sha256:attached.sha256,programSha256:current.sha256,items:final.items,warnings:[current.note],validation:{...validation,file:destination,note:`${validation.note} Validation was performed before publication.`}};
 }finally{await rm(dir,{recursive:true,force:true});}
}
