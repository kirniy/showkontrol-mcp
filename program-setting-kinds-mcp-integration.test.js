import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowPart} from './xml-copy.js';

const hash=(algorithm,value)=>createHash(algorithm).update(value).digest('hex');
const part=(name,value)=>`<part name="${name}" md5="${hash('md5',value)}">${Buffer.from(value).toString('base64')}</part>`;

test('MCP composers copy Script and OSC settings into embedded and direct graphs atomically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-setting-kinds-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=name=>path.join(dir,name);
 const graph=(kind,first,second)=>`<graph><node id="${first}" type="processor" kind="${kind}" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="proc.script">old</setting></settings></node><node id="${second}" type="generator" kind="OSC" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="gen.enabled">false</setting><setting key="gen.address">/old</setting></settings></node></graph>`;
 const show=kind=>`<skshow>${part('content/Program.skpr',`<skprogram version="1"><item start="0" name="Embedded" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="A">${graph(kind,'n1','n2')}</cue></sktimeline></item><item start="1" name="Direct" notes="">${graph(kind,'n3','n4')}</item></skprogram>`)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n885" type="processor" kind=""><settings><setting key="proc.script"><![CDATA[// inert capture fixture]]></setting></settings></node><node id="n888" type="generator" kind="OSC"><settings><setting key="gen.address">/mcp/config75</setting><setting key="gen.port">17075</setting></settings></node></graph></showkontrol>';
 await Promise.all([writeFile(file('source.skshow'),show('')),writeFile(file('wrong-kind.skshow'),show('other')),writeFile(file('donor.skf'),donor)]);
 const baseSetting={donor:file('donor.skf'),donorFormat:'skf',donorSha256:hash('sha256',donor)};
 const embedded={...baseSetting,action:'copy_patch_setting_to_timeline_cue',index:0,cueId:'c1',nodeId:'n1',donorNodeId:'n885',key:'proc.script'};
 const direct={...baseSetting,action:'copy_patch_setting_to_item_graph',index:1,nodeId:'n3',donorNodeId:'n885',key:'proc.script'};
 const operations=[embedded,{...embedded,nodeId:'n2',donorNodeId:'n888',key:'gen.address'},{...embedded,nodeId:'n2',donorNodeId:'n888',key:'gen.port'},direct,{...direct,nodeId:'n4',donorNodeId:'n888',key:'gen.address'},{...direct,nodeId:'n4',donorNodeId:'n888',key:'gen.port'}];
 const client=new Client({name:'program-setting-kinds',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',wrap=ops=>full?{program:{operations:ops}}:{operations:ops},base={source:file('source.skshow'),sha256:hash('sha256',show(''))},destination=file(`out-${full}.skshow`);
  const result=await client.callTool({name,arguments:{...base,destination,...wrap(operations)}});assert.notEqual(result.isError,true,JSON.stringify(result));
  const xml=(await readShowPart({file:destination,name:'content/Program.skpr'})).text;
  for(const expected of ['type="processor" kind="" stopped="1"','type="generator" kind="OSC" stopped="1"','<setting key="node.stopped">true</setting>','<setting key="gen.enabled">false</setting>','<setting key="proc.script"><![CDATA[// inert capture fixture]]></setting>','<setting key="gen.address">/mcp/config75</setting>','<setting key="gen.port">17075</setting>'])assert.equal(xml.split(expected).length-1,expected.includes('node.stopped')?4:2,expected);
  for(const [label,badBase,badOp] of [
   ['type',base,{...direct,nodeId:'n4'}],
   ['kind',{source:file('wrong-kind.skshow'),sha256:hash('sha256',show('other'))},direct],
   ['embedded-type',base,{...embedded,nodeId:'n2'}],
   ['embedded-kind',{source:file('wrong-kind.skshow'),sha256:hash('sha256',show('other'))},embedded],
   ['stale',base,{...direct,donorSha256:'0'.repeat(64)}],
   ['stopped',base,{...direct,key:'node.stopped'}]
  ]){
   const failed=file(`failed-${full}-${label}.skshow`),response=await client.callTool({name,arguments:{...badBase,destination:failed,...wrap([operations[1],badOp])}});assert.equal(response.isError,true,JSON.stringify(response));await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(file('source.skshow'),'utf8'),show(''));assert.equal(await readFile(file('donor.skf'),'utf8'),donor);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});
