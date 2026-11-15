import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShow,readShowPart} from './xml-copy.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
test('MCP moves sets directly and in multi-track, full-show and session composition',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-move-set-mcp-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),name='Set.skls',patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';
 const list='<sksetlist version="2" active="0">\n <set name="First"><entry track="Template"/></set>\n <set name="Middle"/>\n <set name="Last"/>\n</sksetlist>';
 const original=`<skshow>${part('Template.sktl','<sktimeline version="1" name="Template"><layers><layer/></layers></sktimeline>')}${part(name,list)}${part('patch.skf',patch)}</skshow>`;
 await writeFile(source,original);const {sha256}=await inspectShow({file:source});
 const client=new Client({name:'move-set-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(tool,args)=>client.callTool({name:tool,arguments:args});
 const parse=response=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 const direct='showkontrol_edit_show_setlist_copy',multi='showkontrol_compose_multi_track_show_copy',full='showkontrol_compose_full_show_copy',session='showkontrol_compose_session_media_copy';
 const tools=(await client.listTools()).tools;
 assert.ok(tools.find(tool=>tool.name===direct).inputSchema.properties.operation.enum.includes('move_set'));
 for(const tool of [multi,full,session])assert.match(JSON.stringify(tools.find(item=>item.name===tool).inputSchema.properties.setlistOperations),/"move_set"/,tool);

 const single=path.join(dir,'single.skshow');
 const moved=parse(await call(direct,{source,destination:single,sha256,name,operation:'move_set',setName:'First',toIndex:2}));
 assert.deepEqual(moved.move,{setName:'First',fromIndex:0,toIndex:2,active:{before:0,after:2}});
 assert.equal((await readShowPart({file:single,name})).text,'<sksetlist version="2" active="2">\n <set name="Middle"/>\n <set name="Last"/>\n <set name="First"><entry track="Template"/></set>\n</sksetlist>');
 for(const args of [{setName:'First',toIndex:0},{setName:'First',toIndex:9},{setName:'First',toIndex:1,index:0}]){
  const blocked=path.join(dir,'blocked.skshow'),response=await call(direct,{source,destination:blocked,sha256,name,operation:'move_set',...args});
  assert.equal(response.isError,true,JSON.stringify(args));await assert.rejects(readFile(blocked),{code:'ENOENT'});
 }

 const tracks=[{templateName:'Template.sktl',trackName:'Track One',partName:'content/One.sktl',cues:[{layer:0,startMs:0,lengthMs:10,label:'Cue 1'}],set:{name,setName:'Last'}}];
 const operations=[{operation:'move_set',name,setName:'Last',toIndex:0}];
 const composed=path.join(dir,'composed.skshow'),multiResult=parse(await call(multi,{source,destination:composed,sha256,tracks,setlistOperations:operations}));
 assert.deepEqual(multiResult.setlistOperations,operations);
 assert.equal((await readShowPart({file:composed,name})).text,'<sksetlist version="2" active="1">\n <set name="Last"><entry track="Track One"/></set>\n <set name="First"><entry track="Template"/></set>\n <set name="Middle"/>\n</sksetlist>');
 // The schema is strict: move_set does not take an entry index, and toIndex is required.
 for(const op of [{operation:'move_set',name,setName:'Last',toIndex:0,index:1},{operation:'move_set',name,setName:'Last'},{operation:'move_set',name,setName:'Last',toIndex:-1}]){
  const failed=path.join(dir,'failed.skshow'),response=await call(multi,{source,destination:failed,sha256,tracks,setlistOperations:[op]});
  assert.equal(response.isError,true,JSON.stringify(op));await assert.rejects(readFile(failed),{code:'ENOENT'});
 }
 const late=path.join(dir,'late.skshow'),lateFailure=await call(multi,{source,destination:late,sha256,tracks,setlistOperations:[...operations,{operation:'move_set',name,setName:'Last',toIndex:0}]});
 assert.equal(lateFailure.isError,true);await assert.rejects(readFile(late),{code:'ENOENT'});

 const fullOut=path.join(dir,'full.skshow'),fullResult=parse(await call(full,{source,destination:fullOut,sha256,setlistOperations:[{operation:'move_set',name,setName:'Middle',toIndex:0}]}));
 assert.deepEqual(fullResult.validation.diagnostics,[]);
 assert.equal((await readShowPart({file:fullOut,name})).text,'<sksetlist version="2" active="1">\n <set name="Middle"/>\n <set name="First"><entry track="Template"/></set>\n <set name="Last"/>\n</sksetlist>');

 const sessionDir=path.join(dir,'Session A');await mkdir(path.join(sessionDir,'MEDIA'),{recursive:true});
 await writeFile(path.join(sessionDir,'session.skshow'),original);await writeFile(path.join(sessionDir,'session.skf'),patch.replace('name="Show"','name="Session A"'));
 const sessionOut=path.join(dir,'Session B');
 parse(await call(session,{source:sessionDir,destination:sessionOut,sha256:sha(original),setlistOperations:[{operation:'move_set',name,setName:'Last',toIndex:1}]}));
 assert.equal((await readShowPart({file:path.join(sessionOut,'session.skshow'),name})).text,'<sksetlist version="2" active="0">\n <set name="First"><entry track="Template"/></set>\n <set name="Last"/>\n <set name="Middle"/>\n</sksetlist>');
 const sessionFailed=path.join(dir,'Session C'),sessionFailure=await call(session,{source:sessionDir,destination:sessionFailed,sha256:sha(original),setlistOperations:[{operation:'move_set',name,setName:'Last',toIndex:2}]});
 assert.equal(sessionFailure.isError,true);await assert.rejects(readdir(sessionFailed),{code:'ENOENT'});

 assert.equal(await readFile(source,'utf8'),original);assert.equal(await readFile(path.join(sessionDir,'session.skshow'),'utf8'),original);
 assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')||n.startsWith('.')),[]);
});
