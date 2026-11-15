import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {editTimelineLayerCopy} from './layers.js';
import {inspectTimeline,inspectShowTimeline} from './timeline.js';
import {readShowPart} from './xml-copy.js';
// Minimal layer and cue structure from a ShowKontrol R27 test timeline.
const fixture='<sktimeline version="1" name="Track"><layers><layer name="Layer 1"/><layer name="Layer 2"/><layer name="Layer 3"/><layer name="Layer 4"/></layers><audio name="Audio 1" follow="0"/><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"/></sktimeline>';
const digest=(algorithm,data)=>createHash(algorithm).update(data).digest('hex');
async function setup(){const dir=await mkdtemp(path.join(tmpdir(),'layers-'));const xml=fixture;const source=path.join(dir,'track.sktl');await writeFile(source,xml);return {dir,xml,source,sha256:digest('sha256',xml)};}
test('append copies the template and rename keeps cues and other fields',async()=>{
 const {dir,source,sha256}=await setup(),destination=path.join(dir,'append.sktl');
 const before=await inspectTimeline({file:source});
 const result=await editTimelineLayerCopy({source,destination,sha256,operation:'append',layerName:'Layer 2',newName:'Lights & "FX"'});
 const after=await inspectTimeline({file:destination});assert.equal(result.index,4);assert.deepEqual(after.layers[4],{name:'Lights & "FX"'});assert.deepEqual(after.cueElements,before.cueElements);
 const renamed=path.join(dir,'rename.sktl');await editTimelineLayerCopy({source:destination,destination:renamed,sha256:after.sha256,operation:'rename',layerName:'Layer 1',newName:'Main'});
 const last=await inspectTimeline({file:renamed});assert.equal(last.layers[0].name,'Main');assert.deepEqual(last.cueElements,before.cueElements);
});
test('edits show part and preserves copied layer attributes',async()=>{
 const {dir,xml}=await setup();const altered=xml.replace('<layer name="Layer 1"/>','<layer name="Layer 1" color="blue"/>');
 const part=Buffer.from(altered),source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');
 const show=`<skshow><part name="content/Track.sktl" md5="${digest('md5',part)}">${part.toString('base64')}</part></skshow>`;await writeFile(source,show);
 await editTimelineLayerCopy({source,destination,sha256:digest('sha256',show),format:'skshow',name:'content/Track.sktl',operation:'append',layerName:'Layer 1',newName:'New'});
 const read=await readShowPart({file:destination,name:'content/Track.sktl'});assert.match(read.text,/<layer name="New" color="blue"\/>/);
 assert.deepEqual((await inspectShowTimeline({file:destination,name:'content/Track.sktl'})).layers.at(-1),{name:'New',color:'blue'});
});
test('append rejects nested content while rename preserves it',async()=>{
 const {dir,xml}=await setup();const source=path.join(dir,'nested.sktl');
 const nested=xml.replace('<layer name="Layer 1"/>','<layer name="Layer 1"><graph><node id="n1"/></graph></layer>');await writeFile(source,nested);
 const args={source,sha256:digest('sha256',nested),layerName:'Layer 1',newName:'New'};
 await assert.rejects(editTimelineLayerCopy({...args,destination:path.join(dir,'append.sktl'),operation:'append'}),/empty content/);
 const destination=path.join(dir,'rename.sktl');await editTimelineLayerCopy({...args,destination,operation:'rename'});
 assert.match(await readFile(destination,'utf8'),/<layer name="New"><graph><node id="n1"\/><\/graph><\/layer>/);
});
test('rejects stale sources, duplicate or ambiguous names, overwrite and unsupported operations',async()=>{
 const {dir,source,sha256,xml}=await setup(),destination=path.join(dir,'out.sktl');const options={source,destination,sha256,operation:'append',layerName:'Layer 1',newName:'New'};
 await assert.rejects(editTimelineLayerCopy({...options,sha256:'bad'}),/changed/);
 await assert.rejects(editTimelineLayerCopy({...options,newName:'Layer 2'}),/already exists/);
 await assert.rejects(editTimelineLayerCopy({...options,operation:'remove'}),/Only append and rename/);
 const duplicate=path.join(dir,'duplicate.sktl');const content=xml.replace('name="Layer 2"','name="Layer 1"');await writeFile(duplicate,content);
 await assert.rejects(editTimelineLayerCopy({...options,source:duplicate,sha256:digest('sha256',content)}),/exactly one/);
 await writeFile(destination,'existing');await assert.rejects(editTimelineLayerCopy(options),/EEXIST/);assert.equal(await readFile(destination,'utf8'),'existing');
});
