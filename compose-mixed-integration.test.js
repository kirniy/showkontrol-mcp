import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP composes mixed graphs on single and multiple tracks atomically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-compose-mixed-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),donor=path.join(dir,'donor.skshow'),patchPath=path.join(dir,'patch.skf');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const input=`<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="L"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 const donorXml=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n228" type="action" title="FeedbackNotify"><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.message">Stored action fixture</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(source,input),writeFile(donor,donorXml),writeFile(patchPath,patch)]);
 const hash=text=>createHash('sha256').update(text).digest('hex');
 const client=new Client({name:'compose-mixed-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args}),parse=r=>JSON.parse(r.content[0].text);
 const mixedGraph={nodes:[{kind:'cue',template:donor,templateSha256:hash(donorXml),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'},{kind:'patch',template:patchPath,templateSha256:hash(patch),templateFormat:'skf',nodeId:'n228'}],wires:[{from:0,to:1}]};
 const track={templateName:'content/Empty.sktl',trackName:'First',partName:'content/First.sktl',donor:{file:donor,sha256:hash(donorXml),name:'content/Donor.sktl',cueId:'src'},cues:[{layer:0,startMs:0,lengthMs:40,label:'Mixed',mixedGraph,settings:[{nodeIndex:1,key:'notify.message',value:'Changed'}]}]};
 const single=await call('showkontrol_compose_show_copy',{source,destination:path.join(dir,'single.skshow'),sha256:hash(input),...track});assert.equal(single.isError,undefined,JSON.stringify(single));
 const verify=async(file,result,name)=>{const read=await call('showkontrol_inspect_cue_graph',{file,format:'skshow',name,cueId:result.cues[0].id});const graph=parse(read).graph;assert.deepEqual(graph.nodes.map(n=>n.type),['trigger','action']);assert.deepEqual(result.cues[0].nodeIds,graph.nodes.map(n=>n.id));assert.deepEqual(graph.connections.map(({fromNode,toNode})=>({fromNode,toNode})),[{fromNode:result.cues[0].nodeIds[0],toNode:result.cues[0].nodeIds[1]}]);assert.equal(graph.nodes[1].settings.find(s=>s.key==='notify.message').value,'Changed');};
 await verify(path.join(dir,'single.skshow'),parse(single),track.partName);
 const multiPath=path.join(dir,'multi.skshow'),second={...track,trackName:'Second',partName:'content/Second.sktl'};
 const multi=await call('showkontrol_compose_multi_track_show_copy',{source,destination:multiPath,sha256:hash(input),tracks:[track,second]});assert.equal(multi.isError,undefined,JSON.stringify(multi));await verify(multiPath,parse(multi).tracks[1],second.partName);
 for(const cue of [{...track.cues[0],donor:null},{...track.cues[0],settings:[{nodeIndex:2,key:'notify.message',value:'x'}]},{...track.cues[0],mixedGraph:{...mixedGraph,nodes:[mixedGraph.nodes[0],{...mixedGraph.nodes[1],templateSha256:'0'.repeat(64)}]}}]){
  const failed=path.join(dir,'failed.skshow'),result=await call('showkontrol_compose_multi_track_show_copy',{source,destination:failed,sha256:hash(input),tracks:[track,{...second,cues:[cue]}]});assert.equal(result.isError,true,JSON.stringify(result));await assert.rejects(readFile(failed),/ENOENT/);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
 }
 assert.equal(await readFile(source,'utf8'),input);assert.equal(await readFile(donor,'utf8'),donorXml);assert.equal(await readFile(patchPath,'utf8'),patch);
});
