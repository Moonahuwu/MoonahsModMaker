import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  autodetectPaths,
  copyToDownloads,
  decodeStock as decodeStockApi,
  downloadEntry,
  heroDetail as heroDetailApi,
  heroVoicelines as heroVoicelinesApi,
  itemDetail as itemDetailApi,
  type HeroAbility,
  type HeroAbilitySound,
  type HeroPortrait,
  type VoiceLine,
  type ItemCard,
  loadState,
  newProject,
  probeAudio,
  readEventPools,
  readModArrays,
  refreshVanilla as refreshVanillaApi,
  sanitizeName,
  listProfiles,
  saveProfile,
  loadProfile,
  deleteProfile,
  renameProfile,
  type ProfileBlob,
} from "./lib/api";
import { SidePanel } from "./components/SidePanel";
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
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { useToast } from "./components/Toaster";
import { useSettings } from "./lib/settings";
import { songHash, overrideHash } from "./lib/songHash";
import type { EventProject, EventView, Project, Song, SoundOverride } from "./types";
import "./index.css";

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const DEFAULT_GAIN_DB = 6;

const MOD_COMBINER = "modcombiner";
/** Special always-present tab for shop items (scaffold; sounds wired later). */
const ITEMS = "items";
/** Special always-present tab for loose-file sound replacement (any game sound). */
const REPLACE_SOUNDS = "replacesounds";

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
  { key: "all", label: "Everything (all sounds)", prefix: "sounds", hint: "Full tree — power users" },
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
  intro: "Deadlock Intro",
  urn: "Urn Music",
  midboss: "Midboss",
  powerups: "Powerups",
  teamobj: "Team Objectives",
  heroes: "Heroes",
  shop: "Shop Music",
  ui: "UI",
  [ITEMS]: "Items",
  [REPLACE_SOUNDS]: "Replace Sounds",
  [MOD_COMBINER]: "Mod combiner",
};

/** Parent groupings in the sidebar: a collapsible header over related tabs. */
const TAB_CATEGORIES: { label: string; tabs: string[] }[] = [
  { label: "Map", tabs: ["urn", "midboss", "powerups", "teamobj"] },
];

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
    (e) => !defIds.has(e.id) && isDynamicSlot(e.id) && slotHasContent(e),
  );
  return { ...saved, events: [...merged, ...extras] };
}

