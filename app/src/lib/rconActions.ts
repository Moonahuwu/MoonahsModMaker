// Shared RCON quick-actions, used by both the Custom Server admin panel and the
// F8 mod-menu overlay so they never drift. Each action is one or more console
// commands sent in order.
//
// These use the REAL match-setup cfgs that ship in Deadlock's
// game/citadel/cfg/ (verified on disk + via `exec`). The widely-posted
// `citadel_botmatch_practice_6v6_easy.cfg` does NOT exist and fails with
// "unable to read file"; the correct file is `citadel_botmatch_practice_6v6.cfg`.
//
// Why bots wouldn't move before: a real bot match needs `citadel_solo_bot_match 1`
// (set by these cfgs) — just spawning practice bots leaves them idle. After exec'ing
// the cfg you must `changelevel` to (re)start the match with those settings; the
// match then runs its normal pregame wait → intro → play once a player connects.

export interface QuickAction {
  label: string;
  cmds: string[];
  title?: string;
}

export interface CatalogGroup {
  title: string;
  items: QuickAction[];
}

// The fuller set of commands discovered live, grouped for the mod-menu's
// "Commands" submenu. All verified to exist on the server (find/exec).
export function commandCatalog(map: string): CatalogGroup[] {
  const m = map.trim() || "dl_midtown";
  return [
    {
      title: "Match modes (restart to apply)",
      items: [
        { label: "Bot match 6v6", cmds: ["exec citadel_botmatch_practice_6v6.cfg", "citadel_cinematic_intro_enabled 1", `changelevel ${m}`] },
        { label: "Player vs bots", cmds: ["exec citadel_botmatch_player_vs_bot.cfg", `changelevel ${m}`] },
        { label: "Sandbox", cmds: ["exec citadel_sandbox_match.cfg", `changelevel ${m}`] },
        { label: "1v1", cmds: ["exec citadel_1v1_match.cfg", `changelevel ${m}`] },
      ],
    },
    {
      title: "Bots",
      items: [
        { label: "More bots (12)", cmds: ["citadel_spawn_practice_bots_count 12"] },
        { label: "Crazy bots (24)", title: "Experimental - needs Max players raised at launch", cmds: ["citadel_spawn_practice_bots_count 24"] },
        { label: "Bots wander", cmds: ["citadel_bot_move_random 1"] },
        { label: "Bots shop", cmds: ["citadel_bot_shop 2"] },
        { label: "Kick bots", cmds: ["sv_cheats 1", "bot_kick_all"] },
        { label: "No bots", cmds: ["citadel_spawn_practice_bots 0", "citadel_solo_bot_match 0"] },
      ],
    },
    {
      title: "Items",
      items: [
        { label: "Enhanced items ON", title: "All purchased/drafted items become their enhanced version", cmds: ["sv_cheats 1", "citadel_item_purchases_force_enhanced 1"] },
        { label: "Enhanced items OFF", cmds: ["citadel_item_purchases_force_enhanced 0"] },
        { label: "Unlock flex slots", cmds: ["sv_cheats 1", "citadel_unlock_flex_slots"] },
      ],
    },
    {
      title: "Match flow",
      items: [
        { label: "Cinematic intro ON", cmds: ["citadel_cinematic_intro_enabled 1"] },
        { label: "Cinematic intro OFF", cmds: ["citadel_cinematic_intro_enabled -1"] },
        { label: `Restart (${m})`, cmds: [`changelevel ${m}`] },
      ],
    },
    {
      title: "Cheats & world",
      items: [
        { label: "Cheats ON", cmds: ["sv_cheats 1"] },
        { label: "All-talk", cmds: ["sv_alltalk 1", "sv_allchat 1"] },
        { label: "Dup heroes", cmds: ["citadel_allow_duplicate_heroes 1"] },
        { label: "Speed ×2", cmds: ["host_timescale 2"] },
        { label: "Speed normal", cmds: ["host_timescale 1"] },
        { label: "Status", cmds: ["status"] },
      ],
    },
  ];
}

export function quickActions(map: string): QuickAction[] {
  const m = map.trim() || "dl_midtown";
  return [
    {
      label: "Bot match 6v6",
      title: "Solo 6v6 vs bots with the full match intro, then restart to apply",
      cmds: [
        "exec citadel_botmatch_practice_6v6.cfg",
        "citadel_cinematic_intro_enabled 1",
        `changelevel ${m}`,
      ],
    },
    {
      label: "Player vs bots",
      title: "1 lane vs bots",
      cmds: ["exec citadel_botmatch_player_vs_bot.cfg", `changelevel ${m}`],
    },
    {
      label: "Sandbox",
      title: "Coop sandbox: cheats, all-talk, duplicate heroes",
      cmds: ["exec citadel_sandbox_match.cfg", `changelevel ${m}`],
    },
    { label: "No bots", cmds: ["citadel_spawn_practice_bots 0", "citadel_solo_bot_match 0"] },
    { label: `Restart (${m})`, cmds: [`changelevel ${m}`] },
    { label: "Cheats on", cmds: ["sv_cheats 1"] },
    { label: "Status", cmds: ["status"] },
  ];
}
