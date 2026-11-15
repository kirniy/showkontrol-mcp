import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShowTimeline,inspectCueGraph} from './timeline.js';

test('MCP cue edits are ordered, atomic, checksum guarded and preserve graphs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-edits-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline=id=>`<sktimeline version="1"><layers><layer/><layer/></layers><cue id="${id}" layer="0" startMs="0" lenMs="40" label="Old"><graph><node id="node1" type="groupin"><settings/></node></graph></cue></sktimeline>`;
 const patch=part('patch.skf','<showkontrol version="2"/>');const original=`<skshow>${part('a.sktl',timeline('a'))}${part('b.sktl',timeline('b'))}${patch}</skshow>`;await writeFile(source,original);
 const client=new Client({name:'cue-edits-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tool='showkontrol_edit_show_timeline_cues_copy';assert.ok((await client.listTools()).tools.some(t=>t.name===tool));
 const call=args=>client.callTool({name:tool,arguments:args}),parse=r=>JSON.parse(r.content[0].text);
 const {sha256}=await inspectShowTimeline({file:source,name:'a.sktl'});
 const edits=[{name:'a.sktl',cueId:'a',label:'First',layer:1},{name:'b.sktl',cueId:'b',startMs:100,lengthMs:200},{name:'a.sktl',cueId:'a',label:'Final & cue'}];
 const result=await call({source,destination,sha256,edits});assert.equal(result.isError,undefined,JSON.stringify(result));
 const a=await inspectShowTimeline({file:destination,name:'a.sktl'}),b=await inspectShowTimeline({file:destination,name:'b.sktl'});
 assert.equal(a.sha256,parse(result).sha256);assert.equal(a.cueElements[0].attributes.label,'Final & cue');assert.equal(a.cueElements[0].attributes.layer,'1');assert.equal(b.cueElements[0].attributes.startMs,'100');assert.equal(b.cueElements[0].attributes.lenMs,'200');
 for(const [name,cueId] of [['a.sktl','a'],['b.sktl','b']])assert.deepEqual((await inspectCueGraph({file:destination,format:'skshow',name,cueId})).graph,(await inspectCueGraph({file:source,format:'skshow',name,cueId})).graph);
 const saved=await readFile(destination,'utf8');assert.ok(saved.includes(patch));
 assert.equal((await call({source,destination,sha256,edits})).isError,true);assert.equal(await readFile(destination,'utf8'),saved);
 const failed=path.join(dir,'failed.skshow');assert.equal((await call({source,destination:failed,sha256,edits:[edits[0],{name:'b.sktl',cueId:'missing',label:'bad'}]})).isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 assert.equal((await call({source,destination:failed,sha256:'0'.repeat(64),edits})).isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 assert.equal(await readFile(source,'utf8'),original);assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow']);
});
