import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import os from 'node:os';import path from 'node:path';
import {validateShow} from './validate-show.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('show validation reports scoped graph, track and checksum problems',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-validate-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const patch='<showkontrol version="2"><graph><node id="n1"/><connection fromNode="n1" toNode="missing"/></graph><appSettings/></showkontrol>';
 const timeline='<sktimeline version="1" name="Song"><cue id="c1"><graph><node id="n1"/></graph></cue></sktimeline>';
 const setlist='<sksetlist version="2"><set name="Main"><entry track="Song"/><entry track="Absent"/></set></sksetlist>';
 const bad=part('bad.txt','data').replace(/md5="[a-f0-9]{32}"/,'md5="00000000000000000000000000000000"');
 const xml=`<skshow>${part('patch.skf',patch)}${part('one.sktl',timeline)}${part('two.sktl','<sktimeline version="1" name="Song"/>')}${part('set.skls',setlist)}${bad}</skshow>`;
 await writeFile(file,xml);const result=await validateShow({file});
 assert.equal(result.sha256,createHash('sha256').update(xml).digest('hex'));
 assert.deepEqual(result.diagnostics.map(d=>d.code).sort(),['ambiguous_track','duplicate_node_id','invalid_md5','invalid_wire_pin','invalid_wire_pin','missing_track','unknown_wire_endpoint']);
 assert.deepEqual(result.diagnostics.find(d=>d.code==='duplicate_node_id').scope,{part:'one.sktl',path:'sktimeline/cue/graph',cueId:'c1',nodeId:'n1'});
 assert.equal(result.diagnostics.find(d=>d.code==='unknown_wire_endpoint').scope.nodeId,'missing');
 assert.equal(result.diagnostics.find(d=>d.code==='missing_track').scope.track,'Absent');
});
test('valid show has no diagnostics and malformed parts are reported',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-validate-valid-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const timeline=part('song.sktl','<sktimeline version="1" name="Song"><cue id="c"><graph><node id="n1"/><node id="n2"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></cue></sktimeline>');
 const list=part('set.skls','<sksetlist version="2"><set name="Set"><entry track="Song"/></set></sksetlist>');
 await writeFile(file,`<skshow>${timeline}${list}</skshow>`);assert.deepEqual((await validateShow({file})).diagnostics,[]);
 await writeFile(file,`<skshow>${part('bad.sktl','<wrong/>')}</skshow>`);assert.equal((await validateShow({file})).diagnostics[0].code,'invalid_native_xml');
});
test('patch schema errors, scene limits and ignored parts have explicit coverage',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-coverage-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const invalidPatch=part('patch.skf','<notshow><graph><node id="n1"/><node id="n1"/></graph></notshow>');
 await writeFile(file,`<skshow>${invalidPatch}${part('scene.sksc','<arbitrary/>')}${part('readme.txt','ignored')}</skshow>`);
 const result=await validateShow({file});
 assert.ok(result.diagnostics.some(d=>d.code==='invalid_patch'&&d.scope.part==='patch.skf'));
 assert.ok(result.diagnostics.some(d=>d.code==='duplicate_node_id'&&d.scope.part==='patch.skf'));
 assert.ok(result.diagnostics.some(d=>d.code==='unverified_scene_schema'&&d.scope.part==='scene.sksc'&&d.severity==='warning'));
 assert.ok(result.diagnostics.some(d=>d.code==='invalid_patch'&&d.severity==='error'));
 assert.deepEqual(result.coverage,[{part:'patch.skf',status:'invalid'},{part:'scene.sksc',status:'partial'},{part:'readme.txt',status:'ignored'}]);
});

test('router targets and numeric pins are checked without changing the show',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-router-validation-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
 const patch=routers=>`<showkontrol version="2"><graph>${routers}<node id="n3"/><connection fromNode="n3" fromPin="banana" toNode="n3" toPin="-1"/></graph><appSettings/></showkontrol>`;
 const cue=value=>`<sktimeline version="1"><cue id="c1"><graph><node id="n9" type="action"><settings><setting key="route.router_target">${value}</setting></settings></node><connection fromNode="n9" toNode="n9" toPin="0"/></graph></cue></sktimeline>`;
 for(const [routers,value,code] of [[router('n1','A'),'Missing','missing_router_target'],[router('n1','A'),'&#65;',null],[router('n1','A')+router('n2','<![CDATA[A]]>'),'<![CDATA[A]]>','ambiguous_router_target'],[router('n1','A'),' ','invalid_router_target']]){
  const xml=`<skshow>${part('patch.skf',patch(routers))}${part('song.sktl',cue(value))}${part('scene.sksc','<scene/>')}${part('other.bin','data')}</skshow>`;await writeFile(file,xml);
  const result=await validateShow({file});assert.equal(await readFile(file,'utf8'),xml);assert.equal(result.diagnostics.filter(d=>d.code==='invalid_wire_pin').length,3);assert.deepEqual(result.diagnostics.filter(d=>d.code.endsWith('_router_target')).map(d=>d.code),code?[code]:[]);assert.equal(result.coverage.find(c=>c.part==='scene.sksc').status,'partial');assert.equal(result.coverage.find(c=>c.part==='other.bin').status,'ignored');
 }
});

