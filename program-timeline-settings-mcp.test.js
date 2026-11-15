import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(algorithm,data)=>createHash(algorithm).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;

test('MCP composes per-item timeline settings and reads them back',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-timeline-settings-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'timeline-settings-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const call=async(name,args)=>{const result=await client.callTool({name:`showkontrol_${name}`,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 const tool=(await client.listTools()).tools.find(t=>t.name==='showkontrol_compose_program_schedule_copy');assert.ok(tool);const schema=tool.inputSchema.properties.items.items.properties.timeline.properties.settings;assert.equal(schema.maxItems,100);assert.deepEqual(new Set(schema.items.required),new Set(['cueId','nodeId','key','value']));assert.equal(schema.items.additionalProperties,false);
 const file=n=>path.join(dir,n);const show=`<skshow>${part('note.txt','hello')}</skshow>`;const donor='<sktimeline version="1"><layers/><cue id="c1"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 await Promise.all([writeFile(file('source.skshow'),show),writeFile(file('donor.sktl'),donor)]);
 const values=['item.first','item.second'];const items=values.map((value,index)=>({start:index,name:`Item ${index}`,notes:'',timeline:{donor:file('donor.sktl'),donorSha256:hash('sha256',donor),remapCueIds:true,settings:[{cueId:'c1',nodeId:'n1',key:'trigger.path',value}]}}));
 const output=file('output.skshow');const result=await call('compose_program_schedule_copy',{source:file('source.skshow'),destination:output,sha256:hash('sha256',show),items});
 assert.notEqual(result.mappings[0].timeline.cues.c1,result.mappings[1].timeline.cues.c1);assert.notEqual(result.mappings[0].timeline.nodes.n1,result.mappings[1].timeline.nodes.n1);
 for(const [index,value] of values.entries()){const extracted=file(`timeline-${index}.sktl`);await call('extract_program_timeline_copy',{source:output,destination:extracted,sha256:result.sha256,index});const graph=await call('inspect_cue_graph',{file:extracted,format:'sktl',cueId:result.mappings[index].timeline.cues.c1});const node=graph.graph.nodes.find(n=>n.id===result.mappings[index].timeline.nodes.n1);assert.ok(node);assert.equal(node.settings.find(s=>s.key==='trigger.path').value,value);}
 assert.equal(await readFile(file('donor.sktl'),'utf8'),donor);assert.equal(await readFile(file('source.skshow'),'utf8'),show);
});
