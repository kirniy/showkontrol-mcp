import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(algorithm,data)=>createHash(algorithm).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
const data=result=>{assert.equal(result.isError,undefined);return JSON.parse(result.content[0].text);};

test('MCP composes and reads an ordered schedule, and rolls back failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-compose-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-compose-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const name='showkontrol_compose_program_schedule_copy',tool=(await client.listTools()).tools.find(tool=>tool.name===name);assert.ok(tool);
 const schema=tool.inputSchema;assert.deepEqual(new Set(schema.required),new Set(['source','destination','sha256','items']));assert.equal(schema.properties.items.maxItems,100);assert.equal(schema.properties.replaceExisting.type,'boolean');
 const item=schema.properties.items.items;assert.equal(item.additionalProperties,false);assert.deepEqual(new Set(item.required),new Set(['start','name','notes']));assert.equal(item.properties.timeline.properties.remapCueIds.type,'boolean');assert.equal(item.properties.graph.properties.settings.maxItems,100);
 const file=n=>path.join(dir,n),show=`<skshow>${part('note.txt','hello')}</skshow>`,donor='<sktimeline version="1"><layers/><cue id="c1"><graph><node id="n1" type="x"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 await Promise.all([writeFile(file('source.skshow'),show),writeFile(file('donor.sktl'),donor)]);
 const timeline={donor:file('donor.sktl'),donorSha256:hash('sha256',donor),remapCueIds:true},graph={donor:file('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'c1',settings:[{nodeId:'n1',key:'trigger.path',value:'item.active'}]};
 const args={source:file('source.skshow'),destination:file('out.skshow'),sha256:hash('sha256',show),items:[{start:0,name:'First',notes:'',timeline,graph},{start:1000,name:'Second',notes:'',timeline,graph}]};
 const result=data(await client.callTool({name,arguments:args}));assert.equal(result.sha256,hash('sha256',await readFile(args.destination)));assert.equal(new Set(result.mappings.flatMap(m=>[m.timeline.nodes.n1,m.graph.nodes.n1])).size,4);assert.notEqual(result.mappings[0].timeline.cues.c1,result.mappings[1].timeline.cues.c1);assert.ok(result.validation.diagnostics.every(d=>d.severity!=='error'));
 const inspected=data(await client.callTool({name:'showkontrol_inspect_show_program',arguments:{file:args.destination}}));assert.deepEqual(inspected.items.map(i=>i.name),['First','Second']);
 const readback=data(await client.callTool({name:'showkontrol_inspect_program_item_graph',arguments:{file:args.destination,sha256:result.sha256,index:1}}));assert.match(JSON.stringify(readback),/item.active/);assert.match(JSON.stringify(readback),new RegExp(result.mappings[1].graph.nodes.n1));
 const bad={...args,destination:file('failed.skshow'),items:[args.items[0],{...args.items[1],graph:{...graph,settings:[{nodeId:'n99',key:'trigger.path',value:'x'}]}}]};const failure=await client.callTool({name,arguments:bad});assert.equal(failure.isError,true);assert.match(failure.content[0].text,/node ID/i);await assert.rejects(readFile(bad.destination),{code:'ENOENT'});assert.equal(await readFile(args.source,'utf8'),show);assert.ok(!(await readdir(dir)).some(n=>n.startsWith('.showkontrol-compose-')));
});
