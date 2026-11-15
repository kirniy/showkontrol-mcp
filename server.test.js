import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP protocol forwards reads and writes without retrying', async t => {
 let requests=[];
 const mock=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push({method:req.method,url:req.url,authorization:req.headers.authorization,body:raw&&JSON.parse(raw)});res.setHeader('Content-Type','application/json');if(req.url.includes('failure')){res.writeHead(403);res.end(JSON.stringify({error:'denied'}));} else res.end(JSON.stringify({ok:true}));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 t.after(()=>mock.close());
 const transport=new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_TOKEN:'test-secret'}});
 const client=new Client({name:'test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 const list=await client.listTools();assert.ok(list.tools.some(tool=>tool.name==='showkontrol_create_rpp'));
 const read=await client.callTool({name:'showkontrol_read',arguments:{path:'/state'}});assert.equal(JSON.parse(read.content[0].text).ok,true);
 await client.callTool({name:'showkontrol_set_parameter',arguments:{node:'Deck Router',key:'router.active',value:'Input 2'}});
 assert.deepEqual(requests[1],{method:'PUT',url:'/api/v1/nodes/Deck%20Router/params/router.active',authorization:'Bearer test-secret',body:{value:'Input 2'}});
 const bad=await client.callTool({name:'showkontrol_read',arguments:{path:'/../../outside'}});assert.equal(bad.isError,true);assert.equal(requests.length,2);
 const denied=await client.callTool({name:'showkontrol_write',arguments:{method:'POST',path:'/failure',body:{}}});assert.equal(denied.isError,true);assert.equal(requests.length,3);
});

import {renderRpp,writeRpp} from './rpp.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('RPP marker generation preserves timing and refuses overwrite',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-rpp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'cues.rpp');
 const markers=[{seconds:1.25,name:'Lights'},{seconds:90,name:'Video'}];
 const result=await writeRpp({file,markers});assert.equal(result.markers,2);const text=await readFile(file,'utf8');
 assert.match(text,/MARKER 1 1\.25 "Lights" 0/);assert.match(text,/MARKER 2 90 "Video" 0/);
 await assert.rejects(writeRpp({file,markers}),/EEXIST/);assert.equal(await readFile(file,'utf8'),text);
 assert.throws(()=>renderRpp({markers:[{seconds:0,name:'bad"name'}]}),/Names cannot/);
});
test('RPP cue items keep track names, labels and durations',()=>{
 const text=renderRpp({tracks:[{name:'Lighting',cues:[{seconds:2.5,duration:3,name:'Strobe'}]}]});
 assert.match(text,/<TRACK\n    NAME "Lighting"/);
 assert.match(text,/POSITION 2\.5\n      LENGTH 3\n      NAME "Strobe"/);
 assert.match(text,/\|Strobe/);
 assert.throws(()=>renderRpp({tracks:[{name:'Lighting',cues:[{seconds:1,duration:0,name:'Bad'}]}]}),/duration/);
});

import {inspectXml,editXmlCopy} from './xml-copy.js';
test('XML copy edits exact text, preserves the source and rejects invalid or ambiguous edits',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-xml-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source.skf');const dest=path.join(dir,'out.skf');
 const {writeFile}=await import('node:fs/promises');const original='<?xml version="1.0"?>\n<show><unknown x="1"/><track>Old</track></show>\n';await writeFile(source,original);
 const info=await inspectXml({file:source});await editXmlCopy({source,destination:dest,sha256:info.sha256,edits:[{find:'<track>Old</track>',replace:'<track>New</track>'}]});
 assert.equal(await readFile(source,'utf8'),original);assert.equal(await readFile(dest,'utf8'),original.replace('Old','New'));
 await assert.rejects(editXmlCopy({source,destination:path.join(dir,'bad'),sha256:info.sha256,edits:[{find:'Old',replace:'<'}]}));
 await assert.rejects(editXmlCopy({source,destination:path.join(dir,'bad2'),sha256:'0'.repeat(64),edits:[{find:'Old',replace:'New'}]}),/changed/);
});

