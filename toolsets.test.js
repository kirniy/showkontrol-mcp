import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {TOOL_GROUPS,TOOLSET_NAMES,toolFilter} from './toolsets.js';

async function list(t,toolsets){
 const env={...process.env};delete env.SHOWKONTROL_TOOLSETS;if(toolsets!==undefined)env.SHOWKONTROL_TOOLSETS=toolsets;
 const client=new Client({name:'toolsets-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env,stderr:'ignore'}));
 t.after(()=>client.close());
 const {tools}=await client.listTools();
 // A server without prompts does not declare the capability, and prompts/list is then not served.
 const {prompts}=client.getServerCapabilities().prompts?await client.listPrompts():{prompts:[]};
 return {tools,names:tools.map(tool=>tool.name).sort(),prompts:prompts.map(prompt=>prompt.name)};
}
const sorted=names=>[...names].sort();

test('tool groups are the sections of docs/tools.md and cover every registered tool once',async t=>{
 const sections=[];
 for(const line of (await readFile('docs/tools.md','utf8')).split('\n')){
  if(line.startsWith('## '))sections.push([]);
  const match=/^\| `(showkontrol_[a-z0-9_]+)`/.exec(line);
  if(match)sections.at(-1).push(match[1]);
 }
 assert.deepEqual(Object.values(TOOL_GROUPS),sections.filter(section=>section.length));
 const grouped=Object.values(TOOL_GROUPS).flat();
 assert.equal(new Set(grouped).size,grouped.length);
 const {names,prompts}=await list(t);
 assert.deepEqual(names,sorted(grouped));
 assert.deepEqual(prompts,['author_offline_show']);
});

test('SHOWKONTROL_TOOLSETS registers only the selected groups',async t=>{
 const all=await list(t);
 const live=await list(t,'live');
 assert.deepEqual(live.names,sorted(TOOL_GROUPS.live));
 assert.deepEqual(live.prompts,[]);
 const offline=await list(t,' offline ');
 assert.deepEqual(offline.names,sorted(Object.entries(TOOL_GROUPS).filter(([group])=>group!=='live').flatMap(([,names])=>names)));
 assert.deepEqual(offline.prompts,['author_offline_show']);
 const both=await list(t,'live,offline');
 assert.deepEqual(both.names,all.names);
 assert.deepEqual((await list(t,'all')).names,all.names);
 assert.deepEqual((await list(t,'')).names,all.names);
 const narrow=await list(t,'files,programs');
 assert.deepEqual(narrow.names,sorted([...TOOL_GROUPS.files,...TOOL_GROUPS.programs]));
 // The prompt also names composition and media tools, so it is not offered here.
 assert.deepEqual(narrow.prompts,[]);
 for(const tool of narrow.tools)assert.deepEqual(tool,all.tools.find(other=>other.name===tool.name));
});

test('live_read registers only live tools annotated read-only',async t=>{
 const all=await list(t);
 const {tools,names,prompts}=await list(t,'live_read');
 const expected=all.tools.filter(tool=>TOOL_GROUPS.live.includes(tool.name)&&tool.annotations?.readOnlyHint===true).map(tool=>tool.name).sort();
 assert.deepEqual(names,expected);
 assert.ok(names.length>=15&&names.length<TOOL_GROUPS.live.length);
 for(const name of ['showkontrol_write','showkontrol_deck_command','showkontrol_run_action','showkontrol_set_parameter','showkontrol_put_patch','showkontrol_delete_node'])assert.ok(!names.includes(name),name);
 for(const name of ['showkontrol_discover','showkontrol_get_live_deck','showkontrol_sample_events','showkontrol_read_binary'])assert.ok(names.includes(name),name);
 assert.ok(tools.every(tool=>tool.annotations.readOnlyHint===true));
 assert.deepEqual(prompts,[]);
 const mixed=await list(t,'live_read,reaper');
 assert.deepEqual(mixed.names,sorted([...expected,...TOOL_GROUPS.reaper]));
});

test('an unknown toolset stops the server before it serves',()=>{
 for(const value of ['lve','live,','live,,offline','Live']){
  const result=spawnSync(process.execPath,['server.js'],{env:{...process.env,SHOWKONTROL_TOOLSETS:value},input:'',encoding:'utf8',timeout:20000});
  assert.notEqual(result.status,0,value);
  assert.match(result.stderr,/SHOWKONTROL_TOOLSETS: unknown toolset/,value);
  assert.equal(result.stdout,'',value);
 }
 assert.throws(()=>toolFilter('live,nope'),/unknown toolset "nope"; use a comma-separated list of live, files/);
 assert.equal(toolFilter(undefined),null);
 assert.equal(toolFilter('  '),null);
 assert.throws(()=>toolFilter('live')('showkontrol_not_grouped',{}),/has no toolset group/);
 assert.deepEqual(TOOLSET_NAMES.slice(-3),['offline','live_read','all']);
});

// Provider rules seen in refused tool lists (OpenAI and Anthropic) and client reports of unresolved $ref/$defs.
test('tool input schemas avoid references and top-level combinators',async t=>{
 const {tools}=await list(t);
 const problems=[];
 for(const tool of tools){
  const schema=tool.inputSchema;
  if(schema.type!=='object')problems.push(`${tool.name}: top-level type ${schema.type}`);
  for(const key of ['oneOf','anyOf','allOf','enum','const','not'])if(Object.hasOwn(schema,key))problems.push(`${tool.name}: top-level ${key}`);
  for(const key of Object.keys(schema.properties??{}))if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(key))problems.push(`${tool.name}: property ${key}`);
  (function walk(node,at){
   if(!node||typeof node!=='object')return;
   for(const key of ['$ref','$defs','definitions'])if(Object.hasOwn(node,key)&&!at.endsWith('/properties'))problems.push(`${tool.name}: ${key} at ${at||'/'}`);
   if(typeof node.pattern==='string'&&/\\[pP]\{/.test(node.pattern))problems.push(`${tool.name}: Unicode property pattern at ${at}`);
   for(const [key,value] of Object.entries(node))walk(value,`${at}/${key}`);
  })(schema,'');
 }
 assert.deepEqual(problems,[]);
});

test('JSON value fields stay required and reject non-JSON values',async t=>{
 const {tools}=await list(t);
 const verified=tools.find(tool=>tool.name==='showkontrol_set_parameter_verified').inputSchema;
 assert.deepEqual(verified.properties.value,{});
 assert.ok(verified.required.includes('value'));
 for(const name of ['showkontrol_create_node','showkontrol_plan_live_graph','showkontrol_create_staged_live_graph','showkontrol_compose_live_patch']){
  const schema=JSON.stringify(tools.find(tool=>tool.name===name).inputSchema);
  assert.match(schema,/"params":\{"type":"object","propertyNames":\{"type":"string"\},"additionalProperties":\{\}\}/,name);
 }
 const env={...process.env,SHOWKONTROL_URL:'http://127.0.0.1:9',SHOWKONTROL_TIMEOUT_MS:'200'};delete env.SHOWKONTROL_TOOLSETS;delete env.SHOWKONTROL_TOKEN;delete env.SHOWKONTROL_USE_LOCAL_PAIRING;
 const client=new Client({name:'json-value-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env,stderr:'ignore'}));
 t.after(()=>client.close());
 const missing=await client.callTool({name:'showkontrol_set_parameter_verified',arguments:{node:'n1',key:'k'}});
 assert.equal(missing.isError,true);assert.match(missing.content[0].text,/Expected a JSON value at value/);
 // Accepted values reach the (unreachable) API, so the outcome is an unknown write, not a validation error.
 for(const value of [null,0,'x',false,[1,{a:null}],{nested:{list:['y']}}]){
  const response=await client.callTool({name:'showkontrol_set_parameter_verified',arguments:{node:'n1',key:'k',value}});
  assert.equal(JSON.parse(response.content[0].text).status,'write_unknown',JSON.stringify(value));
 }
 const params=await client.callTool({name:'showkontrol_create_node',arguments:{request:'r',dryRun:true,params:{a:[1,'b',{c:true}]}}});
 assert.equal(params.isError,true);assert.match(params.content[0].text,/connection failed|timed out/);
});

test('the toolset table in docs/setup.md states the registered counts',async t=>{
 const setup=await readFile('docs/setup.md','utf8');
 for(const toolset of ['live','live_read','offline','all']){
  const row=new RegExp(`^\\| \`${toolset}\` \\| (\\d+) \\|`,'m').exec(setup);
  assert.ok(row,toolset);
  assert.equal(Number(row[1]),(await list(t,toolset)).names.length,toolset);
 }
 const example=/`files,programs` registers (\d+) tools/.exec(setup);
 assert.ok(example);assert.equal(Number(example[1]),(await list(t,'files,programs')).names.length);
});
