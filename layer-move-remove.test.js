import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {editTimelineLayerCopy} from './layers.js';
import {parseTimeline} from './timeline.js';
import {readShowPart} from './xml-copy.js';
const hash=(alg,s)=>createHash(alg).update(s).digest('hex');
const graph='<graph><node id="n1" type="action" x="540" y="140" title="FeedbackBeep" layer="-1" kind=""><settings><setting key="action.category">test</setting></settings></node></graph>';
const xml=`<sktimeline version="1"><layers><layer name="A"/><layer name="B" color="blue"/><layer name="C"/><layer name="D"/></layers><cue id="a" layer="0">${graph}</cue><cue id="c" layer="2"/><cue id="d" layer="3"/><unknown keep="yes"/></sktimeline>`;
async function setup(content=xml){const dir=await mkdtemp(path.join(tmpdir(),'layer-move-')),source=path.join(dir,'in.sktl');await writeFile(source,content);return {dir,source,sha256:hash('sha256',content)};}
async function edit(content,operation,layerName,targetIndex){const opts=await setup(content),destination=path.join(opts.dir,'out.sktl');const result=await editTimelineLayerCopy({...opts,destination,operation,layerName,...(targetIndex===undefined?{}:{targetIndex})});return {result,text:await readFile(destination,'utf8')};}
test('moves layers in both directions and preserves cue graphs',async()=>{
 for(const [layer,target,names,indices] of [['A',3,['B','C','D','A'],['3','1','2']],['D',0,['D','A','B','C'],['1','3','0']]]){
  const {text,result}=await edit(xml,'move',layer,target),parsed=parseTimeline(text);
  assert.deepEqual(parsed.layers.map(l=>l.name),names);assert.deepEqual(parsed.cueElements.map(c=>c.attributes.layer),indices);assert.equal(result.index,target);assert.ok(text.includes(graph));assert.ok(text.includes('<unknown keep="yes"/>'));
 }
});
test('removes empty layer and adjusts only subsequent cue indices',async()=>{
 const {text,result}=await edit(xml,'remove','B');const parsed=parseTimeline(text);
 assert.deepEqual(parsed.layers.map(l=>l.name),['A','C','D']);assert.deepEqual(parsed.cueElements.map(c=>c.attributes.layer),['0','1','2']);assert.equal(result.index,1);assert.ok(text.includes(graph));
});
test('edits a show part and validates checksum on readback',async()=>{
 const {dir}=await setup(),source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const show=`<skshow><part name="content/t.sktl" md5="${hash('md5',xml)}">${Buffer.from(xml).toString('base64')}</part></skshow>`;await writeFile(source,show);
 await editTimelineLayerCopy({source,destination,sha256:hash('sha256',show),format:'skshow',name:'content/t.sktl',operation:'remove',layerName:'B'});
 const part=await readShowPart({file:destination,name:'content/t.sktl'});assert.deepEqual(parseTimeline(part.text).cueElements.map(c=>c.attributes.layer),['0','1','2']);assert.ok(part.text.includes(graph));
});
test('rejects unsafe structures without writing a destination',async()=>{
 const cases=[
  [xml,'remove','A',undefined,/occupied/],
  [xml.replace('<unknown keep="yes"/>','<cue id="nested" layer="0"/>').replace('<cue id="a" layer="0">','<cue id="a" layer="0"><cue id="nested2" layer="0"/>'),'move','A',1,/Nested cues/],
  [xml.replace('<unknown keep="yes"/>','<other layerIndex="0"/>'),'move','A',1,/reference/],
  [xml.replace('<unknown keep="yes"/>','<layers/>'),'move','A',1,/exactly one/],
  [xml.replace('layer="2"','layer="9"'),'remove','B',undefined,/invalid layer/],
  [xml.replace('<layer name="B" color="blue"/>','<layer name="B"><data/></layer>'),'remove','B',undefined,/content/],
  [xml,'move','A',4,/Target index/],
  [xml.replace('layer="-1"','layer="0"'),'move','A',1,/reference/]
 ];
 for(const [content,operation,layerName,targetIndex,error] of cases){const opts=await setup(content),destination=path.join(opts.dir,'out.sktl');await assert.rejects(editTimelineLayerCopy({...opts,destination,operation,layerName,targetIndex}),error);await assert.rejects(readFile(destination),{code:'ENOENT'});}
});

test('rejects targetIndex for operations that do not use it',async()=>{
 for(const operation of ['append','rename','remove']){
  const opts=await setup();
  await assert.rejects(editTimelineLayerCopy({...opts,destination:path.join(opts.dir,'out.sktl'),operation,layerName:'B',newName:operation==='remove'?undefined:'New',targetIndex:1}),/Only move accepts targetIndex/);
 }
});
