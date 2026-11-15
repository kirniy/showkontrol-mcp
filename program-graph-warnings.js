import {inspectProgramItemGraph} from './program.js';

export const cueActiveWarning='Program item graph contains trigger.path cue.active; review whether item.active is appropriate. Runtime behavior is unverified.';

export async function programGraphWarnings(file,sha256,index){
 const {graph}=await inspectProgramItemGraph({file,sha256,index});
 return graph.nodes.some(node=>node.type==='trigger'&&node.settings.some(setting=>setting.key==='trigger.path'&&setting.value==='cue.active'))?[cueActiveWarning]:[];
}