function accentFor(ev: { group: string; side: string }): string {
  if (ev.group === "intro") return ev.side === "Mother" ? "#3974ae" : "#ffac10";
  if (ev.group === "urn") return "#a855f7"; // violet
  if (ev.group === "midboss") return "#f97316"; // orange
  if (ev.group === "powerups") return "#84cc16"; // lime
  if (ev.group === "teamobj") return "#60a5fa"; // blue
  if (ev.group === "shop") return "#10b981"; // emerald (souls/shop)
  if (ev.group === "ui") return "#38bdf8"; // sky (menus)
  if (ev.group === ITEMS) return "#f59e0b"; // amber (items)
  return "#e0564f"; // heroes
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [pools, setPools] = useState<Record<string, EventView>>({});
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
  // Selected shop item (Items tab) -> drill-in to its sound events.
  const [selectedItem, setSelectedItem] = useState<ItemCard | null>(null);
  const [itemSounds, setItemSounds] = useState<HeroAbilitySound[] | null>(null);
  const [itemDetailLoading, setItemDetailLoading] = useState(false);
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

  // Slot-group tabs (in slot order) plus the special Mod Combiner tab.
  const tabs = useMemo(() => {
    const seen: string[] = [];
    for (const e of project?.events ?? []) {
      if (!seen.includes(e.group)) seen.push(e.group);
    }
    if (!seen.includes(ITEMS)) seen.push(ITEMS);
    if (!seen.includes(REPLACE_SOUNDS)) seen.push(REPLACE_SOUNDS);
    seen.push(MOD_COMBINER);
    return seen;
  }, [project]);

  // Sidebar nav structure: standalone tabs, with category tabs collapsed under a
  // single parent header (rendered at the position of the first member tab).
  const navItems = useMemo(() => {
    const items: (
      | { type: "tab"; key: string }
      | { type: "category"; label: string; tabs: string[] }
    )[] = [];
    const usedCats = new Set<string>();
    for (const g of tabs) {
      const cat = TAB_CATEGORIES.find((c) => c.tabs.includes(g));
      if (cat) {
        if (usedCats.has(cat.label)) continue;
        usedCats.add(cat.label);
        items.push({
          type: "category",
          label: cat.label,
          tabs: cat.tabs.filter((t) => tabs.includes(t)),
        });
      } else {
        items.push({ type: "tab", key: g });
      }
    }
    return items;
  }, [tabs]);

  // Which parent categories are collapsed (default: all expanded).
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

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

        // Dropped image while viewing an item → set it as that item's icon.
        if (images.length > 0) {
          if (activeTabRef.current === ITEMS && selectedItemRef.current) {
            void setItemIcon(selectedItemRef.current, images[0]);
          } else {
            push("info", "Open an item in the Items tab, then drop a PNG/JPG to set its icon");
          }
        }

        // Dropped mod .vpk(s) → add to the Mod combiner list.
        if (vpks.length > 0) {
          const cur = settingsRef.current.importedMods;
          const next = [...cur];
          for (const v of vpks) if (!next.includes(v)) next.push(v);
          const addedN = next.length - cur.length;
          if (addedN > 0) {
            updateSettings({ importedMods: next });
            setActiveTab(MOD_COMBINER);
            push("success", `Added ${addedN} mod${addedN === 1 ? "" : "s"} to combine`);
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
      // Sync dynamic hero ability slots' stock to the live first entry, so the
      // existing game sound shows as the stock row. Re-synced each load (not just
      // when empty) so a stale pinned ref from an earlier session self-heals
      // instead of previewing the wrong sound.
      setProject((prev) => {
        if (!prev) return prev;
        let changed = false;
        const events = prev.events.map((e) => {
          if (isDynamicSlot(e.id)) {
            const first = map[e.id]?.entries?.[0];
            if (first && first !== e.stockEntry) {
              changed = true;
              return { ...e, stockEntry: first };
            }
          }
          return e;
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

  async function addSong(slotId: string, path: string) {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      const ffmpegPath = settingsRef.current.ffmpegPath || undefined;
      const info = await probeAudio(path, ffmpegPath);
      const sanitized = await sanitizeName(baseName(path));
      const soundName = uniqueSoundName(sanitized, proj);
      const slot = proj.events.find((e) => e.id === slotId);
      const order = slot ? slot.songs.length : 0;
      const song: Song = {
        id: crypto.randomUUID(),
        label: baseName(path),
        sourceMp3: path,
        soundName,
        trimStart: 0,
        trimEnd: info.duration,
        gainDb: DEFAULT_GAIN_DB,
        fadeIn: 0,
        fadeOut: 0,
        looping: slot?.eventName.endsWith(".Lp") ?? false,
        order,
        lastCompiledHash: null,
      };
      setProject((prev) =>
        prev
          ? {
              ...prev,
              events: prev.events.map((e) =>
                e.id === slotId ? { ...e, songs: [...e.songs, song] } : e,
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
        events: prev.events.map((e) => ({
          ...e,
          songs: e.songs.map((s) => (s.id === songId ? { ...s, soundName: name } : s)),
        })),
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

  // Copy one of your source mp3s into Downloads.
  async function downloadSong(sourceMp3: string) {
    try {
      const dest = await copyToDownloads(sourceMp3);
      push("success", `Saved to ${dest}`);
    } catch (e) {
      push("error", `Download failed: ${e}`);
    }
  }

  // "Merge into project": adopt a mod's added entries into matching slots.
  async function mergeModIntoProject(vpk: string) {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      const arrays = await readModArrays(settingsRef.current.vpkHelperPath, vpk);
      const byKey = new Map(arrays.map((a) => [`${a.eventName}::${a.arrayKey}`, a]));
      let adoptedCount = 0;
      let slotsTouched = 0;
      setProject((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          events: prev.events.map((ev) => {
            const a = byKey.get(`${ev.eventName}::${ev.arrayKey}`);
            if (!a) return ev;
            const ourRefs = ev.songs.map(
              (s) => `${prev.soundFolder}/${s.soundName}.vsnd`,
            );
            const existing = new Set([
              ev.stockEntry,
              ...(pools[ev.id]?.entries ?? []),
              ...ourRefs,
              ...ev.adopted.map((x) => x.reference),
            ]);
            const fresh = a.entries.filter((r) => !existing.has(r));
            if (fresh.length === 0) return ev;
            slotsTouched++;
            adoptedCount += fresh.length;
            return {
              ...ev,
              adopted: [
                ...ev.adopted,
                ...fresh.map((r) => ({ reference: r, sourceVpk: vpk, label: shortRef(r) })),
              ],
            };
          }),
        };
      });
      if (adoptedCount > 0) {
        push("success", `Adopted ${adoptedCount} track(s) into ${slotsTouched} slot(s)`);
      } else {
        push("info", "Nothing new to adopt from that mod for your slots");
      }
    } catch (e) {
      push("error", `Merge into project failed: ${e}`);
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
          looping: slot?.eventName.endsWith(".Lp") ?? false,
          order,
          lastCompiledHash: null,
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
          }
        : prev,
    );
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

  // Refresh the merge base from the live game pak: decompile its events files,
  // repoint vanillaRoot at the fresh copy, re-read pools, and correct each slot's
  // stockEntry to the live first entry (kills drifted stock refs).
  async function refreshVanilla(opts?: { helper?: string; pak?: string }) {
    const proj = projectRef.current;
    const s = settingsRef.current;
    if (!proj) return;
    // Allow freshly-detected values to be passed in directly (first-run setup
    // runs detect then refresh in one tick, before settingsRef has updated).
    const helper = opts?.helper ?? s.vpkHelperPath;
    const pak = opts?.pak ?? s.deadlockPak;
    try {
      const relpaths = Array.from(new Set(proj.events.map((e) => e.eventsRelpath)));
      const res = await refreshVanillaApi(helper, pak, relpaths);
      updateSettings({ vanillaRoot: res.vanillaRoot });

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
      setPools(map);

      // Pin each slot's stock to the current game's first array entry.
      let corrected = 0;
      setProject((prev) =>
        prev
          ? {
              ...prev,
              events: prev.events.map((e) => {
                const first = map[e.id]?.entries?.[0];
                if (first && first !== e.stockEntry) {
                  corrected++;
                  return { ...e, stockEntry: first };
                }
                return e;
              }),
            }
          : prev,
      );

      const failNote = res.failed.length ? ` (${res.failed.length} missing)` : "";
      push(
        "success",
        `Refreshed ${res.refreshed.length} file(s) from the game; fixed ${corrected} stock ref(s)${failNote}`,
      );
    } catch (e) {
      push("error", `Refresh failed: ${e}`);
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
        push("info", "Couldn't auto-detect any paths — set them manually");
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
  async function ensureVanillaFiles(relpaths: string[]) {
    const s = settingsRef.current;
    const todo = relpaths.filter((r) => r && !ensuredFiles.current.has(r));
    if (todo.length === 0) return;
    try {
      const res = await refreshVanillaApi(s.vpkHelperPath, s.deadlockPak, todo);
      todo.forEach((r) => ensuredFiles.current.add(r));
      if (res.vanillaRoot && res.vanillaRoot !== s.vanillaRoot) {
        updateSettings({ vanillaRoot: res.vanillaRoot });
      }
    } catch (e) {
      push("error", `Couldn't load hero sound data: ${e}`);
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
      const mods = (prev.iconMods ?? []).filter((m) => m.id !== id);
      mods.push({
        id,
        name: item.displayName,
        targetVtexc: item.iconInternal!,
        sourceImage: imagePath,
        width: size.w,
        height: size.h,
      });
      return { ...prev, iconMods: mods };
    });
    push("success", `Custom icon set for ${item.displayName} — compile to apply`);
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
          looping: false,
          lastCompiledHash: null,
        });
        return { ...prev, soundOverrides: list };
      });
      push("success", `Replacement set for ${label} — compile to apply`);
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

  const visibleSlots = (project?.events ?? []).filter((e) => e.group === activeTab);
  const songCount = (project?.events ?? []).reduce((n, e) => n + e.songs.length, 0);

  // One SidePanel for a slot, with all its handlers wired (shared by the normal
  // tabs and the Heroes drill-in).
  const renderPanel = (ev: EventProject) => (
    <SidePanel
      key={ev.id}
      ev={ev}
      view={pools[ev.id]}
      soundFolder={project!.soundFolder}
      ffmpegPath={settings.ffmpegPath || undefined}
      accent={accentFor(ev)}
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
        : (project?.events ?? [])
            .filter((e) => e.group === g)
            .reduce((n, e) => n + e.songs.length, 0);

  // One sidebar tab button (indented when nested under a parent category).
  const renderTabButton = (g: string, indented: boolean) => {
    const count = tabCount(g);
    const active = g === activeTab;
    return (
      <button
        key={g}
        onClick={() => setActiveTab(g)}
        className={`flex items-center justify-between rounded-lg py-2 pr-3 text-left text-sm transition ${
          indented ? "pl-6" : "px-3"
        } ${
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

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left sidebar: brand + tabs — fixed, never scrolls */}
      <aside className="flex h-screen w-52 shrink-0 flex-col gap-1 border-r border-zinc-800 bg-zinc-950/60 p-4">
        <div className="mb-4">
          <h1 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
            Moonah's
          </h1>
          <p className="text-[11px] text-zinc-600">Mod Maker</p>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {navItems.map((item) => {
            if (item.type === "tab") return renderTabButton(item.key, false);
            // Category: a collapsible parent header over its member tabs.
            const collapsed = collapsedCats.has(item.label);
            const catCount = item.tabs.reduce((n, t) => n + tabCount(t), 0);
            const hasActive = item.tabs.includes(activeTab);
            return (
              <div key={item.label} className="flex flex-col gap-1">
                <button
                  onClick={() =>
                    setCollapsedCats((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.label)) next.delete(item.label);
                      else next.add(item.label);
                      return next;
                    })
                  }
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider transition ${
                    hasActive ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="text-[9px] text-zinc-600">{collapsed ? "▶" : "▼"}</span>
                    {item.label}
                  </span>
                  {catCount > 0 && (
                    <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
                      {catCount}
                    </span>
                  )}
                </button>
                {!collapsed &&
                  item.tabs.map((t) => renderTabButton(t, true))}
              </div>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center justify-between pt-2">
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Setup"
            title="Setup"
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
          >
            <span className="text-base">⚙</span>
            <span>Setup</span>
          </button>
          <span className="text-[10px] text-zinc-700">
            {songCount} track{songCount === 1 ? "" : "s"}
          </span>
        </div>
      </aside>

      {/* Main content — the only scrollable pane */}
      <main className="flex h-screen flex-1 flex-col gap-5 overflow-y-auto p-6 pb-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="bg-gradient-to-r from-zinc-50 to-zinc-400 bg-clip-text text-xl font-bold tracking-tight text-transparent">
              {TAB_LABELS[activeTab] ?? activeTab}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {activeTab === MOD_COMBINER
                ? "Merge other mods' sounds into your compile — nothing of yours is removed."
                : activeTab === REPLACE_SOUNDS
                  ? "Replace any game sound directly by its file — no soundevents touched. Browse a category, preview, then drop in your audio."
                  : "Your entries merge in — every other mod stays untouched."}
            </p>
          </div>
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
        </header>

        {activeTab === MOD_COMBINER ? (
          <ImportedMods
            settings={settings}
            update={updateSettings}
            onMerge={mergeModIntoProject}
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
            onPickIcon={() => selectedItem && void pickItemIcon(selectedItem)}
            onRemoveIcon={() => selectedItem && removeItemIcon(selectedItem.name)}
          />
        ) : activeTab === REPLACE_SOUNDS ? (
          <SoundBrowser
            helperPath={settings.vpkHelperPath}
            pakPath={settings.deadlockPak}
            categories={SOUND_CATEGORIES}
            overrides={project?.soundOverrides ?? []}
            accent="#f472b6"
            onPreview={(ref) => decodeStock(ref)}
            onReplace={(ref, label) => void replaceSound(ref, label)}
            onRemoveOverride={removeOverrideByRef}
            renderEditor={(o) => (
              <OverrideEditor
                override={o}
                onChange={(patch) => updateOverride(o.id, patch)}
                onPickFile={() => void pickOverrideFile(o)}
              />
            )}
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
            />
          ) : (
            <HeroGrid
              helperPath={settings.vpkHelperPath}
              pakPath={settings.deadlockPak}
              showExperimental={settings.showExperimentalHeroes}
              selected={selectedHero}
              onSelect={(h) => {
                setSelectedHero(h.codename);
                setSelectedHeroInfo(h);
              }}
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {visibleSlots.map(renderPanel)}
          </div>
        )}

        <div className="flex-1" />

        {project && (
          <CompileBar
            settings={settings}
            update={updateSettings}
            events={project.events}
            iconMods={project.iconMods ?? []}
            soundOverrides={project.soundOverrides ?? []}
            onCompiled={markAllCompiled}
          />
        )}
      </main>

      {project && !settings.firstRunDone && (
        <FirstRunWizard
          settings={settings}
          onRunSetup={runFirstSetup}
          onDone={() => updateSettings({ firstRunDone: true })}
        />
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
