import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {composeShowCopy} from './compose-show.js';
import {inspectShowTimeline} from './timeline.js';
const hash=(type,text)=>createHash(type).update(text).digest('hex');
const timeline='<sktimeline version="1"><layers><layer name="A"/><layer name="B"/><layer name="C"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"><graph><node id="n1" type="groupin" layer="-1"><settings/></node></graph></cue></sktimeline>';
async function setup(){
 const dir=await mkdtemp(path.join(tmpdir(),'compose-layer-')),source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow'),name='content/Track.sktl';
 const show=`<skshow><part name="${name}" md5="${hash('md5',timeline)}">${Buffer.from(timeline).toString('base64')}</part></skshow>`;await writeFile(source,show);
 return {dir,source,destination,sha256:hash('sha256',show),existingPartName:name};
}
test('composes ordered layer moves and removals with cue remapping',async()=>{
 const args=await setup();await composeShowCopy({...args,layerOperations:[{operation:'move',layerName:'A',targetIndex:2},{operation:'remove',layerName:'B'}]});
 const result=await inspectShowTimeline({file:args.destination,name:args.existingPartName});
 assert.deepEqual(result.layers.map(layer=>layer.name),['C','A']);assert.equal(result.cueElements[0].attributes.layer,'1');
});
test('rejects invalid layer operation fields before writing',async()=>{
 const args=await setup();
 for(const operation of [{operation:'move',layerName:'A'},{operation:'move',layerName:'A',targetIndex:-1},{operation:'move',layerName:'A',targetIndex:1,newName:'X'},{operation:'remove',layerName:'B',targetIndex:0},{operation:'remove',layerName:'B',newName:'X'},{operation:'rename',layerName:'A',newName:'X',targetIndex:1}]){
  await assert.rejects(composeShowCopy({...args,layerOperations:[operation]}),/Layer operations/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 }
});
test('cleans intermediate copies when a layer removal fails',async()=>{
 const args=await setup();await assert.rejects(composeShowCopy({...args,layerOperations:[{operation:'move',layerName:'A',targetIndex:2},{operation:'remove',layerName:'A'}]}),/occupied/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
});
