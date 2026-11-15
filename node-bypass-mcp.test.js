import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP bypass schema, action and readback',async t=>{const seen=[];const mock=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;seen.push([req.method,req.url,body?JSON.parse(body):undefined]);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/api/v1/nodes'?{nodes:[{id:'n / 1',title:'Group'}]}:req.method==='POST'?{ok:true,action:'app.node.bypass_on'}:{key:'node.bypassed',value:true}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());const c=new Client({name:'test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>c.close());let r=await c.callTool({name:'showkontrol_set_node_bypass',arguments:{id:'n / 1',bypassed:true}});assert.equal(r.isError,undefined);assert.equal(JSON.parse(r.content[0].text).status,'matched');assert.deepEqual(seen,[['GET','/api/v1/nodes',undefined],['POST','/api/v1/actions/app.node.bypass_on',{'appact.node':'Group'}],['GET','/api/v1/nodes/n%20%2F%201/params/node.bypassed',undefined]]);r=await c.callTool({name:'showkontrol_set_node_bypass',arguments:{id:'n1',bypassed:'true'}});assert.equal(r.isError,true);assert.equal(seen.length,3);});
// One timeout covers every request. It must be long enough that the preliminary GET cannot expire under parallel load; only the held POST should time out.
test('MCP reports POST timeout as unknown and does not retry',{timeout:30000},async t=>{
 const seen=[];let postClosed;
 const mock=http.createServer((req,res)=>{
  seen.push(`${req.method} ${req.url}`);
  // Hold the POST without a response until the client aborts it.
  if(req.method==='POST'){postClosed=new Promise(resolve=>res.on('close',resolve));return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({nodes:[{id:'n1',title:'Group'}]}));
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
 const c=new Client({name:'test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_TIMEOUT_MS:'1000'}}));t.after(()=>c.close());
 const r=await c.callTool({name:'showkontrol_set_node_bypass',arguments:{id:'n1',bypassed:true}});
 const text=(r.content??[]).map(x=>x.text).join('\n'),context=`tool ${r.isError?'error':'result'}: ${text}; requests: ${JSON.stringify(seen)}`;
 let data;try{data=JSON.parse(text);}catch{assert.fail(`Expected a JSON write_unknown result, got ${context}`);}
 assert.equal(r.isError,undefined,context);
 assert.equal(data.status,'write_unknown',context);
 // The timeout must belong to the POST, not to the preliminary GET.
 assert.equal(data.detail,'POST /api/v1/actions/app.node.bypass_on: timed out; the outcome of the write may be unknown; no automatic retry',context);
 // The client abandoned the held POST; no second request followed.
 assert.ok(postClosed,context);await postClosed;
 assert.deepEqual(seen,['GET /api/v1/nodes','POST /api/v1/actions/app.node.bypass_on'],context);
});
