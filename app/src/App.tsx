import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  autodetectPaths,
  checkSoundRefs,
  copyToDownloads,
  decodeStock as decodeStockApi,
  downloadEntry,
  openInViewer,
  itemParticles,
  itemDetail as itemDetailApi,
  randomizeConfig,
  type HeroAbility,
  type HeroAbilitySound,
  type HeroPortrait,
  type HeroSound,
  type VoiceLine,
  type ItemCard,
  loadState,
  newProject,
  probeAudio,
  readEventPools,
  refreshVanilla as refreshVanillaApi,
  listEditableEvents,
  importPackEvents,
  scanPackContents,
  eventsForRefs,
  cachePack,
  packIcons,
  checkAppUpdate,
  digimodDetected,
  installAppUpdate,
  type AppUpdate,
  type HeroImage,
  type ImportEvent,
  listSoundeventFiles,
  downloadTools,
  sanitizeName,
  listProfiles,
  saveProfile,
  loadProfile,
  deleteProfile,
  renameProfile,
  type ProfileBlob,
} from "./lib/api";
import {
  cHeroDetail as heroDetailApi,
  cHeroImages,
  cHeroSounds as heroSoundsApi,
  cHeroVoicelines as heroVoicelinesApi,
  cItemSoundIndex as itemSoundIndex,
  cItemRoster,
  clearDataCache,
  heroStem,
  preloadGameData,
  type PreloadProgress,
} from "./lib/dataCache";
import { SidePanel } from "./components/SidePanel";
import { Backdrop } from "./components/Backdrop";
import { ImportReview, type PackReview, type ReviewEvent, type ReviewGroup } from "./components/ImportReview";
import { SetupSection } from "./components/SetupSection";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { ImportedMods } from "./components/ImportedMods";
import { CompileBar } from "./components/CompileBar";
import { HeroGrid } from "./components/HeroGrid";
import { HeroDetail } from "./components/HeroDetail";
import { VoicelinesPanel } from "./components/VoicelinesPanel";
import { ItemsTab } from "./components/ItemsTab";
import { SoundBrowser } from "./components/SoundBrowser";
import { OverrideEditor } from "./components/OverrideEditor";
import { EffectsBrowser } from "./components/EffectsBrowser";
import { PostersTab } from "./components/PostersTab";
import { DigimodTab, DEFAULT_DIGIMOD } from "./components/DigimodTab";
import { UiMasterTab } from "./components/UiMasterTab";
import { getCopiedSound } from "./lib/soundClipboard";
import { CustomServer } from "./components/CustomServer";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { useToast } from "./components/Toaster";
import { useSettings, slotSoundFolder, sheetSiblingsKey, TOOLS_BUNDLE_URL } from "./lib/settings";
import { songHash, overrideHash, effectHash, posterHash } from "./lib/songHash";
import type { EffectOverride, EventProject, EventView, PosterOverride, Project, Song, SoundOverride } from "./types";
import { GameBananaBrowser } from "./components/GameBananaBrowser";
import "./index.css";
import "./App.css";

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const DEFAULT_GAIN_DB = 6;

const MOD_COMBINER = "modcombiner";
/** Browse + one-click download Deadlock mods from GameBanana. */
const GAMEBANANA = "gamebanana";
/** Special always-present tab for shop items (scaffold; sounds wired later). */
const ITEMS = "items";
/** Special always-present tab for loose-file sound replacement (any game sound). */
const REPLACE_SOUNDS = "replacesounds";
/** Special always-present tab for recoloring particle (VFX) effects. */
const EFFECTS = "effects";
/** Special always-present tab for dedicated-server hosting + config editor. */
const CUSTOM_SERVER = "customserver";
/** Special always-present tab for replacing in-world posters/signs/graffiti. */
const POSTERS = "posters";
/** Jumpscares/Deaths (DigiMaster) — only when the engine is detected installed. */
const JUMPSCARES = "jumpscares";
/** UI Master (experimental): edit the game's panorama layouts/styles. */
const UIMASTER = "uimaster";
/** Catch-all tab for events auto-discovered from a new patch. */
const UNSORTED = "unsorted";

/** Curated top categories for the particle (VFX) browser. */
const PARTICLE_CATEGORIES: { key: string; label: string; prefix: string; hint?: string }[] = [
  {
    key: "abilities",
    label: "Hero Abilities",
    prefix: "particles/abilities",
    hint: "Per-hero ability VFX",
  },
  {
    key: "upgrades",
    label: "Items & Upgrades",
    prefix: "particles/upgrades",
    hint: "Item effects (Cursed Relic = upgrade_glitch)",
  },
  { key: "weapons", label: "Weapons & Gunfire", prefix: "particles/weapons" },
  { key: "world", label: "World & Map", prefix: "particles/world" },
  { key: "status", label: "Status Effects", prefix: "particles/status_effects" },
  { key: "all", label: "Everything (all particles)", prefix: "particles", hint: "Full tree - power users" },
];

/** Curated top categories for the loose-file sound browser (path prefixes into
 *  the game's sound tree). Keeps 79k sounds navigable instead of a flat dump. */
const SOUND_CATEGORIES: { key: string; label: string; prefix: string; hint?: string }[] = [
  { key: "vo", label: "Announcer & Hero VO", prefix: "sounds/vo", hint: "Voice lines (by hero)" },
  { key: "abilities", label: "Hero Abilities", prefix: "sounds/abilities", hint: "Ability SFX (by hero)" },
  { key: "weapons", label: "Weapons & Gunfire", prefix: "sounds/weapons", hint: "Per-hero + shared" },
  { key: "music", label: "Music", prefix: "sounds/music", hint: "Stingers, menu, intro" },
  { key: "ui", label: "UI & Menus", prefix: "sounds/ui" },
  { key: "mods", label: "Items", prefix: "sounds/mods", hint: "Weapon / armor / tech" },
  { key: "hit", label: "Hit Markers", prefix: "sounds/hit_indicators" },
  { key: "player", label: "Player & Foley", prefix: "sounds/player", hint: "Footsteps, movement" },
  { key: "world", label: "World & Objectives", prefix: "sounds/world" },
  { key: "gameplay", label: "Gameplay", prefix: "sounds/gameplay" },
  { key: "guardian", label: "Guardians & NPCs", prefix: "sounds/npc" },
  { key: "ambient", label: "Ambience", prefix: "sounds/ambient" },
  { key: "cosmetics", label: "Cosmetics", prefix: "sounds/cosmetics" },
  { key: "all", label: "Everything (all sounds)", prefix: "sounds", hint: "Full tree - power users" },
];

/** The built-in, undeletable empty profile = stock game (no tracks). */
const VANILLA_NAME = "Vanilla";

/** Mirror the backend's profile-name sanitize so the display name matches the
 *  stored file stem (keeps the active-profile checkmark in sync). */
function cleanProfileName(s: string): string {
  // eslint-disable-next-line no-control-regex
  const out = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/^\.+|\.+$/g, "").trim();
  return out || "profile";
}

const TAB_LABELS: Record<string, string> = {
  intro: "Match Intro",
  urn: "Urn Music",
  rift: "Rift",
  midboss: "Midboss",
  powerups: "Powerups",
  teamobj: "Team Objectives",
  heroes: "Heroes",
  shop: "Shop Music",
  ui: "UI",
  match: "Match Music",
  stingers: "Stingers",
  brawl: "Brawl Mode",
  gameplay: "Gameplay",
  combat: "Combat",
  mapsfx: "Map SFX",
  ambience: "Ambience",
  npcs: "NPCs",
  [UNSORTED]: "Misc / Unsorted",
  [ITEMS]: "Items",
  [REPLACE_SOUNDS]: "All Sounds",
  [EFFECTS]: "Effects",
  [POSTERS]: "Wall Art",
  [JUMPSCARES]: "Jumpscares",
  [UIMASTER]: "UI Master",
  [CUSTOM_SERVER]: "Custom Server",
  [MOD_COMBINER]: "Mod combiner",
  [GAMEBANANA]: "GameBanana",
};

/** Canonical sidebar order: Heroes (+Items) on top, curated categories next,
 *  Misc last. Shared by the sidebar and the import review's group sorting. */
const SIDEBAR_ORDER = [
  "heroes", ITEMS,
  "intro", "match", "stingers", "brawl",
  "urn", "rift", "midboss", "powerups", "teamobj", "shop",
  "gameplay", "combat", "mapsfx", "ambience", "npcs",
  "ui", UNSORTED,
];

/** Parent groupings in the sidebar: a collapsible header over related tabs. */
const TAB_CATEGORIES: { label: string; tabs: string[] }[] = [
  { label: "In-game", tabs: ["urn", "rift", "midboss", "powerups", "teamobj", "shop"] },
  { label: "Match", tabs: ["intro", "match", "stingers", "brawl"] },
  // Gameplay has curated slots; the rest appear once discovery/import routes
  // slots into them.
  { label: "Game SFX", tabs: ["gameplay", "combat", "mapsfx", "ambience", "npcs"] },
];

/** The ♪ "Sound" master header: every sound-event category/tab nests under
 *  it, with the loose-file browser (All Sounds) as the catch-all at the
 *  bottom — child order follows the `tabs` array, and that one is pushed
 *  last. */
const SOUND_MASTER = "Sounds";
const SOUND_MASTER_CATEGORIES = ["In-game", "Match", "Game SFX"];
const SOUND_MASTER_TABS = ["ui", UNSORTED, REPLACE_SOUNDS];

/** Tabs an auto-discovered/imported slot can be manually moved between. The
 *  id-keyed drill-in tabs (Heroes, Items) are excluded — their UIs render
 *  slots by their own id scheme and wouldn't show a foreign slot. */
const MOVE_TARGETS: { value: string; label: string }[] = [
  "intro",
  "urn",
  "rift",
  "midboss",
  "powerups",
  "teamobj",
  "shop",
  "ui",
  "match",
  "stingers",
  "brawl",
  "gameplay",
  "combat",
  "mapsfx",
  "ambience",
  "npcs",
  UNSORTED,
].map((g) => ({ value: g, label: TAB_LABELS[g] ?? g }));

function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "");
}

/** Natural pixel size of an image URL (falls back to 200×200 on error). */
function imageNaturalSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 200, h: img.naturalHeight || 200 });
    img.onerror = () => resolve({ w: 200, h: 200 });
    img.src = src;
  });
}

/** Dynamic per-hero ability-sound slots (created on demand, not in the default
 *  schema) are id-prefixed so reconcile can recognize and keep them. */
const HERO_SLOT_PREFIX = "heroabil_";

function heroAbilSlotId(codename: string, eventName: string): string {
  return `${HERO_SLOT_PREFIX}${codename}_${eventName
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()}`;
}

/** Dynamic per-item sound slots (Items tab), id-prefixed like hero slots. */
const ITEM_SLOT_PREFIX = "itemsnd_";

function itemSndSlotId(itemName: string, eventName: string): string {
  return `${ITEM_SLOT_PREFIX}${itemName}_${eventName
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()}`;
}

/** A dynamically-created (hero or item) slot that should persist only with content. */
function isDynamicSlot(id: string): boolean {
  return id.startsWith(HERO_SLOT_PREFIX) || id.startsWith(ITEM_SLOT_PREFIX);
}

/** Auto-discovered slots (events a new patch added, surfaced into the
 *  "New / Unsorted" tab). Persisted even when empty so the tab is stable. */
const AUTO_SLOT_PREFIX = "auto_";
/** Slots created by importing an old mod pack (adopted entries). Persisted like
 *  auto slots. */
const IMPORT_SLOT_PREFIX = "imp_";

function isAutoSlot(id: string): boolean {
  return id.startsWith(AUTO_SLOT_PREFIX) || id.startsWith(IMPORT_SLOT_PREFIX);
}

function isImportSlot(id: string): boolean {
  return id.startsWith(IMPORT_SLOT_PREFIX);
}

/** Import artifacts (adopt-only slots with no user edits) the importer creates. */
function isImportArtifact(e: EventProject): boolean {
  return (
    e.songs.length === 0 &&
    (isImportSlot(e.id) ||
      e.id.startsWith(HERO_SLOT_PREFIX) ||
      e.id.startsWith(ITEM_SLOT_PREFIX) ||
      isAutoSlot(e.id))
  );
}

/** Event names / soundevent files to skip when importing a pack (matched as a
 *  lowercase substring of the event name or its file). "priest" = the Half-Life
 *  crossbow hero mod built on gordon audio; not wanted. Ask to add more. */
const EXCLUDED_IMPORT_TERMS = ["priest"];

function isExcludedImport(relpath: string, eventName: string): boolean {
  const r = relpath.toLowerCase();
  const n = eventName.toLowerCase();
  return EXCLUDED_IMPORT_TERMS.some((t) => r.includes(t) || n.includes(t));
}

function autoSlotId(relpath: string, eventName: string): string {
  return `${AUTO_SLOT_PREFIX}${`${relpath}_${eventName}`
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()}`;
}

function importSlotId(relpath: string, eventName: string, arrayKey: string): string {
  return `${IMPORT_SLOT_PREFIX}${`${relpath}_${eventName}_${arrayKey}`
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()}`;
}

/** Human label for a discovered event: the last 2–3 dotted segments, spaced. */
function eventLabel(eventName: string): string {
  return eventName.split(".").slice(-3).join(" ").replace(/_/g, " ");
}

/** Best-effort home tab for a discovered/imported event with no curated slot:
 *  ui.vsndevts → UI, and well-known event-name families in the main music/world
 *  files → their curated tab. Anything unrecognized lands in Unsorted (the
 *  catch-all). Slot ids never encode the group, so re-routing an event in a
 *  later version moves it (with its content) instead of duplicating it. Hero
 *  and item events are routed by their own id-aware branches before this. */
function routeGroupFor(relpath: string, eventName: string): string {
  const n = eventName.toLowerCase();
  // Whole-file homes first.
  if (relpath === "soundevents/powerups.vsndevts") return "powerups";
  if (
    relpath.startsWith("soundevents/ambience/") ||
    relpath.includes("world_ambient_emitters")
  )
    return "ambience";
  if (relpath.startsWith("soundevents/npc/")) return "npcs";
  if (/soundevents\/(player|gameplay|damage|status_effects)\.vsndevts$/.test(relpath))
    // The midboss's own SFX (horn/low-health/death) live in gameplay.vsndevts
    // but belong with the Midboss tab, not general hit feedback.
    return n.includes("midboss") ? "midboss" : "gameplay";
  if (/soundevents\/(ziplines|breakables)\.vsndevts$/.test(relpath)) return "mapsfx";
  // Chat-wheel pings and hero-poster cosmetics are menu-feedback sounds; they
  // ride with the UI tab (and its includeUiSounds build gate).
  if (/soundevents\/(chat_wheel|cosmetics)\.vsndevts$/.test(relpath)) return "ui";
  if (relpath === "soundevents/music_arpeggiator.vsndevts") return "match";
  // soundevents/mods/* are shop-item sounds: imports route them into the Items
  // tab per owning item (via the item index); only unindexed/new-patch ones
  // fall through to Misc, where the move-to-tab control covers them.
  if (
    relpath === "soundevents/music.vsndevts" ||
    relpath === "soundevents/world.vsndevts"
  ) {
    if (n.includes("matchintro")) return "intro";
    // Idol = the music events; Soul.Urn.* = the urn's own SFX (pickup/carry/
    // cash-in). Segment match, NOT includes("urn") — "returned" contains "urn".
    if (n.includes("idol") || /(^|\.)urn(\.|$)/.test(n)) return "urn";
    if (n.includes("koth")) return "rift";
    if (n.includes("midboss") || n.includes("rejuv")) return "midboss";
    if (n.includes("powerup")) return "powerups";
    if (/tier\d|titan/.test(n)) return "teamobj";
    if (n.includes("shop")) return "shop";
    if (
      n.startsWith("ui.") ||
      n.includes("mainmenu") ||
      n.includes("pause") ||
      n.includes("matchmake")
    )
      return "ui";
    if (n.includes("brawl")) return "brawl";
    if (n.startsWith("stinger.")) return "stingers";
    // Every remaining music-file event is match-flow music; world-file
    // leftovers are map interactables (teleporters, bounce pads, zap towers).
    return relpath === "soundevents/music.vsndevts" ? "match" : "mapsfx";
  }
  if (relpath.endsWith("ui.vsndevts") && !relpath.includes("soundevents/base/")) return "ui";
  return UNSORTED;
}

/** A slot carries user content worth persisting. */
function slotHasContent(e: EventProject): boolean {
  return (
    e.songs.length > 0 ||
    e.adopted.length > 0 ||
    e.excludedEntries.length > 0 ||
    e.removedEntries.length > 0
  );
}

/** Align a saved project to the current slot schema: ordered by the default,
 *  preferring saved slot data (songs, refreshed stock) where the id still exists,
 *  dropping saved slots no longer in the schema, and adding any new default slots.
 *  Dynamic hero ability slots are kept only when they hold content (empty ones,
 *  created just by browsing a hero, are pruned). */
function reconcileProject(saved: Project, def: Project): Project {
  const savedById = new Map(saved.events.map((e) => [e.id, e]));
  const defIds = new Set(def.events.map((e) => e.id));
  const merged = def.events.map((d) => savedById.get(d.id) ?? d);
  const extras = saved.events.filter(
    (e) =>
      !defIds.has(e.id) &&
      // Auto-discovered slots persist always (keep the catch-all tab stable);
      // hero/item slots persist only when they hold content.
      (isAutoSlot(e.id) || (isDynamicSlot(e.id) && slotHasContent(e))) &&
      // Excluded imports (EXCLUDED_IMPORT_TERMS, e.g. the priest mod) are
      // purged on load — but never a slot the user attached songs/edits to
      // (autosave would make that deletion permanent).
      !(isExcludedImport(e.eventsRelpath, e.eventName) && !slotHasContent(e)),
  );
  // Re-home previously-Unsorted auto/import slots whose event family the router
  // now recognizes. Ids are group-independent, so this moves the slot (with all
  // its content) to its proper tab instead of duplicating it.
  const events = [...merged, ...extras].map((e) =>
    (isAutoSlot(e.id) || isImportSlot(e.id)) && e.group === UNSORTED
      ? { ...e, group: routeGroupFor(e.eventsRelpath, e.eventName) }
      : e,
  );
  return { ...saved, events: enforceSoundNames(dedupeReimportedSongs(events)) };
}

