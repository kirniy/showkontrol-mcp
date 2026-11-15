import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
test('MCP composes a staged track and graph into a Program and rolls back failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'full-show-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donor=`<skshow>${part('Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 await writeFile(f('in.skshow'),input);await writeFile(f('donor.skshow'),donor);
 const client=new Client({name:'full-show-integration-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});const parse=response=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 const tool='showkontrol_compose_full_show_copy';
 const item={start:0,name:'Program Item',notes:'',timeline:{stagedShow:{trackIndex:0},remapCueIds:true},graph:{stagedShow:{trackIndex:0,cueIndex:0}}};
 const args={source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',input),tracks:[{templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',donor:{file:f('donor.skshow'),sha256:hash('sha256',donor),name:'Donor.sktl',cueId:'d'},cues:[{layer:0,startMs:0,lengthMs:100,label:'Cue'}]}],program:{items:[item]}};
 const result=parse(await call(tool,args));const cue=result.tracks[0].cues[0];assert.ok(result.program.mappings[0].timeline.cues[cue.id]);assert.ok(result.program.mappings[0].graph.nodes[cue.idMap.n1]);
 const program=parse(await call('showkontrol_inspect_show_program',{file:args.destination}));assert.equal(program.sha256,result.sha256);assert.equal(program.items[0].name,'Program Item');
 const graph=parse(await call('showkontrol_inspect_program_item_graph',{file:args.destination,sha256:result.sha256,index:0}));assert.match(JSON.stringify(graph),/cue.active/);assert.match(JSON.stringify(graph),new RegExp(result.program.mappings[0].graph.nodes[cue.idMap.n1]));
 const bad=f('bad.skshow');
 for(const program of [
  {items:[{...item,graph:{stagedShow:{trackIndex:0,cueIndex:0,cueId:'d'}}}]},
  {items:[{...item,timeline:{stagedShow:{trackIndex:-1}}}]},
  {items:[{...item,graph:{stagedShow:{trackIndex:0,cueIndex:8}}}]}
 ]){const response=await call(tool,{...args,destination:bad,program});assert.equal(response.isError,true,JSON.stringify(response));await assert.rejects(readFile(bad),{code:'ENOENT'});assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);}
 assert.equal(await readFile(f('in.skshow'),'utf8'),input);assert.equal(await readFile(f('donor.skshow'),'utf8'),donor);
});
