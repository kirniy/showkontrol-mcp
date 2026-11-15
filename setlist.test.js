import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {inspectShowSetlist,addShowSetlistTrackCopy} from './setlist.js';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
test('set list inspection uses the same snapshot for its checksum and contents',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-snapshot-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow');
 const part=text=>`<part name="Setlist.skls" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const show=name=>`<skshow>${part(`<sksetlist version="2"><set name="${name}"/></sksetlist>`)}</skshow>`;
 const original=show('Before'),replacement=show('After');await writeFile(source,original);
 const open=fs.promises.open;let replaced=false;
 fs.promises.open=async (...args)=>{const handle=await open(...args);if(args[0]===source&&!replaced){const close=handle.close.bind(handle);handle.close=async()=>{await close();replaced=true;await writeFile(source,replacement)};}return handle;};syncBuiltinESMExports();
 try{const result=await inspectShowSetlist({file:source,name:'Setlist.skls'});assert.equal(result.sha256,createHash('sha256').update(original).digest('hex'));assert.deepEqual(result.sets,[{name:'Before',tracks:[]}]);assert.equal(await readFile(source,'utf8'),replacement);}
 finally{fs.promises.open=open;syncBuiltinESMExports();}
});
test('append a track to the app-fixture set list without altering other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline=part('content/Track.sktl','<sktimeline version="1" name="Track"><layers/></sktimeline>');const setlist=part('content/Setlist.skls','<?xml version="1.0" encoding="UTF-8"?><sksetlist version="2" active="0"><set name="Set 1"><entry track="Track"/></set></sksetlist>');const second=part('content/Track_2.sktl','<sktimeline version="1" name="Track 2"><layers/></sktimeline>');const original=`<skshow>${setlist}${timeline}${second}</skshow>`;await writeFile(source,original);
 const before=await inspectShowSetlist({file:source,name:'content/Setlist.skls'});assert.deepEqual(before.sets,[{name:'Set 1',tracks:['Track']}]);
 const args={source,destination,sha256:before.sha256,name:'content/Setlist.skls',setName:'Set 1',trackName:'Track 2'};await addShowSetlistTrackCopy(args);
 assert.deepEqual((await inspectShowSetlist({file:destination,name:args.name})).sets,[{name:'Set 1',tracks:['Track','Track 2']}]);assert.ok((await readFile(destination,'utf8')).includes(timeline));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(addShowSetlistTrackCopy(args),/EEXIST/);await assert.rejects(addShowSetlistTrackCopy({...args,destination:path.join(dir,'bad'),trackName:'Missing'}),/exactly one timeline/);await assert.rejects(addShowSetlistTrackCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
});
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP lists set list tools and appends an existing track',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 await writeFile(source,`<skshow>${part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Set 1"><entry track="Track"/></set></sksetlist>')}${part('content/Track.sktl','<sktimeline version="1" name="Track"/>')}${part('content/Track_2.sktl','<sktimeline version="1" name="Track 2"/>')}</skshow>`);
 const client=new Client({name:'setlist-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const {tools}=await client.listTools();for(const name of ['showkontrol_inspect_show_setlist','showkontrol_add_show_setlist_track_copy'])assert.ok(tools.some(tool=>tool.name===name));
 const inspected=await client.callTool({name:'showkontrol_inspect_show_setlist',arguments:{file:source,name:'content/Setlist.skls'}});assert.equal(inspected.isError,undefined);const before=JSON.parse(inspected.content[0].text);
 const changed=await client.callTool({name:'showkontrol_add_show_setlist_track_copy',arguments:{source,destination,sha256:before.sha256,name:'content/Setlist.skls',setName:'Set 1',trackName:'Track 2'}});assert.equal(changed.isError,undefined);
 const readback=await client.callTool({name:'showkontrol_inspect_show_setlist',arguments:{file:destination,name:'content/Setlist.skls'}});assert.deepEqual(JSON.parse(readback.content[0].text).sets,[{name:'Set 1',tracks:['Track','Track 2']}]);
});
test('add a track to a self-closing set without changing adjacent sets',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-empty-set-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const setlist='<sksetlist version="2"><set name="Set 1"/><set name="Set 2"><entry track="Other"/></set></sksetlist>';
 const timeline=part('Track.sktl','<sktimeline version="1" name="Track &amp; One"/>');
 const original=`<skshow>${part('Setlist.skls',setlist)}${timeline}</skshow>`;await writeFile(source,original);
 const before=await inspectShowSetlist({file:source,name:'Setlist.skls'});
 await addShowSetlistTrackCopy({source,destination,sha256:before.sha256,name:'Setlist.skls',setName:'Set 1',trackName:'Track & One'});
 assert.deepEqual((await inspectShowSetlist({file:destination,name:'Setlist.skls'})).sets,[{name:'Set 1',tracks:['Track & One']},{name:'Set 2',tracks:['Other']}]);
 assert.ok((await readFile(destination,'utf8')).includes(timeline));assert.equal(await readFile(source,'utf8'),original);
});
import {editShowSetlistCopy} from './setlist.js';
test('create a set and reorder or remove entries in offline copies',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const original=`<skshow>${part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Set 1"><entry track="A"/><entry track="B"/><entry track="C"/></set></sksetlist>')}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`;await writeFile(source,original);
 const name='content/Setlist.skls', {sha256}=await inspectShowSetlist({file:source,name});
 const call=(operation,extra)=>editShowSetlistCopy({source,destination:path.join(dir,operation),sha256,name,operation,...extra});
 await call('create_set',{newSetName:'Set & 2'});assert.deepEqual((await inspectShowSetlist({file:path.join(dir,'create_set'),name})).sets.map(s=>s.name),['Set 1','Set & 2']);
 await call('move_track',{setName:'Set 1',index:0,toIndex:2});assert.deepEqual((await inspectShowSetlist({file:path.join(dir,'move_track'),name})).sets[0].tracks,['B','C','A']);
 await call('remove_track',{setName:'Set 1',index:1});assert.deepEqual((await inspectShowSetlist({file:path.join(dir,'remove_track'),name})).sets[0].tracks,['A','C']);
 await assert.rejects(call('move_set',{setName:'Set 1',toIndex:0}),/active-set/);await assert.rejects(call('remove_set',{setName:'Set 1'}),/active-set/);
 await assert.rejects(call('move_track',{setName:'Set 1',index:0,toIndex:4}),/outside/);await assert.rejects(call('create_set',{newSetName:'Set 1'}),/already exists/);
 await assert.rejects(editShowSetlistCopy({source,destination:path.join(dir,'stale'),sha256:'0'.repeat(64),name,operation:'create_set',newSetName:'X'}),/changed/);assert.equal(await readFile(source,'utf8'),original);
});
test('self-closing set preserves dollar replacement tokens in track names',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-dollar-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const trackName="Track $& $$ $' $`";
 await writeFile(source,`<skshow>${part('Setlist.skls','<sksetlist version="2"><set name="Set 1"/></sksetlist>')}${part('Track.sktl','<sktimeline version="1" name="Track $&amp; $$ $&apos; $`"/>')}</skshow>`);
 const before=await inspectShowSetlist({file:source,name:'Setlist.skls'});
 await addShowSetlistTrackCopy({source,destination,sha256:before.sha256,name:'Setlist.skls',setName:'Set 1',trackName});
 assert.deepEqual((await inspectShowSetlist({file:destination,name:'Setlist.skls'})).sets,[{name:'Set 1',tracks:[trackName]}]);
});
test('set and track edits handle greater-than signs in attribute values',async t=>{
 const {editShowSetlistCopy}=await import('./setlist.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-gt-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),created=path.join(dir,'created.skshow'),added=path.join(dir,'added.skshow'),removed=path.join(dir,'removed.skshow'),existing=path.join(dir,'existing.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 await writeFile(source,`<skshow>${part('Setlist.skls','<sksetlist version="2"><set name="Existing > Set"><entry track="Old > Track"/></set></sksetlist>')}${part('Track.sktl','<sktimeline version="1" name="New > Track"/>')}</skshow>`);
 const args={name:'Setlist.skls'},info=file=>inspectShowSetlist({file,...args});
 let before=await info(source);
 await editShowSetlistCopy({source,destination:existing,sha256:before.sha256,...args,operation:'remove_track',setName:'Existing > Set',index:0});
 assert.deepEqual((await info(existing)).sets,[{name:'Existing > Set',tracks:[]}]);
 await editShowSetlistCopy({source,destination:created,sha256:before.sha256,...args,operation:'create_set',newSetName:'New > Set'});
 before=await info(created);
 await addShowSetlistTrackCopy({source:created,destination:added,sha256:before.sha256,...args,setName:'New > Set',trackName:'New > Track'});
 assert.deepEqual((await info(added)).sets,[{name:'Existing > Set',tracks:['Old > Track']},{name:'New > Set',tracks:['New > Track']}]);
 before=await info(added);
 await editShowSetlistCopy({source:added,destination:removed,sha256:before.sha256,...args,operation:'remove_track',setName:'New > Set',index:0});
 assert.deepEqual((await info(removed)).sets[1],{name:'New > Set',tracks:[]});
});
test('remove and move target direct entries instead of commented decoys',async t=>{
 const {editShowSetlistCopy}=await import('./setlist.js');const {readShowPart}=await import('./xml-copy.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-comment-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),removed=path.join(dir,'removed.skshow'),moved=path.join(dir,'moved.skshow'),name='Setlist.skls';
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const xml='<sksetlist version="2"><!-- <set name="fake"><entry track="fake"/></set> --><set name="Set 1"><!-- <entry track="decoy"/> --><entry track="A"></entry><entry track="B"/></set></sksetlist>';
 await writeFile(source,`<skshow>${part(name,xml)}</skshow>`);const before=await inspectShowSetlist({file:source,name});
 await editShowSetlistCopy({source,destination:removed,sha256:before.sha256,name,operation:'remove_track',setName:'Set 1',index:0});
 assert.deepEqual((await inspectShowSetlist({file:removed,name})).sets,[{name:'Set 1',tracks:['B']}]);
 assert.match((await readShowPart({file:removed,name})).text,/<!-- <entry track="decoy"\/> -->/);
 await editShowSetlistCopy({source,destination:moved,sha256:before.sha256,name,operation:'move_track',setName:'Set 1',index:0,toIndex:1});
 assert.deepEqual((await inspectShowSetlist({file:moved,name})).sets,[{name:'Set 1',tracks:['B','A']}]);
 assert.match((await readShowPart({file:moved,name})).text,/<!-- <entry track="decoy"\/> -->/);
});
