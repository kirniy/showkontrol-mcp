import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP discovers and edits an existing cue graph setting',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-setting-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline='<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0.0" lenMs="40.0" label="Cue"><graph><node id="n155" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 await writeFile(source,`<skshow>${part('content/Track.sktl',timeline)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`);
 const client=new Client({name:'cue-setting-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 assert.ok((await client.listTools()).tools.some(t=>t.name==='showkontrol_edit_cue_graph_setting_copy'));
 const call=(name,args)=>client.callTool({name,arguments:args}), parse=r=>JSON.parse(r.content[0].text);const common={format:'skshow',name:'content/Track.sktl',cueId:'c1'};
 const before=await call('showkontrol_inspect_cue_graph',{file:source,...common});assert.equal(before.isError,undefined);
 const edited=await call('showkontrol_edit_cue_graph_setting_copy',{source,destination,sha256:parse(before).sha256,...common,nodeId:'n155',key:'trigger.on',value:'State Off'});assert.equal(edited.isError,undefined);
 const after=await call('showkontrol_inspect_cue_graph',{file:destination,...common});assert.equal(after.isError,undefined);assert.equal(parse(after).graph.nodes[0].settings.find(s=>s.key==='trigger.on').value,'State Off');
});
