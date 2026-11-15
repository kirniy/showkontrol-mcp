import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(algorithm,b)=>createHash(algorithm).update(b).digest('hex');
test('MCP exposes the remapped Program graph copy and writes the remapped graph',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-remap-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-remap-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const name='showkontrol_copy_remapped_program_item_graph_copy', tools=await client.listTools(), tool=tools.tools.find(tool=>tool.name===name);
 assert.ok(tool);assert.deepEqual(new Set(tool.inputSchema.required),new Set(['source','destination','sha256','index','donor','donorSha256','donorCueId','target','targetSha256']));assert.equal(tool.inputSchema.properties.replaceExisting.type,'boolean');assert.equal(tool.inputSchema.properties.donorName.type,'string');
 const file=n=>path.join(dir,n), program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers/><cue id="other"><graph><node id="n7" type="x"/></graph></cue></sktimeline></item></skprogram>', donor='<sktimeline version="1"><layers/><cue id="c1"><graph><node id="n7" type="x"/><node id="n2" type="y"/><connection fromNode="n7" toNode="n2"/></graph></cue></sktimeline>', show=`<skshow><part name="content/Program.skpr" md5="${hash('md5',program)}">${Buffer.from(program).toString('base64')}</part></skshow>`;
 await Promise.all([writeFile(file('source.skpr'),program),writeFile(file('donor.sktl'),donor),writeFile(file('target.skshow'),show)]);
 const result=await client.callTool({name,arguments:{source:file('source.skpr'),destination:file('out.skpr'),sha256:hash('sha256',program),index:0,donor:file('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'c1',target:file('target.skshow'),targetSha256:hash('sha256',show)}});
 assert.equal(result.isError,undefined);const data=JSON.parse(result.content[0].text);assert.deepEqual(data.mapping,{n7:'n8',n2:'n9'});const output=await readFile(file('out.skpr'),'utf8');assert.equal(data.sha256,hash('sha256',output));assert.ok(output.includes('<node id="n7" type="x"/>'));assert.ok(output.includes('<connection fromNode="n8" toNode="n9"/>'));
});
