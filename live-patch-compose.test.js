import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('typed live patch sends one exact request and validates input', async t => {
 const seen=[];
 const mock=http.createServer(async (req,res)=>{let body='';for await(const chunk of req) body+=chunk;seen.push({method:req.method,url:req.url,body:JSON.parse(body)});res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"test"}');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'patch-compose-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const nodes=[{request:'trigger',title:'MCP_ALIAS_A',params:{'trigger.mode':'Timer',nested:{list:[1,false,null]},empty:'',zero:0}},{request:'action',title:'MCP_ALIAS_B',params:{'action.category':'Application','action.t7':'Feedback/Notify'}}];
 const connections=[{from:{node:'MCP_ALIAS_A',pin:0},to:{node:'MCP_ALIAS_B',pin:0}}];
 const invoke=arguments_=>client.callTool({name:'showkontrol_compose_live_patch',arguments:arguments_});
 assert.equal((await invoke({nodes,connections})).isError,true);
 assert.deepEqual(seen,[{method:'PUT',url:'/api/v1/patch',body:{dryRun:true,nodes,connections}}]);
 assert.equal((await invoke({nodes:[{request:'other:type',title:'Other'}],connections:[],dryRun:false})).isError,true);
 assert.deepEqual(seen[1].body,{dryRun:false,nodes:[{request:'other:type',title:'Other'}],connections:[]});
 assert.equal((await invoke({nodes,connections:[{from:{node:'MCP_ALIAS_A'},to:{node:'MCP_ALIAS_B'}}]})).isError,true);
 assert.deepEqual(seen[2].body,{dryRun:true,nodes,connections:[{from:{node:'MCP_ALIAS_A'},to:{node:'MCP_ALIAS_B'}}]});
 for(const args of [{nodes:[{request:'group',title:'a',alias:'x'}],connections:[]},{nodes,connections:[{from:{node:'a',pin:-1},to:{node:'b',pin:0}}]},{nodes,connections,dryRun:'false'},{nodes:[{request:'group',title:'a',params:[]}],connections:[]},{nodes:[{request:'group',title:'a',params:null}],connections:[]}]) assert.equal((await invoke(args)).isError,true);
 assert.equal(seen.length,3);
});

 test('upstream parameter errors are returned without retry', async t => {
 const seen=[];
 const mock=http.createServer(async (req,res)=>{let body='';for await(const chunk of req) body+=chunk;seen.push(JSON.parse(body));res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid parameter'}));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'patch-params-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const nodes=[{request:'trigger',title:'A',params:{'invalid.key':'invalid enum'}}];
 const result=await client.callTool({name:'showkontrol_compose_live_patch',arguments:{nodes,connections:[]}});
 assert.equal(result.isError,true);
 assert.match(JSON.stringify(result.content),/HTTP 422: invalid parameter/);
 assert.deepEqual(seen,[{dryRun:true,nodes,connections:[]}]);
 });

test('patch validation errors include bounded problem strings and redact credentials', async t => {
 let calls=0;
 const mock=http.createServer(async (req,res)=>{for await(const _ of req) {} calls++;res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'nothing was changed',problems:["wire 1: unknown node 'MCP_CONFIG_DIAG'",'token-secret\n'+ 'x'.repeat(600),{token:'hidden'},...Array(12).fill('extra')],other:'private'}));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'patch-errors-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_TOKEN:'token-secret'}}));t.after(()=>client.close());
 const result=await client.callTool({name:'showkontrol_validate_patch',arguments:{spec:{}}});
 const message=result.content[0].text;
 assert.equal(result.isError,true);assert.match(message,/HTTP 422: nothing was changed/);assert.match(message,/wire 1: unknown node 'MCP_CONFIG_DIAG'/);assert.match(message,/PUT \/api\/v1\/patch/);assert.match(message,/\[redacted\]/);
 assert.doesNotMatch(message,/token-secret|private|hidden|x{501}/);assert.equal((message.match(/extra/g)||[]).length,7);assert.equal(calls,1);
});

test('malformed error bodies fall back to the HTTP status', async t => {
 let calls=0;
 const bodies=['{broken',JSON.stringify({error:{secret:'hidden'},problems:'hidden'}),JSON.stringify({error:'invalid',problems:[null,42,{message:'hidden'}]})];
 const mock=http.createServer(async (req,res)=>{for await(const _ of req) {} res.writeHead(422,{'Content-Type':'application/json'});res.end(bodies[calls++]);});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'malformed-errors-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 for(let i=0;i<3;i++){const result=await client.callTool({name:'showkontrol_validate_patch',arguments:{spec:{}}});assert.equal(result.isError,true);assert.match(result.content[0].text,/HTTP 422:/);assert.doesNotMatch(result.content[0].text,/hidden|broken|problems:/);}
 assert.equal(calls,3);
});

test('redacts the credentials used for the request if pairing changes before the response', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-pair-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'pair.json');await writeFile(file,JSON.stringify({key:'old-pair',token:'old-token'}));
 let calls=0;
 const mock=http.createServer(async (req,res)=>{for await(const _ of req) {} calls++;assert.equal(req.headers['x-sk-pair'],'old-pair');assert.equal(req.headers.authorization,'Bearer old-token');await writeFile(file,'invalid json');res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'old-token',problems:['wire: old-pair']}));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const env={...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_USE_LOCAL_PAIRING:'1',SHOWKONTROL_PAIRING_FILE:file};delete env.SHOWKONTROL_PAIR_KEY;delete env.SHOWKONTROL_TOKEN;
 const client=new Client({name:'pair-rotation-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env}));t.after(()=>client.close());
 const result=await client.callTool({name:'showkontrol_validate_patch',arguments:{spec:{}}});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/HTTP 422: \[redacted\]/);assert.match(result.content[0].text,/wire: \[redacted\]/);assert.doesNotMatch(result.content[0].text,/old-token|old-pair|Could not read/);assert.equal(calls,1);
});

