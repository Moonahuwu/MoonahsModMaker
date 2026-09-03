// Animated painting targets - display data for Wall Art's Animated tab.
// Technique, host choices and surface data by goldenboy44 (leonyarov), used
// with permission:
// https://gamebanana.com/tools/23828
// https://github.com/leonyarov/deadlock-dynamic-paintings
//
// The compile-side twin (cells, models, material paths) lives in
// dynpaint.rs; panel ids and cells must match it. Every panel of a host
// overrides the same model file, so ONE surface per host can be animated at
// a time.

export interface DynpaintPanelInfo {
  id: string;
  title: string;
  blurb: string;
  /** The surface's real proportions in texture pixels (drives tile shape). */
  cell: { w: number; h: number };
}

export interface DynpaintTargetInfo {
  id: string;
  name: string;
  where: string;
  /** Newer, still being checked in game (goldenboy44 marks Midtown beta). */
  beta?: boolean;
  /** Extra caveat shown small under the host. */
  note?: string;
  /** The map's lighting on this surface, for preview only - the compile
   *  bakes it in either way (goldenboy44's measured value). */
  roomLight?: { css: string; help: string };
  panels: DynpaintPanelInfo[];
}

export const DYNPAINT_TARGETS: DynpaintTargetInfo[] = [
  {
    id: "hideout_portrait_canvas",
    name: "The Patron Portrait",
    where: "Hideout, above the fireplace",
    roomLight: {
      css: "#98704f",
      help: "The room dims the painting to about a fifth and warms it. That is baked into the compile whatever you do here - toggle it off to judge the picture on its own.",
    },
    panels: [
      {
        id: "card1",
        title: "The Patron Portrait",
        blurb: "The big painting above the fireplace",
        cell: { w: 512, h: 764 },
      },
    ],
  },
  {
    id: "midtown_hidden_king",
    name: "The Hidden King signs",
    where: "Midtown, church district (Amber side)",
    beta: true,
    note: "Signs draw while their host archway does (out to roughly 4,400 units - vanilla culling).",
    panels: [
      { id: "card1", title: "Library Painting #1", blurb: "The painting on the right", cell: { w: 364, h: 720 } },
      { id: "card2", title: "Library Painting #2", blurb: "The painting on the left", cell: { w: 364, h: 720 } },
      { id: "card3", title: "Speakeasy Adframe", blurb: "Visible from the Hidden King side, outside the T1 camp", cell: { w: 528, h: 496 } },
      { id: "card4", title: "Item Ad #1", blurb: "Outside the T1 camp", cell: { w: 396, h: 660 } },
      { id: "card5", title: "Library Painting #3", blurb: "Adjacent to painting #4, on the left side", cell: { w: 368, h: 708 } },
      { id: "card6", title: "Item Ad #2", blurb: "Outside the T1 camp", cell: { w: 396, h: 660 } },
      { id: "card7", title: "Library Painting #4", blurb: "Adjacent to painting #3, on the right side", cell: { w: 364, h: 720 } },
      { id: "card8", title: "Vertical Adframe", blurb: "Near the T1 camp, above the staircase", cell: { w: 368, h: 716 } },
      { id: "card9", title: "Horizontal Adframe", blurb: "On top of the T1 camp building and staircase", cell: { w: 748, h: 352 } },
      { id: "card10", title: "T2 Camp Painting", blurb: "Inside the T2 camp behind the library", cell: { w: 756, h: 348 } },
      { id: "card11", title: "Ad Standee", blurb: "Near the guardian", cell: { w: 552, h: 476 } },
    ],
  },
  {
    id: "midtown_archmother",
    name: "The Archmother signs",
    where: "Midtown, bodega corner (Sapphire side)",
    beta: true,
    note: "Signs draw while their host prop does (vanilla culling).",
    panels: [
      { id: "card1", title: "Horizontal Adframe #1", blurb: "Above the curiosity shop", cell: { w: 1028, h: 256 } },
      { id: "card2", title: "Horizontal Adframe #2", blurb: "Above the double veil", cell: { w: 1028, h: 256 } },
      { id: "card3", title: "Ad Standee", blurb: "Near the guardian", cell: { w: 556, h: 472 } },
      { id: "card4", title: "Square Billboard", blurb: "Outside the T2 camp", cell: { w: 512, h: 512 } },
      { id: "card5", title: "Horizontal Adframe #3", blurb: "Behind the T2 camp, near the big veil", cell: { w: 884, h: 296 } },
    ],
  },
];