/** One-time cleanup: re-importing a pack used to re-convert already-absorbed
 *  tracks, doubling every one as a `name_2`-style copy. Drop songs that are a
 *  numbered-name duplicate of an earlier track in the same slot with the same
 *  label and identical trim window. */
function dedupeReimportedSongs(events: EventProject[]): EventProject[] {
  return events.map((e) => {
    if (e.songs.length < 2) return e;
    const kept: Song[] = [];
    for (const s of e.songs) {
      const isDup = kept.some((k) => {
        if (k.label !== s.label) return false;
        if (Math.abs((k.trimEnd - k.trimStart) - (s.trimEnd - s.trimStart)) > 0.01) return false;
        const esc = k.soundName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${esc}_\\d+$`).test(s.soundName);
      });
      if (!isDup) kept.push(s);
    }
    return kept.length === e.songs.length ? e : { ...e, songs: kept };
  });
}

/** Mirror the backend rule: sound names become game file paths, so they must
 *  be lowercase letters/numbers (runs of anything else collapse to `_`). */
function cleanSoundName(input: string): string {
  const out = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return out || "track";
}

/** Migrate legacy data: rename any track whose soundName breaks the rule
 *  (uppercase / special characters), keeping names unique project-wide. A
 *  renamed track drops its compiled hash so the next compile re-renders it. */
function enforceSoundNames(events: EventProject[]): EventProject[] {
  const used = new Set<string>();
  const claim = (base: string): string => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let i = 2;
    while (used.has(`${base}_${i}`)) i++;
    const n = `${base}_${i}`;
    used.add(n);
    return n;
  };
  return events.map((e) => {
    if (e.songs.length === 0) return e;
    let changed = false;
    const songs = e.songs.map((s) => {
      const name = claim(cleanSoundName(s.soundName));
      if (name === s.soundName) return s;
      changed = true;
      return { ...s, soundName: name, lastCompiledHash: null };
    });
    return changed ? { ...e, songs } : e;
  });
}

/** A track named exactly like an original sound OVERWRITES that file — auto-
 *  exclude the colliding original entry so the array doesn't double-play the
 *  replacement (this also flips the panel's "replace" switch on). Applied when
 *  a track is added, renamed or absorbed; one-shot, so re-enabling by hand is
 *  never fought. */
function withAutoReplace(
  e: EventProject,
  soundNames: string[],
  globalFolder: string,
  poolEntries: string[] | undefined,
): EventProject {
  const folder = slotSoundFolder(e, globalFolder).replace(/\/+$/, "");
  const originals = new Set([...(poolEntries ?? []), ...(e.stockEntry ? [e.stockEntry] : [])]);
  const hits = soundNames
    .map((n) => `${folder}/${n}.vsnd`)
    .filter(
      (r) => originals.has(r) && !e.excludedEntries.includes(r) && !e.removedEntries.includes(r),
    );
  return hits.length ? { ...e, excludedEntries: [...e.excludedEntries, ...hits] } : e;
}

function accentFor(ev: { group: string; side: string }): string {
  if (ev.group === "intro") return ev.side === "Mother" ? "#3974ae" : "#ffac10";
  if (ev.group === "urn") return "#a855f7"; // violet
  if (ev.group === "rift") return "#22d3ee"; // cyan (KotH rift)
  if (ev.group === "midboss") return "#f97316"; // orange
  if (ev.group === "powerups") return "#84cc16"; // lime
  if (ev.group === "teamobj") return "#60a5fa"; // blue
  if (ev.group === "shop") return "#10b981"; // emerald (souls/shop)
  if (ev.group === "ui") return "#38bdf8"; // sky (menus)
  if (ev.group === "match") return "#f472b6"; // pink (match flow)
  if (ev.group === "stingers") return "#facc15"; // yellow (kill streaks)
  if (ev.group === "brawl") return "#fb7185"; // rose (brawl mode)
  if (ev.group === "mapsfx") return "#4ade80"; // green (map interactables)
  if (ev.group === "ambience") return "#2dd4bf"; // teal (ambience)
  if (ev.group === "npcs") return "#e879f9"; // fuchsia (NPCs)
  if (ev.group === "gameplay") return "#f87171"; // red (hit feedback)
  if (ev.group === "combat") return "#fb923c"; // orange (combat SFX)
  if (ev.group === UNSORTED) return "#fbbf24"; // amber (new/unsorted)
  if (ev.group === "heroes") return "#a7fff1"; // mint (heroes)
  if (ev.group === ITEMS) return "#fb923c"; // orange (items)
  if (ev.group === EFFECTS) return "#c084fc"; // violet (VFX)
  if (ev.group === POSTERS) return "#8b5cf6"; // deep violet (posters)
  if (ev.group === JUMPSCARES) return "#ef4444"; // red (spooky)
  if (ev.group === UIMASTER) return "#f59e0b"; // amber (experimental UI editing)
  if (ev.group === CUSTOM_SERVER) return "#38bdf8"; // sky (server)
  if (ev.group === GAMEBANANA) return "#eab308"; // GameBanana yellow
  return "#e0564f"; // heroes
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [pools, setPools] = useState<Record<string, EventView>>({});
  // Pool/stock refs that don't exist as real files in the game pak — their
  // "preview" would play a beep or a wrong clip, so the UI hides it.
  const [missingSoundRefs, setMissingSoundRefs] = useState<Set<string>>(new Set());
  // Global "modified only" filter: sidebar, slot lists and the hero/item grids
  // show only what carries the user's changes, for quick navigation.
  const [modifiedOnly, setModifiedOnly] = useState(false);
  // Mod-import review modal state (+ the scanned events awaiting confirm).
  const [packReview, setPackReview] = useState<PackReview | null>(null);
  const pendingImportEvents = useRef<ImportEvent[] | null>(null);
  // Refs sourced from stock-path replacement files: always converted into the
  // user's own tracks on import (there's nothing to "link" — the ref IS the
  // original's path), with the pack's file dropped from the bundle after.
  const pendingOverwriteRefs = useRef<Set<string>>(new Set());
  // Per-song expand state, kept here (not in the card) so it survives tab
  // switches. Default = collapsed; a song is expanded when freshly dropped/
  // created, or once the user opens it — and stays that way on return.
  const [expandedSongs, setExpandedSongs] = useState<Record<string, boolean>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("intro");
  // Selected hero in the Heroes grid (codename, e.g. "punkgoat") -> opens the
  // per-hero menu (background + ability bar + inline sounds).
  const [selectedHero, setSelectedHero] = useState<string | null>(null);
  const [selectedHeroInfo, setSelectedHeroInfo] = useState<HeroPortrait | null>(null);
  const [heroAbilities, setHeroAbilities] = useState<HeroAbility[] | null>(null);
  const [heroDetailLoading, setHeroDetailLoading] = useState(false);
  const [selectedAbility, setSelectedAbility] = useState<string | null>(null);
  // Voicelines view for the selected hero (toggled from the hero menu).
  const [showVoicelines, setShowVoicelines] = useState(false);
  const [voicelines, setVoicelines] = useState<VoiceLine[] | null>(null);
  const [voicelinesLoading, setVoicelinesLoading] = useState(false);
  // The hero's full non-VO sound set (gunfire/abilities/movement), shown in the
  // hero detail under the ability bar.
  const [heroSounds, setHeroSounds] = useState<HeroSound[] | null>(null);
  const [heroSoundsLoading, setHeroSoundsLoading] = useState(false);
  // The selected hero's replaceable panorama images (cards/icons/minimap/bg/logo).
  const [heroImgs, setHeroImgs] = useState<HeroImage[] | null>(null);
  useEffect(() => {
    setHeroImgs(null);
    if (!selectedHero) return;
    const s = settingsRef.current;
    // backgrounds + hero_names use the display-name stem (abrams, grey_talon…);
    // cards/icons use the internal codename (selectedHero).
    const stem = heroStem(selectedHeroInfo?.displayName ?? selectedHero);
    let cancelled = false;
    cHeroImages(s.vpkHelperPath, s.deadlockPak, selectedHero, stem)
      .then((r) => !cancelled && setHeroImgs(r))
      .catch(() => !cancelled && setHeroImgs([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHero, selectedHeroInfo]);

  // Replace / clear one hero image slot (rides the icon-mod pipeline).
  async function pickHeroImage(img: HeroImage) {
    if (!selectedHero) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (typeof picked !== "string") return;
    const id = `heroimg_${selectedHero}_${img.kind}`;
    // Slots without known dimensions (name logo, ability icons) take the
    // user art's own size so nothing gets squashed to a square.
    let w = img.width;
    let h = img.height;
    if (!w || !h) {
      try {
        const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight });
          el.onerror = reject;
          el.src = convertFileSrc(picked);
        });
        w = dims.w;
        h = dims.h;
      } catch {
        w = w || 512;
        h = h || 512;
      }
    }
    setProject((prev) =>
      prev
        ? {
            ...prev,
            iconMods: [
              ...(prev.iconMods ?? []).filter((m) => m.id !== id),
              {
                id,
                name: `${selectedHeroInfo?.displayName ?? selectedHero} - ${img.kind}`,
                targetVtexc: img.target,
                sourceImage: picked,
                width: w || 512,
                height: h || 512,
                hue: 0,
                enabled: true,
              },
            ],
          }
        : prev,
    );
    push("success", "Hero image set - compile to apply");
  }

  function removeHeroImage(img: HeroImage) {
    if (!selectedHero) return;
    const id = `heroimg_${selectedHero}_${img.kind}`;
    setProject((prev) =>
      prev ? { ...prev, iconMods: (prev.iconMods ?? []).filter((m) => m.id !== id) } : prev,
    );
  }

  const heroCustomImages = useMemo(() => {
    const out: Record<string, { src: string; enabled: boolean }> = {};
    if (selectedHero) {
      const p = `heroimg_${selectedHero}_`;
      for (const m of project?.iconMods ?? []) {
        if (m.id.startsWith(p)) {
          out[m.id.slice(p.length)] = { src: m.sourceImage, enabled: m.enabled !== false };
        }
      }
    }
    return out;
  }, [project?.iconMods, selectedHero]);
  // Selected shop item (Items tab) -> drill-in to its sound events.
  const [selectedItem, setSelectedItem] = useState<ItemCard | null>(null);
  const [itemSounds, setItemSounds] = useState<HeroAbilitySound[] | null>(null);
  const [itemDetailLoading, setItemDetailLoading] = useState(false);
  // The selected item's particle effects (for the "open in viewer" buttons).
  const [itemFx, setItemFx] = useState<string[] | null>(null);
  // Soundevents files already decompiled into the vanilla merge base this session.
  const ensuredFiles = useRef<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, update: updateSettings, ready: settingsReady } = useSettings();
  const { push } = useToast();

  // Profiles = named build configs (project + imported mods). The active one is
  // tracked in settings.activeProfile; this is just the list for the picker.
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profileBusy, setProfileBusy] = useState(false);

  const panelEls = useRef<Record<string, HTMLElement | null>>({});
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Refs for the global drag-drop handler (which has stable deps).
  const selectedItemRef = useRef<ItemCard | null>(null);
  selectedItemRef.current = selectedItem;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  // Set by the Posters tab so OS-level image drops can land on a poster rect.
  const posterDropRef = useRef<((paths: string[], cssX: number, cssY: number) => boolean) | null>(
    null,
  );

  // ---- Startup game-data preload ----------------------------------------
  // Warm every tab's data (rosters, the sound index, then each hero's detail
  // in the background) once per session so opening a category is instant.
  // A loading card covers the core steps; the hero warm-up runs quietly after.
  const [preload, setPreload] = useState<PreloadProgress | null>(null);
  const [preloadDismissed, setPreloadDismissed] = useState(false);
  const preloadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!settingsReady || !settings.firstRunDone) return;
    const helper = settings.vpkHelperPath;
    const pak = settings.deadlockPak;
    if (!helper || !pak) return;
    const key = `${helper}|${pak}`;
    if (preloadedFor.current === key) return;
    preloadedFor.current = key;
    setPreloadDismissed(false);
    // Warm only the curated categories — skip the "Everything (all sounds)"
    // catch-all so launch doesn't walk the full 79k tree.
    const prefixes = SOUND_CATEGORIES.filter((c) => c.key !== "all").map((c) => c.prefix);
    void preloadGameData(helper, pak, prefixes, setPreload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady, settings.firstRunDone, settings.vpkHelperPath, settings.deadlockPak]);

  // Slot-group tabs in a canonical sidebar order: Heroes (+Items) on top, the
  // curated categories next, dynamic/unknown groups after, and the utility
  // tabs at the bottom (Replace Sounds last).
  // Item-name → custom-icon lookup for the Items grid/detail overlays.
  const customItemIcons = useMemo(() => {
    const out: Record<string, { src: string; hue: number; enabled: boolean }> = {};
    for (const m of project?.iconMods ?? []) {
      if (m.id.startsWith("icon_") && !m.id.startsWith("icon_import_")) {
        out[m.id.slice(5)] = {
          src: m.sourceImage,
          hue: m.hue ?? 0,
          enabled: m.enabled !== false,
        };
      }
    }
    return out;
  }, [project?.iconMods]);

  // Jumpscares tab gate: does any installed pak ship the DigiMaster engine?
  const [digimodOn, setDigimodOn] = useState(false);
  useEffect(() => {
    if (!settings.addonsDir) return;
    digimodDetected(settings.addonsDir)
      .then(setDigimodOn)
      .catch(() => {});
  }, [settings.addonsDir]);

  const tabs = useMemo(() => {
    const seen: string[] = [];
    for (const e of project?.events ?? []) {
      if (!seen.includes(e.group)) seen.push(e.group);
    }
    const out = [
      // Heroes + Items always show; the rest only once slots exist in them.
      ...SIDEBAR_ORDER.filter((g) => g === "heroes" || g === ITEMS || seen.includes(g)),
      // Anything discovery/import routed into a group we don't know yet.
      ...seen.filter((g) => !SIDEBAR_ORDER.includes(g)),
    ];
    // Effects is experimental (VFX recolor): the toggle is authoritative.
    // Recolors in the project stop compiling while it's off (see the
    // CompileBar effectOverrides prop), so nothing ships invisibly.
    if (settings.experimentalEffects) out.push(EFFECTS);
    if (settings.experimentalUiMaster) out.push(UIMASTER);
    out.push(POSTERS);
    // Jumpscares only when the DigiMaster engine is in the user's mods (or
    // this project already configures it).
    if (
      digimodOn ||
      (project?.digimod &&
        (project.digimod.scares.length > 0 ||
          project.digimod.deaths.length > 0 ||
          (project.digimod.mergeVpks?.length ?? 0) > 0))
    )
      out.push(JUMPSCARES);
    // Custom Server is experimental: the toggle is authoritative (gameplay
    // edits only compile behind the separate includeGameplay option anyway).
    if (settings.experimentalServer) out.push(CUSTOM_SERVER);
    out.push(GAMEBANANA, MOD_COMBINER, REPLACE_SOUNDS);
    return out;
  }, [
    project,
    settings.experimentalEffects,
    settings.experimentalServer,
    settings.experimentalUiMaster,
    digimodOn,
  ]);

  // If the active tab vanishes (e.g. turning off an experimental feature while
  // viewing it), fall back to the first tab.
  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab("intro");
  }, [tabs, activeTab]);

  // Fresh tab = fresh scroll position. (Playing audio stops via each player's
  // unmount cleanup when the old tab's content unmounts.)
  const mainRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  // Esc closes the settings modal.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  // Sidebar nav structure: standalone tabs, with category tabs collapsed under
  // a single parent header (rendered at the position of the first member tab).
  // All sound-event tabs additionally nest under one colored ♪ "Sound" master.
  const navItems = useMemo(() => {
    type Child = { type: "tab"; key: string } | { type: "category"; label: string; tabs: string[] };
    const items: (Child | { type: "master"; label: string; items: Child[] })[] = [];
    const usedCats = new Set<string>();
    let master: { type: "master"; label: string; items: Child[] } | null = null;
    const pushSound = (child: Child) => {
      if (!master) {
        master = { type: "master", label: SOUND_MASTER, items: [] };
        items.push(master);
      }
      master.items.push(child);
    };
    for (const g of tabs) {
      const cat = TAB_CATEGORIES.find((c) => c.tabs.includes(g));
      if (cat) {
        if (usedCats.has(cat.label)) continue;
        usedCats.add(cat.label);
        const entry: Child = {
          type: "category",
          label: cat.label,
          tabs: cat.tabs.filter((t) => tabs.includes(t)),
        };
        if (SOUND_MASTER_CATEGORIES.includes(cat.label)) pushSound(entry);
        else items.push(entry);
      } else if (SOUND_MASTER_TABS.includes(g)) {
        pushSound({ type: "tab", key: g });
      } else {
        items.push({ type: "tab", key: g });
      }
    }
    return items;
  }, [tabs]);

  // Which parent categories are collapsed (default: all expanded).
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

  // Sidebar width: user-adjustable via the drag handle (persists locally).
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const saved = Number(localStorage.getItem("eim:sidebarW"));
    return Number.isFinite(saved) && saved >= 176 && saved <= 420 ? saved : 208;
  });

  const hydrated = useRef(false);

  // Bootstrap profiles once settings (which hold the active-profile name) load.
  // Ensures the built-in Vanilla profile exists, migrates the legacy single
  // project.json (+ old settings.importedMods) into "Superpack" on first run,
  // then loads the active profile into the editor.
  useEffect(() => {
    if (!settingsReady || hydrated.current) return;
    hydrated.current = true;
    (async () => {
      try {
        const def = await newProject();
        let list = await listProfiles();

        if (!list.includes(VANILLA_NAME)) {
          await saveProfile(VANILLA_NAME, { project: def, importedMods: [] });
          list = await listProfiles();
        }

        let active = settings.activeProfile;
        const userProfiles = list.filter((n) => n !== VANILLA_NAME);
        if (userProfiles.length === 0) {
          const legacy = await loadState().catch(() => null);
          // Existing content migrates into "Superpack"; a brand-new install gets
          // a plain "Default".
          const firstName = legacy ? "Superpack" : "Default";
          await saveProfile(firstName, {
            project: legacy ?? def,
            importedMods: settings.importedMods ?? [],
          });
          active = firstName;
          list = await listProfiles();
        }

        if (!active || !list.includes(active)) {
          active = list.find((n) => n !== VANILLA_NAME) ?? list[0];
        }

        const blob = await loadProfile(active);
        const proj = blob?.project ? reconcileProject(blob.project, def) : def;
        setProfiles(list);
        setProject(proj);
        updateSettings({
          activeProfile: active,
          importedMods: blob?.importedMods ?? settings.importedMods ?? [],
        });
        void load(proj);
      } catch (e) {
        hydrated.current = false;
        push("error", String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady]);

  // Debounced autosave of the active profile (project + imported mods) on change.
  useEffect(() => {
    if (!project || !hydrated.current || !settings.activeProfile) return;
    const name = settings.activeProfile;
    const blob: ProfileBlob = { project, importedMods: settings.importedMods };
    const id = setTimeout(() => void saveProfile(name, blob), 600);
    return () => clearTimeout(id);
  }, [project, settings.importedMods, settings.activeProfile]);

  // One-time migration: UI-tab edits used to always compile; the new
  // includeUiSounds gate defaults OFF. If this project already carries UI
  // content, enable the gate once so existing mods keep building unchanged.
  useEffect(() => {
    if (!project || !hydrated.current || settings.uiSoundsMigrated) return;
    const hasUi = project.events.some((e) => e.group === "ui" && slotHasContent(e));
    updateSettings({ uiSoundsMigrated: true, ...(hasUi ? { includeUiSounds: true } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, settings.uiSoundsMigrated]);

  // One-click compile-tools install: download the prebuilt bundle (trimmed
  // CSDK compiler + static ffmpeg) into app-data and point settings at it.
  async function downloadToolsBundle() {
    try {
      push("info", "Downloading compile tools (~430 MB)… this can take a few minutes");
      const res = await downloadTools(TOOLS_BUNDLE_URL);
      updateSettings({
        csdkRoot: res.csdkRoot,
        ...(res.ffmpegPath ? { ffmpegPath: res.ffmpegPath } : {}),
      });
      push("success", "Compile tools installed - you're ready to build");
    } catch (e) {
      push("error", `Tools download failed: ${e}`);
    }
  }

  // Persist the active profile immediately (autosave is debounced).
  async function flushActiveProfile() {
    const name = settingsRef.current.activeProfile;
    if (name && projectRef.current) {
      await saveProfile(name, {
        project: projectRef.current,
        importedMods: settingsRef.current.importedMods,
      });
    }
  }

  // Load a profile blob into the editor (resets transient hero UI), and point
  // settings at it. The autosave effect persists from here on.
  function applyProfile(name: string, blob: ProfileBlob | null, def: Project) {
    const proj = blob?.project ? reconcileProject(blob.project, def) : def;
    setSelectedHero(null);
    setSelectedHeroInfo(null);
    setHeroAbilities(null);
    setSelectedAbility(null);
    setProject(proj);
    updateSettings({ activeProfile: name, importedMods: blob?.importedMods ?? [] });
    void load(proj);
  }

  async function switchProfile(name: string) {
    if (name === settingsRef.current.activeProfile) return;
    setProfileBusy(true);
    try {
      await flushActiveProfile();
      const def = await newProject();
      const blob = await loadProfile(name);
      applyProfile(name, blob, def);
      push("success", `Switched to "${name}"`);
    } catch (e) {
      push("error", `Couldn't switch profile: ${e}`);
    } finally {
      setProfileBusy(false);
    }
  }

  async function createProfile(rawName: string) {
    const name = cleanProfileName(rawName);
    setProfileBusy(true);
    try {
      await flushActiveProfile();
      const def = await newProject();
      const blob: ProfileBlob = { project: def, importedMods: [] };
      await saveProfile(name, blob);
      setProfiles(await listProfiles());
      applyProfile(name, blob, def);
      push("success", `Created "${name}"`);
    } catch (e) {
      push("error", `Couldn't create profile: ${e}`);
    } finally {
      setProfileBusy(false);
    }
  }

  async function duplicateProfile(rawName: string) {
    const name = cleanProfileName(rawName);
    setProfileBusy(true);
    try {
      await flushActiveProfile();
      const def = await newProject();
      const blob: ProfileBlob = {
        project: projectRef.current ?? def,
        importedMods: settingsRef.current.importedMods,
      };
      await saveProfile(name, blob);
      setProfiles(await listProfiles());
      applyProfile(name, blob, def);
      push("success", `Duplicated to "${name}"`);
    } catch (e) {
      push("error", `Couldn't duplicate profile: ${e}`);
    } finally {
      setProfileBusy(false);
    }
  }

  async function renameActiveProfile(rawName: string) {
    const from = settingsRef.current.activeProfile;
    const to = cleanProfileName(rawName);
    if (!from || from === VANILLA_NAME || to === from) return;
    setProfileBusy(true);
    try {
      await flushActiveProfile();
      await renameProfile(from, to);
      setProfiles(await listProfiles());
      updateSettings({ activeProfile: to });
      push("success", `Renamed to "${to}"`);
    } catch (e) {
      push("error", `Couldn't rename profile: ${e}`);
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteActiveProfile() {
    const name = settingsRef.current.activeProfile;
    if (!name || name === VANILLA_NAME) return;
    setProfileBusy(true);
    try {
      await deleteProfile(name);
      const list = await listProfiles();
      setProfiles(list);
      const next = list.find((n) => n !== VANILLA_NAME) ?? VANILLA_NAME;
      const def = await newProject();
      const blob = await loadProfile(next);
      applyProfile(next, blob, def);
      push("info", `Deleted "${name}"`);
    } catch (e) {
      push("error", `Couldn't delete profile: ${e}`);
    } finally {
      setProfileBusy(false);
    }
  }

  function pickSide(x: number, y: number): { side: string | null; how: string } {
    const dpr = window.devicePixelRatio || 1;
    const panels = Object.entries(panelEls.current).filter(([, el]) => !!el) as [
      string,
      HTMLElement,
    ][];
    if (panels.length === 0) return { side: null, how: "no-panels" };
    const candidates: [number, number, string][] = [
      [x, y, "raw"],
      [x / dpr, y / dpr, "dpr"],
    ];
    for (const [cx, cy, tag] of candidates) {
      for (const [id, el] of panels) {
        const r = el.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          return { side: id, how: `hit:${tag}` };
        }
      }
    }
    let best = panels[0][0];
    let bestD = Infinity;
    for (const [id, el] of panels) {
      const r = el.getBoundingClientRect();
      const dx = x / dpr - (r.left + r.right) / 2;
      const dy = y / dpr - (r.top + r.bottom) / 2;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return { side: best, how: "closest" };
  }

  useEffect(() => {
    // Browser preview (no Tauri runtime): getCurrentWebview() throws and
    // would unmount the whole app. Skipping native drag-drop lets the UI
    // render at localhost:1420 in a plain browser for visual debugging —
    // backend calls just no-op there.
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlistenP = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        const { side } = pickSide(p.position.x, p.position.y);
        setDropTarget(side);
      } else if (p.type === "leave") {
        setDropTarget(null);
      } else if (p.type === "drop") {
        const { side } = pickSide(p.position.x, p.position.y);
        setDropTarget(null);
        const vpks = p.paths.filter((pp) => /\.vpk$/i.test(pp));
        const audio = p.paths.filter((pp) => AUDIO_EXT.test(pp));
        const images = p.paths.filter((pp) => IMAGE_EXT.test(pp));

        // Dropped image → poster rect under the cursor (Posters tab) or the
        // open item's icon (Items tab).
        if (images.length > 0) {
          const dpr = window.devicePixelRatio || 1;
          if (
            activeTabRef.current === POSTERS &&
            posterDropRef.current?.(images, p.position.x / dpr, p.position.y / dpr)
          ) {
            // handled by the Posters tab
          } else if (activeTabRef.current === POSTERS) {
            push("info", "Drop the image onto a poster region on the sheet");
          } else if (activeTabRef.current === ITEMS && selectedItemRef.current) {
            void setItemIcon(selectedItemRef.current, images[0]);
          } else {
            push("info", "Open an item in the Items tab, then drop a PNG/JPG to set its icon");
          }
        }

        // Dropped a mod .vpk → open the import review for it. Several at once
        // fall back to plain bundle-list adds (one review at a time).
        if (vpks.length === 1) {
          setActiveTab(MOD_COMBINER);
          void startPackImport(vpks[0]);
        } else if (vpks.length > 1) {
          const cur = settingsRef.current.importedMods;
          const next = [...cur];
          for (const v of vpks) if (!next.includes(v)) next.push(v);
          const addedN = next.length - cur.length;
          if (addedN > 0) {
            updateSettings({ importedMods: next });
            setActiveTab(MOD_COMBINER);
            push("success", `Added ${addedN} mods to bundle - import them one at a time to pick their sounds`);
          } else {
            push("info", "Those mod(s) are already in the combine list");
          }
        }

        // Dropped audio → add to the slot under the cursor.
        if (audio.length > 0) {
          if (side) {
            for (const path of audio) void addSong(side, path);
          } else {
            push("error", "Drop the .mp3 onto a track slot");
          }
        }

        if (vpks.length === 0 && audio.length === 0 && images.length === 0) {
          push("error", "Drop an .mp3 (onto a slot), an image (onto an item), or a mod .vpk");
        }
      }
    });
    return () => {
      void unlistenP.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(proj?: Project) {
    const p = proj ?? projectRef.current;
    if (!p) return;
    try {
      const root = settingsRef.current.vanillaRoot.replace(/[/\\]+$/, "");
      const slots = p.events.map((e) => ({
        eventsPath: `${root}/${e.eventsRelpath}`,
        eventName: e.eventName,
        arrayKey: e.arrayKey,
      }));
      const views = await readEventPools(slots);
      const map: Record<string, EventView> = {};
      p.events.forEach((e, i) => {
        const v = views[i];
        if (v) map[e.id] = v;
      });
      setPools(map);
      // Flag pool/stock refs the pak doesn't actually ship (placeholder/legacy
      // refs) so their rows show "no sound" instead of a beeping preview.
      void (async () => {
        const s = settingsRef.current;
        if (!s.vpkHelperPath || !s.deadlockPak) return;
        try {
          const refs = new Set<string>();
          for (const e of p.events) if (e.stockEntry) refs.add(e.stockEntry);
          for (const v of Object.values(map)) for (const r of v.entries) refs.add(r);
          if (refs.size === 0) return;
          const missing = await checkSoundRefs(s.vpkHelperPath, s.deadlockPak, [...refs]);
          setMissingSoundRefs(new Set(missing));
        } catch {
          /* best effort — previews just stay enabled */
        }
      })();
      // Sync dynamic hero ability slots' stock to the live first entry, so the
      // existing game sound shows as the stock row. Re-synced each load (not just
      // when empty) so a stale pinned ref from an earlier session self-heals
      // instead of previewing the wrong sound.
      setProject((prev) => {
        if (!prev) return prev;
        let changed = false;
        const events = prev.events.map((e) => {
          let ev = e;
          if (isDynamicSlot(ev.id)) {
            const first = map[ev.id]?.entries?.[0];
            if (first && first !== ev.stockEntry) {
              changed = true;
              ev = { ...ev, stockEntry: first };
            }
          }
          // Adopted refs that are already in the vanilla base file are vanilla
          // sounds a pack happened to bundle (or stock-named replacements) —
          // not the mod's own tracks. Drop the bogus adoption; the pool rows
          // show those entries already.
          const pool = map[ev.id]?.entries;
          if (pool && ev.adopted.length > 0) {
            const inPool = new Set(pool);
            const kept = ev.adopted.filter((a) => !inPool.has(a.reference));
            if (kept.length !== ev.adopted.length) {
              changed = true;
              ev = { ...ev, adopted: kept };
            }
          }
          return ev;
        });
        return changed ? { ...prev, events } : prev;
      });
    } catch (e) {
      push("error", `Couldn't read events file: ${e}`);
    }
  }

  function toggleSongExpanded(id: string) {
    setExpandedSongs((m) => ({ ...m, [id]: !m[id] }));
  }

  function uniqueSoundName(base: string, proj: Project, exceptId?: string): string {
    const taken = new Set(
      proj.events.flatMap((e) =>
        e.songs.filter((s) => s.id !== exceptId).map((s) => s.soundName),
      ),
    );
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  async function addSong(slotId: string, path: string, preset?: Partial<Song>) {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      const ffmpegPath = settingsRef.current.ffmpegPath || undefined;
      // A paste (preset) already knows its trim window — skip the probe.
      const trimEnd =
        preset?.trimEnd !== undefined ? preset.trimEnd : (await probeAudio(path, ffmpegPath)).duration;
      const sanitized = await sanitizeName(preset?.label ?? baseName(path));
      const soundName = uniqueSoundName(sanitized, proj);
      const slot = proj.events.find((e) => e.id === slotId);
      const order = slot ? slot.songs.length : 0;
      const song: Song = {
        label: baseName(path),
        sourceMp3: path,
        trimStart: 0,
        trimEnd,
        gainDb: DEFAULT_GAIN_DB,
        fadeIn: 0,
        fadeOut: 0,
        looping:
          (slot?.eventName.endsWith(".Lp") || /_lp(_|\.|$)/i.test(slot?.stockEntry ?? "")) ??
          false,
        lastCompiledHash: null,
        // Pasted tracks carry their copied settings over the defaults; the
        // identity fields below always win.
        ...preset,
        soundName,
        order,
        id: crypto.randomUUID(),
      };
      setProject((prev) =>
        prev
          ? {
              ...prev,
              events: prev.events.map((e) =>
                e.id === slotId
                  ? withAutoReplace(
                      { ...e, songs: [...e.songs, song] },
                      [song.soundName],
                      settingsRef.current.soundFolder,
                      pools[e.id]?.entries,
                    )
                  : e,
              ),
            }
          : prev,
      );
      setExpandedSongs((m) => ({ ...m, [song.id]: true })); // open the new drop
      push("success", `Added "${baseName(path)}" to ${slot?.side ?? "slot"}`);
    } catch (e) {
      push("error", `Could not add ${baseName(path)}: ${e}`);
    }
  }

  /** Paste the sound-clipboard track into a slot: same file + all its edits
   *  (trims/gain/fades/loop), fresh identity. */
  function pasteSong(slotId: string) {
    const c = getCopiedSound();
    if (!c) return;
    void addSong(slotId, c.sourceMp3, {
      label: c.label,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      gainDb: c.gainDb,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      looping: c.looping,
    });
  }

  function updateSong(songId: string, patch: Partial<Song>) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.map((s) => (s.id === songId ? { ...s, ...patch } : s)),
            })),
          }
        : prev,
    );
  }

  async function renameSong(songId: string, raw: string) {
    const clean = (await sanitizeName(raw)) || "track";
    setProject((prev) => {
      if (!prev) return prev;
      const name = uniqueSoundName(clean, prev, songId);
      return {
        ...prev,
        events: prev.events.map((e) => {
          if (!e.songs.some((s) => s.id === songId)) return e;
          const next = {
            ...e,
            songs: e.songs.map((s) => (s.id === songId ? { ...s, soundName: name } : s)),
          };
          // Renamed to exactly match an original → auto-engage replace.
          return withAutoReplace(next, [name], settingsRef.current.soundFolder, pools[e.id]?.entries);
        }),
      };
    });
  }

  // Persist a new drag order: each song's `order` becomes its index in the list.
  function reorderSongs(slotId: string, orderedIds: string[]) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) =>
              e.id === slotId
                ? {
                    ...e,
                    songs: e.songs.map((s) => {
                      const idx = orderedIds.indexOf(s.id);
                      return idx === -1 ? s : { ...s, order: idx };
                    }),
                  }
                : e,
            ),
          }
        : prev,
    );
  }

  function removeSong(songId: string) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.filter((s) => s.id !== songId),
            })),
          }
        : prev,
    );
  }

  // Decode a compiled entry to a playable URL. `vpk` defaults to the game pak
  // (stock tracks); pass a mod vpk for adopted entries.
  async function decodeStock(ref: string, vpk?: string): Promise<string> {
    const s = settingsRef.current;
    const path = await decodeStockApi(s.vpkHelperPath, vpk ?? s.deadlockPak, ref);
    return convertFileSrc(path);
  }

  function shortRef(ref: string): string {
    return (ref.split("/").pop() ?? ref).replace(/\.vsnd$/, "");
  }

  // Download a copy of an existing entry (decoded from its vpk) into Downloads.
  async function downloadEntryTo(ref: string, vpk?: string) {
    const s = settingsRef.current;
    try {
      const dest = await downloadEntry(s.vpkHelperPath, vpk ?? s.deadlockPak, ref);
      push("success", `Saved to ${dest}`);
    } catch (e) {
      push("error", `Download failed: ${e}`);
    }
  }

  // Batch-download stock sounds into Downloads (sequential; one toast at the end).
  async function downloadManyEntries(refs: string[]) {
    const s = settingsRef.current;
    if (refs.length > 1) push("info", `Downloading ${refs.length} sound(s)…`);
    let ok = 0;
    let fail = 0;
    let dest = "";
    for (const r of refs) {
      try {
        dest = await downloadEntry(s.vpkHelperPath, s.deadlockPak, r);
        ok++;
      } catch {
        fail++;
      }
    }
    const folder = dest.replace(/[\\/][^\\/]*$/, "");
    push(
      fail > 0 ? "error" : "success",
      `Downloaded ${ok} sound(s)${fail > 0 ? `, ${fail} failed` : ""}${folder ? ` → ${folder}` : ""}`,
    );
  }

  // Copy one of your source mp3s into Downloads.
  async function downloadSong(sourceMp3: string) {
    try {
      const dest = await copyToDownloads(sourceMp3);
      push("success", `Saved to ${dest}`);
    } catch (e) {
      push("error", `Download failed: ${e}`);
    }
  }

  // event name -> owning shop item(s), so item sounds land in the Items tab.
  async function buildItemIndex(): Promise<Map<string, { item: string; label: string }[]>> {
    const s = settingsRef.current;
    const itemIndex = new Map<string, { item: string; label: string }[]>();
    try {
      for (const r of await itemSoundIndex(s.vpkHelperPath, s.deadlockPak)) {
        const arr = itemIndex.get(r.eventName) ?? [];
        arr.push({ item: r.itemName, label: r.label });
        itemIndex.set(r.eventName, arr);
      }
    } catch {
      /* item routing is best-effort; fall back to Misc if it fails */
    }
    return itemIndex;
  }

  // Step 1 of importing a mod: scan the pack and open the review modal — the
  // user picks which sound events to break out and whether to bundle the rest.
  async function startPackImport(vpk: string) {
    const proj = projectRef.current;
    const s = settingsRef.current;
    if (!proj) return;
    try {
      push("info", "Scanning pack… this can take a moment");
      const [events, contents, itemIndex] = await Promise.all([
        importPackEvents(s.vpkHelperPath, s.deadlockPak, vpk, []),
        scanPackContents(s.vpkHelperPath, s.deadlockPak, vpk),
        buildItemIndex(),
      ]);
      // Stock-path replacement files are the mod's own audio parked at an
      // original's path. Find the event(s) that reference each one and offer
      // them as importable events too — on import the audio becomes YOUR
      // track appended to the array (merge), not a raw file overwrite.
      const overwriteKeys = new Set<string>();
      pendingOverwriteRefs.current = new Set();
      try {
        const stockRefs = contents.overwrites.map((f) => f.replace(/_c$/, ""));
        if (stockRefs.length > 0) {
          // Make sure the soundevents files this pack touches — and any HERO
          // file its replacement sounds belong to (e.g. a Drifter ability mod
          // when you've never opened Drifter) — are decompiled locally, so
          // the reverse lookup can actually find the owning events.
          const ensure = new Set<string>(events.map((e) => e.eventsRelpath));
          for (const f of contents.overwrites) {
            const m = f.match(/^sounds\/(?:abilities|vo|weapons)\/([a-z0-9_]+)\//);
            if (m) ensure.add(`soundevents/hero/${m[1]}.vsndevts`);
          }
          const vroot = await ensureVanillaFiles([...ensure]);
          const hits = await eventsForRefs(vroot, stockRefs);
          const byKey = new Map(
            events.map((e) => [`${e.eventsRelpath}::${e.eventName}::${e.arrayKey}`, e]),
          );
          for (const h of hits) {
            const key = `${h.eventsRelpath}::${h.eventName}::${h.arrayKey}`;
            const existing = byKey.get(key);
            if (existing) {
              if (!existing.refs.includes(h.reference)) existing.refs.push(h.reference);
            } else {
              const ie: ImportEvent = {
                eventsRelpath: h.eventsRelpath,
                eventName: h.eventName,
                arrayKey: h.arrayKey,
                refs: [h.reference],
              };
              events.push(ie);
              byKey.set(key, ie);
            }
            overwriteKeys.add(key);
            pendingOverwriteRefs.current.add(h.reference);
          }
        }
      } catch {
        /* best-effort — unmapped replacements stay plain bundle overwrites */
      }
      pendingImportEvents.current = events;
      const curated = new Map<string, EventProject>(
        proj.events.map((e) => [`${e.eventsRelpath}::${e.eventName}::${e.arrayKey}`, e]),
      );
      const groupsMap = new Map<string, ReviewEvent[]>();
      for (const ie of events) {
        if (isExcludedImport(ie.eventsRelpath, ie.eventName)) continue;
        const key = `${ie.eventsRelpath}::${ie.eventName}::${ie.arrayKey}`;
        const cur = curated.get(key);
        // `_shared.vsndevts` isn't a real hero — those events fall through to
        // the family router (a "_shared" drill-in would never render).
        const heroMatch = ie.eventsRelpath.match(/^soundevents\/hero\/(?!_shared\.)(.+)\.vsndevts$/);
        let group: string;
        let folds = false;
        let label = eventLabel(ie.eventName);
        if (cur && !isImportSlot(cur.id)) {
          group = cur.group;
          folds = true;
          label = cur.side || label;
        } else if (heroMatch) {
          group = "heroes";
        } else if (itemIndex.has(ie.eventName)) {
          group = ITEMS;
          label = itemIndex.get(ie.eventName)![0].label;
        } else {
          group = routeGroupFor(ie.eventsRelpath, ie.eventName);
        }
        const list = groupsMap.get(group) ?? [];
        list.push({
          key,
          eventName: ie.eventName,
          label,
          trackCount: ie.refs.length,
          foldsIntoExisting: folds,
          overwrite: overwriteKeys.has(key),
        });
        groupsMap.set(group, list);
      }
      const orderIdx = (g: string) => {
        const i = SIDEBAR_ORDER.indexOf(g);
        return i === -1 ? SIDEBAR_ORDER.length : i;
      };
      const groups: ReviewGroup[] = [...groupsMap.entries()]
        .sort((a, b) => orderIdx(a[0]) - orderIdx(b[0]))
        .map(([group, evs]) => ({
          group,
          label: TAB_LABELS[group] ?? group,
          accent: accentFor({ group, side: "" }),
          events: evs.sort((x, y) => x.label.localeCompare(y.label)),
        }));
      setPackReview({
        vpk,
        name: baseName(vpk),
        groups,
        contents,
        priorExcludes: s.importedModExcludes?.[vpk] ?? [],
      });
    } catch (e) {
      push("error", `Pack scan failed: ${e}`);
    }
  }

  // Step 2: apply the reviewed import. Selected events are broken out as
  // editable, adopted slots (matching events fold into existing tabs, hero
  // sounds into their hero, item sounds into the Items tab, UI behind its
  // toggle, the rest to Misc); `bundle` registers the whole vpk in the combine
  // list so all its other files (incl. stock-named replacements) ride along.
  async function applyPackImport(
    vpk: string,
    selectedKeys: Set<string>,
    bundle: boolean,
    excludedFiles: string[],
    mode: "linked" | "absorb",
    zeroGain: boolean,
  ) {
    const proj = projectRef.current;
    const s = settingsRef.current;
    if (!proj) return;
    setPackReview(null);
    try {
      // One-off import: extract the pack into the app-managed cache and use
      // THAT as the source from here on — the original .vpk is never needed
      // again (move it, delete it, whatever). Skipped when nothing will
      // reference the pack later (pure absorb, no bundle).
      let source = vpk;
      const needsCache = bundle || mode === "linked";
      if (needsCache) {
        try {
          push("info", "Caching pack files (one-time - the .vpk won't be needed again)…");
          source = await cachePack(s.vpkHelperPath, vpk);
        } catch (e) {
          push("error", `Couldn't cache the pack - keeping the original .vpk as the source: ${e}`);
        }
      }
      if (bundle) {
        // Register the bundle + remember which of its files were deselected
        // (compile drops them from the combined stage).
        const excludes = { ...(s.importedModExcludes ?? {}) };
        delete excludes[vpk];
        if (excludedFiles.length > 0) excludes[source] = excludedFiles;
        else delete excludes[source];
        updateSettings({
          importedMods: [
            ...s.importedMods.filter((m) => m !== vpk && m !== source),
            source,
          ],
          importedModExcludes: excludes,
        });
      }
      // Adopt the pack's panorama images (item icons etc.) as editable Icon
      // Mods — otherwise they'd ship invisibly inside the pack (and be missing
      // from the "mine" build entirely).
      let adoptedIcons = 0;
      try {
        const excludedSet = new Set(excludedFiles);
        const icons = (await packIcons(s.vpkHelperPath, source)).filter(
          (ic) => !excludedSet.has(ic.targetVtexc),
        );
        if (icons.length > 0) {
          let byInternal = new Map<string, ItemCard>();
          try {
            const roster = await cItemRoster(s.vpkHelperPath, s.deadlockPak);
            byInternal = new Map(
              roster.filter((r) => r.iconInternal).map((r) => [r.iconInternal!, r]),
            );
          } catch {
            /* roster is only used for friendly names */
          }
          const existing = projectRef.current?.iconMods ?? [];
          const additions = icons
            .map((ic) => {
              const item = byInternal.get(ic.targetVtexc);
              const id = item
                ? `icon_${item.name}`
                : `icon_import_${ic.targetVtexc.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
              return { ic, item, id };
            })
            .filter(
              ({ ic, id }) =>
                !existing.some((m) => m.id === id || m.targetVtexc === ic.targetVtexc),
            );
          if (additions.length > 0) {
            adoptedIcons = additions.length;
            setProject((prev) =>
              prev
                ? {
                    ...prev,
                    iconMods: [
                      ...(prev.iconMods ?? []),
                      ...additions.map(({ ic, item, id }) => ({
                        id,
                        name:
                          item?.displayName ?? ic.targetVtexc.split("/").pop() ?? "imported icon",
                        targetVtexc: ic.targetVtexc,
                        sourceImage: ic.pngPath,
                        width: ic.width,
                        height: ic.height,
                        hue: 0,
                        enabled: true,
                      })),
                    ],
                  }
                : prev,
            );
          }
        }
      } catch {
        /* icon adoption is best-effort — sounds still import */
      }
      const iconNote = adoptedIcons > 0 ? ` · ${adoptedIcons} icon(s) adopted` : "";

      const events = (pendingImportEvents.current ?? []).filter((ie) =>
        selectedKeys.has(`${ie.eventsRelpath}::${ie.eventName}::${ie.arrayKey}`),
      );
      if (events.length === 0) {
        push(
          "success",
          (bundle ? "Pack added - it'll be bundled on compile" : "Nothing imported") + iconNote,
        );
        return;
      }
      const itemIndex = await buildItemIndex();

      // Start from the current slots minus pure import artifacts (adopt-only
      // imp_ slots with no songs) so re-importing re-sorts cleanly instead of
      // leaving stale Misc copies. User-edited slots are always kept.
      const keptIds = new Set<string>();
      const slotsById = new Map<string, EventProject>();
      const order: string[] = [];
      let removedExcluded = 0;
      for (const e of proj.events) {
        // Drop excluded (e.g. priest) import artifacts entirely, and drop
        // adopt-only imp_ slots so this run re-sorts them fresh. User-edited
        // slots (with songs) are always kept.
        if (isImportArtifact(e) && isExcludedImport(e.eventsRelpath, e.eventName)) {
          removedExcluded++;
          continue;
        }
        // Adopt-only imp_ slots re-sort fresh, but never drop one carrying
        // user edits (songs OR removals/exclusions — re-import must not
        // resurrect sounds the user pruned).
        if (isImportSlot(e.id) && !slotHasContent(e)) continue;
        slotsById.set(e.id, e);
        order.push(e.id);
        keptIds.add(e.id);
      }
      const curatedId = new Map(
        [...slotsById.values()].map(
          (e) => [`${e.eventsRelpath}::${e.eventName}::${e.arrayKey}`, e.id] as const,
        ),
      );
      const additions = new Map<string, { reference: string; sourceVpk: string; label: string }[]>();

      // Get-or-create a target slot by id and fold in fresh adopted refs.
      const adoptInto = (id: string, make: () => EventProject, refs: string[]): number => {
        if (!slotsById.has(id)) {
          slotsById.set(id, make());
          order.push(id);
        }
        const slot = slotsById.get(id)!;
        const have = new Set([
          ...slot.adopted.map((a) => a.reference),
          // Tracks previously CONVERTED from a pack (absorb / edit-adopted)
          // count as already-imported — re-importing must not double them.
          ...slot.songs.map((x) => x.importedRef).filter((r): r is string => !!r),
          ...(additions.get(id)?.map((a) => a.reference) ?? []),
        ]);
        const fresh = refs.filter((r) => !have.has(r));
        if (!fresh.length) return 0;
        const add = additions.get(id) ?? [];
        add.push(...fresh.map((r) => ({ reference: r, sourceVpk: source, label: shortRef(r) })));
        additions.set(id, add);
        return fresh.length;
      };
      const mkSlot = (
        id: string,
        group: string,
        ie: { eventName: string; arrayKey: string; eventsRelpath: string },
        label?: string,
      ): EventProject => ({
        id,
        group,
        side: label ?? eventLabel(ie.eventName),
        eventName: ie.eventName,
        arrayKey: ie.arrayKey,
        stockEntry: "",
        vsndDurationMode: "auto",
        vsndDurationManual: null,
        songs: [],
        previousOwnedNames: [],
        excludedEntries: [],
        removedEntries: [],
        adopted: [],
        eventsRelpath: ie.eventsRelpath,
      });

      let adoptedRefs = 0;
      let skipped = 0;
      const counts = { folded: 0, hero: 0, item: 0, ui: 0, sorted: 0, misc: 0 };
      for (const ie of events) {
        if (isExcludedImport(ie.eventsRelpath, ie.eventName)) {
          skipped++;
          continue;
        }
        // `_shared.vsndevts` isn't a real hero — those events fall through to
        // the family router (a "_shared" drill-in would never render).
        const heroMatch = ie.eventsRelpath.match(/^soundevents\/hero\/(?!_shared\.)(.+)\.vsndevts$/);
        const curated = curatedId.get(`${ie.eventsRelpath}::${ie.eventName}::${ie.arrayKey}`);
        if (curated && !isImportSlot(curated)) {
          // Fold into a curated/hero/item slot that already exists.
          const n = adoptInto(curated, () => slotsById.get(curated)!, ie.refs);
          if (n) (adoptedRefs += n), counts.folded++;
        } else if (heroMatch) {
          // Hero ability sound → that hero's drill-in (Heroes tab).
          const codename = heroMatch[1];
          const id = heroAbilSlotId(codename, ie.eventName);
          const n = adoptInto(id, () => mkSlot(id, "heroes", ie), ie.refs);
          if (n) (adoptedRefs += n), counts.hero++;
        } else if (itemIndex.has(ie.eventName)) {
          // Item sound → the Items tab, once per owning item.
          for (const owner of itemIndex.get(ie.eventName)!) {
            const id = itemSndSlotId(owner.item, ie.eventName);
            const n = adoptInto(id, () => mkSlot(id, ITEMS, ie, owner.label), ie.refs);
            if (n) (adoptedRefs += n), counts.item++;
          }
        } else {
          // Route by file/name family: UI → UI tab (behind its build toggle),
          // known music/world families → their curated tab, the rest → Misc.
          const group = routeGroupFor(ie.eventsRelpath, ie.eventName);
          const id = importSlotId(ie.eventsRelpath, ie.eventName, ie.arrayKey);
          const n = adoptInto(id, () => mkSlot(id, group, ie), ie.refs);
          if (n) {
            adoptedRefs += n;
            if (group === "ui") counts.ui++;
            else if (group === UNSORTED) counts.misc++;
            else counts.sorted++;
          }
        }
      }

      const finalEvents = order.map((id) => {
        const slot = slotsById.get(id)!;
        const add = additions.get(id);
        return add && add.length ? { ...slot, adopted: [...slot.adopted, ...add] } : slot;
      });
      setProject((prev) => (prev ? { ...prev, events: finalEvents } : prev));

      // Pool the newly-created slots so they render. Decompile their soundevents
      // files into the merge base first (import touches files we may not have
      // pulled yet, e.g. hero/*, mods/*, gameplay/player/damage).
      const created = finalEvents.filter((e) => !keptIds.has(e.id));
      if (created.length) {
        await ensureVanillaFiles(Array.from(new Set(created.map((e) => e.eventsRelpath))));
        const root = settingsRef.current.vanillaRoot.replace(/[/\\]+$/, "");
        const newViews = await readEventPools(
          created.map((e) => ({
            eventsPath: `${root}/${e.eventsRelpath}`,
            eventName: e.eventName,
            arrayKey: e.arrayKey,
          })),
        );
        setPools((prev) => {
          const next = { ...prev };
          created.forEach((e, i) => {
            const v = newViews[i];
            if (v) next[e.id] = v;
          });
          return next;
        });
      }
      // Convert adopted entries into editable songs (decoded from the pack,
      // renamed to a clean sound name), dropping the adoption — the result
      // looks exactly like audio you added yourself. In "absorb" mode this
      // covers everything; in "linked" mode only the stock-path replacement
      // refs, which must become your tracks (their ref IS the original's
      // path). Un-decodable entries stay adopted (linked) instead.
      let absorbed = 0;
      {
        const overwriteRefs = pendingOverwriteRefs.current;
        const jobs = [...additions.entries()].flatMap(([slotId, adds]) =>
          adds
            .filter((a) => mode === "absorb" || overwriteRefs.has(a.reference))
            .map((a) => ({ slotId, reference: a.reference, label: a.label })),
        );
        if (jobs.length > 0) {
          push("info", `Converting ${jobs.length} track(s) into your own…`);
          const done: { slotId: string; reference: string; label: string; mp3: string; duration: number }[] = [];
          let next = 0;
          const worker = async () => {
            while (next < jobs.length) {
              const j = jobs[next++];
              try {
                const mp3 = await decodeStockApi(s.vpkHelperPath, source, j.reference);
                const info = await probeAudio(mp3, s.ffmpegPath || undefined);
                done.push({ ...j, mp3, duration: info.duration });
              } catch {
                /* un-decodable → stays adopted/linked */
              }
            }
          };
          await Promise.all(Array.from({ length: 3 }, () => worker()));
          absorbed = done.length;
          if (done.length > 0) {
            setProject((prev) => {
              if (!prev) return prev;
              const used = new Set(prev.events.flatMap((e) => e.songs.map((x) => x.soundName)));
              const claim = (base: string): string => {
                if (!used.has(base)) {
                  used.add(base);
                  return base;
                }
                let i = 2;
                while (used.has(`${base}_${i}`)) i++;
                const n = `${base}_${i}`;
                used.add(n);
                return n;
              };
              const bySlot = new Map<string, typeof done>();
              for (const d of done) {
                const l = bySlot.get(d.slotId) ?? [];
                l.push(d);
                bySlot.set(d.slotId, l);
              }
              return {
                ...prev,
                events: prev.events.map((e) => {
                  const list = bySlot.get(e.id);
                  if (!list) return e;
                  const drop = new Set(list.map((d) => d.reference));
                  let order = e.songs.length;
                  const addedNames: string[] = [];
                  const songs = [
                    ...e.songs,
                    ...list.map((d) => {
                      const soundName = claim(cleanSoundName(d.label));
                      addedNames.push(soundName);
                      return {
                        id: crypto.randomUUID(),
                        label: d.label,
                        sourceMp3: d.mp3,
                        soundName,
                        trimStart: 0,
                        trimEnd: d.duration,
                        // Mod audio is already mastered — the +6 dB new-track
                        // boost is opt-out at import time.
                        gainDb: zeroGain ? 0 : DEFAULT_GAIN_DB,
                        fadeIn: 0,
                        fadeOut: 0,
                        looping: e.eventName.endsWith(".Lp"),
                        order: order++,
                        lastCompiledHash: null,
                        importedRef: d.reference,
                      };
                    }),
                  ];
                  // A converted replacement keeps the original's name — auto-
                  // engage "replace" so the array doesn't double-play it.
                  return withAutoReplace(
                    { ...e, songs, adopted: e.adopted.filter((a) => !drop.has(a.reference)) },
                    addedNames,
                    settingsRef.current.soundFolder,
                    pools[e.id]?.entries,
                  );
                }),
              };
            });
            // The absorbed audio now compiles from YOUR tracks — drop the
            // pack's copies from the bundle so they don't ship twice.
            if (bundle) {
              const cur = settingsRef.current;
              const merged = { ...(cur.importedModExcludes ?? {}) };
              const extra = done.map((d) => d.reference.replace(/\.vsnd$/, ".vsnd_c"));
              merged[source] = Array.from(new Set([...(merged[source] ?? []), ...extra]));
              updateSettings({ importedModExcludes: merged });
            }
          }
        }
      }

      const exclNote =
        removedExcluded || skipped
          ? ` · skipped ${skipped + removedExcluded} excluded (${EXCLUDED_IMPORT_TERMS.join(", ")})`
          : "";
      const absorbNote = absorbed > 0 ? ` · ${absorbed} converted into your own tracks` : "";
      push(
        "success",
        `Import done - ${adoptedRefs} sound(s): ${counts.hero} hero, ${counts.item} item, ${counts.ui} UI, ${counts.sorted} sorted to tabs, ${counts.misc} misc, ${counts.folded} folded into existing${absorbNote}${exclNote}${iconNote}`,
      );
    } catch (e) {
      push("error", `Import failed: ${e}`);
    }
  }

  // Convert an adopted entry into an editable mp3 song card.
  async function editAdopted(slotId: string, ref: string, vpk: string, label: string) {
    const s = settingsRef.current;
    try {
      const mp3 = await decodeStockApi(s.vpkHelperPath, vpk, ref);
      const info = await probeAudio(mp3, s.ffmpegPath || undefined);
      const sanitized = await sanitizeName(label);
      const newId = crypto.randomUUID();
      setProject((prev) => {
        if (!prev) return prev;
        const soundName = uniqueSoundName(sanitized, prev);
        const slot = prev.events.find((e) => e.id === slotId);
        const order = slot ? slot.songs.length : 0;
        const song: Song = {
          id: newId,
          label,
          sourceMp3: mp3,
          soundName,
          trimStart: 0,
          trimEnd: info.duration,
          gainDb: DEFAULT_GAIN_DB,
          fadeIn: 0,
          fadeOut: 0,
          looping:
          (slot?.eventName.endsWith(".Lp") || /_lp(_|\.|$)/i.test(slot?.stockEntry ?? "")) ??
          false,
          order,
          lastCompiledHash: null,
          importedRef: ref,
        };
        return {
          ...prev,
          events: prev.events.map((e) =>
            e.id === slotId
              ? {
                  ...e,
                  songs: [...e.songs, song],
                  adopted: e.adopted.filter((x) => x.reference !== ref),
                }
              : e,
          ),
        };
      });
      setExpandedSongs((m) => ({ ...m, [newId]: true })); // open it for editing
      push("success", `Now editing "${label}"`);
    } catch (e) {
      push("error", `Couldn't edit ${label}: ${e}`);
    }
  }

  // After a successful compile, stamp each song with its current hash so the
  // next compile can skip unchanged tracks (and the badge reads "Compiled").
  function markAllCompiled() {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.map((s) => ({ ...s, lastCompiledHash: songHash(s) })),
            })),
            soundOverrides: (prev.soundOverrides ?? []).map((o) => ({
              ...o,
              lastCompiledHash: overrideHash(o),
            })),
            effectOverrides: (prev.effectOverrides ?? []).map((e) => ({
              ...e,
              lastCompiledHash: effectHash(e),
            })),
            posterOverrides: (prev.posterOverrides ?? []).map((p, _, all) => ({
              ...p,
              lastCompiledHash: posterHash(p, sheetSiblingsKey(all, p.sheetId)),
            })),
          }
        : prev,
    );
  }

  // Loudness leveling: nudge EVERY track's + sound replacement's gain by delta
  // dB (clamped ±24). Changed items lose their compile stamp so they re-render.
  function bulkGain(delta: number) {
    const cur = projectRef.current;
    const touched =
      (cur?.events.reduce((n, e) => n + e.songs.length, 0) ?? 0) +
      (cur?.soundOverrides?.length ?? 0);
    if (touched === 0) return push("info", "No tracks or replacements to adjust");
    const clamp = (v: number) => Math.max(-24, Math.min(24, v + delta));
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.map((s) => ({
                ...s,
                gainDb: clamp(s.gainDb),
                lastCompiledHash: null,
              })),
            })),
            soundOverrides: (prev.soundOverrides ?? []).map((o) => ({
              ...o,
              gainDb: clamp(o.gainDb),
              lastCompiledHash: null,
            })),
          }
        : prev,
    );
    push("success", `Adjusted gain ${delta > 0 ? "+" : ""}${delta} dB on ${touched} item(s)`);
  }

  // Slot-targeted toggles (slots can share an event name, so key by slot id).
  function patchSlot(slotId: string, fn: (e: EventProject) => EventProject) {
    setProject((prev) =>
      prev
        ? { ...prev, events: prev.events.map((e) => (e.id === slotId ? fn(e) : e)) }
        : prev,
    );
  }

  function toggleEntry(slotId: string, ref: string) {
    patchSlot(slotId, (e) => ({
      ...e,
      excludedEntries: e.excludedEntries.includes(ref)
        ? e.excludedEntries.filter((r) => r !== ref)
        : [...e.excludedEntries, ref],
    }));
  }

  function removeEntry(slotId: string, ref: string) {
    patchSlot(slotId, (e) =>
      e.removedEntries.includes(ref)
        ? e
        : { ...e, removedEntries: [...e.removedEntries, ref] },
    );
  }

  function restoreEntry(slotId: string, ref: string) {
    patchSlot(slotId, (e) => ({
      ...e,
      removedEntries: e.removedEntries.filter((r) => r !== ref),
      excludedEntries: e.excludedEntries.filter((r) => r !== ref),
    }));
  }

  // Refresh the merge base from the live game pak and reconcile every slot
  // against the new patch:
  //  • re-decompiles ALL main soundevent files (music/world/ui) + any others the
  //    project references (hero/item files), so the fix looks through every sound
  //    event we could own — not only files that already have a slot;
  //  • re-pins each slot's stockEntry to the live first entry (kills drifted refs)
  //    WITHOUT touching the user's own songs/adopted entries — mods don't break;
  //  • detects slots whose event the patch DELETED: kept + flagged when they still
  //    hold your content, counted as cleaned when they were unused.
  // Returns the reconciled events + the refreshed vanillaRoot on success (so a
  // one-click "fix + recompile" builds its compile config from fresh data
  // instead of racing React state/settings), or null on failure.
  async function refreshVanilla(opts?: {
    helper?: string;
    pak?: string;
  }): Promise<{ events: EventProject[]; vanillaRoot: string } | null> {
    const proj = projectRef.current;
    const s = settingsRef.current;
    if (!proj) return null;
    // Allow freshly-detected values to be passed in directly (first-run setup
    // runs detect then refresh in one tick, before settingsRef has updated).
    const helper = opts?.helper ?? s.vpkHelperPath;
    const pak = opts?.pak ?? s.deadlockPak;
    try {
      // Always pull the three main soundevent files, plus whatever else our slots
      // reference, so "fix" sweeps every sound event we could own.
      const MAIN_FILES = [
        "soundevents/music.vsndevts",
        "soundevents/world.vsndevts",
        "soundevents/ui.vsndevts",
      ];
      // Sweep EVERY soundevents file in the pak so all sound events are
      // accounted for — excluding hero files (the Heroes tab browses those
      // live) and voiceline files (the voicelines panel's domain). Falls back
      // to the main files if the pak listing fails.
      let sweepFiles = MAIN_FILES;
      try {
        const all = await listSoundeventFiles(helper, pak);
        const swept = all.filter(
          (f) =>
            !f.startsWith("soundevents/hero/") &&
            !f.startsWith("soundevents/vo/") &&
            // base/* are inheritance templates (editing them cascades into
            // everything that derives from them) and from_tools is dev-only.
            !f.startsWith("soundevents/base/") &&
            !f.includes("soundevents_from_tools") &&
            !f.includes("generated_vo") &&
            !f.includes("new_player_vo") &&
            !f.includes("voip"),
        );
        if (swept.length) sweepFiles = Array.from(new Set([...MAIN_FILES, ...swept]));
      } catch {
        /* pak listing is best-effort; the main files still sweep */
      }
      const relpaths = Array.from(
        new Set([...sweepFiles, ...proj.events.map((e) => e.eventsRelpath)]),
      );
      const res = await refreshVanillaApi(helper, pak, relpaths);
      // The game data changed — every cached roster/detail/browse is stale.
      clearDataCache();
      updateSettings({ vanillaRoot: res.vanillaRoot });
      const refreshedFiles = new Set(res.refreshed);

      const root = res.vanillaRoot.replace(/[/\\]+$/, "");
      const slots = proj.events.map((e) => ({
        eventsPath: `${root}/${e.eventsRelpath}`,
        eventName: e.eventName,
        arrayKey: e.arrayKey,
      }));
      const views = await readEventPools(slots);
      const map: Record<string, EventView> = {};
      proj.events.forEach((e, i) => {
        const v = views[i];
        if (v) map[e.id] = v;
      });

      // Reconcile every existing slot against the refreshed data.
      let corrected = 0; // drifted stock refs re-pinned
      let removedKept = 0; // event the patch deleted, but slot holds your content
      let removedUnused = 0; // event the patch deleted, slot was empty (safe)
      const removedNames: string[] = [];
      const reconciled: EventProject[] = [];
      for (const e of proj.events) {
        const view = map[e.id];
        // A null view means the event/array isn't in the file. Trust that as a
        // "removed by patch" signal ONLY when the file itself refreshed — a file
        // that failed to decompile also yields null, which is NOT a removal.
        if (!view && refreshedFiles.has(e.eventsRelpath)) {
          if (slotHasContent(e)) {
            removedKept++;
            removedNames.push(e.eventName);
            reconciled.push(e); // keep your content; compile just skips it
          } else if (isAutoSlot(e.id)) {
            removedUnused++; // drop a stale auto-discovered slot (nothing lost)
          } else {
            removedUnused++;
            reconciled.push(e); // keep curated default slots even when empty
          }
          continue;
        }
        // Re-pin the stock track to the live first entry (vanilla's first entry is
        // always the stock track). Leaves songs/adopted/exclusions untouched.
        const first = view?.entries?.[0];
        if (first && first !== e.stockEntry) {
          corrected++;
          reconciled.push({ ...e, stockEntry: first });
        } else {
          reconciled.push(e);
        }
      }

      // Auto-discover events a NEW patch added: enumerate every primary
      // vsnd_files event in the main files and diff against a stored baseline.
      // First run just seeds the baseline (no flood of ~300 stock events); later
      // runs route each new event to its home tab when the name/file family is
      // recognized, else into the "New / Unsorted" catch-all.
      let added = 0;
      const newAutoSlots: EventProject[] = [];
      let pendingBaseline: { knownSoundEvents: string[]; knownSweepFiles: string[] } | null =
        null;
      try {
        const discovered = await listEditableEvents(root, sweepFiles);
        const liveKeys = new Set(discovered.map((d) => `${d.eventsRelpath}::${d.eventName}`));
        const baseline = new Set(s.knownSoundEvents ?? []);
        const seeding = baseline.size === 0;
        // Files contributing to the baseline so far. On the full-pak sweep's
        // FIRST run (knownSweepFiles empty) unknown files seed silently — they
        // hold pre-existing stock events, and surfacing them would flood Misc
        // with hundreds of slots. After that, a file we've never swept means
        // the PATCH added it, so its events surface like any other new event.
        const baselineFiles = new Set(Array.from(baseline, (k) => k.split("::")[0]));
        const knownFiles = new Set(s.knownSweepFiles ?? []);
        // Events already represented by any slot (curated or auto) are never re-added.
        const slotted = new Set(reconciled.map((e) => `${e.eventsRelpath}::${e.eventName}`));
        if (!seeding) {
          for (const d of discovered) {
            const key = `${d.eventsRelpath}::${d.eventName}`;
            if (baseline.has(key) || slotted.has(key)) continue;
            const newPatchFile =
              knownFiles.size > 0 && !knownFiles.has(d.eventsRelpath);
            if (!baselineFiles.has(d.eventsRelpath) && !newPatchFile) continue;
            newAutoSlots.push({
              id: autoSlotId(d.eventsRelpath, d.eventName),
              group: routeGroupFor(d.eventsRelpath, d.eventName),
              side: eventLabel(d.eventName),
              eventName: d.eventName,
              arrayKey: "vsnd_files",
              stockEntry: d.stockEntry,
              vsndDurationMode: "auto",
              vsndDurationManual: null,
              songs: [],
              previousOwnedNames: [],
              excludedEntries: [],
              removedEntries: [],
              adopted: [],
              eventsRelpath: d.eventsRelpath,
            });
            slotted.add(key);
            added++;
          }
        }
        // Re-baseline to the current live set (so removed events drop out too,
        // and so a deleted auto slot doesn't keep re-appearing), and record
        // which files this sweep covered. Applied AFTER the project (with the
        // new slots) is persisted below — saving the baseline first would make
        // the new events permanently invisible if the app closed before the
        // debounced project autosave flushed.
        pendingBaseline = {
          knownSoundEvents: Array.from(liveKeys),
          knownSweepFiles: Array.from(new Set(sweepFiles)),
        };
        // Pool the new slots so they're immediately editable.
        if (newAutoSlots.length) {
          const newViews = await readEventPools(
            newAutoSlots.map((e) => ({
              eventsPath: `${root}/${e.eventsRelpath}`,
              eventName: e.eventName,
              arrayKey: e.arrayKey,
            })),
          );
          newAutoSlots.forEach((e, i) => {
            const v = newViews[i];
            if (v) map[e.id] = v;
          });
        }
        if (seeding) {
          push(
            "info",
            `Indexed ${liveKeys.size} game sound events - from the next patch on, brand-new events appear automatically under “New / Unsorted”.`,
          );
        }
      } catch (e) {
        // Discovery is best-effort; a failure must not break the core fix.
        push("error", `New-event discovery skipped: ${e}`);
      }

      const finalEvents = [...reconciled, ...newAutoSlots];
      setPools(map);
      // Merge into the CURRENT project rather than overwriting with the
      // snapshot-derived list: the fix runs for many seconds with the UI live,
      // so a slot the user edited mid-fix keeps their version (it only misses
      // this round's stock re-pin), slots created mid-fix survive, and a slot
      // the user deleted mid-fix stays deleted.
      const beforeById = new Map(proj.events.map((e) => [e.id, e]));
      const reconciledById = new Map(finalEvents.map((e) => [e.id, e]));
      setProject((prev) => {
        if (!prev) return prev;
        const next: EventProject[] = [];
        for (const p of prev.events) {
          const snap = beforeById.get(p.id);
          const rec = reconciledById.get(p.id);
          const untouched = !!snap && JSON.stringify(p) === JSON.stringify(snap);
          if (untouched) {
            if (rec) next.push(rec); // else: reconcile dropped it (removed by patch)
          } else {
            next.push(p); // edited or created while the fix ran - user wins
          }
        }
        const have = new Set(next.map((e) => e.id));
        for (const r of finalEvents) {
          // Append only genuinely new slots (discovery); ids the snapshot had
          // but prev lacks were deleted by the user mid-fix — leave them out.
          if (!have.has(r.id) && !beforeById.has(r.id)) next.push(r);
        }
        return { ...prev, events: next };
      });
      // Persist the project with the new slots FIRST, then commit the baseline
      // (see the pendingBaseline note above for why this order matters).
      const profileName = settingsRef.current.activeProfile;
      if (profileName) {
        await saveProfile(profileName, {
          project: { ...proj, events: finalEvents },
          importedMods: settingsRef.current.importedMods,
        });
      }
      if (pendingBaseline) updateSettings(pendingBaseline);

      const failNote = res.failed.length ? ` · ${res.failed.length} file(s) missing` : "";
      push(
        "success",
        `Fixed for patch: refreshed ${res.refreshed.length} file(s), re-pinned ${corrected} stock ref(s)` +
          (added ? ` · ${added} new event(s) → New/Unsorted` : "") +
          (removedUnused ? ` · cleaned ${removedUnused} removed unused event(s)` : "") +
          failNote,
      );
      if (removedKept > 0) {
        const shown = removedNames.slice(0, 4).join(", ");
        push(
          "info",
          `Heads up: ${removedKept} event(s) you've modded were removed in this patch (${shown}${removedNames.length > 4 ? "…" : ""}). Your tracks are kept, not deleted - they just won't apply until the event returns.`,
        );
      }
      return { events: finalEvents, vanillaRoot: root };
    } catch (e) {
      push("error", `Refresh failed: ${e}`);
      return null;
    }
  }

  // Best-effort auto-detect of tool/game paths; fills in what it finds.
  async function autodetect() {
    try {
      const d = await autodetectPaths();
      const patch: Partial<typeof settings> = {};
      if (d.csdkRoot) patch.csdkRoot = d.csdkRoot;
      if (d.deadlockPak) patch.deadlockPak = d.deadlockPak;
      if (d.addonsDir) patch.addonsDir = d.addonsDir;
      if (d.vpkHelper) patch.vpkHelperPath = d.vpkHelper;
      if (d.ffmpeg && d.ffmpeg !== "ffmpeg") patch.ffmpegPath = d.ffmpeg;
      const found = Object.keys(patch).length;
      if (found > 0) {
        updateSettings(patch);
        push("success", `Auto-detected ${found} path(s)`);
      } else {
        push("info", "Couldn't auto-detect any paths - set them manually");
      }
    } catch (e) {
      push("error", `Auto-detect failed: ${e}`);
    }
  }

  // First-run / one-click setup: detect tool+game paths, then pull the current
  // game's music data in as the merge base — so a new user is ready to compile
  // without typing any paths or supplying a ModFiles snapshot.
  async function runFirstSetup() {
    let helper = settingsRef.current.vpkHelperPath;
    let pak = settingsRef.current.deadlockPak;
    try {
      const d = await autodetectPaths();
      const patch: Partial<typeof settings> = {};
      if (d.csdkRoot) patch.csdkRoot = d.csdkRoot;
      if (d.deadlockPak) (patch.deadlockPak = d.deadlockPak), (pak = d.deadlockPak);
      if (d.addonsDir) patch.addonsDir = d.addonsDir;
      if (d.vpkHelper) (patch.vpkHelperPath = d.vpkHelper), (helper = d.vpkHelper);
      if (d.ffmpeg && d.ffmpeg !== "ffmpeg") patch.ffmpegPath = d.ffmpeg;
      if (Object.keys(patch).length) updateSettings(patch);
    } catch (e) {
      push("error", `Auto-detect failed: ${e}`);
    }
    // Pull live game music data in as the merge base (fixes the need for a local
    // ModFiles snapshot + drifted stock refs). Uses the just-detected paths.
    await refreshVanilla({ helper, pak });
  }

  // Decompile the given soundevents files into the vanilla merge base (once each),
  // so ability-sound pools can be read and merged. Points vanillaRoot at the
  // app-managed copy.
  /** Returns the (possibly refreshed) vanilla root, so callers that need to
   *  read it immediately don't race the async settings update. */
  async function ensureVanillaFiles(relpaths: string[]): Promise<string> {
    const s = settingsRef.current;
    const todo = relpaths.filter((r) => r && !ensuredFiles.current.has(r));
    if (todo.length === 0) return s.vanillaRoot;
    try {
      const res = await refreshVanillaApi(s.vpkHelperPath, s.deadlockPak, todo);
      todo.forEach((r) => ensuredFiles.current.add(r));
      if (res.vanillaRoot && res.vanillaRoot !== s.vanillaRoot) {
        updateSettings({ vanillaRoot: res.vanillaRoot });
      }
      return res.vanillaRoot || s.vanillaRoot;
    } catch (e) {
      push("error", `Couldn't load hero sound data: ${e}`);
      return s.vanillaRoot;
    }
  }

  // Ensure project slots exist for an ability's sound events (created empty;
  // pruned on next launch if still empty). Lets the user add sounds to them.
  // Returns the updated project (with any new slots) so the caller can read pools
  // for them immediately — setProject alone is async, so a load() right after
  // would otherwise miss the just-added slots and they'd show no stock sound.
  function ensureAbilitySlots(codename: string, ability: HeroAbility): Project | null {
    const prev = projectRef.current;
    if (!prev) return null;
    const have = new Set(prev.events.map((e) => e.id));
    const add: EventProject[] = [];
    for (const snd of ability.sounds) {
      const id = heroAbilSlotId(codename, snd.eventName);
      if (have.has(id)) continue;
      add.push({
        id,
        group: "heroes",
        side: snd.label,
        eventName: snd.eventName,
        arrayKey: snd.arrayKey,
        stockEntry: "",
        vsndDurationMode: "auto",
        vsndDurationManual: null,
        songs: [],
        previousOwnedNames: [],
        excludedEntries: [],
        removedEntries: [],
        adopted: [],
        eventsRelpath: snd.eventsRelpath,
      });
    }
    if (!add.length) return prev;
    const next = { ...prev, events: [...prev.events, ...add] };
    setProject(next);
    return next;
  }

  // Load a hero's abilities when selected; decompile its sound files into vanilla.
  useEffect(() => {
    setShowVoicelines(false);
    setVoicelines(null);
    setHeroSounds(null);
    if (!selectedHero) {
      setHeroAbilities(null);
      setSelectedAbility(null);
      return;
    }
    let cancelled = false;
    setHeroDetailLoading(true);
    setSelectedAbility(null);
    setHeroAbilities(null);
    (async () => {
      const s = settingsRef.current;
      try {
        const abilities = await heroDetailApi(
          s.vpkHelperPath,
          s.deadlockPak,
          selectedHero,
        );
        if (cancelled) return;
        setHeroAbilities(abilities);
        const relpaths = Array.from(
          new Set(abilities.flatMap((a) => a.sounds.map((x) => x.eventsRelpath))),
        );
        await ensureVanillaFiles(relpaths);
        if (!cancelled) void load();
      } catch (e) {
        if (!cancelled) push("error", `Couldn't load ${selectedHero}: ${e}`);
      } finally {
        if (!cancelled) setHeroDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHero]);

  // When an ability is opened, materialize its sound slots + read their pools.
  // load() is given the project that already includes the new slots so they get
  // their stock sound on the first open (not just after a later reload).
  useEffect(() => {
    if (!selectedHero || !selectedAbility || !heroAbilities) return;
    const ability = heroAbilities.find((a) => a.ability === selectedAbility);
    if (!ability) return;
    const next = ensureAbilitySlots(selectedHero, ability);
    void load(next ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHero, selectedAbility, heroAbilities]);

  // Load the selected hero's voicelines the first time the Voicelines view opens.
  useEffect(() => {
    if (!selectedHero || !showVoicelines || voicelines) return;
    let cancelled = false;
    setVoicelinesLoading(true);
    (async () => {
      const s = settingsRef.current;
      try {
        const lines = await heroVoicelinesApi(s.vpkHelperPath, s.deadlockPak, selectedHero);
        if (!cancelled) setVoicelines(lines);
      } catch (e) {
        if (!cancelled) push("error", `Couldn't load voicelines: ${e}`);
      } finally {
        if (!cancelled) setVoicelinesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHero, showVoicelines]);

  // Load the selected hero's non-VO sound set (gunfire/abilities/movement) for
  // the "More sounds" section. Cheap (one decompile + parse), cached per hero.
  useEffect(() => {
    if (!selectedHero) return;
    let cancelled = false;
    setHeroSoundsLoading(true);
    (async () => {
      const s = settingsRef.current;
      try {
        const list = await heroSoundsApi(s.vpkHelperPath, s.deadlockPak, selectedHero);
        if (!cancelled) setHeroSounds(list);
      } catch (e) {
        if (!cancelled) push("error", `Couldn't load hero sounds: ${e}`);
      } finally {
        if (!cancelled) setHeroSoundsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHero]);

  // Materialize a single voiceline's editor slot (lazy, on first expand) and
  // make sure its VO soundevents file is decompiled into the merge base.
  function ensureVoicelineSlot(codename: string, vl: VoiceLine): Project | null {
    const prev = projectRef.current;
    if (!prev) return null;
    const id = heroAbilSlotId(codename, vl.eventName);
    if (prev.events.some((e) => e.id === id)) return prev;
    const slot: EventProject = {
      id,
      group: "heroes",
      side: vl.label,
      eventName: vl.eventName,
      arrayKey: vl.arrayKey,
      stockEntry: "",
      vsndDurationMode: "auto",
      vsndDurationManual: null,
      songs: [],
      previousOwnedNames: [],
      excludedEntries: [],
      removedEntries: [],
      adopted: [],
      eventsRelpath: vl.eventsRelpath,
    };
    const next = { ...prev, events: [...prev.events, slot] };
    setProject(next);
    return next;
  }

  async function openVoiceline(vl: VoiceLine) {
    if (!selectedHero) return;
    await ensureVanillaFiles([vl.eventsRelpath]);
    const next = ensureVoicelineSlot(selectedHero, vl);
    void load(next ?? undefined);
  }

  // Materialize an item's sound slots (created empty, pruned if unused). Returns
  // the updated project so the caller can pool the new slots immediately.
  function ensureItemSlots(itemName: string, sounds: HeroAbilitySound[]): Project | null {
    const prev = projectRef.current;
    if (!prev) return null;
    const have = new Set(prev.events.map((e) => e.id));
    const add: EventProject[] = [];
    for (const snd of sounds) {
      const id = itemSndSlotId(itemName, snd.eventName);
      if (have.has(id)) continue;
      add.push({
        id,
        group: ITEMS,
        side: snd.label,
        eventName: snd.eventName,
        arrayKey: snd.arrayKey,
        stockEntry: "",
        vsndDurationMode: "auto",
        vsndDurationManual: null,
        songs: [],
        previousOwnedNames: [],
        excludedEntries: [],
        removedEntries: [],
        adopted: [],
        eventsRelpath: snd.eventsRelpath,
      });
    }
    if (!add.length) return prev;
    const next = { ...prev, events: [...prev.events, ...add] };
    setProject(next);
    return next;
  }

  // Load a selected item's sounds, decompile their files into vanilla, and
  // materialize the slots (all sounds shown at once — no sub-abilities).
  useEffect(() => {
    if (!selectedItem) {
      setItemSounds(null);
      return;
    }
    let cancelled = false;
    setItemDetailLoading(true);
    setItemSounds(null);
    (async () => {
      const s = settingsRef.current;
      try {
        const sounds = await itemDetailApi(s.vpkHelperPath, s.deadlockPak, selectedItem.name);
        if (cancelled) return;
        setItemSounds(sounds);
        const relpaths = Array.from(new Set(sounds.map((x) => x.eventsRelpath)));
        await ensureVanillaFiles(relpaths);
        if (cancelled) return;
        const next = ensureItemSlots(selectedItem.name, sounds);
        void load(next ?? undefined);
      } catch (e) {
        if (!cancelled) push("error", `Couldn't load ${selectedItem.displayName}: ${e}`);
      } finally {
        if (!cancelled) setItemDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem]);

  // Load the selected item's particle effects (for "open in viewer"). Skipped
  // unless the experimental Effects feature is on (the UI is hidden otherwise).
  useEffect(() => {
    if (!selectedItem || !settings.experimentalEffects) {
      setItemFx(null);
      return;
    }
    let cancelled = false;
    setItemFx(null);
    const s = settingsRef.current;
    itemParticles(s.vpkHelperPath, s.deadlockPak, selectedItem.name)
      .then((fx) => !cancelled && setItemFx(fx))
      .catch(() => !cancelled && setItemFx([]));
    return () => {
      cancelled = true;
    };
  }, [selectedItem, settings.experimentalEffects]);

  // Set a custom icon for an item: scale to the icon's native size on compile.
  async function setItemIcon(item: ItemCard, imagePath: string) {
    if (!item.iconInternal) {
      push("error", `No icon target for ${item.displayName}`);
      return;
    }
    const size = item.iconPath
      ? await imageNaturalSize(convertFileSrc(item.iconPath))
      : { w: 200, h: 200 };
    const id = `icon_${item.name}`;
    setProject((prev) => {
      if (!prev) return prev;
      // Keep any hue the user already dialed in when they swap the image.
      const prevHue = (prev.iconMods ?? []).find((m) => m.id === id)?.hue ?? 0;
      const mods = (prev.iconMods ?? []).filter((m) => m.id !== id);
      mods.push({
        id,
        name: item.displayName,
        targetVtexc: item.iconInternal!,
        sourceImage: imagePath,
        width: size.w,
        height: size.h,
        hue: prevHue,
      });
      return { ...prev, iconMods: mods };
    });
    push("success", `Custom icon set for ${item.displayName} - compile to apply`);
  }

  // Tick/untick an item's custom icon: kept in the project, excluded from the
  // compile when off (and the base icon shows again in previews).
  function toggleItemIconEnabled(itemName: string) {
    const id = `icon_${itemName}`;
    setProject((prev) =>
      prev
        ? {
            ...prev,
            iconMods: (prev.iconMods ?? []).map((m) =>
              m.id === id ? { ...m, enabled: m.enabled === false } : m,
            ),
          }
        : prev,
    );
  }

  // Live-adjust the hue of an item's custom icon (no-op if no icon is set yet).
  function setItemHue(itemName: string, hue: number) {
    const id = `icon_${itemName}`;
    setProject((prev) =>
      prev
        ? {
            ...prev,
            iconMods: (prev.iconMods ?? []).map((m) => (m.id === id ? { ...m, hue } : m)),
          }
        : prev,
    );
  }

  function removeItemIcon(itemName: string) {
    const id = `icon_${itemName}`;
    setProject((prev) =>
      prev ? { ...prev, iconMods: (prev.iconMods ?? []).filter((m) => m.id !== id) } : prev,
    );
  }

  // Click-to-pick an image file for the selected item's icon.
  async function pickItemIcon(item: ItemCard) {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });
      if (typeof sel === "string") await setItemIcon(item, sel);
    } catch (e) {
      push("error", `Couldn't pick image: ${e}`);
    }
  }

  // ---- Loose-file sound overrides (Replace Sounds tab) --------------------
  const AUDIO_PICK = [
    { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] },
  ];

  async function pickAudioFile(): Promise<string | null> {
    const sel = await openDialog({ multiple: false, filters: AUDIO_PICK });
    return typeof sel === "string" ? sel : null;
  }

  async function audioDuration(path: string): Promise<number> {
    try {
      return (await probeAudio(path, settings.ffmpegPath || undefined)).duration;
    } catch {
      return 0;
    }
  }

  // Start a replacement for a game sound: pick audio, create the override.
  async function replaceSound(reference: string, label: string) {
    try {
      const sel = await pickAudioFile();
      if (!sel) return;
      const dur = await audioDuration(sel);
      const id = `snd_${reference.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      // Valve's looping sounds carry an `_lp` marker in the file name (they
      // compile with a loop block) — replacing one should loop by default or
      // the ambience/engine/whatever cuts out after one play.
      const looping = /_lp(_|\.|$)/i.test(reference);
      setProject((prev) => {
        if (!prev) return prev;
        const list = (prev.soundOverrides ?? []).filter((o) => o.targetRef !== reference);
        list.push({
          id,
          targetRef: reference,
          label,
          sourceAudio: sel,
          trimStart: 0,
          trimEnd: dur || 0,
          gainDb: 0,
          fadeIn: 0,
          fadeOut: 0,
          looping,
          lastCompiledHash: null,
        });
        return { ...prev, soundOverrides: list };
      });
      push("success", `Replacement set for ${label} - compile to apply`);
    } catch (e) {
      push("error", `Couldn't pick audio: ${e}`);
    }
  }

  function updateOverride(id: string, patch: Partial<SoundOverride>) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            soundOverrides: (prev.soundOverrides ?? []).map((o) =>
              o.id === id ? { ...o, ...patch, lastCompiledHash: null } : o,
            ),
          }
        : prev,
    );
  }

  function removeOverrideByRef(reference: string) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            soundOverrides: (prev.soundOverrides ?? []).filter((o) => o.targetRef !== reference),
          }
        : prev,
    );
  }

  // Swap the source audio file for an existing override.
  async function pickOverrideFile(o: SoundOverride) {
    try {
      const sel = await pickAudioFile();
      if (!sel) return;
      const dur = await audioDuration(sel);
      updateOverride(o.id, { sourceAudio: sel, trimStart: 0, trimEnd: dur || o.trimEnd });
    } catch (e) {
      push("error", `Couldn't pick audio: ${e}`);
    }
  }

  // ---- VFX recolor overrides (Effects tab) --------------------------------
  function addEffectOverride(reference: string, label: string) {
    const id = `fx_${reference.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    setProject((prev) => {
      if (!prev) return prev;
      if ((prev.effectOverrides ?? []).some((e) => e.targetRef === reference)) return prev;
      return {
        ...prev,
        effectOverrides: [
          ...(prev.effectOverrides ?? []),
          { id, targetRef: reference, label, hue: 0, saturation: 1, mode: "static", lastCompiledHash: null },
        ],
      };
    });
  }

  function updateEffectOverride(reference: string, patch: Partial<EffectOverride>) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            effectOverrides: (prev.effectOverrides ?? []).map((e) =>
              e.targetRef === reference ? { ...e, ...patch, lastCompiledHash: null } : e,
            ),
          }
        : prev,
    );
  }

  function removeEffectOverride(reference: string) {
    setProject((prev) =>
      prev
        ? { ...prev, effectOverrides: (prev.effectOverrides ?? []).filter((e) => e.targetRef !== reference) }
        : prev,
    );
  }

  // Posters tab: upsert / patch / remove one poster-art replacement.
  function addPosterOverride(ov: PosterOverride) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            posterOverrides: [...(prev.posterOverrides ?? []).filter((p) => p.id !== ov.id), ov],
          }
        : prev,
    );
  }

  function updatePosterOverride(id: string, patch: Partial<PosterOverride>) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            posterOverrides: (prev.posterOverrides ?? []).map((p) =>
              p.id === id ? { ...p, ...patch, lastCompiledHash: null } : p,
            ),
          }
        : prev,
    );
  }

  function removePosterOverride(id: string) {
    setProject((prev) =>
      prev
        ? { ...prev, posterOverrides: (prev.posterOverrides ?? []).filter((p) => p.id !== id) }
        : prev,
    );
  }

  // Gameplay config (Custom Server tab): upsert/clear one ability-property edit.
  function setVdataOverride(abilityKey: string, propKey: string, value: string) {
    setProject((prev) => {
      if (!prev) return prev;
      const list = prev.vdataOverrides ?? [];
      const idx = list.findIndex((o) => o.abilityKey === abilityKey && o.propKey === propKey);
      const next = idx >= 0 ? list.map((o, i) => (i === idx ? { ...o, value } : o)) : [...list, { abilityKey, propKey, value }];
      return { ...prev, vdataOverrides: next };
    });
  }

  function clearVdataOverride(abilityKey: string, propKey: string) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            vdataOverrides: (prev.vdataOverrides ?? []).filter(
              (o) => !(o.abilityKey === abilityKey && o.propKey === propKey),
            ),
          }
        : prev,
    );
  }

  // Global match-wide stats (Custom Server → Global): upsert/clear by field key.
  function setGlobalOverride(key: string, value: string) {
    setProject((prev) => {
      if (!prev) return prev;
      const list = prev.globalOverrides ?? [];
      const idx = list.findIndex((o) => o.key === key);
      const next = idx >= 0 ? list.map((o, i) => (i === idx ? { ...o, value } : o)) : [...list, { key, value }];
      return { ...prev, globalOverrides: next };
    });
  }

  function clearGlobalOverride(key: string) {
    setProject((prev) =>
      prev ? { ...prev, globalOverrides: (prev.globalOverrides ?? []).filter((o) => o.key !== key) } : prev,
    );
  }

  // World entities (Custom Server → Minions/Boxes/Powerups): upsert/clear by
  // (file, entity, field).
  function setWorldOverride(file: string, entity: string, field: string, value: string) {
    setProject((prev) => {
      if (!prev) return prev;
      const list = prev.worldOverrides ?? [];
      const idx = list.findIndex((o) => o.file === file && o.entity === entity && o.field === field);
      const next = idx >= 0 ? list.map((o, i) => (i === idx ? { ...o, value } : o)) : [...list, { file, entity, field, value }];
      return { ...prev, worldOverrides: next };
    });
  }

  function clearWorldOverride(file: string, entity: string, field: string) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            worldOverrides: (prev.worldOverrides ?? []).filter(
              (o) => !(o.file === file && o.entity === entity && o.field === field),
            ),
          }
        : prev,
    );
  }

  // Randomize EVERY gameplay number (abilities, items, global). Replaces all
  // current gameplay edits and auto-enables the include-in-build toggle.
  const [randomizing, setRandomizing] = useState(false);
  async function randomizeGameplay(temperature = 0.5) {
    if (!settings.vpkHelperPath || !settings.deadlockPak) {
      push("error", "Set the VPK helper and game pak in Setup first");
      return;
    }
    setRandomizing(true);
    try {
      const rolled = await randomizeConfig(settings.vpkHelperPath, settings.deadlockPak, temperature, settings.randomizer);
      setProject((prev) =>
        prev ? { ...prev, vdataOverrides: rolled.vdata, globalOverrides: rolled.global, worldOverrides: rolled.world } : prev,
      );
      updateSettings({ includeGameplay: true });
      const n = rolled.vdata.length + rolled.global.length + rolled.world.length;
      push("success", `Randomized ${n} values`);
    } catch (e) {
      push("error", `Randomize failed: ${e}`);
    } finally {
      setRandomizing(false);
    }
  }

  // Clear all gameplay + global edits (back to vanilla).
  function resetGameplay() {
    setProject((prev) => (prev ? { ...prev, vdataOverrides: [], globalOverrides: [], worldOverrides: [] } : prev));
    push("info", "Gameplay config reset to default");
  }

  // "Open in real viewer": launch VRF's Source2Viewer on the particle (extracted
  // from the pak). Needs the viewer path set in Setup.
  async function openEffectInViewer(reference: string) {
    const viewer = settings.source2ViewerPath;
    if (!viewer) {
      push("info", "Set the Source2Viewer path in Setup to open effects in the real viewer.");
      return;
    }
    try {
      await openInViewer(viewer, settings.vpkHelperPath, settings.deadlockPak, reference);
    } catch (e) {
      push("error", `Couldn't open viewer: ${e}`);
    }
  }

  const visibleSlots = (project?.events ?? []).filter(
    (e) => e.group === activeTab && (!modifiedOnly || slotHasContent(e)),
  );
  const songCount = (project?.events ?? []).reduce((n, e) => n + e.songs.length, 0);

  /** Whether a tab carries any of the user's changes (drives "modified only"). */
  const groupModified = (g: string): boolean => {
    const p = project;
    if (!p) return false;
    if (g === MOD_COMBINER) return settings.importedMods.length > 0;
    if (g === REPLACE_SOUNDS) return (p.soundOverrides ?? []).length > 0;
    if (g === EFFECTS) return (p.effectOverrides ?? []).length > 0;
    if (g === CUSTOM_SERVER)
      return (
        (p.vdataOverrides ?? []).length > 0 ||
        (p.globalOverrides ?? []).length > 0 ||
        (p.worldOverrides ?? []).length > 0
      );
    if (g === ITEMS)
      return (
        (p.iconMods ?? []).length > 0 ||
        p.events.some((e) => e.id.startsWith(ITEM_SLOT_PREFIX) && slotHasContent(e))
      );
    return p.events.some((e) => e.group === g && slotHasContent(e));
  };

  /** Grid filters for "modified only": which heroes / items carry changes. */
  const heroModified = (codename: string): boolean =>
    (project?.events ?? []).some(
      (e) => e.id.startsWith(`${HERO_SLOT_PREFIX}${codename}_`) && slotHasContent(e),
    );
  const itemModified = (name: string): boolean =>
    (project?.iconMods ?? []).some((m) => m.id === `icon_${name}`) ||
    (project?.events ?? []).some(
      (e) => e.id.startsWith(`${ITEM_SLOT_PREFIX}${name}_`) && slotHasContent(e),
    );

  // Manual override for the routing heuristics: move an auto/import slot to a
  // different tab. Slot ids never encode the group, so everything (songs,
  // adopted entries, exclusions) moves with it.
  function moveSlotToTab(slotId: string, group: string) {
    setProject((prev) =>
      prev
        ? { ...prev, events: prev.events.map((e) => (e.id === slotId ? { ...e, group } : e)) }
        : prev,
    );
    push("success", `Moved to ${TAB_LABELS[group] ?? group}`);
  }

  // One SidePanel for a slot, with all its handlers wired (shared by the normal
  // tabs and the Heroes drill-in).
  const renderPanel = (ev: EventProject) => (
    <SidePanel
      key={ev.id}
      ev={ev}
      onPasteSong={pasteSong}
      view={pools[ev.id]}
      moveTargets={isAutoSlot(ev.id) || isImportSlot(ev.id) ? MOVE_TARGETS : undefined}
      onMoveToTab={moveSlotToTab}
      soundFolder={slotSoundFolder(ev, settings.soundFolder)}
      ffmpegPath={settings.ffmpegPath || undefined}
      accent={accentFor(ev)}
      compareByDefault={settings.compareByDefault}
      dropActive={dropTarget === ev.id}
      expandedSongs={expandedSongs}
      onToggleSongExpanded={toggleSongExpanded}
      panelRef={(el) => (panelEls.current[ev.id] = el)}
      onSongChange={updateSong}
      onSongRename={renameSong}
      onSongRemove={removeSong}
      onReorderSongs={reorderSongs}
      onToggleEntry={toggleEntry}
      onRemoveEntry={removeEntry}
      onRestoreEntry={restoreEntry}
      onDecodeStock={decodeStock}
      onEditAdopted={editAdopted}
      onDownloadEntry={downloadEntryTo}
      onDownloadSong={downloadSong}
      missingRefs={missingSoundRefs}
    />
  );

  // One ability-sound slot, rendered as a panel once its (lazily-created) project
  // slot exists.
  const renderSound = (sound: { eventName: string; label: string }) => {
    const id = selectedHero ? heroAbilSlotId(selectedHero, sound.eventName) : "";
    const slot = project?.events.find((e) => e.id === id);
    if (!slot) {
      return (
        <div key={id || sound.eventName} className="text-xs text-zinc-600">
          preparing {sound.label}…
        </div>
      );
    }
    return renderPanel(slot);
  };

  // Same, for the selected shop item's sound slots.
  const renderItemSound = (sound: { eventName: string; label: string }) => {
    const id = selectedItem ? itemSndSlotId(selectedItem.name, sound.eventName) : "";
    const slot = project?.events.find((e) => e.id === id);
    if (!slot) {
      return (
        <div key={id || sound.eventName} className="text-xs text-zinc-600">
          preparing {sound.label}…
        </div>
      );
    }
    return renderPanel(slot);
  };

  // Track count for a tab (imported-mod count for the combiner, else songs).
  const tabCount = (g: string): number =>
    g === MOD_COMBINER
      ? settings.importedMods.length
      : g === REPLACE_SOUNDS
        ? (project?.soundOverrides ?? []).length
        : g === EFFECTS
          ? (project?.effectOverrides ?? []).length
          : (project?.events ?? [])
              .filter((e) => e.group === g)
              .reduce((n, e) => n + e.songs.length, 0);

  // Update check on launch: when a newer release exists, a prompt offers
  // one-click install (download installer → run → app exits); the sidebar
  // chip stays available if dismissed. Never nags on network errors.
  const [appUpdate, setAppUpdate] = useState<AppUpdate | null>(null);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    checkAppUpdate()
      .then((u) => {
        setAppUpdate(u);
        if (u) setUpdatePromptOpen(true);
      })
      .catch(() => {});
  }, []);
  async function runAppUpdate() {
    if (!appUpdate) return;
    if (!appUpdate.setupAsset) {
      void openUrl(appUpdate.url);
      return;
    }
    setUpdating(true);
    try {
      // On success the app exits and the installer takes over.
      await installAppUpdate(appUpdate.setupAsset);
    } catch (e) {
      push("error", `Update failed: ${e} - opening the release page instead`);
      void openUrl(appUpdate.url);
      setUpdating(false);
    }
  }

  // Boot animation: on a fresh launch the sidebar slides open and its entries
  // cascade in. `booted` flips once the show is over so later re-renders
  // (new tabs, count changes) don't replay it.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setBooted(true), 1800);
    return () => clearTimeout(t);
  }, []);
  const bootCls = booted ? "" : " eim-boot-item";
  const bootStyle = (i: number): React.CSSProperties | undefined =>
    booted ? undefined : { animationDelay: `${0.35 + i * 0.05}s` };

  // One sidebar tab button (indented when nested under a parent category).
  // Heroes/Items get their own tint (like the sky ♪ Sound master) so the big
  // three sections read at a glance: mint / orange / sky.
  const renderTabButton = (g: string, indented: boolean, bootIdx?: number) => {
    const count = tabCount(g);
    const active = g === activeTab;
    const tint =
      !indented && (g === "heroes" || g === ITEMS || g === POSTERS)
        ? accentFor({ group: g, side: "" })
        : null;
    if (tint) {
      return (
        <button
          key={g}
          onClick={() => setActiveTab(g)}
          style={{
            ...(bootIdx !== undefined ? bootStyle(bootIdx) : {}),
            borderColor: active ? `${tint}80` : `${tint}33`,
            backgroundColor: active ? `${tint}1f` : `${tint}0d`,
            color: tint,
          }}
          className={`mt-1 flex items-center justify-between rounded-lg border px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-widest transition hover:brightness-125 ${
            bootIdx !== undefined ? bootCls : ""
          }`}
        >
          <span>{TAB_LABELS[g] ?? g}</span>
          {count > 0 && (
            <span
              style={{ backgroundColor: `${tint}26`, color: tint }}
              className="rounded px-1.5 text-[10px] font-semibold"
            >
              {count}
            </span>
          )}
        </button>
      );
    }
    return (
      <button
        key={g}
        onClick={() => setActiveTab(g)}
        style={bootIdx !== undefined ? bootStyle(bootIdx) : undefined}
        className={`flex items-center justify-between rounded-lg py-2 pr-3 text-left text-sm transition ${
          bootIdx !== undefined ? bootCls : ""
        } ${indented ? "pl-3" : "px-3"} ${
          active
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        }`}
      >
        <span className="flex items-center gap-2">
          {indented && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: accentFor({ group: g, side: "" }) }}
            />
          )}
          {TAB_LABELS[g] ?? g}
        </span>
        {count > 0 && (
          <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
            {count}
          </span>
        )}
      </button>
    );
  };

  // One collapsible category header + its member tabs (top-level or nested
  // inside the ♪ Sound master). Returns null when modified-only hides it all.
  const renderCategory = (
    item: { label: string; tabs: string[] },
    bootIdx?: number,
  ): React.ReactNode => {
    const memberTabs = modifiedOnly
      ? item.tabs.filter((t) => groupModified(t) || t === activeTab)
      : item.tabs;
    if (modifiedOnly && memberTabs.length === 0) return null;
    const collapsed = collapsedCats.has(item.label);
    const catCount = memberTabs.reduce((n, t) => n + tabCount(t), 0);
    const hasActive = item.tabs.includes(activeTab);
    return (
      <div
        key={item.label}
        className={`flex flex-col gap-1${bootIdx !== undefined ? bootCls : ""}`}
        style={bootIdx !== undefined ? bootStyle(bootIdx) : undefined}
      >
        <button
          onClick={() =>
            setCollapsedCats((prev) => {
              const next = new Set(prev);
              if (next.has(item.label)) next.delete(item.label);
              else next.add(item.label);
              return next;
            })
          }
          className={`mt-1 flex items-center justify-between rounded-lg border px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-widest transition ${
            hasActive
              ? "border-zinc-700 bg-zinc-900 text-zinc-100"
              : "border-zinc-800/80 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          }`}
        >
          <span className="flex items-center gap-1.5">
            <span
              className={`text-[9px] text-zinc-600 transition-transform duration-200 ${
                collapsed ? "" : "rotate-90"
              }`}
            >
              ▶
            </span>
            {item.label}
          </span>
          {catCount > 0 && (
            <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
              {catCount}
            </span>
          )}
        </button>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="ml-3 flex flex-col gap-1 border-l border-zinc-800/70 pl-1.5">
                {memberTabs.map((t) => renderTabButton(t, true))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Animated backdrop for the content pane (the opaque sidebar covers its
          own strip). Swap the placeholder inside Backdrop for the game-style
          animation when it lands. */}
      <Backdrop accent={accentFor({ group: activeTab, side: "" })} />
      {/* Left sidebar: brand + tabs — fixed, never scrolls. Opaque so the
          backdrop animation only shows through the main content area.
          Width is user-adjustable via the drag handle on its right edge. */}
      <aside
        style={{ width: sidebarW }}
        className={`relative z-30 flex h-screen shrink-0 flex-col gap-1 border-r border-zinc-800 bg-zinc-950 p-4${
          booted ? "" : " eim-boot-aside"
        }`}
      >
        {/* Resize handle: drag to adjust, double-click to reset. */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = sidebarW;
            const move = (ev: MouseEvent) => {
              setSidebarW(Math.min(420, Math.max(176, startW + ev.clientX - startX)));
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
              setSidebarW((w) => {
                localStorage.setItem("eim:sidebarW", String(w));
                return w;
              });
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
          onDoubleClick={() => {
            setSidebarW(208);
            localStorage.setItem("eim:sidebarW", "208");
          }}
          title="Drag to resize the sidebar (double-click to reset)"
          className="absolute -right-1 top-0 z-40 h-full w-2 cursor-col-resize transition-colors hover:bg-emerald-500/25 active:bg-emerald-500/40"
        />
        <div className={`my-3 mb-4${bootCls}`} style={bootStyle(0)}>
          <img
            src="/MMMlogo.svg"
            alt="Moonah's Mod Maker"
            title="Moonah's Mod Maker"
            className="mx-auto h-16 w-auto max-w-full"
            draggable={false}
          />
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {navItems.map((item, navIdx) => {
            if (item.type === "tab") {
              if (modifiedOnly && !groupModified(item.key) && item.key !== activeTab) return null;
              return renderTabButton(item.key, false, navIdx + 2);
            }
            if (item.type === "category") return renderCategory(item, navIdx + 2);
            // ♪ Sound master: one colored parent over every sound-event
            // category/tab (the "this whole block is sounds" divider).
            const allTabs = item.items.flatMap((c) => (c.type === "tab" ? [c.key] : c.tabs));
            const visibleTabs = modifiedOnly
              ? allTabs.filter((t) => groupModified(t) || t === activeTab)
              : allTabs;
            if (modifiedOnly && visibleTabs.length === 0) return null;
            const collapsed = collapsedCats.has(item.label);
            const soundCount = visibleTabs.reduce((n, t) => n + tabCount(t), 0);
            const hasActive = allTabs.includes(activeTab);
            return (
              <div
                key={item.label}
                className={`flex flex-col gap-1${bootCls}`}
                style={bootStyle(navIdx + 2)}
              >
                <button
                  onClick={() =>
                    setCollapsedCats((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.label)) next.delete(item.label);
                      else next.add(item.label);
                      return next;
                    })
                  }
                  className={`mt-1 flex items-center justify-between rounded-lg border px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-widest transition ${
                    hasActive
                      ? "border-sky-500/50 bg-sky-500/10 text-sky-100"
                      : "border-sky-500/25 bg-sky-500/5 text-sky-300/90 hover:border-sky-400/50 hover:text-sky-200"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`text-[9px] text-sky-500/80 transition-transform duration-200 ${
                        collapsed ? "" : "rotate-90"
                      }`}
                    >
                      ▶
                    </span>
                    {item.label}
                  </span>
                  {soundCount > 0 && (
                    <span className="rounded bg-sky-500/15 px-1.5 text-[10px] font-semibold text-sky-300">
                      {soundCount}
                    </span>
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {!collapsed && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="overflow-hidden"
                    >
                      <div className="ml-3 flex flex-col gap-1 border-l border-sky-500/25 pl-1.5">
                        {item.items.map((c) =>
                          c.type === "tab" ? (
                            (!modifiedOnly || groupModified(c.key) || c.key === activeTab) &&
                              renderTabButton(c.key, true)
                          ) : (
                            renderCategory(c)
                          ),
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </nav>
        <div
          className={`mt-auto flex items-center justify-between pt-2${bootCls}`}
          style={bootStyle(navItems.length + 2)}
        >
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
          >
            <span className="text-base">⚙</span>
            <span>Settings</span>
          </button>
          {appUpdate ? (
            <button
              onClick={() => setUpdatePromptOpen(true)}
              title={`You have v${appUpdate.current} - v${appUpdate.latest} is out`}
              className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300 transition hover:bg-violet-500/25"
            >
              ⬆ v{appUpdate.latest} available
            </button>
          ) : (
            <span className="text-[10px] text-zinc-700">
              {songCount} track{songCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </aside>

      {/* Main content: a fixed-height column — the tab content scrolls in the
          inner pane and the CompileBar is a real (non-scrolling) footer, so
          there's no sticky/negative-margin gap under it. (relative so it
          paints above the fixed backdrop layer) */}
      <main className="relative flex h-screen min-w-0 flex-1 flex-col">
        <div ref={mainRef} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6 pb-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="bg-gradient-to-r from-zinc-50 to-zinc-400 bg-clip-text text-xl font-bold tracking-tight text-transparent">
              {TAB_LABELS[activeTab] ?? activeTab}
            </h2>
            {/* Only the specialty tabs get a one-line explainer; the regular
                sound tabs speak for themselves. */}
            {(() => {
              const sub =
                activeTab === MOD_COMBINER
                  ? "Merge other mods' sounds into your compile - nothing of yours is removed."
                  : activeTab === REPLACE_SOUNDS
                    ? "Replace any game sound directly by its file - no soundevents touched. Browse a category, preview, then drop in your audio."
                    : activeTab === EFFECTS
                      ? "Recolor any particle effect - hero abilities, item effects, and more. Preview the recolor live, then compile to apply."
                      : activeTab === POSTERS
                        ? "Replace the world's posters, signs, ghost signs, and graffiti with your own images - drop a PNG onto a region and compile."
                        : activeTab === JUMPSCARES
                          ? "Random jumpscares while you play + videos when you die - your DigiMaster mod, configured here and rebuilt on compile."
                          : activeTab === UIMASTER
                            ? "Edit the game's UI files directly - decompiled to source, compiled back into your mod. Very experimental."
                            : null;
              return sub ? <p className="mt-1 text-sm text-zinc-500">{sub}</p> : null;
            })()}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* "Modified only": hide everything without your changes. */}
            <button
              onClick={() => setModifiedOnly((v) => !v)}
              title="Show only the tabs, heroes, items and slots that carry your changes"
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                modifiedOnly
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
              }`}
            >
              <span className="text-[10px]">{modifiedOnly ? "◉" : "○"}</span>
              Modified only
            </button>
          {profiles.length > 0 && (
            <ProfileSwitcher
              profiles={profiles}
              active={settings.activeProfile}
              vanillaName={VANILLA_NAME}
              busy={profileBusy}
              onSwitch={(n) => void switchProfile(n)}
              onCreate={(n) => void createProfile(n)}
              onDuplicate={(n) => void duplicateProfile(n)}
              onRename={(n) => void renameActiveProfile(n)}
              onDelete={() => void deleteActiveProfile()}
            />
          )}
          </div>
        </header>

        {/* Tab content, keyed so switching tabs fades the new content in. */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="flex flex-col gap-5"
        >
        {activeTab === MOD_COMBINER ? (
          <ImportedMods
            settings={settings}
            update={updateSettings}
            onImportPack={startPackImport}
            digimod={project?.digimod ?? null}
            onDigimodChange={(next) =>
              setProject((prev) => (prev ? { ...prev, digimod: next } : prev))
            }
          />
        ) : activeTab === GAMEBANANA ? (
          <GameBananaBrowser
            settings={settings}
            update={updateSettings}
            onImportPack={startPackImport}
            onBundleMany={(vpks) => {
              const cur = settingsRef.current.importedMods;
              const next = [...cur];
              for (const v of vpks) if (!next.includes(v)) next.push(v);
              updateSettings({ importedMods: next });
            }}
          />
        ) : activeTab === ITEMS ? (
          <ItemsTab
            helperPath={settings.vpkHelperPath}
            pakPath={settings.deadlockPak}
            selected={selectedItem}
            onSelect={setSelectedItem}
            onBack={() => setSelectedItem(null)}
            sounds={itemSounds}
            loading={itemDetailLoading}
            renderSound={renderItemSound}
            customIconSource={
              selectedItem
                ? (project?.iconMods ?? []).find((m) => m.id === `icon_${selectedItem.name}`)
                    ?.sourceImage ?? null
                : null
            }
            customHue={
              selectedItem
                ? (project?.iconMods ?? []).find((m) => m.id === `icon_${selectedItem.name}`)
                    ?.hue ?? 0
                : 0
            }
            iconEnabled={
              selectedItem
                ? (project?.iconMods ?? []).find((m) => m.id === `icon_${selectedItem.name}`)
                    ?.enabled !== false
                : true
            }
            onToggleIconEnabled={() =>
              selectedItem && toggleItemIconEnabled(selectedItem.name)
            }
            customIcons={customItemIcons}
            onHueChange={(hue) => selectedItem && setItemHue(selectedItem.name, hue)}
            onPickIcon={() => selectedItem && void pickItemIcon(selectedItem)}
            onRemoveIcon={() => selectedItem && removeItemIcon(selectedItem.name)}
            experimentalEffects={settings.experimentalEffects}
            effects={itemFx}
            onOpenEffectViewer={(ref) => void openEffectInViewer(ref)}
            onRecolorEffect={() => setActiveTab(EFFECTS)}
            modifiedFilter={modifiedOnly ? itemModified : null}
          />
        ) : activeTab === REPLACE_SOUNDS ? (
          <SoundBrowser
            helperPath={settings.vpkHelperPath}
            pakPath={settings.deadlockPak}
            categories={SOUND_CATEGORIES}
            overrides={project?.soundOverrides ?? []}
            modifiedOnly={modifiedOnly}
            accent="#f472b6"
            onPreview={(ref) => decodeStock(ref)}
            onReplace={(ref, label) => void replaceSound(ref, label)}
            onRemoveOverride={removeOverrideByRef}
            onDownloadMany={downloadManyEntries}
            renderEditor={(o) => (
              <OverrideEditor
                override={o}
                onChange={(patch) => updateOverride(o.id, patch)}
                onPickFile={() => void pickOverrideFile(o)}
              />
            )}
          />
        ) : activeTab === CUSTOM_SERVER ? (
          <CustomServer
            helperPath={settings.vpkHelperPath}
            pakPath={settings.deadlockPak}
            deadlockRoot={
              settings.deadlockPak
                ? settings.deadlockPak.replace(/[\\/]/g, "/").split("/").slice(0, -3).join("/")
                : ""
            }
            showExperimental={settings.showExperimentalHeroes}
            includeGameplay={settings.includeGameplay}
            onToggleGameplay={(on) => updateSettings({ includeGameplay: on })}
            excludedKeys={settings.excludedConfigKeys}
            onSetExcluded={(keys, excluded) => {
              const cur = new Set(settings.excludedConfigKeys);
              if (excluded) keys.forEach((k) => cur.add(k));
              else keys.forEach((k) => cur.delete(k));
              updateSettings({ excludedConfigKeys: [...cur] });
            }}
            overrides={project?.vdataOverrides ?? []}
            onSet={setVdataOverride}
            onClear={clearVdataOverride}
            globalOverrides={project?.globalOverrides ?? []}
            onSetGlobal={setGlobalOverride}
            onClearGlobal={clearGlobalOverride}
            worldOverrides={project?.worldOverrides ?? []}
            onSetWorld={setWorldOverride}
            onClearWorld={clearWorldOverride}
            onRandomize={randomizeGameplay}
            onReset={resetGameplay}
            randomizing={randomizing}
            randomizerOpts={settings.randomizer}
            onSetRandomizerOpts={(patch) =>
              updateSettings({ randomizer: { ...settings.randomizer, ...patch } })
            }
          />
        ) : activeTab === EFFECTS ? (
          <EffectsBrowser
            helperPath={settings.vpkHelperPath}
            pakPath={settings.deadlockPak}
            categories={PARTICLE_CATEGORIES}
            overrides={project?.effectOverrides ?? []}
            accent="#c084fc"
            onAdd={addEffectOverride}
            onUpdate={updateEffectOverride}
            onRemove={removeEffectOverride}
            onOpenViewer={(ref) => void openEffectInViewer(ref)}
          />
        ) : activeTab === UIMASTER ? (
          <UiMasterTab
            settings={settings}
            overrides={project?.uiOverrides ?? []}
            onChange={(next) =>
              setProject((prev) => (prev ? { ...prev, uiOverrides: next } : prev))
            }
          />
        ) : activeTab === JUMPSCARES ? (
          <DigimodTab
            config={project?.digimod ?? DEFAULT_DIGIMOD}
            addonsDir={settings.addonsDir}
            helperPath={settings.vpkHelperPath}
            ffmpegPath={settings.ffmpegPath}
            onChange={(next) => setProject((prev) => (prev ? { ...prev, digimod: next } : prev))}
          />
        ) : activeTab === POSTERS ? (
          <PostersTab
            helperPath={settings.vpkHelperPath}
            pakPath={settings.deadlockPak}
            overrides={project?.posterOverrides ?? []}
            accent="#8b5cf6"
            rectEdits={settings.posterRectEdits}
            hidden={settings.posterHidden}
            hiddenSheets={settings.posterHiddenSheets}
            showUnused={settings.showUnusedPosters}
            customRegions={settings.posterCustomRegions}
            onCustomChange={(sheetId, regions) => {
              updateSettings({
                posterCustomRegions: {
                  ...settingsRef.current.posterCustomRegions,
                  [sheetId]: regions,
                },
              });
            }}
            onAdd={addPosterOverride}
            onUpdate={updatePosterOverride}
            onRemove={removePosterOverride}
            onRectEdit={(id, rect) => {
              const edits = { ...settingsRef.current.posterRectEdits };
              if (rect) edits[id] = rect;
              else delete edits[id];
              updateSettings({ posterRectEdits: edits });
            }}
            onToggleHidden={(id) => {
              const cur = settingsRef.current.posterHidden;
              updateSettings({
                posterHidden: cur.includes(id) ? cur.filter((h) => h !== id) : [...cur, id],
              });
            }}
            onToggleSheetHidden={(sheetId) => {
              const cur = settingsRef.current.posterHiddenSheets;
              updateSettings({
                posterHiddenSheets: cur.includes(sheetId)
                  ? cur.filter((s) => s !== sheetId)
                  : [...cur, sheetId],
              });
            }}
            registerDropHandler={(fn) => {
              posterDropRef.current = fn;
            }}
          />
        ) : activeTab === "heroes" ? (
          selectedHero && showVoicelines ? (
            <VoicelinesPanel
              heroName={selectedHeroInfo?.displayName ?? selectedHero}
              accent={selectedHeroInfo?.color ?? "#e0564f"}
              voicelines={voicelines}
              loading={voicelinesLoading}
              onBack={() => setShowVoicelines(false)}
              onPreview={(ref) => decodeStock(ref)}
              onOpen={(vl) => void openVoiceline(vl)}
              renderSound={renderSound}
              hasContent={(name) => {
                if (!selectedHero) return false;
                const slot = project?.events.find(
                  (e) => e.id === heroAbilSlotId(selectedHero, name),
                );
                return !!slot && slotHasContent(slot);
              }}
              modifiedFilter={
                modifiedOnly && selectedHero
                  ? (name) => {
                      const slot = project?.events.find(
                        (e) => e.id === heroAbilSlotId(selectedHero, name),
                      );
                      return !!slot && slotHasContent(slot);
                    }
                  : null
              }
            />
          ) : selectedHero ? (
            <HeroDetail
              heroName={selectedHeroInfo?.displayName ?? selectedHero}
              backgroundSrc={selectedHeroInfo?.portraitPath ?? null}
              accent={selectedHeroInfo?.color ?? "#e0564f"}
              accent2={selectedHeroInfo?.colorSecondary ?? selectedHeroInfo?.color ?? "#e0564f"}
              abilities={heroAbilities}
              loading={heroDetailLoading}
              selectedAbility={selectedAbility}
              onSelectAbility={setSelectedAbility}
              onShowVoicelines={() => setShowVoicelines(true)}
              onBack={() => {
                setSelectedHero(null);
                setSelectedHeroInfo(null);
              }}
              renderSound={renderSound}
              sounds={heroSounds}
              soundsLoading={heroSoundsLoading}
              images={heroImgs}
              customImages={heroCustomImages}
              onPickImage={(img) => void pickHeroImage(img)}
              onRemoveImage={removeHeroImage}
              onPreviewSound={(ref) => decodeStock(ref)}
              onOpenSound={(s) => void openVoiceline(s)}
              hasContent={(eventName) => {
                if (!selectedHero) return false;
                const slot = project?.events.find(
                  (e) => e.id === heroAbilSlotId(selectedHero, eventName),
                );
                return !!slot && (slot.adopted.length > 0 || slot.songs.length > 0);
              }}
              modifiedOnly={modifiedOnly}
            />
          ) : (
            <HeroGrid
              helperPath={settings.vpkHelperPath}
              pakPath={settings.deadlockPak}
              warmup={
                preload && preload.bgTotal > 0 && preload.bgDone < preload.bgTotal
                  ? { done: preload.bgDone, total: preload.bgTotal }
                  : null
              }
              showExperimental={settings.showExperimentalHeroes}
              selected={selectedHero}
              onSelect={(h) => {
                setSelectedHero(h.codename);
                setSelectedHeroInfo(h);
              }}
              modifiedFilter={modifiedOnly ? heroModified : null}
            />
          )
        ) : (
          <>
            {activeTab === "ui" && (
              <label className="mb-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <input
                  type="checkbox"
                  checked={settings.includeUiSounds}
                  onChange={(e) => updateSettings({ includeUiSounds: e.target.checked })}
                  className="mt-0.5 accent-amber-500"
                />
                <span className="text-xs text-zinc-300">
                  <span className="font-semibold text-amber-300">Apply UI sound changes in the build</span>
                  <br />
                  <span className="text-zinc-500">
                    Off by default - UI soundevent edits make broad menu changes that can
                    break things. Your edits are kept either way; this only controls
                    whether they're compiled in.
                  </span>
                </span>
              </label>
            )}
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {visibleSlots.map(renderPanel)}
            </div>
          </>
        )}
        </motion.div>

        <div className="flex-1" />
        </div>

        {project && (
          <CompileBar
            settings={settings}
            update={updateSettings}
            events={project.events}
            iconMods={project.iconMods ?? []}
            soundOverrides={project.soundOverrides ?? []}
            effectOverrides={settings.experimentalEffects ? (project.effectOverrides ?? []) : []}
            vdataOverrides={project.vdataOverrides ?? []}
            globalOverrides={project.globalOverrides ?? []}
            worldOverrides={project.worldOverrides ?? []}
            posterOverrides={project.posterOverrides ?? []}
            digimod={project.digimod ?? null}
            uiOverrides={settings.experimentalUiMaster ? (project.uiOverrides ?? []) : []}
            onCompiled={markAllCompiled}
            onBulkGain={bulkGain}
            onFixForNewPatch={refreshVanilla}
            tabLabels={TAB_LABELS}
          />
        )}
      </main>

      {project && !settings.firstRunDone && (
        <FirstRunWizard
          settings={settings}
          onRunSetup={runFirstSetup}
          onDownloadTools={downloadToolsBundle}
          onDone={() => updateSettings({ firstRunDone: true })}
        />
      )}

      {/* Update prompt: shown once per launch when a newer release exists. */}
      {updatePromptOpen && appUpdate && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[26rem] rounded-2xl border border-violet-500/30 bg-zinc-950 p-5 shadow-2xl">
            <h3 className="text-base font-bold text-zinc-100">⬆ Update available</h3>
            <p className="mt-1 text-sm text-zinc-400">
              Moonahs Mod Maker <span className="font-semibold text-violet-300">v{appUpdate.latest}</span>{" "}
              is out - you have v{appUpdate.current}.
            </p>
            <p className="mt-2 text-[11px] text-zinc-600">
              {appUpdate.setupAsset
                ? '"Install now" downloads the new installer and runs it - the app closes itself; your projects and settings are kept.'
                : "This release has no installer attached, so the release page opens in your browser instead."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setUpdatePromptOpen(false)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:text-zinc-200"
              >
                Later
              </button>
              <button
                onClick={() => void openUrl(appUpdate.url)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500"
              >
                What's new
              </button>
              <button
                onClick={() => void runAppUpdate()}
                disabled={updating}
                className="rounded-lg bg-violet-500 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-400 disabled:opacity-50"
              >
                {updating ? "Downloading…" : appUpdate.setupAsset ? "Install now" : "Open release page"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mod-import review: pick what to bring in from a scanned pack. */}
      <AnimatePresence>
        {packReview && (
          <ImportReview
            review={packReview}
            onCancel={() => setPackReview(null)}
            onConfirm={(sel, bundle, excluded, mode, zeroGain) =>
              void applyPackImport(packReview.vpk, sel, bundle, excluded, mode, zeroGain)
            }
          />
        )}
      </AnimatePresence>

      {/* Startup preload: loading card while the core game data warms up. */}
      <AnimatePresence>
        {settings.firstRunDone && preload && !preload.coreDone && !preloadDismissed && (
          <motion.div
            className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="w-80 rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
              initial={{ scale: 0.97, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.97, y: 8 }}
            >
              <div className="mb-4 flex items-center gap-3">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Loading game data…</h3>
              </div>
              <ul className="flex flex-col gap-2">
                {preload.steps.map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-xs">
                    <span
                      className={`w-4 text-center ${
                        s.status === "done"
                          ? "text-emerald-400"
                          : s.status === "error"
                            ? "text-red-400"
                            : "text-zinc-600"
                      }`}
                    >
                      {s.status === "done" ? "✓" : s.status === "error" ? "✕" : s.status === "loading" ? "…" : "·"}
                    </span>
                    <span className={s.status === "done" ? "text-zinc-300" : "text-zinc-500"}>{s.label}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
                The first launch takes a moment while portraits, icons and the sound index are
                pulled from the game - after that it's cached and quick.
              </p>
              <button
                onClick={() => setPreloadDismissed(true)}
                className="mt-3 w-full rounded-lg border border-zinc-800 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
              >
                Continue in background
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quiet background warm-up progress (per-hero data), bottom-left. */}
      {preload && preload.coreDone && preload.bgTotal > 0 && preload.bgDone < preload.bgTotal && (
        <div className="fixed bottom-3 left-3 z-20 flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-[11px] text-zinc-500 shadow-lg">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
          Caching hero data {preload.bgDone}/{preload.bgTotal}
        </div>
      )}

      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSettingsOpen(false)}
          >
            <motion.div
              className="w-full max-w-2xl"
              initial={{ scale: 0.97, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.97, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
            >
              <SetupSection
                settings={settings}
                update={updateSettings}
                onClose={() => setSettingsOpen(false)}
                onRefreshVanilla={refreshVanilla}
                onAutodetect={autodetect}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
