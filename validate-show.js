import {SaxesParser} from 'saxes';
import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {parseSetlist} from './setlist.js';
import {parsePatch} from './patch.js';

// This checks references and identifiers in supported native XML, not app behavior.
export async function validateShow({file}){
 const snapshot=await readShowSnapshot({file});
 const diagnostics=[],coverage=[],timelines=[],setlists=[],nodeIds=new Map();
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
     graph={scope:{part:part.name,path:tagStack.map(t=>t.name).join('/'),...(parent?.name==='cue'&&parent.attributes.id?{cueId:parent.attributes.id}:{})},nodes:[],connections:[]};parsedGraphs.push(graph);
    }else if(graph&&parent?.name==='graph'&&tag.name==='node')graph.nodes.push(tag.attributes.id);
    else if(graph&&parent?.name==='graph'&&tag.name==='connection')graph.connections.push({...tag.attributes});
   });
   graphParser.on('closetag',tag=>{if(tag.name==='graph')graph=null;tagStack.pop()});graphParser.write(xml).close();
   for(const g of parsedGraphs){
    const local=new Set();
    for(const id of g.nodes){
     if(!id){add('missing_node_id',g.scope,'Graph node has no ID');continue;}
     if(nodeIds.has(id))add('duplicate_node_id',{...g.scope,nodeId:id},`Node ID also occurs in ${nodeIds.get(id)}`);else nodeIds.set(id,part.name);
     local.add(id);
    }
    for(const connection of g.connections)for(const endpoint of ['fromNode','toNode'])if(!connection[endpoint]||!local.has(connection[endpoint]))add('unknown_wire_endpoint',{...g.scope,endpoint,nodeId:connection[endpoint]??null},'Connection endpoint is not a node in this graph');
   }
  }catch(error){partCoverage.status='invalid';add('invalid_native_xml',scope,error.message);}
 }
 for(const setlist of setlists)for(const set of setlist.sets)for(const track of set.tracks){
  const matches=timelines.filter(timeline=>timeline.name===track),scope={part:setlist.part,set:set.name,track};
  if(matches.length===0)add('missing_track',scope,'Set track does not match a timeline name');
  else if(matches.length>1)add('ambiguous_track',scope,`Set track matches ${matches.length} timelines`);
 }
 return {file,sha256:snapshot.sha256,coverage,diagnostics,note:'Checks native XML references only; ShowKontrol compatibility is not validated.'};
}
