import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectShow,readShowPart} from './xml-copy.js';
import {renameShowTrackCopy} from './track-rename.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('rejects unsupported decoded references and unreadable XML without publishing',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'track-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in'),destination=path.join(dir,'out');
 const timeline=part('track.sktl','<sktimeline version="1" name="Alpha &amp; Beta"/>');
 const examples=[
  ['patch.skf','<patch><appact track="Alpha &amp; Beta"/></patch>'],
  ['program.skpr','<program><setting>alpha &amp; beta</setting></program>'],
  ['cue.sksc','<cue><target>Alpha &#38; Beta</target></cue>'],
  ['cue.skcp','<cue name="ALPHA &amp; BETA"/>'],
  ['other.sktl','<sktimeline version="1" name="Other"><cue track="Alpha &amp; Beta"/></sktimeline>'],
  ['broken.skf','<patch>'],
  ['bad.skcp',Buffer.from([0xff])],
 ];
 for(const [name,xml] of examples){
  const original=`<skshow>${timeline}${part(name,xml)}</skshow>`;await writeFile(source,original);
  const sha256=(await inspectShow({file:source})).sha256;
  await assert.rejects(renameShowTrackCopy({source,destination,sha256,oldName:'Alpha & Beta',newName:'New'}));
  assert.deepEqual(await readdir(dir),['in']);assert.equal(await readFile(source,'utf8'),original);
 }
});
test('rewrites only exact setlist entries and supports a case-only rename',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'track-ref-ok-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in'),destination=path.join(dir,'out');
 const set='<sksetlist version="2"><set name="Set"><entry track="Alpha &amp; Beta"/></set></sksetlist>';
 await writeFile(source,`<skshow>${part('track.sktl','<sktimeline version="1" name="Alpha &amp; Beta"/>')}${part('set.skls',set)}${part('patch.skf','<patch><appact track="Other"/></patch>')}</skshow>`);
 const sha256=(await inspectShow({file:source})).sha256;
 const result=await renameShowTrackCopy({source,destination,sha256,oldName:'Alpha & Beta',newName:'alpha & beta'});
 assert.equal(result.entries,1);assert.match((await readShowPart({file:destination,name:'set.skls'})).text,/track="alpha &amp; beta"/);
 assert.equal((await readShowPart({file:destination,name:'patch.skf'})).text,'<patch><appact track="Other"/></patch>');
});
