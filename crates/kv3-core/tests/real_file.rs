//! Integration tests against the real extracted `music.vsndevts` shipped in the
//! repo. These are the spec's "riskiest correctness piece": prove formatting
//! fidelity and that we only ever touch the entries we own.

use kv3_core::{apply_merge, apply_merges, read_event, EventMerge};

const KING: &str = "Music.MatchIntro.MatchStart.King";
const MOTHER: &str = "Music.MatchIntro.MatchStart.Mother";
const KING_STOCK: &str = "sounds/music/match_intro/music_match_intro_king_160bpm.vsnd";
const MOTHER_STOCK: &str = "sounds/music/match_intro/music_match_intro_mother_160bpm.vsnd";

fn real_file() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ModFiles/soundevents/music.vsndevts"
    );
    std::fs::read_to_string(path).expect("read real music.vsndevts")
}

/// Byte index just before an event's key line, for prefix-equality checks.
fn event_start(text: &str, event_name: &str) -> usize {
    text.find(event_name).expect("event present")
}

#[test]
fn reads_real_king_and_mother_pools() {
    let text = real_file();

    let king = read_event(&text, KING).unwrap();
    assert_eq!(king.entries.len(), 3, "King should have stock + 2 mods");
    assert_eq!(king.entries[0], KING_STOCK);
    assert_eq!(king.vsnd_duration, Some(27.0));

    let mother = read_event(&text, MOTHER).unwrap();
    assert_eq!(mother.entries.len(), 4, "Mother should have stock + 3 mods");
    assert_eq!(mother.entries[0], MOTHER_STOCK);
}

#[test]
fn noop_merge_roundtrips_byte_for_byte() {
    let text = real_file();
    let noop = EventMerge {
        event_name: KING.into(),
        array_key: "vsnd_files".into(),
        stock_entry: KING_STOCK.into(),
        owned_in_order: vec![],
        previous_owned: vec![],
        new_duration: None,
        excluded: vec![],
    };
    let out = apply_merge(&text, &noop).unwrap();
    assert_eq!(out, text, "no-op merge must reproduce the file exactly");
}

#[test]
fn adding_to_king_leaves_everything_else_identical() {
    let text = real_file();
    let new_ref = "sounds/music/match_intro/mysong.vsnd";

    let edit = EventMerge {
        event_name: KING.into(),
        array_key: "vsnd_files".into(),
        stock_entry: KING_STOCK.into(),
        owned_in_order: vec![new_ref.into()],
        previous_owned: vec![],
        new_duration: Some(30.0),
        excluded: vec![],
    };
    let out = apply_merge(&text, &edit).unwrap();

    // King now has the new entry appended after stock + the two foreign mods.
    let king = read_event(&out, KING).unwrap();
    assert_eq!(
        king.entries,
        vec![
            KING_STOCK,
            "sounds/music/match_intro/kingintro.vsnd",
            "sounds/music/match_intro/kingintro2.vsnd",
            new_ref,
        ]
    );
    assert_eq!(king.vsnd_duration, Some(30.0));

    // Everything before the King event is untouched.
    let king_at = event_start(&text, KING);
    assert_eq!(&out[..king_at], &text[..king_at], "prefix changed");

    // The entire Mother event block is untouched (compare from Mother key to the
    // end of its block in both files).
    let mother_orig = &text[event_start(&text, MOTHER)..];
    let mother_out = &out[event_start(&out, MOTHER)..];
    assert_eq!(mother_out, mother_orig, "Mother (and tail) changed");
}

#[test]
fn add_then_remove_returns_to_original() {
    let text = real_file();
    let new_ref = "sounds/music/match_intro/mysong.vsnd";

    let add = EventMerge {
        event_name: KING.into(),
        array_key: "vsnd_files".into(),
        stock_entry: KING_STOCK.into(),
        owned_in_order: vec![new_ref.into()],
        previous_owned: vec![],
        new_duration: None, // keep duration to preserve byte identity on remove
        excluded: vec![],
    };
    let added = apply_merge(&text, &add).unwrap();

    let remove = EventMerge {
        event_name: KING.into(),
        array_key: "vsnd_files".into(),
        stock_entry: KING_STOCK.into(),
        owned_in_order: vec![],
        previous_owned: vec![new_ref.into()],
        new_duration: None,
        excluded: vec![],
    };
    let removed = apply_merge(&added, &remove).unwrap();

    assert_eq!(removed, text, "add then remove should restore the original");
}

#[test]
fn merging_both_events_is_independent() {
    let text = real_file();
    let edits = vec![
        EventMerge {
            event_name: KING.into(),
            array_key: "vsnd_files".into(),
            stock_entry: KING_STOCK.into(),
            owned_in_order: vec!["sounds/music/match_intro/kingsong.vsnd".into()],
            previous_owned: vec![],
            new_duration: None,
            excluded: vec![],
        },
        EventMerge {
            event_name: MOTHER.into(),
            array_key: "vsnd_files".into(),
            stock_entry: MOTHER_STOCK.into(),
            owned_in_order: vec!["sounds/music/match_intro/mothersong.vsnd".into()],
            previous_owned: vec![],
            new_duration: None,
            excluded: vec![],
        },
    ];
    let out = apply_merges(&text, &edits).unwrap();

    let king = read_event(&out, KING).unwrap();
    assert!(king.entries.contains(&"sounds/music/match_intro/kingsong.vsnd".to_string()));
    assert_eq!(king.entries.len(), 4);

    let mother = read_event(&out, MOTHER).unwrap();
    assert!(mother.entries.contains(&"sounds/music/match_intro/mothersong.vsnd".to_string()));
    assert_eq!(mother.entries.len(), 5);

    // Unrelated events still present and intact.
    assert!(out.contains("Music.MatchIntro.Connecting"));
    assert!(out.contains("Music.MatchIntro.HeroReveal"));
}
