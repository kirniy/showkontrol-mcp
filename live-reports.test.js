import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('live reports route bounded reads and preserve responses and errors', async t => {
 const requests=[]; let insightsCalls=0;
 const mock=http.createServer((req,res)=>{
  requests.push({method:req.method,url:req.url});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/data/plays?limit=20') return res.end(JSON.stringify({plays:[],extra:{retained:true}}));
  if(req.url==='/api/v1/data/plays?limit=100') return res.end(JSON.stringify([{title:'A & B'}]));
  if(req.url==='/api/v1/data/insights') {if(++insightsCalls===1) return res.end(JSON.stringify({unknownMetric:[1,2]}));res.statusCode=503;return res.end(JSON.stringify({error:'unavailable'}));}
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const transport=new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}});
 const client=new Client({name:'test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const tools=await client.listTools();
 for(const name of ['showkontrol_get_plays','showkontrol_get_insights']) assert.equal(tools.tools.find(t=>t.name===name).annotations.readOnlyHint,true);
 assert.deepEqual(JSON.parse((await call('showkontrol_get_plays',{})).content[0].text),{plays:[],extra:{retained:true}});
 assert.deepEqual(JSON.parse((await call('showkontrol_get_plays',{limit:100})).content[0].text),[{title:'A & B'}]);
 for(const limit of [0,101,-1,1.5,'1&x=2']) {
  const result=await call('showkontrol_get_plays',{limit});
  assert.equal(result.isError,true);
 }
 assert.deepEqual(JSON.parse((await call('showkontrol_get_insights',{})).content[0].text),{unknownMetric:[1,2]});
 const error=await call('showkontrol_get_insights',{});
 assert.equal(error.isError,true);assert.match(error.content[0].text,/HTTP 503: unavailable/);
 assert.deepEqual(requests,[{method:'GET',url:'/api/v1/data/plays?limit=20'},{method:'GET',url:'/api/v1/data/plays?limit=100'},{method:'GET',url:'/api/v1/data/insights'},{method:'GET',url:'/api/v1/data/insights'}]);
});
