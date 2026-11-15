import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const part = (name, text) => `<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const graph = value => `<graph><node id="n154" type="groupin"><settings/></node><node id="n155" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">${value}</setting></settings></node><node id="n156" type="action"><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n154" fromPin="0" toNode="n155" toPin="0"/><connection fromNode="n155" fromPin="0" toNode="n156" toPin="0"/></graph>`;

test('MCP composes a show with distinct cue donors and a set entry', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'sk-compose-mcp-'));
 t.after(() => rm(dir,{recursive:true,force:true}));
 const source = path.join(dir,'source.skshow'), first = path.join(dir,'first.skshow'), second = path.join(dir,'second.skshow'), destination = path.join(dir,'out.skshow');
 const sourceText = `<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Set 1"/></sksetlist>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 const donorText = value => `<skshow>${part('content/Donor.sktl',`<sktimeline version="1" name="Donor"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue">${graph(value)}</cue></sktimeline>`)}</skshow>`;
 await writeFile(source,sourceText); await writeFile(first,donorText('State On')); await writeFile(second,donorText('State Off'));
 const client = new Client({name:'compose-integration-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env})); t.after(() => client.close());
 assert.ok((await client.listTools()).tools.some(tool => tool.name === 'showkontrol_compose_show_copy'));
 const call = async (name,args) => { const response = await client.callTool({name,arguments:args}); assert.equal(response.isError,undefined,JSON.stringify(response)); return JSON.parse(response.content[0].text); };
 const inspected = async file => (await call('showkontrol_inspect_show',{file})).sha256;
 const donor = async file => ({file,sha256:await inspected(file),name:'content/Donor.sktl',cueId:'c1'});
 const args = {source,destination,sha256:await inspected(source),templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',donor:await donor(first),set:{name:'content/Setlist.skls',setName:'Set 1'},cues:[{layer:0,startMs:0,lengthMs:40,label:'Default'},{layer:0,startMs:100,lengthMs:40,label:'Override',donor:await donor(second)},{layer:0,startMs:200,lengthMs:40,label:'No graph',donor:null}]};
 const result = await call('showkontrol_compose_show_copy',args);
 assert.equal(result.sha256,await inspected(destination)); assert.equal(new Set(result.cues.map(cue => cue.id)).size,3);
 const graphs = await Promise.all(result.cues.map(cue => call('showkontrol_inspect_cue_graph',{file:destination,format:'skshow',name:args.partName,cueId:cue.id})));
 const value = info => info.graph.nodes.find(node => node.type === 'trigger').settings.find(setting => setting.key === 'trigger.on').value;
 assert.equal(value(graphs[0]),'State On'); assert.equal(value(graphs[1]),'State Off'); assert.equal(graphs[2].graph,null);
 assert.deepEqual((await call('showkontrol_inspect_show_setlist',{file:destination,name:args.set.name})).sets,[{name:'Set 1',tracks:['New']}]);
 assert.equal(await readFile(source,'utf8'),sourceText); assert.equal(await readFile(first,'utf8'),donorText('State On')); assert.equal(await readFile(second,'utf8'),donorText('State Off'));
 const failure = await client.callTool({name:'showkontrol_compose_show_copy',arguments:{...args,destination:path.join(dir,'bad.skshow'),cues:[...args.cues,{layer:99,startMs:300,lengthMs:40,label:'Invalid'}]}});
 assert.equal(failure.isError,true); assert.deepEqual((await readdir(dir)).sort(),['first.skshow','out.skshow','second.skshow','source.skshow']);
});

test('MCP composes ordered layer edits on single and multiple tracks', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'sk-compose-layers-mcp-')); t.after(() => rm(dir,{recursive:true,force:true}));
 const source = path.join(dir,'source.skshow');
 const sourceText = `<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Base"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,sourceText);
 const client = new Client({name:'compose-layers-integration-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env})); t.after(() => client.close());
 const call = (name,args) => client.callTool({name,arguments:args});
 const parse = response => {assert.equal(response.isError,undefined,JSON.stringify(response)); return JSON.parse(response.content[0].text);};
 const sha256 = parse(await call('showkontrol_inspect_show',{file:source})).sha256;
 const track = name => ({templateName:'content/Empty.sktl',trackName:name,partName:`content/${name}.sktl`,layerOperations:[{operation:'append',layerName:'Base',newName:'Copy'},{operation:'rename',layerName:'Copy',newName:name}],cues:[{layer:1,startMs:0,lengthMs:40,label:`${name} cue`}]});
 const verify = async (file,entry,result) => {
  const timeline = parse(await call('showkontrol_inspect_show_timeline',{file,name:entry.partName}));
  assert.deepEqual(timeline.layers.map(layer => layer.name),['Base',entry.trackName]);
  assert.equal(timeline.cueElements[0].attributes.layer,'1');
  assert.equal(timeline.cueElements[0].attributes.id,result.cues[0].id);
 };
 const singlePath=path.join(dir,'single.skshow'), first=track('First');
 const single=parse(await call('showkontrol_compose_show_copy',{source,destination:singlePath,sha256,...first}));
 await verify(singlePath,first,single);
 const multiPath=path.join(dir,'multi.skshow'), second=track('Second'), tracks=[first,second];
 const multi=parse(await call('showkontrol_compose_multi_track_show_copy',{source,destination:multiPath,sha256,tracks}));
 for (const [index,entry] of tracks.entries()) await verify(multiPath,entry,multi.tracks[index]);
 const failed=path.join(dir,'failed.skshow');
 const failure=await call('showkontrol_compose_multi_track_show_copy',{source,destination:failed,sha256,tracks:[first,{...second,layerOperations:[...second.layerOperations,{operation:'rename',layerName:'Missing',newName:'Bad'}]}]});
 assert.equal(failure.isError,true,JSON.stringify(failure));
 await assert.rejects(readFile(failed),/ENOENT/);
 assert.deepEqual((await readdir(dir)).sort(),['multi.skshow','single.skshow','source.skshow']);
 assert.equal(await readFile(source,'utf8'),sourceText);
});
