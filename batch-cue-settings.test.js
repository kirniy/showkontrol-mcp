import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShow} from './xml-copy.js';import {editCueGraphSettingsShowCopy} from './batch-cue-settings.js';

test('batch setting MCP edits across timelines and fails without publishing or leaving temporary files',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),failed=path.join(dir,'failed.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline=id=>`<sktimeline version="1"><cue id="${id}"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node><node id="n2" type="action"><settings><setting key="action.category">old</setting></settings></node></graph></cue></sktimeline>`;
 const original=`<skshow>${part('content/A.sktl',timeline('a'))}${part('content/B.sktl',timeline('b'))}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`;await writeFile(source,original);
 const client=new Client({name:'batch-settings-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 assert.ok((await client.listTools()).tools.some(tool=>tool.name==='showkontrol_edit_cue_graph_settings_show_copy'));
 const call=(name,args)=>client.callTool({name,arguments:args}),parse=r=>JSON.parse(r.content[0].text);
 const settings=[{name:'content/A.sktl',cueId:'a',nodeId:'n1',key:'trigger.path',value:'new & value'},{name:'content/A.sktl',cueId:'a',nodeId:'n2',key:'action.category',value:'Application'},{name:'content/B.sktl',cueId:'b',nodeId:'n1',key:'trigger.path',value:'other'}];
 const {sha256}=await inspectShow({file:source});const base={source,sha256,settings};
 const result=await call('showkontrol_edit_cue_graph_settings_show_copy',{...base,destination});assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(parse(result).settings.length,3);
 for(const [name,cueId,expected] of [['content/A.sktl','a',['new & value','Application']],['content/B.sktl','b',['other','old']]]){
  const graph=await call('showkontrol_inspect_cue_graph',{file:destination,format:'skshow',name,cueId});assert.deepEqual(parse(graph).graph.nodes.map(n=>n.settings[0].value),expected);
 }
 const bad=await call('showkontrol_edit_cue_graph_settings_show_copy',{...base,destination:failed,settings:[settings[0],{...settings[1],key:'missing'}]});assert.equal(bad.isError,true);await assert.rejects(readFile(failed),/ENOENT/);
 await assert.rejects(editCueGraphSettingsShowCopy({...base,destination:failed,sha256:'0'.repeat(64)}),/changed/i);
 await assert.rejects(editCueGraphSettingsShowCopy({...base,destination}),/EEXIST/);
 assert.equal(await readFile(source,'utf8'),original);assert.equal((await readdir(dir)).some(name=>name.startsWith('.showkontrol-settings-')),false);
});