import {inspectShow,readShowPart,editShowPart} from './xml-copy.js';
import {createHash} from 'node:crypto';
test('skshow part copy verifies checksums and preserves other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-show-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'a.skshow'),destination=path.join(dir,'b.skshow');const {writeFile}=await import('node:fs/promises');
 const part=(name,txt)=>`<part name="${name}" md5="${createHash('md5').update(txt).digest('hex')}">${Buffer.from(txt).toString('base64')}</part>`;const unrelated=part('other.xml','<other/>');const original=`<skshow>${part('patch.skf','<show><node>old</node></show>')}${unrelated}</skshow>`;await writeFile(source,original);
 const info=await inspectShow({file:source});assert.equal(info.parts.length,2);assert.ok(info.parts.every(p=>p.valid));
 await editShowPart({source,destination,sha256:info.sha256,name:'patch.skf',edits:[{find:'old',replace:'new'}]});assert.match((await readShowPart({file:destination,name:'patch.skf'})).text,/>new</);assert.ok((await readFile(destination,'utf8')).includes(unrelated));assert.equal(await readFile(source,'utf8'),original);
});

test('RPP media tracks encode distinct source types and complete item timing',()=>{
 const mediaTracks=[{name:'Audio',kind:'audio',nativeColor:16777300,items:[{file:'/media/song.wav',seconds:2.5,duration:6,sourceOffset:1.25,fadeIn:0.5,fadeOut:1,takeVolume:0.75,name:'Song'}]},{name:'Video',kind:'video',items:[{file:'clip.mp4',seconds:0,duration:3}]}];
 const rpp=renderRpp({mediaTracks});assert.match(rpp,/NAME "Audio"\n    PEAKCOL 16777300/);assert.match(rpp,/POSITION 2\.5\n      LENGTH 6[\s\S]*?FADEIN 0 0\.5[\s\S]*?FADEOUT 0 1[\s\S]*?VOLPAN 1 0 0\.75 -1\n      SOFFS 1\.25/);
 assert.match(rpp,/<SOURCE WAVE\n        FILE "\/media\/song.wav"/);assert.match(rpp,/<SOURCE VIDEO\n        FILE "clip.mp4"/);
 assert.throws(()=>renderRpp({mediaTracks:[{name:'A',kind:'audio',items:[{file:'x.wav',seconds:0,duration:1,fadeIn:2}]}]}),/Fade durations/);
 assert.throws(()=>renderRpp({mediaTracks:[{name:'A',kind:'audio',items:[{file:'x.wav"\n>',seconds:0,duration:1}]}]}));
 assert.throws(()=>renderRpp({mediaTracks:[{name:'A',kind:'audio',items:[{file:'x.aac',seconds:0,duration:1}]}]}),/Audio source/);
});

test('RPP generation warns when take volume may be lost on import',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-rpp-level-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const mediaTracks=[{name:'Audio',kind:'audio',items:[{file:'/audio.wav',seconds:0,duration:1,takeVolume:0.5}]}];
 const result=await writeRpp({file:path.join(dir,'show.rpp'),mediaTracks,projectName:'Show'});
 assert.equal(result.warnings.length,2);assert.match(result.warnings[1],/take volume.*not preserved/);
});

test('MCP returns exact binary bytes and bounds event samples', async t => {
 const bytes=Buffer.from([0,255,13,10,42,128]);
 const mock=http.createServer((req,res)=>{
  if(req.url==='/api/v1/media'){res.writeHead(200,{'Content-Type':'image/png'});res.end(bytes);return;}
  if(req.url==='/api/v1/large'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(6*1024*1024)});res.end();return;}
  if(req.url==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': keepalive\n\nevent: state\ndata: {"playing":true}\n\n');return;}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const transport=new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}});
 const client=new Client({name:'test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 const media=await client.callTool({name:'showkontrol_read_binary',arguments:{path:'/media'}});
 assert.equal(media.content[0].type,'resource');assert.equal(media.content[0].resource.mimeType,'image/png');assert.deepEqual(Buffer.from(media.content[0].resource.blob,'base64'),bytes);
 const large=await client.callTool({name:'showkontrol_read_binary',arguments:{path:'/large'}});assert.equal(large.isError,true);assert.match(large.content[0].text,/5 MiB/);
 const sample=await client.callTool({name:'showkontrol_sample_events',arguments:{durationMs:150,maxEvents:5}});const result=JSON.parse(sample.content[0].text);
 assert.deepEqual(result.events,[{event:'state',data:{playing:true}}]);assert.equal(result.reason,'duration');
 const capped=await client.callTool({name:'showkontrol_sample_events',arguments:{durationMs:1000,maxEvents:1}});assert.equal(JSON.parse(capped.content[0].text).reason,'maxEvents');
});

