// Tool groups for SHOWKONTROL_TOOLSETS. Each group is one section of docs/tools.md (toolsets.test.js keeps them equal).
export const TOOL_GROUPS={
 live:['showkontrol_discover','showkontrol_read','showkontrol_read_binary','showkontrol_sample_events','showkontrol_get_plays','showkontrol_get_insights','showkontrol_get_deck','showkontrol_get_live_deck','showkontrol_diagnose_live_node','showkontrol_list_actions','showkontrol_search_actions','showkontrol_get_action','showkontrol_node_type_detail','showkontrol_validate_node_settings','showkontrol_get_parameter','showkontrol_list_connections','showkontrol_verify_live_connections','showkontrol_get_patch','showkontrol_validate_patch','showkontrol_plan_live_graph','showkontrol_write','showkontrol_deck_command','showkontrol_run_action','showkontrol_session_command','showkontrol_set_node_bypass','showkontrol_set_parameter_verified','showkontrol_set_parameter','showkontrol_set_setting','showkontrol_fire_node','showkontrol_create_node','showkontrol_delete_node','showkontrol_create_connection','showkontrol_delete_connection','showkontrol_put_patch','showkontrol_compose_live_patch','showkontrol_create_staged_live_graph'],
 files:['showkontrol_inspect_show_overview','showkontrol_validate_show','showkontrol_inspect_show','showkontrol_read_show_part','showkontrol_read_show_part_page','showkontrol_edit_show_part_copy','showkontrol_inspect_xml','showkontrol_edit_xml_copy'],
 timelines:['showkontrol_inspect_timeline','showkontrol_inspect_show_timeline','showkontrol_add_timeline_cue_copy','showkontrol_add_show_timeline_cue_copy','showkontrol_add_show_timeline_cues_copy','showkontrol_edit_show_timeline_cues_copy','showkontrol_edit_timeline_cue_copy','showkontrol_delete_timeline_cue_copy','showkontrol_edit_timeline_layer_copy','showkontrol_inspect_cue_references'],
 audio:['showkontrol_add_timeline_audio_lane_copy','showkontrol_add_timeline_audio_clip_copy','showkontrol_edit_timeline_audio_clip_copy','showkontrol_remove_timeline_audio_clip_copy','showkontrol_remove_timeline_audio_lane_copy','showkontrol_rename_timeline_audio_lane_copy','showkontrol_move_timeline_audio_lane_copy'],
 graphs:['showkontrol_inspect_cue_graph','showkontrol_copy_cue_graph_show_copy','showkontrol_copy_cue_graphs_show_copy','showkontrol_copy_cue_graph_timeline_copy','showkontrol_copy_cue_graph_node_show_copy','showkontrol_copy_patch_node_to_cue_show_copy','showkontrol_copy_patch_setting_to_cue_show_copy','showkontrol_assemble_cue_graph_show_copy','showkontrol_assemble_mixed_cue_graph_show_copy','showkontrol_edit_cue_graph_setting_copy','showkontrol_edit_cue_graph_settings_show_copy','showkontrol_add_cue_graph_setting_copy','showkontrol_set_cue_graph_node_stopped_copy','showkontrol_edit_cue_graph_wire_copy','showkontrol_remove_cue_graph_node_copy','showkontrol_remove_cue_graph_copy'],
 tracks:['showkontrol_create_show_track_copy','showkontrol_clone_media_track_copy','showkontrol_rename_show_track_copy','showkontrol_remove_show_track_copy','showkontrol_inspect_show_setlist','showkontrol_create_show_setlist_copy','showkontrol_add_show_setlist_track_copy','showkontrol_edit_show_setlist_copy'],
 composition:['showkontrol_compose_show_copy','showkontrol_compose_multi_track_show_copy','showkontrol_compose_full_show_copy'],
 patch:['showkontrol_inspect_patch','showkontrol_edit_patch_setting_copy','showkontrol_edit_patch_graph_copy','showkontrol_edit_patch_batch_copy','showkontrol_copy_patch_node'],
 programs:['showkontrol_inspect_program','showkontrol_inspect_show_program','showkontrol_inspect_program_item_graph','showkontrol_inspect_program_timeline','showkontrol_compose_program_schedule_copy','showkontrol_compose_program_edits_copy','showkontrol_create_program_copy','showkontrol_extract_show_program_copy','showkontrol_attach_show_program_copy','showkontrol_extract_program_timeline_copy','showkontrol_embed_program_timeline_copy','showkontrol_embed_remapped_program_timeline_copy','showkontrol_copy_program_item_graph_copy','showkontrol_copy_remapped_program_item_graph_copy','showkontrol_remap_program_item_graph_copy','showkontrol_edit_program_item_graph_setting_copy'],
 media:['showkontrol_inspect_show_media','showkontrol_add_media_mappings_copy','showkontrol_edit_media_mappings_copy','showkontrol_inspect_session_media','showkontrol_preflight_session_audio','showkontrol_compose_session_media_copy','showkontrol_find_session_staging','showkontrol_remove_stale_session_staging'],
 reaper:['showkontrol_preflight_rpp_media','showkontrol_create_rpp','showkontrol_create_marker_csv']
};
const offline=Object.keys(TOOL_GROUPS).filter(group=>group!=='live');
// live_read keeps the live tools annotated readOnlyHint; dry runs are reads, as in docs/tools.md.
const SETS={...Object.fromEntries(Object.keys(TOOL_GROUPS).map(group=>[group,{groups:[group]}])),offline:{groups:offline},live_read:{groups:['live'],readOnly:true},all:{groups:Object.keys(TOOL_GROUPS)}};
export const TOOLSET_NAMES=Object.keys(SETS);
const groupOf=new Map(Object.entries(TOOL_GROUPS).flatMap(([group,names])=>names.map(name=>[name,group])));

// Returns null when every tool is registered (variable unset or blank), otherwise a predicate over (name, annotations).
export function toolFilter(value){
 if(value===undefined||!value.trim())return null;
 const names=value.split(',').map(name=>name.trim());
 const unknown=names.filter(name=>!Object.hasOwn(SETS,name));
 if(unknown.length)throw Error(`SHOWKONTROL_TOOLSETS: unknown toolset ${unknown.map(name=>JSON.stringify(name)).join(', ')}; use a comma-separated list of ${TOOLSET_NAMES.join(', ')}`);
 const sets=names.map(name=>SETS[name]);
 return (name,annotations)=>{
  const group=groupOf.get(name);
  if(!group)throw Error(`Tool ${name} has no toolset group`);
  return sets.some(set=>set.groups.includes(group)&&(!set.readOnly||annotations?.readOnlyHint===true));
 };
}
