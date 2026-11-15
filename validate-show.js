import {SaxesParser} from 'saxes';
import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {parseSetlist} from './setlist.js';
import {parsePatch} from './patch.js';
import {validateRouterTarget} from './patch-setting-to-cue.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';

// This checks references and identifiers in supported native XML, not app behavior.
export async function validateShow({file}){
 const snapshot=await readShowSnapshot({file});
 const diagnostics=[],coverage=[],timelines=[],setlists=[],routerTargets=[],nodeIds=new Map();
 const add=(code,scope,message,severity='error')=>diagnostics.push({code,severity,scope,message});
 const names=new Map();for(const part of snapshot.parts)names.set(part.name,(names.get(part.name)||0)+1);
 for(const [name,count] of names)if(count>1)add('duplicate_part',{part:name},`Part name occurs ${count} times`);
 for(const part of snapshot.parts){
  const scope={part:part.name};
  if(!part.valid){coverage.push({...scope,status:'invalid_checksum'});add('invalid_md5',scope,'Part checksum does not match');continue;}
  if(names.get(part.name)>1){coverage.push({...scope,status:'duplicate_name'});continue;}
  if(!/\.(?:skf|sktl|sksc|skls)$/i.test(part.name)){coverage.push({...scope,status:'ignored'});continue;}
  const partCoverage={...scope,status:/\.sksc$/i.test(part.name)?'partial':'checked'};coverage.push(partCoverage);
  if(/\.sksc$/i.test(part.name))add('unverified_scene_schema',scope,'Scene schema is not validated; graph IDs and connections are checked when present','warning');
  let xml;
  try{xml=readSnapshotPart({snapshot,name:part.name}).text;if(/<!DOCTYPE/i.test(xml))throw Error('DOCTYPE is not supported');}
  catch(error){partCoverage.status='invalid';add('invalid_part',scope,error.message);continue;}
  try{
   if(/\.sktl$/i.test(part.name)){
    const timeline=parseTimeline(xml);timelines.push({part:part.name,name:timeline.attributes.name??''});
   }
   if(/\.skls$/i.test(part.name))setlists.push({part:part.name,sets:parseSetlist(xml)});
   if(!/\.(?:skf|sktl|sksc)$/i.test(part.name))continue;
   if(/\.skf$/i.test(part.name))try{parsePatch(xml);}catch(error){partCoverage.status='invalid';add('invalid_patch',scope,error.message);}
   const graphParser=new SaxesParser(),tagStack=[],parsedGraphs=[];let graph=null;
   graphParser.on('opentag',tag=>{
    const parent=tagStack.at(-1);tagStack.push(tag);
    if(tag.name==='graph'){
     if(graph)throw Error('Nested graphs are unsupported');
     graph={scope:{part:part.name,path:tagStack.map(t=>t.name).join('/'),...(parent?.name==='cue'&&parent.attributes.id?{cueId:parent.attributes.id}:{})},nodes:[],connections:[],supported:(/\.skf$/i.test(part.name)&&tagStack.map(t=>t.name).join('/')==='showkontrol/graph')||(/\.sktl$/i.test(part.name)&&tagStack.map(t=>t.name).join('/')==='sktimeline/cue/graph')};parsedGraphs.push(graph);
    }else if(graph&&parent?.name==='graph'&&tag.name==='node')graph.nodes.push(tag.attributes.id);
    else if(graph&&parent?.name==='graph'&&tag.name==='connection')graph.connections.push({...tag.attributes});
    if(graph?.supported&&tag.name==='setting'&&tag.attributes.key==='route.router_target'){const graphIndex=tagStack.findIndex(t=>t.name==='graph'),node=tagStack[graphIndex+1],placed=tagStack.slice(graphIndex).map(t=>t.name);routerTargets.push({scope:{...graph.scope,nodeId:node?.name==='node'?node.attributes.id??null:null},node:node?.name==='node'?node:null,nodeType:node?.attributes.type,placed:placed.join('/')==='graph/node/settings/setting',tag,depth:tagStack.length,value:'',nested:false});}
    for(const target of routerTargets)if(target.active&&tagStack.length>target.depth)target.nested=true;
    const target=routerTargets.at(-1);if(target?.tag===tag)target.active=true;
   });
   const append=value=>{for(const target of routerTargets)if(target.active)target.value+=value;};graphParser.on('text',append);graphParser.on('cdata',append);
   graphParser.on('closetag',tag=>{for(const target of routerTargets)if(target.active&&target.depth===tagStack.length)target.active=false;if(tag.name==='graph')graph=null;tagStack.pop()});graphParser.write(xml).close();
   for(const g of parsedGraphs){
    if(!g.supported){if(partCoverage.status==='checked')partCoverage.status='partial';add('unsupported_graph',g.scope,'Graph path is unsupported; router target and pin checks are incomplete','warning');}
    const local=new Set();
    for(const id of g.nodes){
     if(!id){add('missing_node_id',g.scope,'Graph node has no ID');continue;}
     if(nodeIds.has(id))add('duplicate_node_id',{...g.scope,nodeId:id},`Node ID also occurs in ${nodeIds.get(id)}`);else nodeIds.set(id,part.name);
     local.add(id);
    }
    for(const connection of g.connections){for(const endpoint of ['fromNode','toNode'])if(!connection[endpoint]||!local.has(connection[endpoint]))add('unknown_wire_endpoint',{...g.scope,endpoint,nodeId:connection[endpoint]??null},'Connection endpoint is not a node in this graph');
     if(g.supported)for(const pin of ['fromPin','toPin'])if(!/^\d+$/.test(connection[pin]??''))add('invalid_wire_pin',{...g.scope,pin,value:connection[pin]??null},'Connection pin must contain digits');}
   }
  }catch(error){partCoverage.status='invalid';add('invalid_native_xml',scope,error.message);}
 }
 for(const target of routerTargets){
  const {scope,value,tag,nested,nodeType,node,placed}=target;
  if(!placed||routerTargets.filter(t=>t.node&&t.node===node).length>1||nodeType!=='action'||nested||Object.keys(tag.attributes).length!==1||!value||value.trim()!==value){add('invalid_router_target',scope,'Router target setting is invalid');continue;}
  try{const patches=snapshot.parts.filter(p=>p.name==='patch.skf');if(patches.length!==1||!patches[0].valid)throw Error('Destination patch is missing, ambiguous or has an invalid checksum');validateRouterTarget(snapshot,value);}
  catch(error){
   if(error.message==='Router target must match exactly one router name in the destination patch'){
    try{const xml=readSnapshotPart({snapshot,name:'patch.skf'}).text,root=parseXmlSpans(xml),nodes=selectXmlSpans(root,['showkontrol','graph','node']);let count=0;
     for(const node of nodes.filter(n=>n.attributes.type==='router'))for(const settings of node.children.filter(n=>n.name==='settings'))for(const name of settings.children.filter(n=>n.name==='setting'&&n.attributes.key==='router.name')){let text='';const parser=new SaxesParser();parser.on('text',v=>text+=v);parser.on('cdata',v=>text+=v);parser.write(xml.slice(name.start,name.end)).close();if(text===value)count++;}
     add(count?'ambiguous_router_target':'missing_router_target',scope,count?'Router target matches multiple router names':'Router target does not match a router name');
    }catch{add('invalid_router_target',scope,'Router target could not be checked against the patch');}
   }else add('invalid_router_target',scope,`Router target could not be checked: ${error.message}`);
  }
 }
 for(const setlist of setlists)for(const set of setlist.sets)for(const track of set.tracks){
  const matches=timelines.filter(timeline=>timeline.name===track),scope={part:setlist.part,set:set.name,track};
  if(matches.length===0)add('missing_track',scope,'Set track does not match a timeline name');
  else if(matches.length>1)add('ambiguous_track',scope,`Set track matches ${matches.length} timelines`);
 }
 return {file,sha256:snapshot.sha256,coverage,diagnostics,note:'Checks native XML references only; ShowKontrol compatibility is not validated.'};
}
