import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('MCP edits one Program graph setting and rejects unsafe edits',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-setting-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 assert.ok((await client.listTools()).tools.some(x=>x.name==='showkontrol_edit_program_item_graph_setting_copy'));
 const call=args=>client.callTool({name:'showkontrol_edit_program_item_graph_setting_copy',arguments:args});
 const file=n=>path.join(dir,n),source=file('in.skpr'),destination=file('out.skpr');
 const xml='\ufeff<?xml version="1.0"?><skprogram version="1"><item start="1" name="A" notes=""><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="trigger.path">cue.active</setting><setting key="node.stopped">true</setting></settings></node></graph><sktimeline version="1"><layers/></sktimeline></item><item start="2" name="B" notes=""/></skprogram>';
 await writeFile(source,xml);const args={source,destination,sha256:hash(xml),index:0,nodeId:'n1',key:'trigger.path',value:'item.active'};
 assert.equal((await call(args)).isError,undefined);assert.equal(await readFile(destination,'utf8'),xml.replace('cue.active','item.active'));
 assert.equal((await call(args)).isError,true);assert.equal(await readFile(destination,'utf8'),xml.replace('cue.active','item.active'));
 const stopped=file('stopped.skpr');assert.equal((await call({...args,destination:stopped,key:'node.stopped',value:'false'})).isError,undefined);assert.equal(await readFile(stopped,'utf8'),xml.replace('stopped="1"','stopped="0"').replace('>true</setting>','>false</setting>'));
 for(const [name,override] of [['hash',{sha256:'0'.repeat(64)}],['index',{index:1}],['node',{nodeId:'missing'}],['key',{key:'missing'}],['stopped',{key:'node.stopped',value:'no'}]]){
  const target=file('bad-'+name+'.skpr');assert.equal((await call({...args,...override,destination:target})).isError,true);await assert.rejects(readFile(target),{code:'ENOENT'});
 }
 for(const [name,modified] of [['duplicate-node',xml.replace('</graph>','<node id="n1"/></graph>')],['duplicate-setting',xml.replace('</settings>','<setting key="trigger.path">other</setting></settings>')],['nested-setting',xml.replace('<setting key="trigger.path">cue.active</setting>','<other><setting key="trigger.path">cue.active</setting></other>')],['nested-value',xml.replace('cue.active','<x/>')],['value-attribute',xml.replace('key="trigger.path"','key="trigger.path" value="cue.active"')]]){
  const input=file(name+'-in.skpr'),target=file(name+'.skpr');await writeFile(input,modified);assert.equal((await call({...args,source:input,sha256:hash(modified),destination:target})).isError,true);await assert.rejects(readFile(target),{code:'ENOENT'});
 }
});
