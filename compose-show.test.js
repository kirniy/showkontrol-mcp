import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {composeShowCopy} from './compose-show.js';
import {inspectShow} from './xml-copy.js';
import {inspectShowTimeline, inspectCueGraph} from './timeline.js';
import {inspectShowSetlist} from './setlist.js';

const part = (name, text) => `<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const graph = '<graph><node id="n154" type="groupin"><settings/></node><node id="n155" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node><node id="n156" type="action"><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n154" fromPin="0" toNode="n155" toPin="0"/><connection fromNode="n155" fromPin="0" toNode="n156" toPin="0"/></graph>';

test('composes cues, donor graphs and a set entry without changing inputs', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'sk-compose-')); t.after(() => rm(dir, {recursive:true, force:true}));
 const source = path.join(dir,'source.skshow'), donorFile = path.join(dir,'donor.skshow'), destination = path.join(dir,'out.skshow');
 const sourceText = `<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><titles/><layers><layer name="Layer 1"/></layers><audio name="Audio 1" follow="0"/></sktimeline>')}${part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Set 1"/></sksetlist>')}${part('patch.skf','<showkontrol version="2"><graph><node id="n200"/></graph></showkontrol>')}</skshow>`;
 const donorText = `<skshow>${part('content/Donor.sktl',`<sktimeline version="1" name="Donor"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue">${graph}</cue></sktimeline>`)}</skshow>`;
 await writeFile(source,sourceText); await writeFile(donorFile,donorText);
 const args = {source,destination,sha256:(await inspectShow({file:source})).sha256,templateName:'content/Empty.sktl',trackName:'New Track',partName:'content/New.sktl',cues:[{layer:0,startMs:100,lengthMs:40,label:'One',settings:[{nodeId:'n155',key:'trigger.path',value:'cue.one'}]},{layer:0,startMs:200,lengthMs:40,label:'Two',settings:[{nodeId:'n155',key:'trigger.path',value:'cue.two'}]}],donor:{file:donorFile,sha256:(await inspectShow({file:donorFile})).sha256,name:'content/Donor.sktl',cueId:'c1'},set:{name:'content/Setlist.skls',setName:'Set 1'}};
 const result = await composeShowCopy(args);
 assert.equal(result.sha256,(await inspectShow({file:destination})).sha256);
 assert.equal(new Set(result.cues.map(c=>c.id)).size,2);
 const timeline = await inspectShowTimeline({file:destination,name:args.partName});
 assert.equal(timeline.cueElements.length,2);
 for (const cue of result.cues) {assert.equal(Object.keys(cue.idMap).length,3); assert.equal((await inspectCueGraph({file:destination,format:'skshow',name:args.partName,cueId:cue.id})).graph.connections.length,2);}
 for (const [i,cue] of result.cues.entries()) {const graph = (await inspectCueGraph({file:destination,format:'skshow',name:args.partName,cueId:cue.id})).graph; assert.equal(graph.nodes.find(n=>n.id===cue.idMap.n155).settings.find(s=>s.key==='trigger.path').value,['cue.one','cue.two'][i]);}
 for (const [settings,donorOverride] of [[[{nodeId:'n999',key:'trigger.path',value:'x'}],undefined],[[{nodeId:'n155',key:'missing',value:'x'}],undefined],[[{nodeId:'n155',key:'trigger.path',value:'x'}],null]]) {await assert.rejects(composeShowCopy({...args,destination:path.join(dir,'bad.skshow'),cues:[args.cues[0],{...args.cues[1],settings,donor:donorOverride}]}));}
 assert.deepEqual((await inspectShowSetlist({file:destination,name:args.set.name})).sets,[{name:'Set 1',tracks:['New Track']}]);
 assert.equal(await readFile(source,'utf8'),sourceText); assert.equal(await readFile(donorFile,'utf8'),donorText);
 await assert.rejects(composeShowCopy(args),/EEXIST/);
 await assert.rejects(composeShowCopy({...args,destination:path.join(dir,'bad.skshow'),donor:{...args.donor,sha256:'0'.repeat(64)}}),/changed/);
 assert.deepEqual((await readdir(dir)).sort(),['donor.skshow','out.skshow','source.skshow']);
});

test('composes simple cues without a donor or set and cleans a failed composition', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'sk-compose-simple-')); t.after(() => rm(dir,{recursive:true,force:true}));
 const source = path.join(dir,'source.skshow'), destination = path.join(dir,'out.skshow');
 const text = `<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,text);
 const args = {source,destination,sha256:(await inspectShow({file:source})).sha256,templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',cues:[{layer:0,startMs:0,lengthMs:40,label:'Cue'}]};
 const result = await composeShowCopy(args);
 assert.equal(result.cues.length,1);
 assert.equal((await inspectCueGraph({file:destination,format:'skshow',name:args.partName,cueId:result.cues[0].id})).graph,null);
 await assert.rejects(composeShowCopy({...args,destination:path.join(dir,'bad.skshow'),cues:[...args.cues,{layer:99,startMs:0,lengthMs:40,label:'Bad'}]}));
 assert.equal(await readFile(source,'utf8'),text);
 assert.deepEqual((await readdir(dir)).sort(),['out.skshow','source.skshow']);
});


