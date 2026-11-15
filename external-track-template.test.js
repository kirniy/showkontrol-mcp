import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectShow,inspectXml} from './xml-copy.js';
import {createShowTrackCopy,inspectShowTimeline} from './timeline.js';
import {composeShowCopy} from './compose-show.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const empty='<sktimeline version="1" name="Template"><layers><layer name="Layer 1"/></layers></sktimeline>';
const occupied='<sktimeline version="1" name="Occupied"><layers><layer name="Layer 1"/></layers><cue id="c1"/></sktimeline>';
test('external timeline templates create and compose tracks with no empty target template',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-ext-template-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'), standalone=path.join(dir,'empty.sktl'), show=path.join(dir,'donor.skshow');
 const original=`<skshow>${part('content/Occupied.sktl',occupied)}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,original);await writeFile(standalone,empty);await writeFile(show,`<skshow>${part('content/Empty.sktl',empty)}</skshow>`);
 const sha256=(await inspectShow({file:source})).sha256;
 const st={file:standalone,format:'sktl',sha256:(await inspectXml({file:standalone})).sha256};
 const sh={file:show,format:'skshow',sha256:(await inspectShow({file:show})).sha256,name:'content/Empty.sktl'};
 const base={source,sha256,trackName:'New',partName:'content/New.sktl'};
 const one=path.join(dir,'one.skshow');await createShowTrackCopy({...base,destination:one,templateDonor:st});
 assert.equal((await inspectShowTimeline({file:one,name:base.partName})).attributes.name,'New');
 const two=path.join(dir,'two.skshow');await composeShowCopy({...base,destination:two,templateDonor:sh,cues:[{layer:0,startMs:0,lengthMs:5,label:'Cue'}]});
 assert.equal((await inspectShowTimeline({file:two,name:base.partName})).cueElements.length,1);
 const three=path.join(dir,'three.skshow');await composeMultiTrackShowCopy({source,destination:three,sha256,tracks:[{trackName:'A',partName:'content/A.sktl',templateDonor:st},{trackName:'B',partName:'content/B.sktl',templateDonor:sh}]});
 assert.equal((await inspectShowTimeline({file:three,name:'content/B.sktl'})).attributes.name,'B');
 const bad=path.join(dir,'bad.skshow');
 for(const args of [
  {...base,templateDonor:{...st,sha256:'0'.repeat(64)}},
  {...base,templateDonor:{...sh,name:'content/Missing.sktl'}},
  {...base,templateDonor:st,trackName:'occupied'},
  {...base,templateDonor:st,partName:'content/occupied.sktl'},
  {...base,templateDonor:st,templateName:'content/Occupied.sktl'},
 ]) await assert.rejects(createShowTrackCopy({...args,destination:bad}));
 await writeFile(standalone,occupied);
 await assert.rejects(createShowTrackCopy({...base,destination:bad,templateDonor:st}),/changed/);
 const nonempty={...st,sha256:(await inspectXml({file:standalone})).sha256};
 await assert.rejects(createShowTrackCopy({...base,destination:bad,templateDonor:nonempty}),/empty/);
 await writeFile(standalone,empty);
 await assert.rejects(composeMultiTrackShowCopy({source,destination:bad,sha256,tracks:[{trackName:'A',partName:'content/A.sktl',templateDonor:st},{trackName:'occupied',partName:'content/B.sktl',templateDonor:sh}]}),/already exists/);
 await assert.rejects(readFile(bad),/ENOENT/);assert.equal(await readFile(source,'utf8'),original);
 assert.deepEqual((await readdir(dir)).sort(),['donor.skshow','empty.sktl','one.skshow','source.skshow','three.skshow','two.skshow']);
});
