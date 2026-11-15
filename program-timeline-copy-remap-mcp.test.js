import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(algorithm,b)=>createHash(algorithm).update(b).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
test('MCP exposes remapped timeline embedding and reads back repeated donor cues',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-timeline-remap-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-timeline-remap-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const name='showkontrol_embed_remapped_program_timeline_copy',tool=(await client.listTools()).tools.find(tool=>tool.name===name);
 assert.ok(tool);assert.deepEqual(new Set(tool.inputSchema.required),new Set(['source','destination','sha256','index','donor','donorSha256','target','targetSha256']));assert.equal(tool.inputSchema.properties.remapCueIds.type,'boolean');assert.equal(tool.inputSchema.properties.replaceExisting.type,'boolean');assert.equal(tool.inputSchema.properties.donorName.type,'string');
 const file=n=>path.join(dir,n),program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>',donor='<sktimeline version="1"><layers/><cue id="c1"><graph><node id="n1" type="x"/><node id="n2" type="y"/><connection fromNode="n1" toNode="n2"/></graph></cue></sktimeline>',show=`<skshow>${part('donor.sktl',donor)}</skshow>`;
 await Promise.all([writeFile(file('source.skpr'),program),writeFile(file('donor.sktl'),donor),writeFile(file('target.skshow'),show)]);
 const base={source:file('source.skpr'),destination:file('first.skpr'),sha256:hash('sha256',program),index:0,donor:file('donor.sktl'),donorSha256:hash('sha256',donor),target:file('target.skshow'),targetSha256:hash('sha256',show),remapCueIds:true};
 const call=async args=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 const first=await call(base),second=await call({...base,source:base.destination,sha256:first.sha256,index:1,destination:file('second.skpr')});
 assert.match(first.cueMapping.c1,/^c\d+_\d+$/);assert.notEqual(first.cueMapping.c1,second.cueMapping.c1);assert.notEqual(first.mapping.n1,second.mapping.n1);
 const output=await readFile(file('second.skpr'),'utf8');assert.equal(hash('sha256',output),second.sha256);assert.ok(output.includes(`fromNode="${second.mapping.n1}" toNode="${second.mapping.n2}"`));
 for(const [index,expected] of [[0,first.cueMapping.c1],[1,second.cueMapping.c1]]){const result=await client.callTool({name:'showkontrol_inspect_program_timeline',arguments:{file:file('second.skpr'),sha256:second.sha256,index}});assert.equal(result.isError,undefined,JSON.stringify(result));const data=JSON.parse(result.content[0].text);assert.equal(data.cueElements[0].attributes.id,expected);}
});