test('selects a donor per cue, uses the default, and skips a graph with null', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'sk-compose-donors-')); t.after(() => rm(dir,{recursive:true,force:true}));
 const source = path.join(dir,'source.skshow'), first = path.join(dir,'first.skshow'), second = path.join(dir,'second.skshow'), destination = path.join(dir,'out.skshow');
 await writeFile(source,`<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`);
 const makeDonor = value => `<skshow>${part('content/Donor.sktl',`<sktimeline version="1" name="Donor"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue">${graph.replace('State On',value)}</cue></sktimeline>`)}</skshow>`;
 await writeFile(first,makeDonor('State On')); await writeFile(second,makeDonor('State Off'));
 const donor = async file => ({file,sha256:(await inspectShow({file})).sha256,name:'content/Donor.sktl',cueId:'c1'});
 const result = await composeShowCopy({source,destination,sha256:(await inspectShow({file:source})).sha256,templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',donor:await donor(first),cues:[{layer:0,startMs:0,lengthMs:40,label:'Default'},{layer:0,startMs:100,lengthMs:40,label:'Other',donor:await donor(second)},{layer:0,startMs:200,lengthMs:40,label:'None',donor:null}]});
 const graphs = await Promise.all(result.cues.map(cue => inspectCueGraph({file:destination,format:'skshow',name:'content/New.sktl',cueId:cue.id})));
 const triggerValue = info => info.graph.nodes.find(n => n.type === 'trigger').settings.find(s => s.key === 'trigger.on').value;
 assert.equal(triggerValue(graphs[0]),'State On'); assert.equal(triggerValue(graphs[1]),'State Off'); assert.equal(graphs[2].graph,null);
 assert.ok(result.cues[0].idMap); assert.ok(result.cues[1].idMap); assert.equal(result.cues[2].idMap,undefined);
});

test('applies ordered layer operations before adding cues and cleans failures', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'sk-compose-layers-')); t.after(() => rm(dir, {recursive:true, force:true}));
 const source = path.join(dir,'source.skshow'), destination = path.join(dir,'out.skshow');
 const input = `<skshow>${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,input);
 const args = {source,destination,sha256:(await inspectShow({file:source})).sha256,templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',layerOperations:[{operation:'append',layerName:'Layer 1',newName:'Copy'},{operation:'rename',layerName:'Copy',newName:'Lights'}],cues:[{layer:1,startMs:0,lengthMs:40,label:'Lights cue'}]};
 await composeShowCopy(args);
 const timeline = await inspectShowTimeline({file:destination,name:args.partName});
 assert.deepEqual(timeline.layers.map(layer=>layer.name),['Layer 1','Lights']);
 assert.equal(timeline.cueElements[0].attributes.layer,'1');
 const bad = path.join(dir,'bad.skshow');
 await assert.rejects(composeShowCopy({...args,destination:bad,layerOperations:[...args.layerOperations,{operation:'append',layerName:'Missing',newName:'Bad'}]}),/exactly one/);
 await assert.rejects(composeShowCopy({...args,destination:bad,layerOperations:[{operation:'remove',layerName:'Lights',newName:'Bad'}]}),/Layer operations/);
 assert.equal(await readFile(source,'utf8'),input);
 assert.deepEqual((await readdir(dir)).sort(),['out.skshow','source.skshow']);
});

test('reports stored stopped nodes after cue settings are applied', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-compose-stopped-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'), donorFile=path.join(dir,'donor.skshow'), destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 const donorText=`<skshow>${part('Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 await writeFile(source,input); await writeFile(donorFile,donorText);
 const sha256=(await inspectShow({file:source})).sha256, donor={file:donorFile,sha256:(await inspectShow({file:donorFile})).sha256,name:'Donor.sktl',cueId:'d'};
 const cue={layer:0,startMs:0,lengthMs:40,label:'Cue'};
 const args={source,destination,sha256,templateName:'Empty.sktl',trackName:'New',partName:'content/New.sktl',donor,cues:[cue,{...cue,settings:[{nodeId:'n1',key:'node.stopped',value:'false'}]},{...cue,settings:[{nodeId:'n1',key:'node.stopped',value:'true'}]}]};
 const result=await composeShowCopy(args);
 assert.deepEqual(result.warnings.map(w=>[w.scope.part,w.scope.cueId,w.scope.nodeId]),[0,2].map(i=>['content/New.sktl',result.cues[i].id,result.cues[i].idMap.n1]));
 assert.equal(result.sha256,(await inspectShow({file:destination})).sha256);
 const bad=path.join(dir,'bad.skshow'); await assert.rejects(composeShowCopy({...args,destination:bad,cues:[cue,{...cue,settings:[{nodeId:'n1',key:'node.stopped',value:'invalid'}]}]}));
 await assert.rejects(readFile(bad),/ENOENT/); assert.equal(await readFile(source,'utf8'),input); assert.equal(await readFile(donorFile,'utf8'),donorText);
});
