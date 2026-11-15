import {inspectXml,editXmlCopy,readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';

function graphInfo(xml,cueId){
 const root=parseXmlSpans(xml),path=['sktimeline',{name:'cue',attributes:{id:cueId}}];
 if(root.name!=='sktimeline'||root.attributes.version!=='1')throw Error('Expected a version 1 sktimeline');
 const cues=selectXmlSpans(root,path),graphs=selectXmlSpans(root,[...path,'graph']);if(cues.length!==1||graphs.length!==1||graphs[0].selfClosing)throw Error('Cue and nonempty graph must occur exactly once');
 const nodes=selectXmlSpans(root,[...path,'graph','node']),connections=selectXmlSpans(root,[...path,'graph','connection']);
 const ids=new Set();for(const n of nodes){if(!n.attributes.id||ids.has(n.attributes.id))throw Error('Missing or duplicate graph node ID');ids.add(n.attributes.id);}
 for(const c of connections){const a=c.attributes;if(!ids.has(a.fromNode)||!ids.has(a.toNode)||!/^(?:0|[1-9]\d*)$/.test(a.fromPin||'')||!/^(?:0|[1-9]\d*)$/.test(a.toPin||''))throw Error('Graph has invalid connection references or pins');}
 return {graph:graphs[0],nodes,connections};
}
export async function editCueGraphWireCopy({source,destination,format,sha256,name,cueId,operation,fromNode,toNode}){
 if(!['sktl','skshow'].includes(format))throw Error('Format must be sktl or skshow');
 if(!['add','remove'].includes(operation))throw Error('Operation must be add or remove');
 if(typeof cueId!=='string'||!cueId||!/^[A-Za-z0-9_.:-]+$/.test(fromNode||'')||!/^[A-Za-z0-9_.:-]+$/.test(toNode||''))throw Error('Valid cue and node IDs are required');
 let xml,actual;if(format==='skshow'){
  if(!name||!name.toLowerCase().endsWith('.sktl'))throw Error('Select a .sktl part');const show=await readShowSnapshot({file:source});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');actual=show.sha256;xml=readSnapshotPart({snapshot:show,name}).text;
 }else ({xml,sha256:actual}=await inspectXml({file:source}));
 if(actual!==sha256)throw Error('Source changed since inspection');
 const before=graphInfo(xml,cueId),from=before.nodes.find(n=>n.attributes.id===fromNode),to=before.nodes.find(n=>n.attributes.id===toNode);if(!from||!to)throw Error('Both connection nodes must exist');
 if(!((from.attributes.type==='groupin'&&to.attributes.type==='trigger')||(from.attributes.type==='trigger'&&to.attributes.type==='action')))throw Error('Only fixture-supported groupin-to-trigger or trigger-to-action connections are supported');
 const equal=a=>a.fromNode===fromNode&&a.fromPin==='0'&&a.toNode===toNode&&a.toPin==='0',matching=before.connections.filter(c=>equal(c.attributes));let modified;
 if(operation==='add'){
  if(matching.length)throw Error('Connection already exists');if(before.connections.some(c=>c.attributes.toNode===toNode&&c.attributes.toPin==='0'))throw Error('Target input is already connected');
  const entry=`<connection fromNode="${fromNode}" fromPin="0" toNode="${toNode}" toPin="0"/>`;modified=xml.slice(0,before.graph.closeStart)+entry+xml.slice(before.graph.closeStart);
 }else{
  if(matching.length!==1)throw Error('Connection must exist exactly once');const match=matching[0];modified=xml.slice(0,match.start)+xml.slice(match.end);
 }
 const after=graphInfo(modified,cueId),actualCount=after.connections.filter(c=>equal(c.attributes)).length;
 if(actualCount!==(operation==='add'?1:0)||after.connections.length!==before.connections.length+(operation==='add'?1:-1)||JSON.stringify(after.nodes.map(n=>n.attributes))!==JSON.stringify(before.nodes.map(n=>n.attributes)))throw Error('Graph wire edit did not produce expected result');
 const args={source,destination,sha256,edits:[{find:xml,replace:modified}]};const result=format==='skshow'?await editShowPart({...args,name}):await editXmlCopy(args);
 return {...result,cueId,operation,fromNode,fromPin:0,toNode,toPin:0,note:'Changed a fixture-supported pin 0 connection in an offline cue graph. Validate operation in ShowKontrol.'};
}
