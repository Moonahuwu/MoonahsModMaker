// Shared RCON quick-actions, used by both the Custom Server admin panel and the
// F8 mod-menu overlay so they never drift. Each action is one or more console
// commands sent in order (e.g. set the bot convars, then changelevel to apply).
//
// Bot commands are the REAL ones discovered from a live server — the widely
// posted `exec citadel_botmatch_practice_6v6_*.cfg` files don't exist on the
// install and fail with "unable to read file".

export interface QuickAction {
  label: string;
  cmds: string[];
}

export function quickActions(map: string): QuickAction[] {
  const m = map.trim() || "dl_midtown";
  return [
    {
      label: "Fill bots 6v6",
      cmds: [
        "citadel_spawn_practice_bots true",
        "citadel_spawn_practice_bots_count 12",
        `changelevel ${m}`,
      ],
    },
    { label: "No bots", cmds: ["citadel_spawn_practice_bots false"] },
    { label: "Kick bots", cmds: ["sv_cheats 1", "bot_kick_all"] },
    { label: `Restart (${m})`, cmds: [`changelevel ${m}`] },
    { label: "Cheats on", cmds: ["sv_cheats 1"] },
    { label: "Status", cmds: ["status"] },
  ];
}
