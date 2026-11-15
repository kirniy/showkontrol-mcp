import {test} from 'node:test';
import assert from 'node:assert/strict';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerActionSearch} from './action-search.js';

test('MCP action search filters the live response shape and pages results', async t=>{
 const server=new McpServer({name:'test',version:'1'}),client=new Client({name:'test',version:'1'});
 const calls=[]; let response={actions:[
  {id:'cdj.20',category:'CDJ Transport',label:'Play / Pause'},
  {id:'app.player.play',category:'Application',label:'Players/Play',extra:'ignored'},
  {id:'app.player.pause',category:'Application',label:'Players/Pause'},
  {id:'app.player.load',category:'Application',label:'Players/Load Track'}
 ]};
 const add=(name,description,inputSchema,handler,annotations)=>server.registerTool(name,{description,inputSchema,annotations},async args=>{
  try{return {content:[{type:'text',text:JSON.stringify(await handler(args))}]};}
  catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
 });
 registerActionSearch(add,async (...args)=>{calls.push(args);if(response instanceof Error)throw response;return response;},{readOnlyHint:true,destructiveHint:false,openWorldHint:true});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(()=>client.close());
 const tool=(await client.listTools()).tools.find(x=>x.name==='showkontrol_search_actions');assert.equal(tool.annotations.readOnlyHint,true);
 const search=async args=>client.callTool({name:'showkontrol_search_actions',arguments:args});
 let r=await search({category:'application',text:'PLAYER',limit:2});assert.equal(r.isError,undefined);
 assert.deepEqual(JSON.parse(r.content[0].text),{total:3,offset:0,limit:2,actions:[{id:'app.player.play',category:'Application',label:'Players/Play'},{id:'app.player.pause',category:'Application',label:'Players/Pause'}],nextOffset:2});
 r=await search({category:'Application',text:'player',limit:2,offset:2});assert.equal(JSON.parse(r.content[0].text).nextOffset,null);assert.equal(JSON.parse(r.content[0].text).actions[0].id,'app.player.load');
 assert.equal(JSON.parse((await search({text:'PLAY / PAUSE'})).content[0].text).total,1);
 assert.equal(JSON.parse((await search({category:'App'})).content[0].text).total,0);
 for(const args of [{limit:101},{limit:0},{offset:-1},{offset:1.5},{text:''},{category:' '.repeat(2)}]) assert.equal((await search(args)).isError,true);
 assert.deepEqual(calls,Array(4).fill(['GET','/actions']));
 response={actions:[{id:'a',category:'x'}]};assert.match((await search({})).content[0].text,/Malformed/);
 response={unexpected:[]};assert.match((await search({})).content[0].text,/Malformed/);
 response=new Error('HTTP 503: unavailable');assert.match((await search({})).content[0].text,/503/);
});
