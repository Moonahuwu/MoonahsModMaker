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
