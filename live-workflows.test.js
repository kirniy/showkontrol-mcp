import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('live deck reads the exact deck and timestamps from state and rejects invalid state',async t=>{
 let response={t:1234,tick:42,epochMs:1700000000000,decks:[{n:2,state:'cued',posUS:0},{n:1,state:'playing',posUS:987654,online:true,title:'Track'}]};
 const seen=[];const mock=http.createServer((req,res)=>{seen.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'live-deck-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const get=()=>client.callTool({name:'showkontrol_get_live_deck',arguments:{deck:1}});
 let result=await get();assert.equal(result.isError,undefined);assert.deepEqual(JSON.parse(result.content[0].text),{deck:response.decks[1],t:1234,tick:42,epochMs:1700000000000});
 response={decks:[{n:2,state:'playing'}]};result=await get();assert.equal(result.isError,true);assert.match(result.content[0].text,/Deck 1 is absent/);
 for(const invalid of [{decks:{}},{decks:[{state:'playing'}]},{decks:[{n:1},{n:1}]},{decks:[{n:1}],t:'bad'}]){response=invalid;result=await get();assert.equal(result.isError,true);assert.match(result.content[0].text,/Malformed \/state response/);}
 assert.deepEqual(seen,Array(6).fill('/api/v1/state'));
});

test('live workflow tools call documented endpoints once and preserve provided bodies',async t=>{
 const seen=[];
 const mock=http.createServer(async(req,res)=>{let s='';for await(const c of req)s+=c;seen.push({method:req.method,url:req.url,body:s?JSON.parse(s):undefined});res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'workflow-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 for(const [name,args] of [['showkontrol_discover',{resource:'node_types'}],['showkontrol_get_deck',{deck:2}],['showkontrol_deck_command',{deck:2,command:'seek',body:{position:12.5}}],['showkontrol_run_action',{id:'Action With Spaces',body:{player:2}}],['showkontrol_session_command',{command:'launch'}]]){
  const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined);
 }
 assert.deepEqual(seen,[{method:'GET',url:'/api/v1/nodes/types',body:undefined},{method:'GET',url:'/api/v1/decks/2',body:undefined},{method:'POST',url:'/api/v1/decks/2/seek',body:{position:12.5}},{method:'POST',url:'/api/v1/actions/Action%20With%20Spaces',body:{player:2}},{method:'POST',url:'/api/v1/session/launch',body:{}}]);
 const invalid=await client.callTool({name:'showkontrol_deck_command',arguments:{deck:9,command:'play'}});assert.equal(invalid.isError,true);assert.equal(seen.length,5);
});
test('patch workflow tools use observed request shapes and force dry run',async t=>{
 const seen=[];const mock=http.createServer(async(req,res)=>{let s='';for await(const c of req)s+=c;seen.push({method:req.method,url:req.url,body:s?JSON.parse(s):undefined});res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());const client=new Client({name:'patch-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const from={node:'a',pin:0},to={node:'b',pin:'In 1'};
 for(const [name,args] of [['showkontrol_node_type_detail',{request:'source:ProDJLink'}],['showkontrol_create_node',{request:'group',title:'Test',dryRun:true}],['showkontrol_create_connection',{from,to,dryRun:true}],['showkontrol_delete_connection',{from,to}],['showkontrol_delete_node',{id:'n1'}],['showkontrol_validate_patch',{spec:{dryRun:false,nodes:[{request:'group'}]}}]]){const r=await client.callTool({name,arguments:args});assert.equal(r.isError,undefined);}
 assert.deepEqual(seen,[{method:'GET',url:'/api/v1/nodes/types/source%3AProDJLink',body:undefined},{method:'POST',url:'/api/v1/nodes',body:{request:'group',title:'Test',dryRun:true}},{method:'POST',url:'/api/v1/connections',body:{from,to,dryRun:true}},{method:'DELETE',url:'/api/v1/connections',body:{from,to}},{method:'DELETE',url:'/api/v1/nodes/n1',body:undefined},{method:'PUT',url:'/api/v1/patch',body:{dryRun:true,nodes:[{request:'group'}]}}]);
});

test('identifier validation and bounded JSON responses',async t=>{
 let count=0; const mock=http.createServer((req,res)=>{count++;res.writeHead(200,{'Content-Type':'application/json'});res.end('"'+ 'x'.repeat(5*1024*1024) +'"');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const c=new Client({name:'bounds-test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>c.close());
 for(const [name,args] of [['showkontrol_get_parameter',{node:'n1',key:'..'}],['showkontrol_set_parameter',{node:'.',key:'x',value:1}],['showkontrol_set_setting',{key:'',value:1}],['showkontrol_fire_node',{node:'..'}]]){const r=await c.callTool({name,arguments:args});assert.equal(r.isError,true)}
 assert.equal(count,0);const r=await c.callTool({name:'showkontrol_read',arguments:{path:'/state'}});assert.equal(r.isError,true);assert.match(r.content[0].text,/exceeds 5 MiB/);assert.equal(count,1);
});

test('action discovery uses encoded IDs and reports HTTP errors',async t=>{
 const seen=[];
 const mock=http.createServer((req,res)=>{seen.push({method:req.method,url:req.url});if(req.url==='/api/v1/actions/missing'){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"missing"}');return;}res.writeHead(200,{'Content-Type':'application/json'});res.end('{"parameters":[{"name":"example"}]}');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'action-discovery-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 for(const [name,args] of [['showkontrol_list_actions',{}],['showkontrol_get_action',{id:'Action / #?'}]]){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined);assert.deepEqual(JSON.parse(result.content[0].text),{parameters:[{name:'example'}]});}
 for(const id of ['', '.', '..']){const result=await client.callTool({name:'showkontrol_get_action',arguments:{id}});assert.equal(result.isError,true);}
 const error=await client.callTool({name:'showkontrol_get_action',arguments:{id:'missing'}});assert.equal(error.isError,true);assert.match(error.content[0].text,/404/);
 assert.deepEqual(seen,[{method:'GET',url:'/api/v1/actions'},{method:'GET',url:'/api/v1/actions/Action%20%2F%20%23%3F'},{method:'GET',url:'/api/v1/actions/missing'}]);
});

test('create node forwards optional JSON params and rejects non-object params',async t=>{
 const seen=[];const mock=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({method:req.method,url:req.url,body:JSON.parse(body)});res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'create-node-params-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const call=args=>client.callTool({name:'showkontrol_create_node',arguments:args});
 const params={'node.name':'Final',enabled:true,count:2,nested:{items:[null,'value']}};
 for(const args of [{request:'trigger',title:'Preview',params,dryRun:true},{request:'group',dryRun:false}])assert.equal((await call(args)).isError,undefined);
 for(const params of [null,[],42,'bad'])assert.equal((await call({request:'group',params,dryRun:true})).isError,true);
 assert.deepEqual(seen,[{method:'POST',url:'/api/v1/nodes',body:{request:'trigger',title:'Preview',params,dryRun:true}},{method:'POST',url:'/api/v1/nodes',body:{request:'group',dryRun:false}}]);
});
