import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const TOKEN='TOKEN_S3cr3t_9f2a',PAIR='PAIR_K3y_77c1';
// The mock echoes the credentials it received in whatever the route returns.
async function mock(t,route){
 const seen=[];
 const server=http.createServer((req,res)=>{
  const credentials=`${req.headers.authorization??''} ${req.headers['x-sk-pair']??''}`;
  seen.push({method:req.method,url:req.url,credentials});
  route(req,res,credentials);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 return {url:`http://127.0.0.1:${server.address().port}`,seen};
}
async function connect(t,env){
 const base={...process.env};for(const key of ['SHOWKONTROL_TOKEN','SHOWKONTROL_PAIR_KEY','SHOWKONTROL_USE_LOCAL_PAIRING','SHOWKONTROL_PAIRING_FILE','SHOWKONTROL_TOOLSETS'])delete base[key];
 const client=new Client({name:'live-hardening-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...base,...env},stderr:'ignore'}));t.after(()=>client.close());
 return async(name,args={})=>{const response=await client.callTool({name,arguments:args});return {error:response.isError===true,text:response.content.map(c=>c.text??JSON.stringify(c)).join('\n')};};
}
const leaks=(text,...secrets)=>secrets.filter(secret=>text.includes(secret));

test('credentials are redacted from status text, error bodies and successful bodies in every live read path',async t=>{
 const {url}=await mock(t,(req,res,credentials)=>{
  if(req.url==='/api/v1/ok'){res.writeHead(200,{'Content-Type':'Application/JSON'});res.end(JSON.stringify({echo:credentials}));return;}
  if(req.url==='/api/v1/patch'){res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({error:credentials,problems:[credentials]}));return;}
  res.writeHead(403,`Denied ${credentials.replace(/^Bearer /,'')}`,{'Content-Type':'application/json'});res.end(JSON.stringify({error:credentials}));
 });
 // Surrounding whitespace, as from a secrets file, is stripped by fetch; the stripped value is what must be redacted.
 const call=await connect(t,{SHOWKONTROL_URL:url,SHOWKONTROL_TOKEN:`${TOKEN}\n`,SHOWKONTROL_PAIR_KEY:` ${PAIR}\n`});
 const results=[
  await call('showkontrol_read',{path:'/denied'}),
  await call('showkontrol_read_binary',{path:'/denied'}),
  await call('showkontrol_sample_events',{durationMs:500,maxEvents:1}),
  await call('showkontrol_put_patch',{spec:{nodes:[]}}),
  await call('showkontrol_read',{path:'/ok'}),
 ];
 for(const result of results.slice(0,4))assert.equal(result.error,true,result.text);
 for(const result of results)assert.deepEqual(leaks(result.text,TOKEN,PAIR),[],result.text);
 assert.match(results[1].text,/^HTTP 403: Denied \[redacted\] \[redacted\]$/);
 assert.match(results[2].text,/HTTP 403: Denied \[redacted\] \[redacted\]/);
 // A mixed-case JSON media type is still JSON.
 assert.deepEqual(JSON.parse(results[4].text),{echo:'Bearer [redacted] [redacted]'});
});

test('numeric secrets from the local pairing file are redacted',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-pairing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'streamdeck.json');await writeFile(file,JSON.stringify({key:777123456,token:888654321}));
 const {url,seen}=await mock(t,(req,res,credentials)=>{res.writeHead(400,'Bad',{'Content-Type':'application/json'});res.end(JSON.stringify({error:credentials}));});
 const call=await connect(t,{SHOWKONTROL_URL:url,SHOWKONTROL_USE_LOCAL_PAIRING:'1',SHOWKONTROL_PAIRING_FILE:file});
 const result=await call('showkontrol_read',{path:'/x'});
 assert.equal(seen[0].credentials,'Bearer 888654321 777123456');
 assert.equal(result.error,true);assert.deepEqual(leaks(result.text,'888654321','777123456'),[],result.text);
});

test('a short secret is redacted from errors but does not rewrite successful bodies',async t=>{
 const {url}=await mock(t,(req,res)=>{
  if(req.url==='/api/v1/ok'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({values:[7,77,'a7b']}));return;}
  res.writeHead(500,'x',{'Content-Type':'application/json'});res.end(JSON.stringify({error:'pair 7 refused'}));
 });
 const call=await connect(t,{SHOWKONTROL_URL:url,SHOWKONTROL_PAIR_KEY:'7'});
 assert.deepEqual(JSON.parse((await call('showkontrol_read',{path:'/ok'})).text),{values:[7,77,'a7b']});
 assert.match((await call('showkontrol_read',{path:'/err'})).text,/pair \[redacted\] refused/);
});

