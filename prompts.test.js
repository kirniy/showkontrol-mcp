import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('offline authoring prompt is discoverable and returns a bounded workflow', async t => {
 const client = new Client({name:'prompt-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));
 t.after(()=>client.close());
 const {prompts} = await client.listPrompts();
 const prompt = prompts.find(p=>p.name==='author_offline_show');
 assert.ok(prompt);
 assert.deepEqual(prompt.arguments.map(({name,required})=>({name,required})),[
  {name:'showPath',required:true},{name:'goal',required:true}
 ]);
 const result = await client.getPrompt({name:'author_offline_show',arguments:{showPath:'/tmp/show.skshow',goal:'Add a lighting cue'}});
 assert.equal(result.messages[0].role,'user');
 const text = result.messages[0].content.text;
 assert.ok(text.includes('\n\nSource show path:'));
 assert.ok(!text.includes('\\n')); 
 for (const phrase of ['/tmp/show.skshow','Add a lighting cue','showkontrol_inspect_show_overview','showkontrol_validate_show','showkontrol_compose_show_copy','showkontrol_compose_full_show_copy','showkontrol_compose_session_media_copy','showkontrol_extract_show_program_copy','showkontrol_extract_program_timeline_copy','showkontrol_embed_program_timeline_copy','showkontrol_attach_show_program_copy','item.active','partial coverage','does not prove']) assert.ok(text.includes(phrase),phrase);
 await assert.rejects(client.getPrompt({name:'author_offline_show',arguments:{showPath:'/tmp/show.skshow'}}));
});