test('live patch checks returned parameters in order and preserves the response', async t => {
 const seen=[];
 const replies=[
  {ok:true,dryRun:false,nodes:[{id:'first',params:[{key:'x',value:false},{key:'nested',value:{a:[1,true]}},{key:'dup',value:1},{key:'dup',value:1}]},{id:'second',params:[{key:'x',value:2}]}],extra:'preserved'},
  {ok:true,dryRun:true,nodes:[]},
  {ok:true,dryRun:false,nodes:[]},
  {ok:true,dryRun:false,nodes:[{id:'same',params:[]},{id:'same',params:[]}]},
  'malformed',
 ];
 const mock=http.createServer(async (req,res)=>{let body='';for await(const chunk of req) body+=chunk;seen.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(replies[seen.length-1]));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'readback-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const nodes=[{request:'group',title:'a',params:{x:'not_boolean',nested:{a:[1,true]},missing:1,dup:1}},{request:'group',title:'b',params:{x:2}}];
 const invoke=async dryRun=>JSON.parse((await client.callTool({name:'showkontrol_compose_live_patch',arguments:{nodes,connections:[],dryRun}})).content[0].text);
 const live=await invoke(false);
 assert.deepEqual(Object.fromEntries(Object.entries(live).filter(([key])=>key!=='parameterChecks')),replies[0]);
 assert.deepEqual(live.parameterChecks,{complete:true,issueCount:3,issues:[{nodeIndex:0,returnedId:'first',key:'x',kind:'mismatch'},{nodeIndex:0,returnedId:'first',key:'missing',kind:'missing'},{nodeIndex:0,returnedId:'first',key:'dup',kind:'ambiguous'}],truncated:false});
 assert.deepEqual(await invoke(true),replies[1]);
 for(let i=2;i<5;i++) assert.deepEqual((await invoke(false)).parameterChecks,{complete:false,reason:'invalid_response_or_node_mapping'});
 assert.equal(seen.length,5);
});

test('live patch parameter details are bounded and malformed params are ambiguous', async () => {
 const {checkLivePatchParameters}=await import('./live-patch-checks.js');
 const params=Object.fromEntries(Array.from({length:105},(_,i)=>[`key${i}`,i]));
 const checks=checkLivePatchParameters([{params}],{ok:true,dryRun:false,nodes:[{id:'id',params:null}]});
 assert.equal(checks.complete,true);assert.equal(checks.issueCount,105);assert.equal(checks.issues.length,100);assert.equal(checks.truncated,true);assert.ok(checks.issues.every(issue=>issue.kind==='ambiguous'));
 for(const response of [{ok:false,dryRun:false,nodes:[{id:'x'}]},{ok:true,dryRun:true,nodes:[{id:'x'}]},{ok:true,dryRun:false,nodes:[{}]},{ok:true,dryRun:false,nodes:[null]}]) assert.equal(checkLivePatchParameters([{params:{}}],response).complete,false);
});