test('an accepted write whose response cannot be returned says that the write may have been applied',async t=>{
 const big=Buffer.alloc(5*1024*1024+1,32);
 const {url,seen}=await mock(t,(req,res)=>{
  const kind=req.url.split('/').pop();
  if(kind==='binary'){res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end('x');}
  else if(kind==='events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: x\n\n');}
  else {res.writeHead(200,{'Content-Type':'application/json'});res.end(big);}
 });
 const call=await connect(t,{SHOWKONTROL_URL:url});
 for(const kind of ['binary','events','large']){
  const write=await call('showkontrol_write',{method:'POST',path:`/w/${kind}`,body:{}});
  assert.equal(write.error,true);assert.match(write.text,/; POST returned HTTP 200, so the write may have been applied; no automatic retry$/,kind);
  const read=await call('showkontrol_read',{path:`/r/${kind}`});
  assert.equal(read.error,true);assert.doesNotMatch(read.text,/may have been applied/,kind);
 }
 assert.equal(seen.filter(r=>r.method==='POST').length,3);
});

test('verified tools do not report a match from a readback that reports failure',async t=>{
 let readback;
 const {url}=await mock(t,(req,res)=>{
  res.writeHead(200,{'Content-Type':'application/json'});
  if(req.method==='GET'&&req.url==='/api/v1/nodes')return res.end(JSON.stringify({nodes:[{id:'n1',title:'Group'}]}));
  if(req.method==='POST')return res.end(JSON.stringify({ok:true,action:'app.node.bypass_on'}));
  if(req.method==='PUT')return res.end(JSON.stringify({key:'k',value:1}));
  res.end(JSON.stringify(readback));
 });
 const call=await connect(t,{SHOWKONTROL_URL:url});
 for(const failure of [{ok:false},{ok:'false'},{success:false},{error:'Node not found'}]){
  readback={key:'k',value:1,...failure};
  assert.equal(JSON.parse((await call('showkontrol_set_parameter_verified',{node:'n1',key:'k',value:1})).text).status,'readback_unknown',JSON.stringify(failure));
  readback={key:'node.bypassed',value:true,...failure};
  assert.equal(JSON.parse((await call('showkontrol_set_node_bypass',{id:'n1',bypassed:true})).text).status,'readback_unknown',JSON.stringify(failure));
 }
 readback={key:'k',value:1};assert.equal(JSON.parse((await call('showkontrol_set_parameter_verified',{node:'n1',key:'k',value:1})).text).status,'matched');
 readback={key:'node.bypassed',value:true};assert.equal(JSON.parse((await call('showkontrol_set_node_bypass',{id:'n1',bypassed:true})).text).status,'matched');
});

test('a rejected verified write keeps the app message',async t=>{
 const {url}=await mock(t,(req,res)=>{res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Value out of range'}));});
 const call=await connect(t,{SHOWKONTROL_URL:url});
 const result=JSON.parse((await call('showkontrol_set_parameter_verified',{node:'n1',key:'k',value:99})).text);
 assert.equal(result.status,'write_unknown');assert.match(result.detail,/no automatic retry\. HTTP 422: Value out of range \(PUT \/api\/v1\/nodes\/n1\/params\/k\)$/);
});

test('a node diagnostic warns when the response describes another node',async t=>{
 const {url}=await mock(t,(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'n2',stopped:false,params:[{key:'node.stopped',value:false}]}));});
 const call=await connect(t,{SHOWKONTROL_URL:url});
 const result=JSON.parse((await call('showkontrol_diagnose_live_node',{id:'n1'})).text);
 assert.deepEqual(result.warnings,['The response node ID differs from the requested identifier. This is expected when a title was supplied; otherwise the values may belong to another node.']);
});

test('an event stream that drops after events returns them',async t=>{
 const {url}=await mock(t,(req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: a\ndata: {"n":1}\n\n');setTimeout(()=>res.socket.destroy(),100);});
 const call=await connect(t,{SHOWKONTROL_URL:url});
 const result=JSON.parse((await call('showkontrol_sample_events',{durationMs:3000,maxEvents:5})).text);
 assert.deepEqual(result,{events:[{event:'a',data:{n:1}}],reason:'connectionFailed'});
});
