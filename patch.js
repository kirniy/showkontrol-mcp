import {SaxesParser} from 'saxes';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
import {hasXmlReference} from './xml-references.js';

export function parsePatch(xml) {
 const parser=new SaxesParser(); const stack=[]; let root, graphCount=0, appCount=0, currentNode, currentSetting, text='';
 const result={nodes:[],connections:[],appSettings:[]};
 parser.on('opentag',tag=>{
  const parent=stack.at(-1); stack.push(tag.name);
  if(stack.length===1){root=tag;if(tag.name!=='showkontrol'||tag.attributes.version!=='2')throw Error('Expected a ShowKontrol version 2 patch');result.name=tag.attributes.name||'';}
  if(stack.join('/')==='showkontrol/graph')graphCount++;
  if(stack.join('/')==='showkontrol/appSettings')appCount++;
  if(parent==='graph'&&tag.name==='node'&&stack.join('/')==='showkontrol/graph/node'){
   currentNode={id:tag.attributes.id,type:tag.attributes.type,title:tag.attributes.title,kind:tag.attributes.kind,settings:[]};result.nodes.push(currentNode);
  }
  if(parent==='graph'&&tag.name==='connection'&&stack.join('/')==='showkontrol/graph/connection')result.connections.push({...tag.attributes});
  if(tag.name==='setting' && (stack.join('/')==='showkontrol/appSettings/setting'||stack.join('/')==='showkontrol/graph/node/settings/setting')){
   currentSetting={key:tag.attributes.key};text='';
  } else if(currentSetting) throw Error('Nested setting content is unsupported');
 });
 parser.on('text',v=>{if(currentSetting)text+=v});
 parser.on('cdata',v=>{if(currentSetting)text+=v});
 parser.on('closetag',tag=>{
  if(tag.name==='setting'&&currentSetting){currentSetting.value=text;(currentNode?currentNode.settings:result.appSettings).push(currentSetting);currentSetting=null;}
  if(tag.name==='node'&&stack.join('/')==='showkontrol/graph/node')currentNode=null;
  stack.pop();
 });
 if(/<!DOCTYPE/i.test(xml))throw Error('DOCTYPE is not supported');parser.write(xml).close();
 if(!root||graphCount!==1||appCount!==1)throw Error('Expected one graph and one appSettings element');
 const ids=new Set();for(const node of result.nodes){if(!node.id||ids.has(node.id))throw Error('Missing or duplicate node ID');ids.add(node.id);}
 return result;
}
async function sourceData(file,format){
 if(format==='skshow'){
  const snapshot=await readShowSnapshot({file});if(!snapshot.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  return {sha256:snapshot.sha256,xml:readSnapshotPart({snapshot,name:'patch.skf'}).text,snapshot};
 }
 const info=await inspectXml({file});return {sha256:info.sha256,xml:info.xml};
}
function showNodeIdExists(snapshot,id){
 for(const part of snapshot.parts.filter(p=>/\.(?:skf|sktl|sksc)$/i.test(p.name))){
  const xml=readSnapshotPart({snapshot,name:part.name}).text;
  if(/<!DOCTYPE/i.test(xml))throw Error('DOCTYPE is not supported');
  let found=false;const parser=new SaxesParser();
  parser.on('opentag',tag=>{if(tag.name==='node'&&tag.attributes.id===id)found=true});
  parser.write(xml).close();if(found)return true;
 }
 return false;
}
export async function inspectPatch({file,format}){
 const {sha256,xml}=await sourceData(file,format);return {file,format,sha256,...parsePatch(xml)};
}
function escapeText(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function escapeRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function openingAttributes(opening){
 let attributes;const parser=new SaxesParser();parser.on('opentag',tag=>{attributes=tag.attributes});
 parser.write(opening.replace(/>$/,'/>')).close();return attributes;
}
export async function editPatchSettingCopy({source,destination,format,sha256,nodeId,key,value}){
 if(!/^[A-Za-z0-9_.:-]+$/.test(key)||nodeId!==undefined&&!/^[A-Za-z0-9_.:-]+$/.test(nodeId))throw Error('Unsupported node ID or setting key');
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw Error('Invalid XML characters in value');
 const loaded=await sourceData(source,format);if(loaded.sha256!==sha256)throw Error('Source changed since inspection');
 const parsed=parsePatch(loaded.xml);
 const settings=nodeId===undefined?parsed.appSettings:parsed.nodes.find(n=>n.id===nodeId)?.settings;
 if(!settings||settings.filter(s=>s.key===key).length!==1)throw Error('Setting must already exist exactly once in the selected scope');
 const root=parseXmlSpans(loaded.xml);
 const path=nodeId===undefined?['showkontrol','appSettings',{name:'setting',attributes:{key}}]:['showkontrol','graph',{name:'node',attributes:{id:nodeId}},'settings',{name:'setting',attributes:{key}}];
 const matches=selectXmlSpans(root,path);if(matches.length!==1)throw Error('Unsupported or ambiguous setting serialization');
 const m=matches[0],opening=loaded.xml.slice(m.start,m.openEnd);
 const replacement=m.selfClosing?opening.replace(/\/\s*>$/, '>')+escapeText(value)+'</setting>':opening+escapeText(value)+loaded.xml.slice(m.closeStart,m.end);
 const changed=loaded.xml.slice(0,m.start)+replacement+loaded.xml.slice(m.end);
 const checked=parsePatch(changed),checkedSettings=nodeId===undefined?checked.appSettings:checked.nodes.find(n=>n.id===nodeId)?.settings;
 if(checkedSettings?.filter(s=>s.key===key&&s.value===value).length!==1)throw Error('Setting value could not be preserved in XML');
 const args={source,destination,sha256,edits:[{find:loaded.xml,replace:changed}]};
 const result=format==='skshow'?await editShowPart({...args,name:'patch.skf'}):await editXmlCopy(args);
 return {...result,nodeId:nodeId??null,key,value,note:'Existing setting changed in an offline copy. Value semantics and ShowKontrol compatibility are not validated.'};
}

// Select only direct graph children from the parsed XML tree.
function patchGraphSpans(xml){
 const root=parseXmlSpans(xml),graphs=selectXmlSpans(root,['showkontrol','graph']);
 if(graphs.length!==1||graphs[0].selfClosing)throw Error('Cannot uniquely locate graph serialization');return {root,graph:graphs[0]};
}
function copyNodeXml(xml,node,newNodeId){
 const opening=xml.slice(node.start,node.openEnd),idAttr=/(\sid\s*=\s*)(["'])([^"']*)\2/g;
 if([...opening.matchAll(idAttr)].length!==1)throw Error('Cannot uniquely locate node ID attribute');
 const changed=opening.replace(idAttr,(_,prefix,quote)=>prefix+quote+newNodeId+quote);
 if(openingAttributes(changed).id!==newNodeId)throw Error('Cannot uniquely locate node ID attribute');
 return changed+xml.slice(node.openEnd,node.end);
}
function validateConnections(parsed){
 const ids=new Set(parsed.nodes.map(n=>n.id));for(const c of parsed.connections)if(!ids.has(c.fromNode)||!ids.has(c.toNode)||!/^\d+$/.test(c.fromPin||'')||!/^\d+$/.test(c.toPin||''))throw Error('Existing graph has invalid connection references or pins');return ids;
}
export async function editPatchGraphCopy({source,destination,format,sha256,operation,nodeId,newNodeId,connection}){
 const idPattern=/^[A-Za-z0-9_.:-]+$/,loaded=await sourceData(source,format);if(loaded.sha256!==sha256)throw Error('Source changed since inspection');
 const parsed=parsePatch(loaded.xml),ids=validateConnections(parsed),{root,graph}=patchGraphSpans(loaded.xml);let modified,expectedNodes=parsed.nodes,expectedConnections=parsed.connections;
 if(operation==='duplicate_node'||operation==='remove_node'){
  if(!nodeId||!idPattern.test(nodeId)||!ids.has(nodeId))throw Error('Node ID must identify an existing node');
  const nodes=selectXmlSpans(root,['showkontrol','graph',{name:'node',attributes:{id:nodeId}}]);if(nodes.length!==1)throw Error('Cannot uniquely locate node serialization');const node=nodes[0];
  if(operation==='remove_node'){
   if(parsed.connections.some(c=>c.fromNode===nodeId||c.toNode===nodeId))throw Error('Remove all connections referencing this node first');
   modified=loaded.xml.slice(0,node.start)+loaded.xml.slice(node.end);expectedNodes=parsed.nodes.filter(n=>n.id!==nodeId);
   // Match substrings conservatively: IDs can appear inside arbitrary field values.
   const pattern=new RegExp(escapeRegex(nodeId));
   if(hasXmlReference(modified,pattern))throw Error('Node has a reference in the patch');
   if(loaded.snapshot)for(const part of loaded.snapshot.parts.filter(p=>p.name!=='patch.skf'&&/\.(?:skf|sktl|sksc|skls)$/i.test(p.name))){
    const xml=readSnapshotPart({snapshot:loaded.snapshot,name:part.name}).text;
    if(/<!DOCTYPE/i.test(xml))throw Error('DOCTYPE is not supported');
    if(hasXmlReference(xml,pattern))throw Error('Node has a reference in another show part');
   }
  }else{
   if(!newNodeId||!idPattern.test(newNodeId)||ids.has(newNodeId)||format==='skshow'&&showNodeIdExists(loaded.snapshot,newNodeId))throw Error('New node ID must be valid and unused');
   const copy=copyNodeXml(loaded.xml,node,newNodeId);modified=loaded.xml.slice(0,node.end)+'\n    '+copy+loaded.xml.slice(node.end);
   const at=parsed.nodes.findIndex(n=>n.id===nodeId);expectedNodes=[...parsed.nodes.slice(0,at+1),{...parsed.nodes[at],id:newNodeId},...parsed.nodes.slice(at+1)];
  }
 }else if(operation==='add_connection'||operation==='remove_connection'){
  if(!connection||!idPattern.test(connection.fromNode||'')||!idPattern.test(connection.toNode||'')||!Number.isSafeInteger(connection.fromPin)||connection.fromPin<0||!Number.isSafeInteger(connection.toPin)||connection.toPin<0)throw Error('Connection requires valid node IDs and nonnegative integer pins');
  const {fromNode,fromPin,toNode,toPin}=connection;if(!ids.has(fromNode)||!ids.has(toNode))throw Error('Connection nodes must exist');
  const attrs={fromNode,fromPin:String(fromPin),toNode,toPin:String(toPin)},equal=c=>Object.entries(attrs).every(([k,v])=>c[k]===v);const count=parsed.connections.filter(equal).length;
  if(operation==='add_connection'){
   if(count)throw Error('Connection already exists');const entry=`<connection fromNode="${fromNode}" fromPin="${fromPin}" toNode="${toNode}" toPin="${toPin}"/>`;
   modified=loaded.xml.slice(0,graph.closeStart)+'    '+entry+'\n  '+loaded.xml.slice(graph.closeStart);expectedConnections=[...parsed.connections,attrs];
  }else{
   if(count!==1)throw Error('Connection must exist exactly once');const elements=selectXmlSpans(root,['showkontrol','graph',{name:'connection',attributes:attrs}]);if(elements.length!==1)throw Error('Unsupported or ambiguous connection serialization');const m=elements[0];modified=loaded.xml.slice(0,m.start)+loaded.xml.slice(m.end);expectedConnections=parsed.connections.filter(c=>!equal(c));
  }
 }else throw Error('Unsupported graph operation');
 const checked=parsePatch(modified);if(JSON.stringify(checked.nodes)!==JSON.stringify(expectedNodes)||JSON.stringify(checked.connections)!==JSON.stringify(expectedConnections))throw Error('Graph edit did not produce expected result');
 const args={source,destination,sha256,edits:[{find:loaded.xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name:'patch.skf'}):await editXmlCopy(args);
 return {...result,operation,note:'Graph XML changed in an offline copy. Node and pin compatibility, unique input occupancy, and ShowKontrol acceptance are not validated. Duplicated nodes keep their settings, title and position.'};
}
export async function copyPatchNode({source,destination,format,sha256,template,templateFormat,templateSha256,nodeId,newNodeId}){
 const idPattern=/^[A-Za-z0-9_.:-]+$/;if(!nodeId||!idPattern.test(nodeId)||!newNodeId||!idPattern.test(newNodeId))throw Error('Node IDs contain unsupported characters');
 const [target,donor]=await Promise.all([sourceData(source,format),sourceData(template,templateFormat)]);if(target.sha256!==sha256)throw Error('Destination source changed since inspection');if(donor.sha256!==templateSha256)throw Error('Template source changed since inspection');
 const targetPatch=parsePatch(target.xml),donorPatch=parsePatch(donor.xml),targetIds=validateConnections(targetPatch);if(targetIds.has(newNodeId)||format==='skshow'&&showNodeIdExists(target.snapshot,newNodeId))throw Error('New node ID must be unused');
 const donorNode=donorPatch.nodes.find(n=>n.id===nodeId);if(!donorNode)throw Error('Template node ID does not exist');const {root:donorRoot}=patchGraphSpans(donor.xml),{graph:targetGraph}=patchGraphSpans(target.xml);
 const nodes=selectXmlSpans(donorRoot,['showkontrol','graph',{name:'node',attributes:{id:nodeId}}]);if(nodes.length!==1)throw Error('Cannot uniquely locate template node serialization');const copy=copyNodeXml(donor.xml,nodes[0],newNodeId);
 const modified=target.xml.slice(0,targetGraph.closeStart)+'    '+copy+'\n  '+target.xml.slice(targetGraph.closeStart),checked=parsePatch(modified);
 if(JSON.stringify(checked.nodes)!==JSON.stringify([...targetPatch.nodes,{...donorNode,id:newNodeId}])||JSON.stringify(checked.connections)!==JSON.stringify(targetPatch.connections))throw Error('Copied node did not match template');
 const args={source,destination,sha256,edits:[{find:target.xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name:'patch.skf'}):await editXmlCopy(args);
 return {...result,nodeId,newNodeId,note:'Copied the node XML only. Connections are not copied. Title, position, settings, and internal references are unchanged; names may collide. Dependencies, hardware, node compatibility, and ShowKontrol acceptance are not validated.'};
}
