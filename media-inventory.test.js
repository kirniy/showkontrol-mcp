import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const part=(name,value,md5)=>{const b=Buffer.from(value);return `<part name="${name}" md5="${md5||createHash('md5').update(b).digest('hex')}">${b.toString('base64')}</part>`};
test('MCP inventories exact mappings, clip attributes and archive checksums',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const timeline='<sktimeline version="1"><audio><clip file="/Users/test/Track.wav" name="Track"/><clip file="MEDIA/Missing.wav"/></audio></sktimeline>';
 const map='/Users/test/Track.wav\tMEDIA/Track.wav\n/Users/test/Missing.wav\tMEDIA/Missing.wav\n/Users/test/Track.wav\tMEDIA/Missing.wav\nbad line\n';
 await writeFile(file,`<skshow>${part('media.map',map)}${part('MEDIA/Track.wav','abc')}${part('MEDIA/Track.wav','bad','00000000000000000000000000000000')}${part('content/A.sktl',timeline)}</skshow>`);
 const client=new Client({name:'media-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async()=>{const response=await client.callTool({name:'showkontrol_inspect_show_media',arguments:{file}});assert.equal(response.isError,undefined);return JSON.parse(response.content[0].text)};
 const r=await call();assert.equal(r.mappings.length,3);assert.deepEqual(r.mappings[0].archiveMatches.map(x=>x.valid),[true,false]);assert.deepEqual(r.mappings[1].archiveMatches,[]);assert.deepEqual(r.clips.map(c=>c.mappingLines),[[1,3],[2,3]]);assert.equal(r.clips[0].attributes.name,'Track');assert.deepEqual(r.diagnostics.map(d=>d.code),['malformed_mapping','duplicate_source','duplicate_archive_path']);
 await writeFile(file,`<skshow>${part('content/A.sktl',timeline)}</skshow>`);const noMap=await call();assert.deepEqual(noMap.mapParts,[]);assert.deepEqual(noMap.mappings,[]);assert.deepEqual(noMap.clips[0].mappingLines,[]);
 await writeFile(file,`<skshow>${part('media.map','a\tMEDIA/a')}${part('media.map','b\tMEDIA/b')}</skshow>`);const duplicate=await call();assert.equal(duplicate.diagnostics[0].code,'duplicate_media_map');assert.deepEqual(duplicate.mappings,[]);
 await writeFile(file,`<skshow>${part('media.map',Buffer.from([255]))}</skshow>`);assert.equal((await call()).diagnostics[0].code,'invalid_media_map_utf8');
 const rows=Array.from({length:8000},(_,i)=>{const id=String(i).padStart(5,'0');return {line:i+1,sourcePath:'/s/'+id+'x'.repeat(80),archivePath:'MEDIA/'+id+'x'.repeat(80),archiveMatches:[]};});
 const hypothetical={file,sha256:'x'.repeat(64),mapParts:[],archiveParts:[],mappings:rows,clips:[],diagnostics:[]};
 assert.ok(Buffer.byteLength(JSON.stringify(hypothetical))<2*1024*1024);
 assert.ok(Buffer.byteLength(JSON.stringify(hypothetical,null,2))>2*1024*1024);
 await writeFile(file,`<skshow>${part('media.map',rows.map(r=>r.sourcePath+'\t'+r.archivePath).join('\n'))}</skshow>`);
 const outputBounded=await client.callTool({name:'showkontrol_inspect_show_media',arguments:{file}});assert.equal(outputBounded.isError,true);assert.match(outputBounded.content[0].text,/inventory exceeds output limit/);
 await writeFile(file,`<skshow>${part('media.map','x'.repeat(2*1024*1024+1))}</skshow>`);const bounded=await client.callTool({name:'showkontrol_inspect_show_media',arguments:{file}});assert.equal(bounded.isError,true);assert.match(bounded.content[0].text,/inventory text limit/);
});


test('media map BOM does not change the first clip source path',async t=>{
 const {inspectShowMedia}=await import('./media-inventory.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-media-bom-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow'), source='/music/Track.wav';
 const map=`\ufeff${source}\tMEDIA/Track.wav\n/other/\ufeffTrack.wav\tMEDIA/Other.wav\n`;
 const timeline=`<sktimeline version="1"><audio><clip file="${source}"/></audio></sktimeline>`;
 const show=Buffer.from(`<skshow>${part('media.map',map)}${part('MEDIA/Track.wav','audio')}${part('content/A.sktl',timeline)}</skshow>`);
 await writeFile(file,show);const result=await inspectShowMedia({file});
 assert.equal(result.mappings[0].sourcePath,source);assert.equal(result.mappings[1].sourcePath,'/other/\ufeffTrack.wav');
 assert.deepEqual(result.clips[0].mappingLines,[1]);assert.equal(result.mappings[0].archiveMatches.length,1);
 assert.deepEqual(await readFile(file),show);
});
