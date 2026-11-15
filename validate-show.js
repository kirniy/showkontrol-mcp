import {SaxesParser} from 'saxes';
import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {parseSetlist} from './setlist.js';
import {parsePatch} from './patch.js';
import {validateRouterTarget} from './patch-setting-to-cue.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
import {storedStoppedWarnings} from './composition-warnings.js';
import {inspectProgramBytes} from './program.js';

// This checks references and identifiers in supported native XML, not app behavior.
export async function validateShow({file}){
 const snapshot=await readShowSnapshot({file});
 const diagnostics=[],coverage=[],timelines=[],setlists=[],routerTargets=[],nodeIds=new Map();
 const add=(code,scope,message,severity='error')=>diagnostics.push({code,severity,scope,message});
 const validateTimelineCues=(root,baseScope,basePath,partCoverage)=>{
  const containers=root.children.filter(n=>n.name==='layers');
    const cues=root.children.filter(n=>n.name==='cue');
    const number=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    for(const [index,cue] of cues.entries()){
     const cueScope={...baseScope,path:`${basePath}/cue`,cueIndex:index,...(cue.attributes.id?{cueId:cue.attributes.id}:{})};
     for(const field of ['layer','startMs','lenMs']){
      const value=cue.attributes[field],fieldScope={...cueScope,field,value:value??null};
      if(value===undefined){if(partCoverage.status==='checked')partCoverage.status='partial';add('missing_cue_field',fieldScope,'Cue field is missing; this variant is not checked','warning');continue;}
      const n=Number(value);
      if(!number.test(value)||!Number.isFinite(n)||(field==='layer'&&(!Number.isInteger(n)||n<0))||(field==='startMs'&&n<0)||(field==='lenMs'&&n<=0)){
       add('invalid_cue_field',fieldScope,'Cue field does not meet the supported numeric constraints');continue;
      }
      if(field==='layer'){
       if(containers.length!==1){if(partCoverage.status==='checked')partCoverage.status='partial';add('ambiguous_cue_layers',fieldScope,'A single direct layers element is required to check the cue layer','warning');}
       else if(n>=containers[0].children.filter(child=>child.name==='layer').length)add('invalid_cue_field',fieldScope,'Cue layer is outside the direct layer count');
      }
     }
    }
    const visit=(node,path)=>{for(const child of node.children){const childPath=`${path}/${child.name}`;if(child.name==='cue'&&node!==root){if(partCoverage.status==='checked')partCoverage.status='partial';add('unsupported_cue', {...baseScope,path:childPath,...(child.attributes.id?{cueId:child.attributes.id}:{})},'Nested cue timing and layer are not checked','warning');}visit(child,childPath);}};
    visit(root,basePath);
 };
 const collectGraphRouterTargets=(graph,graphScope,xml)=>{
  const visit=(element,path)=>{
   if(element.name==='setting'&&element.attributes.key==='route.router_target'){
    const node=path[1]?.name==='node'?path[1]:null,parser=new SaxesParser();let value='';
    parser.on('text',v=>value+=v);parser.on('cdata',v=>value+=v);parser.write(xml.slice(element.start,element.end)).close();
    routerTargets.push({scope:{...graphScope,nodeId:node?.attributes.id??null},node,nodeType:node?.attributes.type,placed:path.map(n=>n.name).join('/')==='graph/node/settings/setting',tag:element,value,nested:element.children.length>0});
   }
   for(const child of element.children)visit(child,[...path,child]);
  };
  visit(graph,[graph]);
 };
 const names=new Map();for(const part of snapshot.parts)names.set(part.name,(names.get(part.name)||0)+1);
 for(const [name,count] of names)if(count>1)add('duplicate_part',{part:name},`Part name occurs ${count} times`);
 const programParts=snapshot.parts.filter(p=>p.name.toLowerCase()==='content/program.skpr');
 if(programParts.length>1&&new Set(programParts.map(p=>p.name)).size>1)add('duplicate_part',{part:'content/Program.skpr'},`Program part occurs ${programParts.length} times, ignoring case`);
 for(const part of snapshot.parts){
  const scope={part:part.name};
  if(!part.valid){coverage.push({...scope,status:'invalid_checksum'});add('invalid_md5',scope,'Part checksum does not match');continue;}
  if(names.get(part.name)>1||(part.name.toLowerCase()==='content/program.skpr'&&programParts.length>1)){coverage.push({...scope,status:'duplicate_name'});continue;}
  if(/\.skpr$/i.test(part.name)){
   const partCoverage={...scope,status:'partial'};coverage.push(partCoverage);
   if(part.name.toLowerCase()!=='content/program.skpr')add('unknown_program_part',scope,'Program part is at an unverified path','warning');
   try{
    const program=inspectProgramBytes(part.bytes);
    add('unverified_program_semantics',scope,'Program outer structure and selected timeline and graph fields are checked; application behavior, item order and media are not validated','warning');
    const xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(part.bytes),root=parseXmlSpans(xml);
    for(const item of program.items){
     if(item.hasGraph){
      const graph=root.children[item.index].children.find(child=>child.name==='graph');
      const graphScope={...scope,path:'skprogram/item/graph',itemIndex:item.index},local=new Set();
      add('unsupported_graph',graphScope,'Only direct node IDs, connection endpoints, numeric pins and router targets are checked; other graph contents are not checked','warning');
      collectGraphRouterTargets(graph,graphScope,xml);
      for(const node of graph.children.filter(child=>child.name==='node')){
       const id=node.attributes.id;
       if(!id){add('missing_node_id',graphScope,'Graph node has no ID');continue;}
       if(nodeIds.has(id))add('duplicate_node_id',{...graphScope,nodeId:id},`Node ID also occurs in ${nodeIds.get(id)}`);else nodeIds.set(id,part.name);
       local.add(id);
      }
      for(const connection of graph.children.filter(child=>child.name==='connection')){
       for(const endpoint of ['fromNode','toNode'])if(!connection.attributes[endpoint]||!local.has(connection.attributes[endpoint]))add('unknown_wire_endpoint',{...graphScope,endpoint,nodeId:connection.attributes[endpoint]??null},'Connection endpoint is not a node in this graph');
       for(const pin of ['fromPin','toPin'])if(!/^\d+$/.test(connection.attributes[pin]??''))add('invalid_wire_pin',{...graphScope,pin,value:connection.attributes[pin]??null},'Connection pin must contain digits');
      }
      const visit=node=>{for(const child of node.children){if(['graph','node','connection'].includes(child.name))add('unsupported_graph_structure',graphScope,`Nested ${child.name} is not checked`,'warning');visit(child);}};
      for(const child of graph.children){if(child.name==='graph')add('unsupported_graph_structure',graphScope,'Nested graph is not checked','warning');visit(child);}
     }
     if(item.hasTimeline){
      const timelineScope={...scope,itemIndex:item.index},basePath='skprogram/item/sktimeline';
      const timeline=root.children[item.index].children.find(child=>child.name==='sktimeline');
      add('unsupported_timeline',{...timelineScope,path:basePath},'Cue timing, layers, and direct cue graph IDs and wires are checked; other timeline contents and runtime behavior are not checked','warning');
      try{parseTimeline(xml.slice(timeline.start,timeline.end));}
      catch(error){add('invalid_native_xml',{...timelineScope,path:basePath},error.message);continue;}
      validateTimelineCues(timeline,timelineScope,basePath,partCoverage);
      const visitGraphs=(node,path,cue)=>{for(const child of node.children){
       const childPath=`${path}/${child.name}`,directCue=node===timeline&&child.name==='cue';
       const currentCue=directCue?child:cue;
       if(child.name==='graph'){
        const cueIndex=currentCue?timeline.children.filter(n=>n.name==='cue').indexOf(currentCue):-1;
        const graphScope={...timelineScope,path:childPath,...(cueIndex>=0?{cueIndex}:{}),...(currentCue?.attributes.id?{cueId:currentCue.attributes.id}:{})};
        const supported=node===currentCue&&timeline.children.includes(currentCue);
        if(!supported)add('unsupported_graph',graphScope,'Graph path is unsupported; graph contents are not checked','warning');
        else{
         collectGraphRouterTargets(child,graphScope,xml);
         const local=new Set();
         for(const graphNode of child.children.filter(n=>n.name==='node')){
          const id=graphNode.attributes.id;
          if(!id){add('missing_node_id',graphScope,'Graph node has no ID');continue;}
          if(nodeIds.has(id))add('duplicate_node_id',{...graphScope,nodeId:id},`Node ID also occurs in ${nodeIds.get(id)}`);else nodeIds.set(id,part.name);
          local.add(id);
         }
         for(const connection of child.children.filter(n=>n.name==='connection')){
          for(const endpoint of ['fromNode','toNode'])if(!connection.attributes[endpoint]||!local.has(connection.attributes[endpoint]))add('unknown_wire_endpoint',{...graphScope,endpoint,nodeId:connection.attributes[endpoint]??null},'Connection endpoint is not a node in this graph');
          for(const pin of ['fromPin','toPin'])if(!/^\d+$/.test(connection.attributes[pin]??''))add('invalid_wire_pin',{...graphScope,pin,value:connection.attributes[pin]??null},'Connection pin must contain digits');
         }
         const nested=n=>{for(const c of n.children){if(['graph','node','connection'].includes(c.name))add('unsupported_graph_structure',graphScope,`Nested ${c.name} is not checked`,'warning');nested(c);}};
         for(const c of child.children){if(c.name==='graph')add('unsupported_graph_structure',graphScope,'Nested graph is not checked','warning');nested(c);}
        }
       }else visitGraphs(child,childPath,currentCue);
      }};
      visitGraphs(timeline,basePath,null);
     }
    }
   }catch(error){partCoverage.status='invalid';add('invalid_native_xml',scope,error.message);}
   continue;
  }
  if(!/\.(?:skf|sktl|sksc|skls)$/i.test(part.name)){coverage.push({...scope,status:'ignored'});continue;}
  const partCoverage={...scope,status:/\.sksc$/i.test(part.name)?'partial':'checked'};coverage.push(partCoverage);
  if(/\.sksc$/i.test(part.name))add('unverified_scene_schema',scope,'Scene schema is not validated; graph IDs and connections are checked when present','warning');
  let xml;
  try{xml=readSnapshotPart({snapshot,name:part.name}).text;if(/<!DOCTYPE/i.test(xml))throw Error('DOCTYPE is not supported');}
  catch(error){partCoverage.status='invalid';add('invalid_part',scope,error.message);continue;}
  try{
   if(/\.sktl$/i.test(part.name)){
    const timeline=parseTimeline(xml);timelines.push({part:part.name,name:timeline.attributes.name??''});
    const root=parseXmlSpans(xml);
    diagnostics.push(...storedStoppedWarnings(xml,part.name,root));
    validateTimelineCues(root,scope,'sktimeline',partCoverage);
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
