import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {inspectShowMedia} from './media-inventory.js';

const part=(name,value,md5)=>{const bytes=Buffer.from(value);return `<part name="${name}" md5="${md5||createHash('md5').update(bytes).digest('hex')}">${bytes.toString('base64')}</part>`;};
const item=timeline=>`<item start="0" name="Item" notes="">${timeline}</item>`;
const program=items=>`<skprogram version="1">${items}</skprogram>`;
const timeline=file=>`<sktimeline version="1"><audio><clip file="${file}"/></audio></sktimeline>`;

test('inventories standalone and Program item clips with literal mapping matches without changing the show',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'media-program-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const input=Buffer.from(`<skshow>${part('media.map','/a.wav\tMEDIA/a.wav\n')}${part('content/Track.sktl',timeline('/a.wav'))}${part('content/Program.skpr',program(item('')+item(timeline('/a.wav'))+item(timeline('MEDIA/a.wav'))))}</skshow>`);
 await writeFile(file,input);const result=await inspectShowMedia({file});
 assert.deepEqual(result.clips.map(({part,itemIndex,mappingLines})=>({part,itemIndex,mappingLines})),[
  {part:'content/Track.sktl',itemIndex:undefined,mappingLines:[1]},
  {part:'content/Program.skpr',itemIndex:1,mappingLines:[1]},
  {part:'content/Program.skpr',itemIndex:2,mappingLines:[1]}
 ]);
 assert.deepEqual(result.diagnostics,[]);assert.deepEqual(await readFile(file),input);
});

test('reports invalid and duplicate Program parts and invalid item timelines',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'media-program-errors-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const inspect=async parts=>{await writeFile(file,`<skshow>${parts}</skshow>`);return inspectShowMedia({file});};
 let result=await inspect(part('content/Program.skpr',program(item('<sktimeline version="2"/>')+item(timeline('/ok')))));
 assert.equal(result.diagnostics[0].code,'invalid_timeline');assert.equal(result.diagnostics[0].itemIndex,0);assert.equal(result.clips[0].itemIndex,1);
 result=await inspect(part('content/Program.skpr','<skprogram version="1"><item/></skprogram>'));
 assert.equal(result.diagnostics[0].code,'invalid_program');assert.deepEqual(result.clips,[]);
 result=await inspect(part('content/Program.skpr',program(item(timeline('/a'))),'00000000000000000000000000000000'));
 assert.equal(result.diagnostics[0].code,'invalid_program_checksum');assert.deepEqual(result.clips,[]);
 result=await inspect(part('content/Program.skpr',program(''))+part('content/program.skpr',program('')));
 assert.equal(result.diagnostics[0].code,'duplicate_program_part');assert.deepEqual(result.clips,[]);
});

test('applies the clip limit across standalone and Program timelines',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'media-program-limit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const many=`<sktimeline version="1"><audio>${'<clip/>'.repeat(10000)}</audio></sktimeline>`;
 await writeFile(file,`<skshow>${part('content/Track.sktl',timeline('/a'))}${part('content/Program.skpr',program(item(many)))}</skshow>`);
 await assert.rejects(inspectShowMedia({file}),/Clip count exceeds inventory item limit/);
});