test('MCP show validation reports graph errors and leaves the source intact',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-validate-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const patch='<showkontrol version="2"><graph><node id="n1" type="router"><settings><setting key="router.name">A</setting></settings></node><node id="n3" type="action"><settings><setting key="route.router_target">Absent</setting></settings></node></graph><appSettings/></showkontrol>';
 const cue='<sktimeline version="1"><cue id="c"><graph><node id="n2" type="action"><settings><setting key="route.router_target">Missing</setting></settings></node><connection fromNode="n2" fromPin="bad" toNode="n2" toPin="0"/></graph></cue></sktimeline>';
 const xml=`<skshow>${part('patch.skf',patch)}${part('song.sktl',cue)}</skshow>`;await writeFile(file,xml);
 const client=new Client({name:'validate-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const response=await client.callTool({name:'showkontrol_validate_show',arguments:{file}});assert.equal(response.isError,undefined);const result=JSON.parse(response.content[0].text);assert.equal(result.diagnostics.filter(d=>d.code==='missing_router_target').length,2);assert.ok(result.diagnostics.some(d=>d.code==='missing_router_target'&&d.scope.part==='patch.skf'));assert.ok(result.diagnostics.some(d=>d.code==='invalid_wire_pin'));assert.equal(await readFile(file,'utf8'),xml);
});

test('patch action router targets are checked once',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-patch-target-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const patch=(names,target)=>`<showkontrol version="2"><graph>${names.map((name,i)=>`<node id="n${i+1}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`).join('')}<node id="n9" type="action"><settings><setting key="route.router_target">${target}</setting></settings></node></graph><appSettings/></showkontrol>`;
 for(const [names,target,code] of [[['A'],'Missing','missing_router_target'],[['A'],'&#65;',null],[['A','<![CDATA[A]]>'],'A','ambiguous_router_target'],[['A'],' ','invalid_router_target']]){
  const xml=`<skshow>${part('patch.skf',patch(names,target))}</skshow>`;await writeFile(file,xml);const result=await validateShow({file});assert.deepEqual(result.diagnostics.filter(d=>d.code.endsWith('_router_target')).map(d=>d.code),code?[code]:[]);assert.equal(await readFile(file,'utf8'),xml);
 }
});

test('duplicate and misplaced router settings are invalid in supported graphs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-target-placement-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const patch='<showkontrol version="2"><graph><node id="n1" type="router"><settings><setting key="router.name">A</setting></settings></node></graph><appSettings/></showkontrol>';
 const setting='<setting key="route.router_target">A</setting>';
 for(const content of [`<settings>${setting}${setting}</settings>`,setting]){
  const timeline=`<sktimeline version="1"><cue id="c"><graph><node id="n2" type="action">${content}</node></graph></cue></sktimeline>`;await writeFile(file,`<skshow>${part('patch.skf',patch)}${part('song.sktl',timeline)}</skshow>`);const result=await validateShow({file});assert.ok(result.diagnostics.some(d=>d.code==='invalid_router_target'));
 }
});

test('unsupported graph paths have partial coverage and a scoped warning',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-unsupported-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const timeline='<sktimeline version="1"><cue id="c"><extension><graph><node id="n1"/><connection fromNode="n1" fromPin="bad" toNode="n1" toPin="0"/></graph></extension></cue></sktimeline>';await writeFile(file,`<skshow>${part('song.sktl',timeline)}</skshow>`);const result=await validateShow({file});assert.equal(result.coverage[0].status,'partial');assert.ok(result.diagnostics.some(d=>d.code==='unsupported_graph'&&d.severity==='warning'&&d.scope.path==='sktimeline/cue/extension/graph'));assert.ok(!result.diagnostics.some(d=>d.code==='invalid_wire_pin'));
});
