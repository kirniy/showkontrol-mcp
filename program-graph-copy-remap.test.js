import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {copyProgramItemGraphRemappedCopy as copy} from './program-graph-copy-remap.js';
const hash=(a,b)=>createHash(a).update(b).digest('hex');
test('remaps before insertion, preserves other content, and guards failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'graph-copy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers/><cue id="c"><graph><node id="n9" type="x"/></graph></cue></sktimeline></item><item start="1" name="B" notes=""/></skprogram>';
 const timeline='<sktimeline version="1"><layers/><cue id="c1"><graph><node id="n9" type="x"/><node id="n2" type="y"/><connection fromNode="n9" toNode="n2"/></graph></cue></sktimeline>';
 const show=`<skshow><part name="content/Program.skpr" md5="${hash('md5',program)}">${Buffer.from(program).toString('base64')}</part></skshow>`;
 await Promise.all([writeFile(f('in.skpr'),program),writeFile(f('donor.sktl'),timeline),writeFile(f('target.skshow'),show)]);
 const args={source:f('in.skpr'),destination:f('one.skpr'),sha256:hash('sha256',program),index:0,donor:f('donor.sktl'),donorSha256:hash('sha256',timeline),donorCueId:'c1',target:f('target.skshow'),targetSha256:hash('sha256',show)};
 const first=await copy(args);assert.deepEqual(first.mapping,{n9:'n10',n2:'n11'});const one=await readFile(args.destination,'utf8');assert.ok(one.includes('<node id="n9" type="x"/>'));assert.ok(one.includes('<connection fromNode="n10" toNode="n11"/>'));
 const second=await copy({...args,source:args.destination,sha256:hash('sha256',one),index:1,destination:f('two.skpr')});assert.deepEqual(second.mapping,{n9:'n12',n2:'n13'});
 const replace={...args,source:args.destination,sha256:hash('sha256',one),destination:f('replace.skpr')};await assert.rejects(copy(replace),/already has/);await copy({...replace,replaceExisting:true});
 for(const key of ['sha256','donorSha256','targetSha256'])await assert.rejects(copy({...args,[key]:'0'.repeat(64),destination:f('bad.skpr')}),/changed/);
 const unsafe=timeline.replace('<node id="n9" type="x"/>','<node id="n9" type="x"><settings><setting key="ref">n2</setting></settings></node>');await writeFile(f('unsafe.sktl'),unsafe);await assert.rejects(copy({...args,donor:f('unsafe.sktl'),donorSha256:hash('sha256',unsafe),destination:f('bad.skpr')}),/unsupported internal references/);
 const linked=one.replace('<item start="1" name="B" notes=""/>','<item start="1" name="n10" notes=""/>');await writeFile(f('linked.skpr'),linked);await assert.rejects(copy({...replace,source:f('linked.skpr'),sha256:hash('sha256',linked),destination:f('linked-out.skpr'),replaceExisting:true}),/referenced outside/);
 await assert.rejects(copy(args),{code:'EEXIST'});assert.equal(await readFile(args.destination,'utf8'),one);assert.ok(!(await readdir(dir)).some(n=>n.endsWith('.tmp')));await assert.rejects(readFile(f('bad.skpr')),{code:'ENOENT'});
});

test('replacement rejects references in target parts but ignores the replaced Program part',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'graph-replace-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n7" type="x"/></graph></item></skprogram>';
 const donor='<sktimeline version="1"><layers/><cue id="c"><graph><node id="n1" type="x"/></graph></cue></sktimeline>';
 const part=(name,xml)=>`<part name="${name}" md5="${hash('md5',xml)}">${Buffer.from(xml).toString('base64')}</part>`;
 const canonical=part('content/Program.skpr',program),safe=`<skshow>${canonical}</skshow>`;
 await Promise.all([writeFile(f('source.skpr'),program),writeFile(f('donor.sktl'),donor),writeFile(f('target.skshow'),safe)]);
 const args={source:f('source.skpr'),destination:f('out.skpr'),sha256:hash('sha256',program),index:0,donor:f('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'c',target:f('target.skshow'),targetSha256:hash('sha256',safe),replaceExisting:true};
 await copy(args);assert.match(await readFile(args.destination,'utf8'),/id="n8"/);
 const patch='<showkontrol><graph><node id="n20" type="x"><settings><setting key="ref">n<![CDATA[7]]></setting></settings></node></graph></showkontrol>';
 const unsafe=`<skshow>${canonical}${part('patch.skf',patch)}</skshow>`;await writeFile(args.target,unsafe);
 await assert.rejects(copy({...args,destination:f('rejected.skpr'),targetSha256:hash('sha256',unsafe)}),/referenced outside/);
 await assert.rejects(readFile(f('rejected.skpr')),{code:'ENOENT'});assert.ok(!(await readdir(dir)).some(n=>n.endsWith('.tmp')));
});

test('reports a cue.active trigger in the copied direct graph',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'graph-warning-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/></skprogram>',show=`<skshow><part name="note.txt" md5="${hash('md5','hello')}">${Buffer.from('hello').toString('base64')}</part></skshow>`,donor='<sktimeline version="1"><layers/><cue id="c"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node></graph></cue></sktimeline>';
 await Promise.all([writeFile(f('in.skpr'),program),writeFile(f('target.skshow'),show),writeFile(f('donor.sktl'),donor)]);
 const result=await copy({source:f('in.skpr'),destination:f('out.skpr'),sha256:hash('sha256',program),index:0,donor:f('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'c',target:f('target.skshow'),targetSha256:hash('sha256',show)});
 assert.ok(result.warnings.some(w=>w.includes('trigger.path cue.active')));
});
test('copy permits opted-in OSC text but still rejects other references',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'graph-opaque-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/></skprogram>',show=`<skshow><part name="content/Program.skpr" md5="${hash('md5',program)}">${Buffer.from(program).toString('base64')}</part></skshow>`;
 const donor='<sktimeline version="1"><layers/><cue id="c"><graph><node id="n1" type="generator" kind="OSC"><settings><setting key="gen.address">/n42</setting></settings></node></graph></cue></sktimeline>';
 await Promise.all([writeFile(f('in.skpr'),program),writeFile(f('target.skshow'),show),writeFile(f('donor.sktl'),donor)]);
 const args={source:f('in.skpr'),destination:f('out.skpr'),sha256:hash('sha256',program),index:0,donor:f('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'c',target:f('target.skshow'),targetSha256:hash('sha256',show)};
 await assert.rejects(copy(args),/unsupported internal references/);const result=await copy({...args,allowOpaqueNodeText:true});assert.match(await readFile(args.destination,'utf8'),/\/n42/);assert.deepEqual(result.warnings.find(w=>w.code==='opaque_node_references_unverified').scope,{part:args.destination,itemIndex:0,nodeId:result.mapping.n1,key:'gen.address'});
 const unsafe=donor.replace('</settings>','<setting key="other">n2</setting></settings>');await writeFile(f('unsafe.sktl'),unsafe);await assert.rejects(copy({...args,donor:f('unsafe.sktl'),donorSha256:hash('sha256',unsafe),destination:f('bad.skpr'),allowOpaqueNodeText:true}),/unsupported internal references/);
});
