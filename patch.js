import {SaxesParser} from 'saxes';
import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';

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
 const scopeRe=nodeId===undefined?/<appSettings\b[^>]*>[\s\S]*?<\/appSettings\s*>/g:/<node\b[^>]*>[\s\S]*?<\/node\s*>/g;
 const scopes=[...loaded.xml.matchAll(scopeRe)].filter(m=>nodeId===undefined||openingAttributes(m[0].slice(0,m[0].indexOf('>')+1)).id===nodeId);if(scopes.length!==1)throw Error('Cannot uniquely locate selected scope in source XML');
 const scope=scopes[0][0];const settingRe=/(<setting\b[^>]*>)([^<]*)(<\/setting\s*>)/g;
 const matches=[...scope.matchAll(settingRe)].filter(m=>openingAttributes(m[1]).key===key);if(matches.length!==1)throw Error('Unsupported or ambiguous setting serialization');
 const m=matches[0];const changed=scope.slice(0,m.index)+m[1]+escapeText(value)+m[3]+scope.slice(m.index+m[0].length);
 const args={source,destination,sha256,edits:[{find:scope,replace:changed}]};
 const result=format==='skshow'?await editShowPart({...args,name:'patch.skf'}):await editXmlCopy(args);
 return {...result,nodeId:nodeId??null,key,value,note:'Existing setting changed in an offline copy. Value semantics and ShowKontrol compatibility are not validated.'};
}

// These operations preserve the source serialization outside the graph element.
export async function editPatchGraphCopy({source,destination,format,sha256,operation,nodeId,newNodeId,connection}){
 const idPattern=/^[A-Za-z0-9_.:-]+$/;
 const loaded=await sourceData(source,format);if(loaded.sha256!==sha256)throw Error('Source changed since inspection');
 const parsed=parsePatch(loaded.xml);const ids=new Set(parsed.nodes.map(n=>n.id));
 for(const c of parsed.connections) if(!ids.has(c.fromNode)||!ids.has(c.toNode)||!/^\d+$/.test(c.fromPin||'')||!/^\d+$/.test(c.toPin||'')) throw Error('Existing graph has invalid connection references or pins');
 const graphs=[...loaded.xml.matchAll(/<graph\b[^>]*>[\s\S]*?<\/graph\s*>/g)];
 if(graphs.length!==1)throw Error('Cannot uniquely locate graph serialization');
 const graph=graphs[0][0];let changed;
 if(operation==='duplicate_node'||operation==='remove_node'){
  if(!nodeId||!idPattern.test(nodeId)||!ids.has(nodeId))throw Error('Node ID must identify an existing node');
  const nodes=[...graph.matchAll(/<node\b[^>]*>[\s\S]*?<\/node\s*>/g)].filter(m=>openingAttributes(m[0].slice(0,m[0].indexOf('>')+1)).id===nodeId);if(nodes.length!==1)throw Error('Cannot uniquely locate node serialization');
  const node=nodes[0][0];
  if(operation==='remove_node'){
   if(parsed.connections.some(c=>c.fromNode===nodeId||c.toNode===nodeId))throw Error('Remove all connections referencing this node first');
   changed=graph.slice(0,nodes[0].index)+graph.slice(nodes[0].index+node.length);
  }else{
   if(!newNodeId||!idPattern.test(newNodeId)||ids.has(newNodeId)||format==='skshow'&&showNodeIdExists(loaded.snapshot,newNodeId))throw Error('New node ID must be valid and unused');
   const start=node.indexOf('>');const opening=node.slice(0,start+1);
   const idAttr=new RegExp('(\\sid=["\\\'])'+escapeRegex(nodeId)+'(["\\\'])','g');
   if([...opening.matchAll(idAttr)].length!==1)throw Error('Cannot uniquely locate node ID attribute');
   const newOpening=opening.replace(idAttr,(_,a,b)=>a+newNodeId+b);if(openingAttributes(newOpening).id!==newNodeId)throw Error('Cannot uniquely locate node ID attribute');
   const copy=newOpening+node.slice(start+1);
   changed=graph.slice(0,nodes[0].index+node.length)+'\n    '+copy+graph.slice(nodes[0].index+node.length);
  }
 }else if(operation==='add_connection'||operation==='remove_connection'){
  if(!connection||!idPattern.test(connection.fromNode||'')||!idPattern.test(connection.toNode||'')||!Number.isSafeInteger(connection.fromPin)||connection.fromPin<0||!Number.isSafeInteger(connection.toPin)||connection.toPin<0)throw Error('Connection requires valid node IDs and nonnegative integer pins');
  const {fromNode,fromPin,toNode,toPin}=connection;
  if(!ids.has(fromNode)||!ids.has(toNode))throw Error('Connection nodes must exist');
  const equal=c=>c.fromNode===fromNode&&c.toNode===toNode&&c.fromPin===String(fromPin)&&c.toPin===String(toPin);
  const count=parsed.connections.filter(equal).length;
  if(operation==='add_connection'){
   if(count)throw Error('Connection already exists');
   const closing=graph.lastIndexOf('</graph');if(closing<0)throw Error('Cannot locate graph end');
   const entry=`<connection fromNode="${fromNode}" fromPin="${fromPin}" toNode="${toNode}" toPin="${toPin}"/>`;
   changed=graph.slice(0,closing)+'    '+entry+'\n  '+graph.slice(closing);
  }else{
   if(count!==1)throw Error('Connection must exist exactly once');
   const elements=[...graph.matchAll(/<connection\b[^>]*\/>/g)].filter(match=>{
    let attrs;const p=new SaxesParser();p.on('opentag',t=>attrs=t.attributes);p.write(match[0]).close();return equal(attrs);
   });
   if(elements.length!==1)throw Error('Unsupported or ambiguous connection serialization');
   const m=elements[0];changed=graph.slice(0,m.index)+graph.slice(m.index+m[0].length);
  }
 }else throw Error('Unsupported graph operation');
 const newXml=loaded.xml.slice(0,graphs[0].index)+changed+loaded.xml.slice(graphs[0].index+graph.length);
 parsePatch(newXml);
 const args={source,destination,sha256,edits:[{find:graph,replace:changed}]};
 const result=format==='skshow'?await editShowPart({...args,name:'patch.skf'}):await editXmlCopy(args);
 return {...result,operation,note:'Graph XML changed in an offline copy. Node and pin compatibility, unique input occupancy, and ShowKontrol acceptance are not validated. Duplicated nodes keep their settings, title and position.'};
}