test('semantic patch inspection and copy edits preserve the wrapper and reject stale or unknown settings',async t=>{
 const {inspectPatch,editPatchSettingCopy}=await import('./patch.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-patch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),dest=path.join(dir,'dest.skshow');const {writeFile}=await import('node:fs/promises');
 const xml='<?xml version="1.0"?><showkontrol version="2" name="Show"><appSettings><setting key="ui.flow">true</setting></appSettings><graph><node id="n1" type="router" title="A"><settings><setting key="router.in1">Deck 1</setting></settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></showkontrol>';
 const part=(name,txt)=>`<part name="${name}" md5="${createHash('md5').update(txt).digest('hex')}">${Buffer.from(txt).toString('base64')}</part>`;
 const untouched=part('other.xml','<other/>');const original=`<skshow>${part('patch.skf',xml)}${untouched}</skshow>`;await writeFile(source,original);
 const info=await inspectPatch({file:source,format:'skshow'});assert.equal(info.nodes[0].settings[0].value,'Deck 1');assert.equal(info.connections[0].fromNode,'n1');
 await editPatchSettingCopy({source,destination:dest,format:'skshow',sha256:info.sha256,nodeId:'n1',key:'router.in1',value:'A & B'});
 const next=await inspectPatch({file:dest,format:'skshow'});assert.equal(next.nodes[0].settings[0].value,'A & B');assert.equal(next.appSettings[0].value,'true');assert.equal(await readFile(source,'utf8'),original);assert.ok((await readFile(dest,'utf8')).includes(untouched));
 await assert.rejects(editPatchSettingCopy({source,destination:path.join(dir,'bad'),format:'skshow',sha256:info.sha256,nodeId:'n1',key:'absent',value:'x'}),/already exist/);
 await assert.rejects(editPatchSettingCopy({source,destination:path.join(dir,'bad'),format:'skshow',sha256:'0'.repeat(64),key:'ui.flow',value:'false'}),/changed/);
});

test('graph copies preserve node fields and enforce connection references',async t=>{
 const {inspectPatch,editPatchGraphCopy}=await import('./patch.js');const {writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'a.skf');const original='<showkontrol version="2" name="s"><appSettings/><graph><node id="n1" type="router" title="A" x="4"><settings><setting key="router.name">A</setting><unknown foo="1"/></settings></node><node id="n2" type="selector"><settings/></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="1"/></graph></showkontrol>';await writeFile(source,original);
 const base=await inspectPatch({file:source,format:'skf'});const duplicate=path.join(dir,'b.skf');
 const run=(file,destination,sha256,opts)=>editPatchGraphCopy({source:file,destination,sha256,format:'skf',...opts});
 await run(source,duplicate,base.sha256,{operation:'duplicate_node',nodeId:'n1',newNodeId:'n3'});
 const copy=await inspectPatch({file:duplicate,format:'skf'});assert.equal(copy.nodes.length,3);assert.equal(copy.nodes[2].id,'n2');assert.equal(copy.nodes[1].id,'n3');assert.ok((await readFile(duplicate,'utf8')).includes('<unknown foo="1"/>'));
 await assert.rejects(run(source,path.join(dir,'fail'),base.sha256,{operation:'remove_node',nodeId:'n1'}),/connections referencing/);
 await assert.rejects(run(source,path.join(dir,'fail'),base.sha256,{operation:'duplicate_node',nodeId:'n1',newNodeId:'n2'}),/unused/);
 const c={fromNode:'n3',fromPin:2,toNode:'n2',toPin:0};const connected=path.join(dir,'c.skf');await run(duplicate,connected,copy.sha256,{operation:'add_connection',connection:c});
 const cInfo=await inspectPatch({file:connected,format:'skf'});assert.equal(cInfo.connections.length,2);
 const disconnected=path.join(dir,'d.skf');await run(connected,disconnected,cInfo.sha256,{operation:'remove_connection',connection:c});const d=await inspectPatch({file:disconnected,format:'skf'});assert.equal(d.connections.length,1);
 const removed=path.join(dir,'e.skf');await run(disconnected,removed,d.sha256,{operation:'remove_node',nodeId:'n3'});assert.equal((await inspectPatch({file:removed,format:'skf'})).nodes.length,2);assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(run(source,path.join(dir,'fail'),base.sha256,{operation:'add_connection',connection:{...c,fromNode:'missing'}}),/must exist/);
 await assert.rejects(run(source,path.join(dir,'fail'),'0'.repeat(64),{operation:'remove_node',nodeId:'n2'}),/changed/);
});

test('copies node templates between offline show wrappers and patches',async t=>{
 const {inspectPatch,copyPatchNode}=await import('./patch.js');const {writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-template-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const template=path.join(dir,'template.skshow'),source=path.join(dir,'source.skf'),destination=path.join(dir,'copy.skf');
 const donorXml='<showkontrol version="2" name="donor"><appSettings/><graph><node id="n1" type="router" title="Router" x="42" y="19"><settings><setting key="router.in1">A &amp; B</setting><unknown flag="keep"/></settings></node><node id="n2" type="selector"><settings/></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></showkontrol>';
 const donor=`<skshow><part name="patch.skf" md5="${createHash('md5').update(donorXml).digest('hex')}">${Buffer.from(donorXml).toString('base64')}</part></skshow>`;
 const target='<showkontrol version="2" name="target"><appSettings/><graph><node id="n1" type="source"><settings/></node></graph></showkontrol>';
 await writeFile(template,donor);await writeFile(source,target);const d=await inspectPatch({file:template,format:'skshow'}),s=await inspectPatch({file:source,format:'skf'});
 const args={source,destination,format:'skf',sha256:s.sha256,template,templateFormat:'skshow',templateSha256:d.sha256,nodeId:'n1',newNodeId:'n3'};
 await copyPatchNode(args);const result=await inspectPatch({file:destination,format:'skf'});
 assert.equal(result.nodes.length,2);assert.equal(result.nodes[1].title,'Router');assert.equal(result.nodes[1].settings[0].value,'A & B');assert.equal(result.connections.length,0);assert.match(await readFile(destination,'utf8'),/<unknown flag="keep"\/>/);
 assert.equal(await readFile(template,'utf8'),donor);assert.equal(await readFile(source,'utf8'),target);
 await assert.rejects(copyPatchNode({...args,destination:path.join(dir,'bad'),newNodeId:'n1'}),/unused/);
 await assert.rejects(copyPatchNode({...args,destination:path.join(dir,'bad'),templateSha256:'0'.repeat(64)}),/Template source changed/);
 await assert.rejects(copyPatchNode({...args,destination:path.join(dir,'bad'),nodeId:'missing'}),/does not exist/);
 await assert.rejects(copyPatchNode(args),/EEXIST/);
});

test('event sampling reports a timeout before headers but accepts an idle stream',async t=>{
 let count=0;const mock=http.createServer((req,res)=>{
  if(++count===1)return;
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close()});
 const client=new Client({name:'events-timeout-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const args={durationMs:150,maxEvents:5};
 const timeout=await client.callTool({name:'showkontrol_sample_events',arguments:args});
 assert.equal(timeout.isError,true);assert.match(timeout.content[0].text,/timed out before event stream headers/i);
 const idle=await client.callTool({name:'showkontrol_sample_events',arguments:args});
 assert.equal(idle.isError,undefined);assert.deepEqual(JSON.parse(idle.content[0].text),{events:[],reason:'duration'});
});

test('write response body timeout reports unknown outcome and does not retry',async t=>{
 let requests=0;const mock=http.createServer((req,res)=>{requests++;res.writeHead(200,{'Content-Type':'application/json'});res.write('{"ok":');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close()});
 const client=new Client({name:'write-timeout-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_TIMEOUT_MS:'150'}}));t.after(()=>client.close());
 const result=await client.callTool({name:'showkontrol_write',arguments:{method:'POST',path:'/actions/test',body:{}}});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/response timed out/i);assert.match(result.content[0].text,/outcome of the write may be unknown/i);assert.match(result.content[0].text,/no automatic retry/i);assert.equal(requests,1);
});

test('connection resets report uncertain writes without retrying or exposing query values',async t=>{
 const requests=[];const mock=http.createServer(async(req,res)=>{for await(const chunk of req){} requests.push(req.method);if(req.url.includes('body')){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');setTimeout(()=>res.destroy(),20);}else req.socket.destroy();});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close()});
 const client=new Client({name:'reset-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 for(const phase of ['headers','body']){
  const result=await client.callTool({name:'showkontrol_write',arguments:{method:'PUT',path:`/${phase}?secret=private`,body:{}}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/connection failed/i);assert.match(result.content[0].text,/outcome of the write may be unknown/i);assert.match(result.content[0].text,/no automatic retry/i);assert.doesNotMatch(result.content[0].text,/private/);
 }
 const read=await client.callTool({name:'showkontrol_read',arguments:{path:'/body'}});assert.equal(read.isError,true);assert.doesNotMatch(read.content[0].text,/outcome of the write/i);
 assert.deepEqual(requests,['PUT','PUT','GET']);
});