export async function copyPatchNode({source,destination,format,sha256,template,templateFormat,templateSha256,nodeId,newNodeId}){
 const idPattern=/^[A-Za-z0-9_.:-]+$/;
 if(!nodeId||!idPattern.test(nodeId)||!newNodeId||!idPattern.test(newNodeId))throw Error('Node IDs contain unsupported characters');
 const [target,donor]=await Promise.all([sourceData(source,format),sourceData(template,templateFormat)]);
 if(target.sha256!==sha256)throw Error('Destination source changed since inspection');
 if(donor.sha256!==templateSha256)throw Error('Template source changed since inspection');
 const targetPatch=parsePatch(target.xml),donorPatch=parsePatch(donor.xml);
 const targetIds=new Set(targetPatch.nodes.map(n=>n.id));
 if(targetIds.has(newNodeId)||format==='skshow'&&showNodeIdExists(target.snapshot,newNodeId))throw Error('New node ID must be unused');
 if(!donorPatch.nodes.some(n=>n.id===nodeId))throw Error('Template node ID does not exist');
 for(const c of targetPatch.connections)if(!targetIds.has(c.fromNode)||!targetIds.has(c.toNode)||!/^\d+$/.test(c.fromPin||'')||!/^\d+$/.test(c.toPin||''))throw Error('Destination graph has invalid connection references or pins');
 const findGraph=xml=>{const graphs=[...xml.matchAll(/<graph\b[^>]*>[\s\S]*?<\/graph\s*>/g)];if(graphs.length!==1)throw Error('Cannot uniquely locate graph serialization');return graphs[0];};
 const sourceGraph=findGraph(donor.xml)[0];const targetGraph=findGraph(target.xml)[0];
 const nodes=[...sourceGraph.matchAll(/<node\b[^>]*>[\s\S]*?<\/node\s*>/g)].filter(m=>openingAttributes(m[0].slice(0,m[0].indexOf('>')+1)).id===nodeId);if(nodes.length!==1)throw Error('Cannot uniquely locate template node serialization');
 const node=nodes[0][0],end=node.indexOf('>'),opening=node.slice(0,end+1);
 const idRe=new RegExp('(\\sid=["\\\'])'+escapeRegex(nodeId)+'(["\\\'])','g');
 if([...opening.matchAll(idRe)].length!==1)throw Error('Cannot uniquely locate node ID attribute');
 const newOpening=opening.replace(idRe,(_,a,b)=>a+newNodeId+b);if(openingAttributes(newOpening).id!==newNodeId)throw Error('Cannot uniquely locate node ID attribute');
 const copy=newOpening+node.slice(end+1);
 const close=targetGraph.lastIndexOf('</graph');if(close<0)throw Error('Cannot locate graph end');
 const changed=targetGraph.slice(0,close)+'    '+copy+'\n  '+targetGraph.slice(close);
 const position=target.xml.indexOf(targetGraph);parsePatch(target.xml.slice(0,position)+changed+target.xml.slice(position+targetGraph.length));
 const args={source,destination,sha256,edits:[{find:targetGraph,replace:changed}]};
 const result=format==='skshow'?await editShowPart({...args,name:'patch.skf'}):await editXmlCopy(args);
 return {...result,nodeId,newNodeId,note:'Copied the node XML only. Connections are not copied. Title, position, settings, and internal references are unchanged; names may collide. Dependencies, hardware, node compatibility, and ShowKontrol acceptance are not validated.'};
}
